// Usage: node test/schedule.test.js <exported-sheet-file>
// The export has "## Sheet name: X" headers followed by CSV rows for each tab.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { parseSchedule, parseReplies, parseObjections, parseNumberBank, parseClock } from '../src/schedule.js';
import { findPhone, isTrivial, firstName, asksForNumber } from '../src/brain.js';
import { toWebClientUrl } from '../src/zoom.js';

function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function tabs(file) {
  const out = {};
  for (const part of fs.readFileSync(file, 'utf8').split(/^## Sheet name: /m).slice(1)) {
    const nl = part.indexOf('\n');
    out[part.slice(0, nl).trim()] = parseCsv(part.slice(nl + 1));
  }
  return out;
}

// --- unit checks ---
const base = new Date('2026-11-23T00:00:00');
assert.equal(parseClock('10:45:00 am', base).getHours(), 10);
assert.equal(parseClock('2:01:47 pm', base).getHours(), 14);
assert.equal(parseClock('12:05:00 am', base).getHours(), 0);
assert.equal(findPhone('my no is 98765 43210 pls call'), '9876543210');
assert.equal(findPhone('+91-9876543210'), '+919876543210');
assert.equal(findPhone('I earn 50000 per month'), null);
assert.ok(isTrivial('Yes'));
assert.ok(isTrivial('1'));
assert.ok(isTrivial('🔥🔥'));
assert.ok(!isTrivial('price kya hai?'));
assert.equal(firstName('rahul sharma (Mumbai)'), 'Rahul');
assert.equal(toWebClientUrl('https://us06web.zoom.us/j/81234567890?pwd=abc&tk=xyz'), 'https://app.zoom.us/wc/81234567890/join?pwd=abc&tk=xyz');

// --- the real sheet ---
const file = process.argv[2];
if (file) {
  const t = tabs(file);
  console.log('Tabs:', Object.keys(t).join(' | '));
  for (const name of Object.keys(t).filter((n) => /variant|chats/i.test(n))) {
    const s = parseSchedule(t[name], base);
    const multi = s.filter((x) => x.text.includes('\n')).length;
    console.log(`  ${name}: ${s.length} timed chats, ${s[0].host} → ${s.at(-1).host}, ${multi} multi-line`);
    for (let i = 1; i < s.length; i++) assert.ok(s[i].at >= s[i - 1].at, `${name}: times out of order at row ${s[i].row}`);
  }
  const r = parseReplies(t['Attendee Replies']);
  const o = parseObjections(t['Objection Handling']);
  console.log(`  Attendee Replies: ${r.length} templates (first: "${r[0].when}", last: "${r.at(-1).when}")`);
  console.log(`  Objection Handling: ${o.length} lines (first: "${o[0].objection}")`);
  assert.ok(r.some((x) => /shared phone number/i.test(x.when)), 'needs a "Shared phone number" template');
  const nb = parseNumberBank(t['Number Drop Bank']);
  console.log(`  Number Drop Bank: ${nb.length} private number-ask lines (social-proof lines excluded)`);
  nb.slice(0, 3).forEach((x) => console.log(`    e.g. "Rahul, ${x.line.charAt(0).toLowerCase()}${x.line.slice(1)}"`));
  assert.ok(nb.length >= 10);
  assert.ok(nb.every((x) => asksForNumber(x.line)), 'every bank line should ask for the number');
}
console.log('✓ all checks passed');
