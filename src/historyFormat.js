// Look of the Webinar History sheet. Used by the agent after every webinar, so every tab always looks the same.
//   Summary  – every webinar, one row each (the dashboard's History page reads this tab)
//   Q&A      – every question from every webinar (the dashboard reads this tab)
//   one tab per webinar, e.g. "24 Nov · Variant 4 – 7.30 PM": at-a-glance numbers + that webinar's Q&A
// The functions return Google Sheets batchUpdate requests (no API calls here).

const hex = (h) => {
  const n = parseInt(h.replace('#', ''), 16);
  return { red: ((n >> 16) & 255) / 255, green: ((n >> 8) & 255) / 255, blue: (n & 255) / 255 };
};
export const C = {
  ink: '#111827', // header background
  white: '#FFFFFF',
  lime: '#D9F26B', // brand accent (same as the dashboard)
  limeSoft: '#F4FBD5',
  band: '#F7F8FA',
  line: '#E5E7EB',
  muted: '#6B7280',
  greenBg: '#DCFCE7',
  greenTx: '#166534',
  amberBg: '#FEF3C7',
  amberTx: '#92400E',
  greyBg: '#F3F4F6',
  greyTx: '#4B5563',
  redBg: '#FEE2E2',
  redTx: '#991B1B',
  blueTx: '#1D4ED8',
};

// r2 = null → to the bottom of the tab, so rows added later get the same look
const range = (sheetId, r1, r2, c1, c2) => ({ sheetId, startRowIndex: r1, ...(r2 == null ? {} : { endRowIndex: r2 }), startColumnIndex: c1, endColumnIndex: c2 });
const fmt = (sheetId, rng, format, fields) => ({
  repeatCell: { range: rng, cell: { userEnteredFormat: format }, fields: fields.split(',').map((f) => `userEnteredFormat.${f}`).join(',') },
});
const width = (sheetId, col, px) => ({
  updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: col, endIndex: col + 1 }, properties: { pixelSize: px }, fields: 'pixelSize' },
});
const rowHeight = (sheetId, r1, r2, px) => ({
  updateDimensionProperties: { range: { sheetId, dimension: 'ROWS', startIndex: r1, endIndex: r2 }, properties: { pixelSize: px }, fields: 'pixelSize' },
});
const text = (o = {}) => ({ fontFamily: 'Inter', fontSize: 10, ...o, ...(o.color ? { foregroundColorStyle: { rgbColor: hex(o.color) } } : {}), color: undefined });
const clean = (o) => JSON.parse(JSON.stringify(o)); // drops undefined
const bg = (h) => ({ backgroundColorStyle: { rgbColor: hex(h) } });
const border = (h = C.line) => ({ style: 'SOLID', width: 1, colorStyle: { rgbColor: hex(h) } });
const textIs = (sheetId, rng, value, bgc, tx, bold = true) => ({
  addConditionalFormatRule: {
    rule: {
      ranges: [rng],
      booleanRule: { condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: value }] }, format: { ...bg(bgc), textFormat: { bold, foregroundColorStyle: { rgbColor: hex(tx) } } } },
    },
  },
});
const formula = (sheetId, rng, f, bgc, tx, bold = false) => ({
  addConditionalFormatRule: {
    rule: { ranges: [rng], booleanRule: { condition: { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: f }] }, format: { ...bg(bgc), textFormat: { bold, foregroundColorStyle: { rgbColor: hex(tx) } } } } },
  },
});
const header = (sheetId, cols) =>
  clean(
    fmt(sheetId, range(sheetId, 0, 1, 0, cols), { ...bg(C.ink), textFormat: text({ bold: true, color: C.lime, fontSize: 10 }), verticalAlignment: 'MIDDLE', horizontalAlignment: 'CENTER', wrapStrategy: 'WRAP' }, 'backgroundColorStyle,textFormat,verticalAlignment,horizontalAlignment,wrapStrategy'),
  );
const body = (sheetId, cols) =>
  clean(fmt(sheetId, range(sheetId, 1, null, 0, cols), { textFormat: text({ color: C.ink }), verticalAlignment: 'TOP', wrapStrategy: 'WRAP' }, 'textFormat,verticalAlignment,wrapStrategy'));
