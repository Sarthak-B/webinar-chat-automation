// Webinar History – written once, when the webinar ends (to HISTORY_SHEET_ID, or the chat sheet if unset):
//   Summary: one row per webinar – attendees, live leads, live lead %, ratio, engagement %, questions, replies
//   Q&A:     every genuine question and the reply it was given
// Only counts and Q&A – no names or numbers (those stay in the chat sheet's Numbers tab for the team).
import { Sheet } from './sheets.js';

export const SUMMARY_TAB = 'Summary';
export const QA_TAB = 'Q&A';

export const SUMMARY_HEADER = [
  'Webinar ID', 'Date', 'Webinar', 'Started', 'Ended',
  'Attendees', 'Live leads', 'Live lead %', 'Lead ratio', 'People who chatted', 'Engagement %', 'Questions asked', 'Replies given',
];
export const QA_HEADER = ['Webinar ID', 'Date', 'Time', 'Question', 'Reply'];

const pct = (a, b) => (b ? `${Math.round((a / b) * 1000) / 10}%` : '');
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
    this.qa.push([this.id, this.today, this.clock(), question, shown]);
  }

  summaryRow() {
    const att = this.peak;
    return [
      this.id, this.today, `${this.cfg.buyers ? '15 Days · ' : ''}${this.cfg.scheduleTab}`, this.started, this.clock(),
      att || '', this.leads.size, pct(this.leads.size, att), ratio(this.leads.size, att),
      this.chatters.size, pct(this.chatters.size, att), this.questions, this.replies,
    ];
  }

  // Called once at the end of the webinar.
  async write() {
    try {
      await this.sheet.ensureTab(SUMMARY_TAB, SUMMARY_HEADER);
      await this.sheet.ensureTab(QA_TAB, QA_HEADER);
      await this.sheet.append(SUMMARY_TAB, [this.summaryRow()]);
      if (this.qa.length) await this.sheet.append(QA_TAB, this.qa);
      this.log(`History saved: ${this.peak || '?'} attendees, ${this.leads.size} live leads, ${this.questions} questions`);
    } catch (e) {
      this.log(`Could not write webinar history: ${e.message}`);
    }
  }
}
