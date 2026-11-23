/**
 * Dashboard data feed for the FlexiFunnels webinar agent.
 * Setup (2 min): open the chat sheet → Extensions → Apps Script → paste this → change KEY →
 * Deploy → New deployment → Web app → Execute as: Me, Who has access: Anyone → copy the URL into the dashboard.
 * The KEY keeps strangers out, so make it long and random.
 */
const KEY = 'CHANGE-ME-to-a-long-random-key';
// The Webinar History sheet's ID (from its URL: /spreadsheets/d/THIS_PART/edit).
// Leave empty if the agent writes the Summary / Q&A tabs into this same sheet.
const HISTORY_SHEET_ID = '';

function doGet(e) {
  const p = e.parameter || {};
  if (p.key !== KEY) return out({ error: 'Wrong key' });
  const ss = SpreadsheetApp.getActive();
  try {
    if (p.action === 'tabs') return out({ title: ss.getName(), tabs: ss.getSheets().map(describe) });
    if (p.action === 'schedule') return out(schedule(ss, p.tab));
    if (p.action === 'rows') return out(rows(ss, p.tab, Number(p.from || 0)));
    if (p.action === 'history') return out(history());
    if (p.action === 'historyqa') return out(historyFor('Q&A', p.id));
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

function out(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
