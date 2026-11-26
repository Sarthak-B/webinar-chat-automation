/**
 * Dashboard backend for the FlexiFunnels webinar agent: sheet feed + GitHub actions, behind one team password.
 * Setup: open the chat sheet → Extensions → Apps Script → paste this → set KEY (the team password) →
 *   Project Settings (⚙) → Script properties → add GITHUB_TOKEN = your dashboard GitHub token →
 *   Deploy → New deployment → Web app → Execute as: Me, Who has access: Anyone → copy the URL into the loader.
 * Teammates then only type the team password once. The GitHub token never leaves this script.
 */
const KEY = 'CHANGE-ME-to-a-long-random-key'; // the team password
const REPO = 'Sarthak-B/webinar-chat-automation';
// The Webinar History sheet's ID (from its URL: /spreadsheets/d/THIS_PART/edit).
// Leave empty if the agent writes the Summary / Q&A tabs into this same sheet.
const HISTORY_SHEET_ID = '';
// 15 Days First Sale Challenge: day tabs ("Day 0 Chats" …) with time | Minute | Second | Name | Role | Messege | Mode,
// counted from FIFTEEN_START.
const FIFTEEN_SHEET_ID = '1T4UCbX34Yyxw14VFcN1xsTMlMnH-ffR0f21BgYegZ5w';
const FIFTEEN_START = '7:00 PM';

// Run this ONCE from the editor (select "authorize" at the top → ▶ Run) and allow the permissions.
// It asks Google for every permission the dashboard needs (sheets + calling GitHub).
function authorize() {
  SpreadsheetApp.getActive().getName();
  historyBook().getName();
  UrlFetchApp.fetch('https://api.github.com/zen', { muteHttpExceptions: true });
  Logger.log('Authorized ✓ – now Deploy → Manage deployments → ✏️ → New version → Deploy');
}

function doGet(e) {
  const p = e.parameter || {};
  if (p.key !== KEY) return out({ error: 'Wrong key' });
  const ss = SpreadsheetApp.getActive();
  try {
    if (p.book === 'fifteen') {
      const fb = SpreadsheetApp.openById(FIFTEEN_SHEET_ID);
      if (p.action === 'tabs') return out({ title: fb.getName(), tabs: fb.getSheets().filter(function (sh) { return /\bday\s*\d+/i.test(sh.getName()); }).map(describeDay).sort(function (a, b) { return a.day - b.day; }) });
      if (p.action === 'schedule') return out(scheduleDay(fb, p.tab));
      if (p.action === 'rows') return out(rows(fb, p.tab, Number(p.from || 0))); // 15 Days Agent Log / Numbers live in its own sheet
      if (p.action === 'send') return out(queueReply(fb, p.to, p.text, p.from, p.learn === '1' ? p.question : ''));
      if (p.action === 'clear') { // 15 Days: only its own Agent Log / Numbers – never the 10 Min history
        const parts = p.what === 'all' ? ['chats', 'numbers'] : p.what === 'history' ? [] : [p.what];
        return out({ ok: true, done: parts.map(function (w) { return clearData(fb, w).cleared; }) });
      }
    }
    if (p.action === 'tabs') return out({ title: ss.getName(), tabs: ss.getSheets().map(describe) });
    if (p.action === 'schedule') return out(schedule(ss, p.tab));
    if (p.action === 'rows') return out(rows(ss, p.tab, Number(p.from || 0)));
    if (p.action === 'history') return out(history());
    if (p.action === 'historyqa') return out(historyFor('Q&A', p.id));
    if (p.action === 'gh') return out(github(p.method, p.path, p.body));
    if (p.action === 'clear') return out(clearData(ss, p.what));
    if (p.action === 'delwebinar') return out(deleteWebinar(p.id));
    if (p.action === 'send') return out(queueReply(ss, p.to, p.text, p.from, p.learn === '1' ? p.question : ''));
    if (p.action === 'autoget') return out(autoGet(ss));
    if (p.action === 'autosave') return out(autoSave(ss, p));
    if (p.action === 'whoami') return out({ ok: true, github: !!githubToken(), repo: REPO });
    return out({ error: 'Unknown action' });
  } catch (err) {
    return out({ error: String(err) });
  }
}

