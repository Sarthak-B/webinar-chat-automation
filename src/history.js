// Webinar History: one Summary row per webinar (updated live), every genuine question + reply (Q&A),
// and every number captured (Leads). Written to the Webinar History sheet (HISTORY_SHEET_ID).
import { Sheet, SheetLogger } from './sheets.js';

export const SUMMARY_TAB = 'Summary';
export const QA_TAB = 'Q&A';
export const LEADS_TAB = 'Leads';

export const SUMMARY_HEADER = [
  'Webinar ID', 'Date', 'Sheet tab', 'Slot', 'Mode', 'Started', 'Ended', 'Status',
  'Attendees (peak)', 'People who chatted', 'Engagement %', 'Questions asked', 'Answered', 'Needs team',
  'Numbers captured', 'Live lead %', 'Numbers from chatters %', 'Timed chats sent', 'Run link',
];
export const QA_HEADER = ['Webinar ID', 'Date', 'Time', 'Attendee', 'Language', 'Question', 'Reply', 'Status'];
export const LEADS_HEADER = ['Webinar ID', 'Date', 'Time', 'Name', 'Number', 'Their message'];

const pct = (a, b) => (b ? `${Math.round((a / b) * 1000) / 10}%` : '');

export class History {
  constructor({ cfg, today, clock, log }) {
    this.cfg = cfg;
    this.today = today;
    this.clock = clock;
    this.log = log;
    this.sheet = new Sheet({ sheetId: cfg.historySheetId || cfg.sheetId, googleCreds: cfg.googleCreds });
    const d = new Date();
    const stamp = d.toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata' }).slice(0, 16); // 2026-11-23 11:00
    this.id = `${stamp} · ${cfg.scheduleTab}`;
    this.started = clock();
    this.peak = 0;
    this.chatters = new Set();
    this.questions = 0;
    this.answered = 0;
    this.needsTeam = 0;
    this.numbers = new Map(); // phone → name
    this.timedSent = 0;
    this.row = null;
    this.ok = false;
  }

  async init() {
    try {
      await this.sheet.ensureTab(SUMMARY_TAB, SUMMARY_HEADER);
      this.qa = new SheetLogger(this.sheet, QA_TAB, QA_HEADER);
      this.leads = new SheetLogger(this.sheet, LEADS_TAB, LEADS_HEADER);
      await this.qa.init();
      await this.leads.init();
      this.row = await this.sheet.appendRow(SUMMARY_TAB, this.summaryRow('Live'));
      this.ok = true;
      this.timer = setInterval(() => this.save('Live'), 5 * 60_000);
      this.log(`History → ${this.cfg.historySheetId ? 'Webinar History sheet' : 'main sheet'} (Summary row ${this.row})`);
    } catch (e) {
      this.log(`History disabled – could not open the history sheet: ${e.message}`);
    }
  }

  // ---- events from the agent ----
  attendees(n) {
    if (Number.isFinite(n) && n > this.peak) this.peak = n;
  }
  chatter(name) {
    this.chatters.add(name);
  }
  lead(name, phone, message) {
    if (this.numbers.has(phone)) return;
    this.numbers.set(phone, name);
    this.leads?.add([this.id, this.today, this.clock(), name, phone, message]);
  }
  question() {
    this.questions++;
  }
  timed() {
    this.timedSent++;
  }
  // status: 'Answered' | 'Needs team' | 'Not answered (timed mode)'
  qaRow({ name, lang, question, reply = '', status }) {
    if (status === 'Answered') this.answered++;
    if (status === 'Needs team') this.needsTeam++;
    const shown = this.cfg.dryRun && reply ? `${status} (dry run – not sent)` : status;
    this.qa?.add([this.id, this.today, this.clock(), name, lang || '', question, reply, shown]);
  }

  summaryRow(status) {
    const attendees = this.peak;
    const chatted = this.chatters.size;
    const leads = this.numbers.size;
    const leadsFromChatters = [...this.numbers.values()].filter((n) => this.chatters.has(n)).length;
    return [
      this.id, this.today, this.cfg.scheduleTab, this.cfg.slot, this.cfg.mode || (this.cfg.dryRun ? 'dry' : this.cfg.autoReply ? 'full' : 'timed'),
      this.started, status === 'Live' ? '' : this.clock(), status,
      attendees || '', chatted, pct(chatted, attendees), this.questions, this.answered, this.needsTeam,
      leads, pct(leads, attendees), pct(leadsFromChatters, chatted), this.timedSent, this.cfg.runUrl,
    ];
  }

  async save(status) {
    if (!this.ok || !this.row) return;
    try {
      await this.sheet.updateRow(SUMMARY_TAB, this.row, this.summaryRow(status));
    } catch (e) {
      this.log(`History summary update failed: ${e.message}`);
    }
  }

  async close(status = 'Completed') {
    clearInterval(this.timer);
    await Promise.all([this.qa?.close(), this.leads?.close()]);
    await this.save(status);
  }
}
