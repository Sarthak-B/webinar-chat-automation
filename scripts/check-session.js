// Opens zoom.us with the saved session and checks it's still logged in.
// Exit 0 = logged in (and the session file is refreshed), exit 1 = logged out.
import { chromium } from 'playwright';

const file = process.env.ZOOM_SESSION_FILE || 'zoom-session.json';
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ storageState: file, locale: 'en-US' });
const page = await context.newPage();
let ok = false;
try {
  await page.goto('https://zoom.us/profile', { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForTimeout(3000);
  ok = !/signin|login/i.test(page.url());
  if (ok) {
    const t = (await page.locator('body').innerText().catch(() => '')) || '';
    const email = (t.match(/[\w.+-]+@[\w-]+\.[\w.]+/) || [''])[0];
    console.log(`Logged in as ${email.replace(/^(.{2}).*(@.*)$/, '$1***$2') || 'unknown account'}`);
    await context.storageState({ path: file });
  }
} catch (e) {
  console.error('check failed:', e.message);
}
await browser.close();
console.log(ok ? '✓ Zoom session is logged in' : '✗ Zoom session is LOGGED OUT – run "npm run save-session" and update ZOOM_SESSION_B64');
process.exit(ok ? 0 : 1);
