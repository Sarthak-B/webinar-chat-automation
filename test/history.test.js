// Checks the Webinar History maths without touching Google Sheets.
import assert from 'node:assert/strict';
import { History, SUMMARY_HEADER, QA_HEADER } from '../src/history.js';

const cfg = { sheetId: 'x', googleCreds: '{}', scheduleTab: 'Variant 3 – 11 AM', dryRun: false };
const h = new History({ cfg, today: '23/11/2026', clock: () => '11:00:00 am', log: () => {} });

h.attendees(180); h.attendees(250); h.attendees(240);            // peak 250
['A', 'B', 'C', 'D', 'E'].forEach((n) => h.chatter(n));           // 5 chatted
['9876543210', '9123456780', '9876543210'].forEach((p) => h.lead(p)); // 2 unique leads
h.question(); h.question(); h.question();
h.qaRow({ question: 'price?', reply: '$447…' });
h.qaRow({ question: 'login problem', reply: 'Our team will call you…' });
h.qaRow({ question: 'timed-mode question' });                    // no reply

const row = Object.fromEntries(SUMMARY_HEADER.map((k, i) => [k, h.summaryRow()[i]]));
assert.equal(row.Attendees, 250);
assert.equal(row['Live leads'], 2);
assert.equal(row['Live lead %'], '0.8%');
assert.equal(row['Lead ratio'], '1 in 125');
assert.equal(row['People who chatted'], 5);
assert.equal(row['Engagement %'], '2%');
assert.equal(row['Questions asked'], 3);
assert.equal(row['Replies given'], 2);
assert.equal(h.qa.length, 3);
assert.deepEqual(QA_HEADER, ['Webinar ID', 'Date', 'Time', 'Question', 'Reply']);
assert.ok(!SUMMARY_HEADER.some((c) => /name|number$/i.test(c)), 'no names/numbers in history');
console.log('✓ history tests passed');