function headerIndex(values) {
  for (let i = 0; i < values.length; i++) if (String(values[i][0]).trim().toLowerCase() === 'video time') return i;
  return -1;
}

function describe(sh) {
  const n = Math.max(1, Math.min(sh.getLastRow(), 600));
  const v = sh.getRange(1, 1, n, 4).getDisplayValues();
  const h = headerIndex(v);
  if (h < 0) return { name: sh.getName(), schedule: false };
  const items = v.slice(h + 1).filter(function (r) { return r[1] && r[2]; });
  return {
    name: sh.getName(),
    schedule: true,
    count: items.length,
    start: v[0][0],
    first: items.length ? items[0][1] : '',
    last: items.length ? items[items.length - 1][1] : '',
  };
}

function schedule(ss, tab) {
  const sh = ss.getSheetByName(tab);
  if (!sh) return { error: 'Tab not found: ' + tab };
  const v = sh.getRange(1, 1, Math.max(1, Math.min(sh.getLastRow(), 600)), 4).getDisplayValues();
  const h = headerIndex(v);
  const items = h < 0 ? [] : v.slice(h + 1).filter(function (r) { return r[1] && r[2]; });
  return { tab: tab, start: v[0][0], items: items };
}

// ---- 15 Days day tabs → same shape as the business tabs: [video time, host time, chat, mode] ----
function dayItems(sh) {
  const n = Math.max(1, Math.min(sh.getLastRow(), 800));
  const v = sh.getRange(1, 1, n, Math.max(1, Math.min(sh.getLastColumn(), 10))).getDisplayValues();
  const norm = function (c) { return String(c || '').trim().toLowerCase(); };
  let h = -1;
  for (let i = 0; i < v.length && h < 0; i++) if (v[i].some(function (c) { return norm(c) === 'minute'; })) h = i;
  if (h < 0) return [];
  const head = v[h].map(norm);
  const col = function (re) { for (let i = 0; i < head.length; i++) if (re.test(head[i])) return i; return -1; };
  const cH = col(/^(time|hour|hours|hr)$/), cM = col(/^minutes?$/), cS = col(/^seconds?$/), cMsg = col(/^mess?[ae]ge?s?$|^message$|^chat$/), cMode = col(/^mode$/);
  const num = function (r, c) { return c < 0 ? 0 : Number(String(r[c] || '').replace(/[^\d.]/g, '')) || 0; };
  const m = FIFTEEN_START.match(/(\d{1,2})(?::(\d\d))?\s*([ap]m)?/i);
  let base = (Number(m[1]) % 12 + (/pm/i.test(m[3] || '') ? 12 : 0)) * 3600 + Number(m[2] || 0) * 60;
  const out = [];
  for (let i = h + 1; i < v.length; i++) {
    const r = v[i], text = String(r[cMsg] || '').trim(), mode = cMode < 0 ? '' : norm(r[cMode]);
    if (!text || (mode && mode !== 'chat')) continue;
    const off = num(r, cH) * 3600 + num(r, cM) * 60 + num(r, cS), t = base + off;
    const hh = Math.floor(t / 3600) % 24, mm = Math.floor((t % 3600) / 60), ss = t % 60;
    const host = ((hh % 12) || 12) + ':' + ('0' + mm).slice(-2) + ':' + ('0' + ss).slice(-2) + (hh >= 12 ? ' pm' : ' am');
    const video = Math.floor(off / 3600) + ':' + ('0' + Math.floor((off % 3600) / 60)).slice(-2) + ':' + ('0' + (off % 60)).slice(-2);
    out.push([video, host, text, mode || 'chat', off]);
  }
  out.sort(function (a, b) { return a[4] - b[4]; });
  return out.map(function (r) { return r.slice(0, 4); });
}
function describeDay(sh) {
  const items = dayItems(sh);
  return { name: sh.getName(), schedule: true, day: Number((sh.getName().match(/day\s*(\d+)/i) || [])[1]), count: items.length, start: '', first: items.length ? items[0][1] : '', last: items.length ? items[items.length - 1][1] : '' };
}
function scheduleDay(fb, tab) {
  const sh = fb.getSheetByName(tab);
  if (!sh) return { error: 'Tab not found: ' + tab };
  return { tab: tab, start: '', items: dayItems(sh) };
}