// stripes: background only (never changes bold/colour of the text)
const stripe = (rng, f) => ({ addConditionalFormatRule: { rule: { ranges: [rng], booleanRule: { condition: { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: f }] }, format: bg(C.band) } } } });
const zebra = (sheetId, cols) => stripe(range(sheetId, 1, null, 0, cols), '=AND($A2<>"",ISEVEN(ROW()))');
const freeze = (sheetId, rows, cols = 0) => ({
  updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: rows, frozenColumnCount: cols } }, fields: 'gridProperties.frozenRowCount,gridProperties.frozenColumnCount' },
});
const tabColor = (sheetId, h) => ({ updateSheetProperties: { properties: { sheetId, tabColorStyle: { rgbColor: hex(h) } }, fields: 'tabColorStyle' } });
const numFmt = (sheetId, rng, type, pattern) => fmt(sheetId, rng, { numberFormat: { type, pattern } }, 'numberFormat');

// ---------- Summary (all webinars) ----------
// A ID · B Date · C Webinar · D Started · E Ended · F Attendees · G Live leads · H Live lead % · I Lead ratio ·
// J People who chatted · K Engagement % · L Questions asked · M Replies given
export function summaryRequests(sheetId) {
  const N = 13;
  const w = [250, 95, 190, 80, 80, 95, 95, 100, 100, 110, 110, 100, 100];
  return [
    tabColor(sheetId, C.lime),
    freeze(sheetId, 1, 1),
    rowHeight(sheetId, 0, 1, 38),
    header(sheetId, N),
    body(sheetId, N),
    ...w.map((px, i) => width(sheetId, i, px)),
    clean(fmt(sheetId, range(sheetId, 1, null, 0, 1), { textFormat: text({ bold: true, color: C.ink }) }, 'textFormat')),
    clean(fmt(sheetId, range(sheetId, 1, null, 1, N), { horizontalAlignment: 'CENTER' }, 'horizontalAlignment')),
    numFmt(sheetId, range(sheetId, 1, null, 5, 7), 'NUMBER', '#,##0'),
    numFmt(sheetId, range(sheetId, 1, null, 7, 8), 'PERCENT', '0.0%'),
    numFmt(sheetId, range(sheetId, 1, null, 9, 10), 'NUMBER', '#,##0'),
    numFmt(sheetId, range(sheetId, 1, null, 10, 11), 'PERCENT', '0.0%'),
    numFmt(sheetId, range(sheetId, 1, null, 11, 13), 'NUMBER', '#,##0'),
    // the numbers that matter most: live leads and lead % in bold green
    clean(fmt(sheetId, range(sheetId, 1, null, 6, 8), { textFormat: text({ bold: true, color: C.greenTx }) }, 'textFormat')),
    // lead % colour: ≥10% green, 5–10% amber, <5% red
    formula(sheetId, range(sheetId, 1, null, 7, 8), '=AND(ISNUMBER($H2),$H2>=0.1)', C.greenBg, C.greenTx, true),
    formula(sheetId, range(sheetId, 1, null, 7, 8), '=AND(ISNUMBER($H2),$H2>=0.05,$H2<0.1)', C.amberBg, C.amberTx, true),
    formula(sheetId, range(sheetId, 1, null, 7, 8), '=AND(ISNUMBER($H2),$H2<0.05)', C.redBg, C.redTx, true),
    // attendee count missing → amber so someone fills it in
    formula(sheetId, range(sheetId, 1, null, 5, 6), '=AND($A2<>"",$F2="")', C.amberBg, C.amberTx),
    zebra(sheetId, N), // last: colour rules above win over the stripes
    { updateBorders: { range: range(sheetId, 0, null, 0, N), innerHorizontal: border(), bottom: border() } },
  ];
}

