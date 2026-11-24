// Webinar History – written once, when the webinar ends (to HISTORY_SHEET_ID, or the chat sheet if unset):
//   Summary: one row per webinar – attendees, live leads, live lead %, ratio, engagement %, questions, replies
//   Q&A:     every genuine question and the reply it was given
// Only counts and Q&A – no names or numbers (those stay in the chat sheet's Numbers tab for the team).
import { Sheet } from './sheets.js';
import { summaryRequests, qaRequests, webinarRequests, webinarValues, webinarTabName, qaStatus } from './historyFormat.js';

export const SUMMARY_TAB = 'Summary';
export const QA_TAB = 'Q&A';

export const SUMMARY_HEADER = [
  'Webinar ID', 'Date', 'Webinar', 'Started', 'Ended',
  'Attendees', 'Live leads', 'Live lead %', 'Lead ratio', 'People who chatted', 'Engagement %', 'Questions asked', 'Replies given',
];
export const QA_HEADER = ['Webinar ID', 'Date', 'Time', 'Question', 'Reply', 'Status'];

const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 1000 : ''); // a fraction – the sheet shows it as 12.3%
const ratio = (leads, attendees) => (leads && attendees ? `1 in ${Math.max(1, Math.round(attendees / leads))}` : '');

export class History {
  constructor({ cfg, today, clock, log }) {
    this.cfg = cfg;
    this.today = today;
    this.clock = clock;
    this.log = log;
    this.sheet = new Sheet({ sheetId: cfg.historySheetId || cfg.sheetId, googleCreds: cfg.googleCreds });
    const stamp = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata' }).slice(0, 16); // 2026-11-23 11:00
    this.id = `${stamp} · ${cfg.buyers ? '15 Days · ' : ''}${cfg.scheduleTab}`;
    this.started = clock();
    this.peak = 0;
    this.chatters = new Set();
    this.leads = new Set(); // phone numbers – only counted, never written to history
    this.questions = 0;
    this.replies = 0;
    this.qa = [];
  }

  // ---- events from the agent ----
  attendees(n) {
    if (Number.isFinite(n) && n > this.peak) this.peak = n;
  }
  chatter(name) {
    this.chatters.add(name);
  }
  lead(phone) {
    this.leads.add(phone);
  }
  question() {
    this.questions++;
  }
  qaRow({ question, reply = '' }) {
    if (reply) this.replies++;
    const shown = reply && this.cfg.dryRun ? `[dry run – not sent] ${reply}` : reply;
    this.qa.push([this.id, this.today, this.clock(), question, shown || '(handed to team)', qaStatus(shown)]);
  }

  summaryRow() {
    const att = this.peak;
    return [
      this.id, this.today, `${this.cfg.buyers ? '15 Days · ' : ''}${this.cfg.scheduleTab}`, this.started, this.clock(),
      att || '', this.leads.size, pct(this.leads.size, att), ratio(this.leads.size, att),
      this.chatters.size, pct(this.chatters.size, att), this.questions, this.replies,
    ];
  }

  // Called once at the end of the webinar: adds a row to Summary, the questions to Q&A, and a tab of its own
  // for this webinar – all formatted the same way every time (src/historyFormat.js).
  async write() {
    try {
      await this.sheet.ensureTab(SUMMARY_TAB, SUMMARY_HEADER);
      await this.sheet.ensureTab(QA_TAB, QA_HEADER);
      await this.sheet.api.spreadsheets.values.update({ spreadsheetId: this.sheet.id, range: `'${QA_TAB}'!A1:F1`, valueInputOption: 'RAW', requestBody: { values: [QA_HEADER] } });
      await this.sheet.append(SUMMARY_TAB, [this.summaryRow()], true);
      if (this.qa.length) await this.sheet.append(QA_TAB, this.qa, true);
      await this.#webinarTab();
      await this.#format();
      this.log(`History saved: ${this.peak || '?'} attendees, ${this.leads.size} live leads, ${this.questions} questions`);
    } catch (e) {
      this.log(`Could not write webinar history: ${e.message}`);
    }
  }

  async #meta() {
    const res = await this.sheet.api.spreadsheets.get({ spreadsheetId: this.sheet.id, fields: 'sheets(properties(sheetId,title,index),conditionalFormats)' });
    return res.data.sheets;
  }

  async #batch(requests) {
    if (requests.length) await this.sheet.api.spreadsheets.batchUpdate({ spreadsheetId: this.sheet.id, requestBody: { requests } });
  }

  // This webinar's own tab, placed right after Summary and Q&A (newest first)
  async #webinarTab() {
    const sheets = await this.#meta();
    const taken = new Set(sheets.map((s) => s.properties.title));
    const base = webinarTabName(this.today, `${this.cfg.buyers ? '15 Days · ' : ''}${this.cfg.scheduleTab}`);
    let name = base;
    for (let i = 2; taken.has(name); i++) name = `${base} (${i})`;
    const add = await this.sheet.api.spreadsheets.batchUpdate({
      spreadsheetId: this.sheet.id,
      requestBody: { requests: [{ addSheet: { properties: { title: name, index: 2, gridProperties: { rowCount: Math.max(200, this.qa.length + 40), columnCount: 6 } } } }] },
    });
    const sheetId = add.data.replies[0].addSheet.properties.sheetId;
    const r = this.summaryRow();
    const values = webinarValues({
      title: `${this.cfg.buyers ? '15 Days · ' : ''}${this.cfg.scheduleTab}`,
      subtitle: `${this.today}  ·  started ${r[3]}  ·  ended ${r[4]}`,
      kpis: [r[5], r[6], r[7], r[8], r[9], r[10], r[11], r[12]],
      qa: this.qa.map((q) => [q[2], q[3], q[4]]),
    });
    await this.sheet.api.spreadsheets.values.update({ spreadsheetId: this.sheet.id, range: `'${name}'!A1`, valueInputOption: 'RAW', requestBody: { values } });
    await this.#batch([
      ...webinarRequests(sheetId, this.qa.length),
      // webinar ID as a note on the title – the dashboard's "Delete this webinar" finds the tab by it
      { updateCells: { range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 1 }, rows: [{ values: [{ note: this.id }] }], fields: 'note' } },
    ]);
  }

  // Summary and Q&A: same look every time (old colour rules removed first so they never pile up),
  // and the empty default "Sheet1" removed.
  async #format() {
    const sheets = await this.#meta();
    const req = [];
    for (const s of sheets) {
      const { sheetId, title } = s.properties;
      const rules = s.conditionalFormats?.length || 0;
      if (title === SUMMARY_TAB || title === QA_TAB) {
        for (let i = 0; i < rules; i++) req.push({ deleteConditionalFormatRule: { sheetId, index: 0 } });
        req.push(...(title === SUMMARY_TAB ? summaryRequests(sheetId) : qaRequests(sheetId)));
        req.push({ updateSheetProperties: { properties: { sheetId, index: title === SUMMARY_TAB ? 0 : 1 }, fields: 'index' } });
      }
    }
    const blank = sheets.find((s) => s.properties.title === 'Sheet1');
    if (blank && sheets.length > 1) req.push({ deleteSheet: { sheetId: blank.properties.sheetId } });
    await this.#batch(req);
  }
}
