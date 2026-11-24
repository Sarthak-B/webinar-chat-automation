// Turns a variant tab ("Variant 3 – 11 AM" etc.) into a list of timed chat rows.
// Uses the Host Time column (B), which the sheet already calculates from the yellow cells.

// "10:45:00 am" / "2:01:47 pm" / "11:00:00" -> Date on `baseDate` (local time zone)
export function parseClock(str, baseDate = new Date()) {
  const m = String(str || '').trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]\.?m\.?)?$/i);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  const s = Number(m[3] || 0);
  const ap = (m[4] || '').toLowerCase().replace(/\./g, '');
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  const d = new Date(baseDate);
  d.setHours(h, min, s, 0);
  return d;
}

// rows: 2D array from the Sheets API (FORMATTED_VALUE)
export function parseSchedule(rows, baseDate = new Date()) {
  const headerIdx = rows.findIndex((r) => String(r[0] || '').trim().toLowerCase() === 'video time');
  if (headerIdx === -1) throw new Error('Could not find the "Video Time" header row in the schedule tab');

  const items = [];
  let prev = null;
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const [video = '', host = '', chat = '', type = ''] = rows[i].map((c) => String(c ?? ''));
    if (!chat.trim()) continue;
    let at = parseClock(host, baseDate);
    if (!at) continue;
    // Sessions that cross midnight: keep times moving forward.
    if (prev && at < prev - 60 * 60 * 1000) at = new Date(at.getTime() + 24 * 60 * 60 * 1000);
    prev = at;
    items.push({
      row: i + 1, // 1-based sheet row
      video: video.trim(),
      host: host.trim(),
      at,
      text: chat.replace(/\r\n/g, '\n').trim(),
      type: type.trim(),
      key: `${host.trim()}|${chat.trim()}`,
    });
  }
  return items.sort((a, b) => a.at - b.at);
}

// "Attendee Replies" tab -> [{ when, reply }]
export function parseReplies(rows) {
  const out = [];
  let started = false;
  for (const r of rows) {
    const a = String(r[0] || '').trim();
    const b = String(r[1] || '').trim();
    if (!started) {
      if (/when the attendee says/i.test(a)) started = true;
      continue;
    }
    if (!a || !b || /^operator tip/i.test(a)) continue;
    out.push({ when: a, reply: b });
  }
  return out;
}

// "Objection Handling" tab -> [{ key, objection, chat }]
export function parseObjections(rows) {
  const out = [];
  let started = false;
  for (const r of rows) {
    const a = String(r[0] || '').trim();
    const b = String(r[1] || '').trim();
    if (!started) {
      if (/^objection$/i.test(a)) started = true;
      continue;
    }
    if (!a || !b) continue;
    out.push({ key: `obj${out.length + 1}`, objection: a, chat: b });
  }
  return out;
}

// "Number Drop Bank" tab -> [{ angle, line }] — lines the agent uses to ask attendees for their number privately.
// The "Social proof" lines need real names of others, so they're left out.
export function parseNumberBank(rows) {
  const out = [];
  let started = false;
  for (const r of rows) {
    const a = String(r[0] || '').trim();
    const b = String(r[1] || '').trim();
    if (!started) {
      if (/^angle$/i.test(a)) started = true;
      continue;
    }
    if (/^operator tips?$/i.test(a)) break;
    if (!a || !b || /social proof/i.test(a) || /\{Name\}/.test(b)) continue;
    out.push({ angle: a, line: b });
  }
  return out;
}

// ---------- pricing lock ----------
// Session start = the tab's top-left cell ("11:00:00 am" / "7:30:00 pm" / "11:00:00").
export function parseSessionStart(rows, baseDate = new Date()) {
  return parseClock(String(rows?.[0]?.[0] ?? '').trim(), baseDate);
}
const MONEY = /₹\s?\d|\$\s?\d|\brs\.?\s?\d|\binr\s?\d|\b\d[\d,.]*\s?(rupees|rupaye|lakh|lac|k)\b/i;
const CHECKOUT = /get\?id=|reserve2k|\/checkout|\benrol(l)?\s*(here|now)\b/i;
// Timed chats that are part of the price pitch: "Price" rows, money in a "Pitch" row, or checkout links.
// ("Proof" rows with result numbers like "₹8,435 >> ₹12 Lakh" are not pricing.)
export function isPricingChat(item) {
  return /^price$/i.test(item.type) || (/^pitch$/i.test(item.type) && MONEY.test(item.text)) || CHECKOUT.test(item.text);
}

// ---------- 15 Days First Sale Challenge sheet ----------
// One tab per day ("Day 0 Chats", "Day 2 Chats" …). Columns (found by header name):
//   time (hours) | Minute | Second | Name | Role | Messege | Mode
// The time is counted from the session start (e.g. 7:00 PM). Only rows whose Mode is "Chat" (or empty)
// are posted; other modes (Poll, Q&A …) are left out.
export const isDayTab = (t) => /\bday\s*\d+/i.test(String(t));
export const dayNumber = (t) => Number((String(t).match(/\bday\s*(\d+)/i) || [])[1] ?? NaN);

// "7 PM" / "7:00 PM" / "19:00" → today's Date
export function startDate(clock, baseDate = new Date()) {
  const t = String(clock).trim().replace(/^(\d{1,2})\s*([ap]m)$/i, '$1:00 $2');
  return parseClock(t, baseDate);
}

export function parseFifteen(rows, startClock = '7:00 PM', baseDate = new Date()) {
  const norm = (c) => String(c ?? '').trim().toLowerCase();
  const h = rows.findIndex((r) => r.some((c) => norm(c) === 'minute') && r.some((c) => /^mess?[ae]ge?s?$|^message$|^chat$/i.test(norm(c))));
  if (h === -1) throw new Error('Could not find the header row (time | Minute | Second | … | Messege | Mode) in this day tab');
  const head = rows[h].map(norm);
  const col = (re) => head.findIndex((c) => re.test(c));
  const cH = col(/^(time|hour|hours|hr)$/), cM = col(/^minutes?$/), cS = col(/^seconds?$/);
  const cMsg = col(/^mess?[ae]ge?s?$|^message$|^chat$/), cMode = col(/^mode$/), cName = col(/^name$/);
  const start = startDate(startClock, baseDate);
  if (!start) throw new Error(`Bad start time "${startClock}"`);
  const num = (r, c) => (c < 0 ? 0 : Number(String(r[c] ?? '').replace(/[^\d.]/g, '')) || 0);
  const items = [];
  let skipped = 0;
  for (let i = h + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const text = String(r[cMsg] ?? '').replace(/\r\n/g, '\n').trim();
    if (!text) continue;
    const mode = cMode < 0 ? '' : norm(r[cMode]);
    if (mode && mode !== 'chat') {
      skipped++;
      continue;
    }
    const offset = num(r, cH) * 3600 + num(r, cM) * 60 + num(r, cS);
    const at = new Date(start.getTime() + offset * 1000);
    const hh = Math.floor(offset / 3600), mm = Math.floor((offset % 3600) / 60), ss = offset % 60;
    const video = `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
    const host = at.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });
    items.push({ row: i + 1, video, host, at, text, type: mode || 'chat', who: String(r[cName] ?? '').trim(), key: `${video}|${text}` });
  }
  items.skipped = skipped;
  return items.sort((a, b) => a.at - b.at);
}
