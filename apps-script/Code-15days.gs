/**
 * 15 Days First Sale Challenge – dashboard backend for the "15 Days Challenge Chats" sheet.
 * (Separate from the 10 Min Business script: this one only lists the Day tabs and their timed chats.)
 *
 * Setup (once):
 *  1. Open the 15 Days Challenge Chats sheet → Extensions → Apps Script → delete everything → paste this.
 *  2. Set KEY below to the SAME team password as the 10 Min Business script.
 *  3. Deploy → New deployment → ⚙ Web app → Execute as: Me · Who has access: Anyone → Deploy → Authorize.
 *  4. Copy the Web app URL (…/exec) into the dashboard: Settings → "15 Days Apps Script URL" (and the loader).
 *
 * Day tabs ("Day 0 Chats", "Day 2 Chats" …): time (hours) | Minute | Second | Name | Role | Messege | Mode
 * Times count from START. Only Mode = Chat (or empty) rows are listed – the same rows the agent posts.
 */
const KEY = 'CHANGE-ME-to-the-team-password';
const START = '7:00 PM';

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.key !== KEY) return out({ error: 'Wrong key' });
  const ss = SpreadsheetApp.getActive();
  try {
    if (p.action === 'tabs') {
      const tabs = ss.getSheets()
        .filter(function (sh) { return /\bday\s*\d+/i.test(sh.getName()); })
        .map(describeDay)
        .sort(function (a, b) { return a.day - b.day; });
      return out({ title: ss.getName(), tabs: tabs });
    }
    if (p.action === 'schedule') {
      const sh = ss.getSheetByName(p.tab);
      if (!sh) return out({ error: 'Tab not found: ' + p.tab });
      return out({ tab: p.tab, start: '', items: dayItems(sh) });
    }
    if (p.action === 'whoami') return out({ ok: true, sheet: ss.getName() });
    return out({ error: 'Unknown action' });
  } catch (err) {
    return out({ error: String(err) });
  }
}

// One day tab → [[video time, host time, chat, mode], …] sorted by time (same shape as the business tabs)
function dayItems(sh) {
  const n = Math.max(1, Math.min(sh.getLastRow(), 800));
  const v = sh.getRange(1, 1, n, Math.max(1, Math.min(sh.getLastColumn(), 10))).getDisplayValues();
  const norm = function (c) { return String(c || '').trim().toLowerCase(); };
  let h = -1;
  for (let i = 0; i < v.length && h < 0; i++) if (v[i].some(function (c) { return norm(c) === 'minute'; })) h = i;
  if (h < 0) return [];
  const head = v[h].map(norm);
  const col = function (re) { for (let i = 0; i < head.length; i++) if (re.test(head[i])) return i; return -1; };
  const cH = col(/^(time|hour|hours|hr)$/), cM = col(/^minutes?$/), cS = col(/^seconds?$/);
  const cMsg = col(/^mess?[ae]ge?s?$|^message$|^chat$/), cMode = col(/^mode$/);
  const num = function (r, c) { return c < 0 ? 0 : Number(String(r[c] || '').replace(/[^\d.]/g, '')) || 0; };
  const m = START.match(/(\d{1,2})(?::(\d\d))?\s*([ap]m)?/i);
  const base = (Number(m[1]) % 12 + (/pm/i.test(m[3] || '') ? 12 : 0)) * 3600 + Number(m[2] || 0) * 60;
  const rows = [];
  for (let i = h + 1; i < v.length; i++) {
    const r = v[i], text = String(r[cMsg] || '').trim(), mode = cMode < 0 ? '' : norm(r[cMode]);
    if (!text || (mode && mode !== 'chat')) continue;
    const off = num(r, cH) * 3600 + num(r, cM) * 60 + num(r, cS), t = base + off;
    const hh = Math.floor(t / 3600) % 24, mm = Math.floor((t % 3600) / 60), ss = t % 60;
    const host = ((hh % 12) || 12) + ':' + ('0' + mm).slice(-2) + ':' + ('0' + ss).slice(-2) + (hh >= 12 ? ' pm' : ' am');
    const video = Math.floor(off / 3600) + ':' + ('0' + Math.floor((off % 3600) / 60)).slice(-2) + ':' + ('0' + (off % 60)).slice(-2);
    rows.push([video, host, text, mode || 'chat', off]);
  }
  rows.sort(function (a, b) { return a[4] - b[4]; });
  return rows.map(function (r) { return r.slice(0, 4); });
}

function describeDay(sh) {
  const items = dayItems(sh);
  return {
    name: sh.getName(),
    schedule: true,
    day: Number((sh.getName().match(/day\s*(\d+)/i) || [])[1]),
    count: items.length,
    start: '',
    first: items.length ? items[0][1] : '',
    last: items.length ? items[items.length - 1][1] : '',
  };
}

function out(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