// ---------- Q&A (all webinars) ----------
// A ID · B Date · C Time · D Question · E Reply · F Status
export function qaRequests(sheetId) {
  const N = 6;
  const w = [230, 95, 85, 400, 500, 130];
  return [
    tabColor(sheetId, '#60A5FA'),
    freeze(sheetId, 1),
    rowHeight(sheetId, 0, 1, 34),
    header(sheetId, N),
    body(sheetId, N),
    ...w.map((px, i) => width(sheetId, i, px)),
    clean(fmt(sheetId, range(sheetId, 1, null, 0, 3), { textFormat: text({ color: C.muted, fontSize: 9 }) }, 'textFormat')),
    clean(fmt(sheetId, range(sheetId, 1, null, 3, 4), { textFormat: text({ bold: true, color: C.ink }) }, 'textFormat')),
    numFmt(sheetId, range(sheetId, 1, null, 2, 3), 'TIME', 'h:mm am/pm'),
    clean(fmt(sheetId, range(sheetId, 1, null, 5, 6), { horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE' }, 'horizontalAlignment,verticalAlignment')),
    ...statusRules(sheetId, range(sheetId, 1, null, 5, 6)),
    zebra(sheetId, N),
    { updateBorders: { range: range(sheetId, 0, null, 0, N), innerHorizontal: border(), bottom: border() } },
  ];
}

const statusRules = (sheetId, rng) => [
  textIs(sheetId, rng, 'Answered', C.greenBg, C.greenTx),
  textIs(sheetId, rng, 'Number shared', '#E0E7FF', '#3730A3'),
  textIs(sheetId, rng, 'Handed to team', C.amberBg, C.amberTx),
  textIs(sheetId, rng, 'Holding reply', C.greyBg, C.greyTx),
  textIs(sheetId, rng, 'AI failed', C.redBg, C.redTx),
];

// Status of one Q&A row, from its reply
export function qaStatus(reply) {
  const r = String(reply || '').trim();
  if (!r || /^\(handed to team\)$/i.test(r)) return 'Handed to team';
  if (/^\(ai failed\)/i.test(r)) return 'AI failed';
  if (/shared with our senior mentors|forwarded to our senior mentor|forward kar diya|mentors ko bhej/i.test(r) && r.length < 200) return 'Number shared';
  if (/^([\p{L} .'-]+, )?sir will cover this in (today'?s )?(the )?session/iu.test(r)) return 'Holding reply';
  return 'Answered';
}

// ---------- one tab per webinar ----------
// Rows: 1 title · 2 subtitle · 4 "At a glance" · 5–12 numbers · 14 "Questions & replies" · 15 header · 16+ Q&A (sheet rows)
export const KPI_LABELS = ['Attendees', 'Live leads', 'Live lead %', 'Lead ratio', 'People who chatted', 'Engagement %', 'Questions asked', 'Replies given'];
export const WEBINAR_QA_HEADER = ['#', 'Time', 'Question', 'Reply', 'Status'];
export const WEBINAR_QA_START = 4 + KPI_LABELS.length + 2; // 0-based row of the Q&A header (row 15 in the sheet)

export function webinarValues({ title, subtitle, kpis, qa }) {
  const rows = [[title], [subtitle], [], ['AT A GLANCE']];
  KPI_LABELS.forEach((label, i) => rows.push([label, '', kpis[i] ?? '']));
  rows.push([], ['QUESTIONS & REPLIES'], WEBINAR_QA_HEADER);
  qa.forEach(([time, q, a], i) => rows.push([i + 1, time, q, a, qaStatus(a)]));
  return rows;
}

export function webinarRequests(sheetId, nQA) {
  const N = 5;
  const last = WEBINAR_QA_START + 1 + Math.max(nQA, 1);
  const merge = (r) => ({ mergeCells: { range: range(sheetId, r, r + 1, 0, N), mergeType: 'MERGE_ALL' } });
  const kpiRows = KPI_LABELS.map((_, i) => 4 + i);
  return [
    tabColor(sheetId, C.ink),
    { unmergeCells: { range: range(sheetId, 0, last, 0, N) } },
    merge(0),
    merge(1),
    merge(3),
    merge(WEBINAR_QA_START - 1),
    ...kpiRows.map((r) => ({ mergeCells: { range: range(sheetId, r, r + 1, 0, 2), mergeType: 'MERGE_ALL' } })),
    ...[48, 95, 430, 520, 140].map((px, i) => width(sheetId, i, px)),
    // title
    rowHeight(sheetId, 0, 1, 46),
    clean(fmt(sheetId, range(sheetId, 0, 1, 0, N), { ...bg(C.ink), textFormat: text({ bold: true, fontSize: 16, color: C.lime }), verticalAlignment: 'MIDDLE', padding: { left: 12 } }, 'backgroundColorStyle,textFormat,verticalAlignment,padding')),
    clean(fmt(sheetId, range(sheetId, 1, 2, 0, N), { ...bg(C.ink), textFormat: text({ italic: true, color: '#D1D5DB' }), verticalAlignment: 'MIDDLE', padding: { left: 12 } }, 'backgroundColorStyle,textFormat,verticalAlignment,padding')),
    rowHeight(sheetId, 1, 2, 26),
    // section labels
    ...[3, WEBINAR_QA_START - 1].map((r) =>
      clean(fmt(sheetId, range(sheetId, r, r + 1, 0, N), { ...bg(C.limeSoft), textFormat: text({ bold: true, fontSize: 9, color: '#3F6212' }), verticalAlignment: 'MIDDLE' }, 'backgroundColorStyle,textFormat,verticalAlignment')),
    ),
    // numbers: label grey, value big and bold
    clean(fmt(sheetId, range(sheetId, 4, 4 + KPI_LABELS.length, 0, 2), { textFormat: text({ color: C.muted }), verticalAlignment: 'MIDDLE' }, 'textFormat,verticalAlignment')),
    clean(fmt(sheetId, range(sheetId, 4, 4 + KPI_LABELS.length, 2, 3), { textFormat: text({ bold: true, fontSize: 13, color: C.ink }), horizontalAlignment: 'LEFT', verticalAlignment: 'MIDDLE' }, 'textFormat,horizontalAlignment,verticalAlignment')),
    clean(fmt(sheetId, range(sheetId, 5, 7, 2, 3), { textFormat: text({ bold: true, fontSize: 13, color: C.greenTx }) }, 'textFormat')), // live leads & lead %
    numFmt(sheetId, range(sheetId, 6, 7, 2, 3), 'PERCENT', '0.0%'),
    numFmt(sheetId, range(sheetId, 9, 10, 2, 3), 'PERCENT', '0.0%'),
    rowHeight(sheetId, 4, 4 + KPI_LABELS.length, 26),
    { updateBorders: { range: range(sheetId, 4, 4 + KPI_LABELS.length, 0, 3), innerHorizontal: border(), bottom: border(), top: border() } },
    formula(sheetId, range(sheetId, 4, 5, 2, 3), '=$C5=""', C.amberBg, C.amberTx),
    // Q&A table
    rowHeight(sheetId, WEBINAR_QA_START, WEBINAR_QA_START + 1, 32),
    clean(fmt(sheetId, range(sheetId, WEBINAR_QA_START, WEBINAR_QA_START + 1, 0, N), { ...bg(C.ink), textFormat: text({ bold: true, color: C.lime }), verticalAlignment: 'MIDDLE', horizontalAlignment: 'CENTER' }, 'backgroundColorStyle,textFormat,verticalAlignment,horizontalAlignment')),
    clean(fmt(sheetId, range(sheetId, WEBINAR_QA_START + 1, last, 0, N), { textFormat: text({ color: C.ink }), verticalAlignment: 'TOP', wrapStrategy: 'WRAP' }, 'textFormat,verticalAlignment,wrapStrategy')),
    clean(fmt(sheetId, range(sheetId, WEBINAR_QA_START + 1, last, 0, 2), { textFormat: text({ color: C.muted, fontSize: 9 }), horizontalAlignment: 'CENTER' }, 'textFormat,horizontalAlignment')),
    clean(fmt(sheetId, range(sheetId, WEBINAR_QA_START + 1, last, 2, 3), { textFormat: text({ bold: true, color: C.ink }) }, 'textFormat')),
    numFmt(sheetId, range(sheetId, WEBINAR_QA_START + 1, last, 1, 2), 'TIME', 'h:mm am/pm'),
    clean(fmt(sheetId, range(sheetId, WEBINAR_QA_START + 1, last, 4, 5), { horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE' }, 'horizontalAlignment,verticalAlignment')),
    ...statusRules(sheetId, range(sheetId, WEBINAR_QA_START + 1, last, 4, 5)),
    stripe(range(sheetId, WEBINAR_QA_START + 1, last, 0, 4), '=ISEVEN(ROW())'),
    { updateBorders: { range: range(sheetId, WEBINAR_QA_START, last, 0, N), innerHorizontal: border(), bottom: border() } },
    freeze(sheetId, 0),
  ];
}

// "24 Nov · Variant 4 – 7.30 PM" (Sheets tab names can't have : / \ ? * [ ])
export function webinarTabName(dateDDMMYYYY, scheduleTab) {
  const [d, m] = String(dateDDMMYYYY).split('/');
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m) - 1] || m;
  return `${Number(d)} ${mon} · ${scheduleTab}`.replace(/[:]/g, '.').replace(/[\/\\?*[\]]/g, '-').slice(0, 95);
}
