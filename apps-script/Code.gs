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
    if (p.action === 'gh') return out(github(p.method, p.path, p.body));
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