// Rows of "Agent Log" / "Numbers". First call (from=0): the latest 3000 rows. After that: only rows after `from`.
function rows(ss, tab, from) {
  const sh = ss.getSheetByName(tab);
  if (!sh) return { total: 0, rows: [] };
  const last = sh.getLastRow();
  const start = from > 0 ? Math.max(2, from + 1) : Math.max(2, last - 2999);
  const end = Math.min(last, start + 2999);
  const data = end >= start ? sh.getRange(start, 1, end - start + 1, sh.getLastColumn()).getDisplayValues() : [];
  return { total: end, from: start, rows: data };
}

// ---- Webinar History ----
function historyBook() {
  return HISTORY_SHEET_ID ? SpreadsheetApp.openById(HISTORY_SHEET_ID) : SpreadsheetApp.getActive();
}
// Summary rows (newest last, up to 300) with the header row first.
function history() {
  const sh = historyBook().getSheetByName('Summary');
  if (!sh || sh.getLastRow() < 1) return { header: [], rows: [] };
  const v = sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getDisplayValues();
  return { header: v[0], rows: v.slice(1).slice(-300) };
}
// Q&A rows for one webinar (column A = Webinar ID).
function historyFor(tab, id) {
  const sh = historyBook().getSheetByName(tab);
  if (!sh || sh.getLastRow() < 2) return { header: [], rows: [] };
  const v = sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getDisplayValues();
  return { header: v[0], rows: v.slice(1).filter(function (r) { return r[0] === id; }) };
}

// ---- Clean-up (dashboard "Clear" buttons; permanent – the dashboard asks first) ----
// what: chats = Agent Log · numbers = Numbers tab + attendee messages that contain a mobile number
//       history = Summary + Q&A · all = everything above
function clearData(ss, what) {
  const done = [];
  const wipe = function (sh) {
    if (!sh) return 0;
    const n = sh.getLastRow() - 1;
    if (n > 0) sh.deleteRows(2, n);
    return Math.max(0, n);
  };
  if (what === 'chats' || what === 'all') done.push('chats: ' + wipe(ss.getSheetByName('Agent Log')));
  if (what === 'numbers' || what === 'all') {
    done.push('numbers: ' + wipe(ss.getSheetByName('Numbers')));
    const log = ss.getSheetByName('Agent Log');
    if (log && what !== 'all' && log.getLastRow() > 1) {
      const v = log.getRange(2, 1, log.getLastRow() - 1, log.getLastColumn()).getValues();
      const keep = v.filter(function (r) { return !(String(r[2]).replace(/^DRY /, '') === 'IN' && hasPhone(r[5])); });
      if (keep.length !== v.length) {
        log.deleteRows(2, v.length);
        if (keep.length) { log.insertRowsAfter(1, keep.length); log.getRange(2, 1, keep.length, keep[0].length).setValues(keep); }
      }
    }
  }
  if (what === 'history' || what === 'all') {
    const hb = historyBook();
    done.push('history: ' + wipe(hb.getSheetByName('Summary')));
    wipe(hb.getSheetByName('Q&A'));
    webinarTabs(hb).forEach(function (sh) { hb.deleteSheet(sh); }); // the one-tab-per-webinar pages
  }
  return { ok: true, cleared: done };
}
function hasPhone(t) {
  const runs = String(t || '').match(/\+?\d[\d\s-]{8,16}\d/g) || [];
  return runs.some(function (run) {
    let d = run.replace(/\D/g, '');
    if (d.length === 12 && d.indexOf('91') === 0) d = d.slice(2); else if (d.length === 11 && d[0] === '0') d = d.slice(1);
    return d.length === 10 && /^[6-9]/.test(d);
  });
}
function deleteWebinar(id) {
  if (!id) return { error: 'No webinar id' };
  const hb = historyBook();
  let n = 0;
  ['Summary', 'Q&A'].forEach(function (tab) {
    const sh = hb.getSheetByName(tab);
    if (!sh || sh.getLastRow() < 2) return;
    const v = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getDisplayValues();
    for (let i = v.length - 1; i >= 0; i--) if (v[i][0] === id) { sh.deleteRow(i + 2); n++; }
  });
  webinarTabs(hb).forEach(function (sh) { if (sh.getRange('A1').getNote() === id) hb.deleteSheet(sh); });
  return { ok: true, deleted: n };
}
// The agent's one-tab-per-webinar pages: every tab except Summary and Q&A whose title cell carries a webinar ID note.
function webinarTabs(hb) {
  return hb.getSheets().filter(function (sh) {
    const t = sh.getName();
    return t !== 'Summary' && t !== 'Q&A' && sh.getRange('A1').getNote() !== '';
  });
}

