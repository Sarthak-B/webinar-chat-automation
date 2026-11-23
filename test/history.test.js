// Checks the Webinar History maths without touching Google Sheets.
import assert from 'node:assert/strict';
import { History, SUMMARY_HEADER, QA_HEADER } from '../src/history.js';

const cfg = { sheetId: 'x', googleCreds: '{}', scheduleTab: 'Variant 3 – 11 AM', slot: '11am', mode: 'full', dryRun: false, autoReply: true, runUrl: '' };
const h = new History({ cfg, today: '23/11/2026', clock: () => '11:00:00 am', log: () => {} });
const qa = [];
h.qa = { add: (r) => qa.push(r) };
h.leads = { add: () => {} };

h.attendees(180); h.attendees(250); h.attendees(240);           // peak 250
['A', 'B', 'C', 'D', 'E'].forEach((n) => h.chatter(n));          // 5 chatted
h.lead('A', '9876543210', 'hi'); h.lead('Z', '9123456780', '');  // 2 numbers (1 from a chatter)
h.lead('A', '9876543210', 'again');                              // duplicate ignored
h.question(); h.question(); h.question();
h.qaRow({ name: 'A', lang: 'english', question: 'price?', reply: '$447…', status: 'Answered' });
h.qaRow({ name: 'B', lang: 'hindi', question: 'login?', reply: '…', status: 'Needs team' });
h.timed(); h.timed();

const row = Object.fromEntries(SUMMARY_HEADER.map((k, i) => [k, h.summaryRow('Completed')[i]]));
assert.equal(row['Attendees (peak)'], 250);
assert.equal(row['People who chatted'], 5);
assert.equal(row['Engagement %'], '2%');
assert.equal(row['Numbers captured'], 2);
assert.equal(row['Live lead %'], '0.8%');
assert.equal(row['Numbers from chatters %'], '20%');
assert.equal(row['Questions asked'], 3);
assert.equal(row.Answered, 1);
assert.equal(row['Needs team'], 1);
assert.equal(row['Timed chats sent'], 2);
assert.equal(qa.length, 2);
assert.equal(qa[0][QA_HEADER.indexOf('Question')], 'price?');
assert.equal(qa[0][QA_HEADER.indexOf('Status')], 'Answered');
console.log('✓ history tests passed');
