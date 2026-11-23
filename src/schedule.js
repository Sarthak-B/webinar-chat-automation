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