// ---- Replies typed on the dashboard → the agent sends them in Zoom ----
// Adds a row to the "Outbox" tab; the running agent picks it up within a few seconds and marks it sent.
// learnQuestion: also save this Q&A to "Attendee Replies" so the AI answers it itself next time
function queueReply(book, to, text, from, learnQuestion) {
  text = String(text || '').trim();
  if (!text) return { error: 'Empty message' };
  if (text.length > 1000) return { error: 'Message too long (max 1000 characters)' };
  let sh = book.getSheetByName('Outbox');
  if (!sh) {
    sh = book.insertSheet('Outbox');
    sh.appendRow(['Sent at', 'To', 'Message', 'Status', 'Id', 'From']);
    sh.setFrozenRows(1);
  }
  const id = Utilities.getUuid().slice(0, 8);
  // plain text in every cell (a reply starting with = or + must never become a formula)
  sh.getRange(sh.getLastRow() + 1, 1, 1, 6).setNumberFormat('@').setValues([[new Date().toISOString(), String(to || '').slice(0, 100), text, 'pending', id, String(from || 'dashboard').slice(0, 40)]]);
  if (learnQuestion) learnAnswer(book, learnQuestion, text, to);
  return { ok: true, id: id };
}
function learnAnswer(book, question, answer, to) {
  const sh = book.getSheetByName('Attendee Replies');
  if (!sh) return;
  question = String(question).trim().slice(0, 300);
  // the attendee's first name → {Name}, so the answer fits anyone
  const first = String(to || '').trim().split(/\s+/)[0];
  if (first && first.length > 2) answer = answer.split(first).join('{Name}');
  sh.getRange(sh.getLastRow() + 1, 1, 1, 2).setNumberFormat('@').setValues([['Asked: "' + question + '" (answered by the team)', answer]]);
}

