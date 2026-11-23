import { google } from 'googleapis';

export class Sheet {
  constructor({ sheetId, googleCreds }) {
    const credentials = JSON.parse(googleCreds);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    this.api = google.sheets({ version: 'v4', auth });
    this.id = sheetId;
    this.ready = new Set();
  }

  async read(tab, range = 'A1:F600') {
    const res = await this.api.spreadsheets.values.get({
      spreadsheetId: this.id,
      range: `'${tab}'!${range}`,
      valueRenderOption: 'FORMATTED_VALUE',
    });
    return res.data.values || [];
  }

  // All tabs that look like a chat schedule (have a "Video Time" header row).
  async listScheduleTabs() {
    const meta = await this.api.spreadsheets.get({ spreadsheetId: this.id, fields: 'sheets.properties.title' });
    const titles = meta.data.sheets.map((s) => s.properties.title);
    const res = await this.api.spreadsheets.values.batchGet({
      spreadsheetId: this.id,
      ranges: titles.map((t) => `'${t}'!A1:A8`),
    });
    return titles.filter((t, i) =>
      (res.data.valueRanges[i].values || []).some((r) => String(r[0] || '').trim().toLowerCase() === 'video time'),
    );
  }

  // Creates the tab with a header row if it doesn't exist yet. Never touches existing tabs.
  async ensureTab(tab, header) {
    if (this.ready.has(tab)) return;
    const meta = await this.api.spreadsheets.get({ spreadsheetId: this.id, fields: 'sheets.properties.title' });
    const exists = meta.data.sheets.some((s) => s.properties.title === tab);
    if (!exists) {
      await this.api.spreadsheets.batchUpdate({
        spreadsheetId: this.id,
        requestBody: { requests: [{ addSheet: { properties: { title: tab } } }] },
      });
      await this.append(tab, [header], true);
    }
    this.ready.add(tab);
  }

  // Appends one row and returns its 1-based row number (so it can be updated later).
  async appendRow(tab, row) {
    const res = await this.api.spreadsheets.values.append({
      spreadsheetId: this.id,
      range: `'${tab}'!A1`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [row] },
    });
    const m = String(res.data.updates?.updatedRange || '').match(/!A(\d+)/);
    return m ? Number(m[1]) : null;
  }

  async updateRow(tab, rowNumber, row) {
    await this.api.spreadsheets.values.update({
      spreadsheetId: this.id,
      range: `'${tab}'!A${rowNumber}`,
      valueInputOption: 'RAW',
      requestBody: { values: [row] },
    });
  }

  async append(tab, rows, skipEnsure = false) {
    if (!skipEnsure && !this.ready.has(tab)) throw new Error(`ensureTab(${tab}) first`);
    await this.api.spreadsheets.values.append({
      spreadsheetId: this.id,
      range: `'${tab}'!A1`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: rows },
    });
  }
}

// Buffers log rows and writes them in batches so we stay well under Sheets API quotas.
export class SheetLogger {
  constructor(sheet, tab, header) {
    this.sheet = sheet;
    this.tab = tab;
    this.header = header;
    this.buf = [];
    this.timer = null;
  }
  async init() {
    await this.sheet.ensureTab(this.tab, this.header);
    this.timer = setInterval(() => this.flush().catch((e) => console.error('[sheet log]', e.message)), 10_000);
  }
  add(row) {
    this.buf.push(row);
  }
  async flush() {
    if (!this.buf.length) return;
    const rows = this.buf.splice(0);
    try {
      await this.sheet.append(this.tab, rows);
    } catch (e) {
      this.buf.unshift(...rows); // retry next time
      throw e;
    }
  }
  async close() {
    clearInterval(this.timer);
    await this.flush().catch((e) => console.error('[sheet log] final flush failed', e.message));
  }
}
