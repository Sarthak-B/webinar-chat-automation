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
assert.equal(row['Live lead %'], 0.008); // shown as 0.8% by the sheet's format
assert.equal(row['Lead ratio'], '1 in 125');
assert.equal(row['People who chatted'], 5);
assert.equal(row['Engagement %'], 0.02);
assert.equal(row['Questions asked'], 3);
assert.equal(row['Replies given'], 2);
assert.equal(h.qa.length, 3);
assert.deepEqual(QA_HEADER, ['Webinar ID', 'Date', 'Time', 'Question', 'Reply', 'Status']);
assert.deepEqual(h.qa.map((r) => r[5]), ['Answered', 'Answered', 'Handed to team']);
assert.ok(!SUMMARY_HEADER.some((c) => /name|number$/i.test(c)), 'no names/numbers in history');
console.log('✓ history tests passed');

// formatted per-webinar tab + Summary/Q&A formatting, against a fake Google Sheets API
{
  const calls = [];
  const api = {
    spreadsheets: {
      get: async () => ({ data: { sheets: [{ properties: { sheetId: 0, title: 'Sheet1' } }, { properties: { sheetId: 1, title: 'Summary' }, conditionalFormats: [{}, {}] }, { properties: { sheetId: 2, title: 'Q&A' } }] } }),
      batchUpdate: async ({ requestBody }) => (calls.push(requestBody.requests), { data: { replies: [{ addSheet: { properties: { sheetId: 9 } } }] } }),
      values: { update: async (r) => calls.push(r.range), append: async () => {} },
    },
  };
  h.sheet = { id: 'x', api, ensureTab: async () => {}, append: async () => {} };
  const logs = [];
  h.log = (m) => logs.push(m);
  await h.write();
  assert.match(logs.at(-1), /History saved/);
  const flat = calls.flat();
  assert.ok(flat.some((r) => r.addSheet?.properties?.title?.includes('·')), 'webinar tab created');
  assert.equal(flat.filter((r) => r.deleteConditionalFormatRule).length, 2, 'old Summary colour rules removed first');
  assert.ok(flat.some((r) => r.deleteSheet?.sheetId === 0), 'empty Sheet1 removed');
  console.log('✓ history sheet formatting tests passed');
}
{
  const { webinarValues, WEBINAR_QA_START, WEBINAR_QA_HEADER } = await import('../src/historyFormat.js');
  const v = webinarValues({ title: 't', subtitle: 's', kpis: [1, 2, 3, 4, 5, 6, 7, 8], qa: [['7:00 pm', 'q', 'a']] });
  assert.deepEqual(v[WEBINAR_QA_START], WEBINAR_QA_HEADER, 'Q&A header row matches the formatting');
  assert.equal(v[WEBINAR_QA_START - 1][0], 'QUESTIONS & REPLIES');
  console.log('✓ webinar tab layout test passed');
}