// ---- Automatic start (GitHub's own schedule never fired for this repo, so this sheet starts the agent) ----
// Run installAutoStart ONCE from the editor (select it at the top → ▶ Run). It sets up:
//   a check every 5 min that starts the agent at each slot's "Start agent at" time · every 6 h → Zoom keep-alive.
// Each slot's tab, mode, Zoom account, start time and on/off live in the "Auto Schedule" tab – the dashboard's
// "Save as auto launch" button writes them there (or edit the tab by hand). Running it again replaces the timers.
const AUTO_TAB = 'Auto Schedule';
const AUTO_HEADER = ['Slot', 'When', 'Tab to read', 'Mode (dry / timed / full)', 'On (yes / no)', 'Start agent at', 'Zoom account', 'Saved'];
const AUTO_DEFAULTS = {
  evening: ['evening', 'Every day · 7:30 PM webinar', 'Variant 4 – 7:30 PM', 'full', 'yes', '6:50 PM', 'auto', ''],
  morning: ['morning', 'Sunday · 11 AM webinar', '', 'full', 'yes', '10:20 AM', 'auto', ''],
};
function installAutoStart() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (['autoStartEvening', 'autoStartMorning', 'autoTick', 'keepZoomAlive'].indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('autoTick').timeBased().everyMinutes(5).create();
  ScriptApp.newTrigger('keepZoomAlive').timeBased().everyHours(6).create();
  const rows = autoRows(SpreadsheetApp.getActive());
  Logger.log('Automatic start is on ✓ – ' + rows.map(function (r) { return r.slot + ': ' + (r.on ? r.tab + ' · ' + r.mode + ' · agent starts ' + r.start : 'off'); }).join(' | '));
}
// "Auto Schedule" tab → [{ slot, days, tab, mode, on, start, account, row }] (creates / upgrades the tab if needed)
function autoRows(ss) {
  let sh = ss.getSheetByName(AUTO_TAB);
  if (!sh) {
    sh = ss.insertSheet(AUTO_TAB);
    sh.getRange(1, 1, 3, AUTO_HEADER.length).setNumberFormat('@').setValues([AUTO_HEADER, AUTO_DEFAULTS.evening, AUTO_DEFAULTS.morning]);
    sh.setFrozenRows(1);
  }
  if (sh.getRange(1, 6).getDisplayValue() !== AUTO_HEADER[5]) { // older 5-column tab → add start time + account
    sh.getRange(1, 1, 1, AUTO_HEADER.length).setValues([AUTO_HEADER]);
    const n = Math.max(0, sh.getLastRow() - 1);
    if (n) {
      const v = sh.getRange(2, 1, n, 1).getDisplayValues();
      v.forEach(function (r, i) {
        const d = AUTO_DEFAULTS[String(r[0]).trim().toLowerCase()];
        if (d) sh.getRange(i + 2, 2).setValue(d[1]), sh.getRange(i + 2, 6, 1, 2).setNumberFormat('@').setValues([[d[5], d[6]]]);
      });
    }
  }
  const n = Math.max(0, sh.getLastRow() - 1);
  const v = n ? sh.getRange(2, 1, n, AUTO_HEADER.length).getDisplayValues() : [];
  return v.filter(function (r) { return String(r[0]).trim(); }).map(function (r, i) {
    const slot = String(r[0]).trim().toLowerCase();
    return {
      slot: slot, when: r[1], tab: String(r[2]).trim(), mode: (['dry', 'timed', 'full'].indexOf(String(r[3]).trim().toLowerCase()) >= 0 ? String(r[3]).trim().toLowerCase() : 'full'),
      on: !/^(no|off|false|0)$/i.test(String(r[4] || 'yes').trim()), start: String(r[5] || (AUTO_DEFAULTS[slot] || [])[5] || '').trim(),
      account: (['auto', 'marketing', 'arman'].indexOf(String(r[6]).trim()) >= 0 ? String(r[6]).trim() : 'auto'), saved: r[7], row: i + 2,
    };
  });
}
// "6:50 PM" / "18:50" → minutes after midnight (or -1)
function clockMin(t) {
  const m = String(t || '').trim().match(/^(\d{1,2})[:.](\d{2})\s*(am|pm)?$/i);
  if (!m) return -1;
  let h = Number(m[1]) % 12; if (!m[3]) h = Number(m[1]); else if (/pm/i.test(m[3])) h += 12;
  return h * 60 + Number(m[2]);
}
// Every 5 min: starts a slot's run once, in the 30 min after its "Start agent at" time (morning = Sundays only).
function autoTick() {
  const ss = SpreadsheetApp.getActive();
  const now = new Date();
  const today = Utilities.formatDate(now, 'Asia/Kolkata', 'yyyy-MM-dd');
  const nowMin = Number(Utilities.formatDate(now, 'Asia/Kolkata', 'H')) * 60 + Number(Utilities.formatDate(now, 'Asia/Kolkata', 'm'));
  const sunday = Utilities.formatDate(now, 'Asia/Kolkata', 'u') === '7';
  const props = PropertiesService.getScriptProperties();
  autoRows(ss).forEach(function (r) {
    if (!r.on || !r.tab) return;
    if (r.slot === 'morning' && !sunday) return;
    const at = clockMin(r.start);
    if (at < 0 || nowMin < at || nowMin > at + 30) return;
    const doneKey = 'AUTO_DONE_' + r.slot;
    if (props.getProperty(doneKey) === today) return;
    if (autoStart(r)) props.setProperty(doneKey, today); // once per slot per day (also when someone launched by hand); a failed start retries in 5 min
  });
}
function autoStart(r) {
  // never two agents at once: skip if a webinar run is already queued or running (e.g. launched by hand)
  for (const status of ['in_progress', 'queued']) {
    const x = github('GET', '/repos/' + REPO + '/actions/workflows/webinar-agent.yml/runs?status=' + status + '&per_page=1');
    if (x.status === 200 && x.data && x.data.total_count > 0) { Logger.log('A webinar run is already ' + status + ' – not starting another'); return true; }
  }
  const res = github('POST', '/repos/' + REPO + '/actions/workflows/webinar-agent.yml/dispatches', JSON.stringify({
    ref: 'main',
    inputs: { webinar: 'business', zoom_account: r.account, tab: r.tab, mode: r.mode },
  }));
  Logger.log('Automatic ' + r.slot + ' run (' + r.tab + ' · ' + r.mode + '): ' + (res.status === 204 ? 'started ✓' : 'FAILED ' + res.status + ' ' + JSON.stringify(res.data)));
  if (res.status !== 204) throw new Error('Could not start the ' + r.slot + ' webinar run: ' + res.status); // Google emails you
  return true;
}
// Dashboard: read / save the auto-launch settings
function autoGet(ss) {
  const timers = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'autoTick'; });
  return { ok: true, timers: timers, slots: autoRows(ss).map(function (r) { delete r.row; return r; }) };
}
function autoSave(ss, p) {
  const slot = String(p.slot || '').trim().toLowerCase();
  if (!/^[a-z0-9-]{2,20}$/.test(slot)) return { error: 'Bad slot' };
  const rows = autoRows(ss);
  const sh = ss.getSheetByName(AUTO_TAB);
  let r = rows.filter(function (x) { return x.slot === slot; })[0];
  const d = AUTO_DEFAULTS[slot] || [slot, '', '', 'full', 'yes', '', 'auto', ''];
  const row = r ? r.row : sh.getLastRow() + 1;
  const cur = r ? [slot, r.when, r.tab, r.mode, r.on ? 'yes' : 'no', r.start, r.account] : d.slice(0, 7);
  if (p.tab !== undefined) cur[2] = String(p.tab).slice(0, 100);
  if (p.mode !== undefined) { if (['dry', 'timed', 'full'].indexOf(p.mode) < 0) return { error: 'Bad mode' }; cur[3] = p.mode; }
  if (p.on !== undefined) cur[4] = p.on === 'yes' ? 'yes' : 'no';
  if (p.start !== undefined) { if (clockMin(p.start) < 0) return { error: 'Bad start time – use e.g. 6:50 PM' }; cur[5] = String(p.start).trim(); }
  if (p.account !== undefined) { if (['auto', 'marketing', 'arman'].indexOf(p.account) < 0) return { error: 'Bad account' }; cur[6] = p.account; }
  cur.push(Utilities.formatDate(new Date(), 'Asia/Kolkata', 'd MMM h:mm a') + (p.by ? ' · ' + String(p.by).slice(0, 30) : ''));
  sh.getRange(row, 1, 1, AUTO_HEADER.length).setNumberFormat('@').setValues([cur]);
  // a slot saved again for today (e.g. a new start time) may still run today
  if (clockMin(cur[5]) > Number(Utilities.formatDate(new Date(), 'Asia/Kolkata', 'H')) * 60 + Number(Utilities.formatDate(new Date(), 'Asia/Kolkata', 'm'))) PropertiesService.getScriptProperties().deleteProperty('AUTO_DONE_' + slot);
  return autoGet(ss);
}
function keepZoomAlive() {
  github('POST', '/repos/' + REPO + '/actions/workflows/session-check.yml/dispatches', JSON.stringify({ ref: 'main' }));
}

// ---- GitHub, on the dashboard's behalf (token stays in Script properties) ----
function githubToken() {
  return PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN') || '';
}
// Only this repo's Actions endpoints (+ the repo itself) can be reached.
function github(method, path, body) {
  method = String(method || 'GET').toUpperCase();
  path = String(path || '');
  const base = '/repos/' + REPO;
  const okPath = path === base || path.indexOf(base + '/actions/') === 0;
  if (!okPath || ['GET', 'POST'].indexOf(method) < 0) return { status: 403, data: { message: 'Not allowed: ' + method + ' ' + path } };
  const token = githubToken();
  if (!token) return { status: 401, data: { message: 'GITHUB_TOKEN is not set in the Apps Script project properties' } };
  const opts = {
    method: method.toLowerCase(),
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    muteHttpExceptions: true,
  };
  if (body) { opts.payload = body; opts.contentType = 'application/json'; }
  const res = UrlFetchApp.fetch('https://api.github.com' + path, opts);
  const text = res.getContentText();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = { message: text.slice(0, 300) }; }
  return { status: res.getResponseCode(), data: data };
}

function out(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
