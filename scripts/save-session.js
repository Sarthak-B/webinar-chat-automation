// Run this on your own laptop:  npm run save-session
// A browser opens → log into the Zoom account yourself (incl. OTP/2FA) → come back here and press Enter.
// It writes zoom-session.json plus zoom-session.b64 (compressed, ready to paste into the GitHub secret).
import fs from 'node:fs';
import zlib from 'node:zlib';
import readline from 'node:readline/promises';
import { chromium } from 'playwright';
import { proxyFromEnv } from '../src/proxy.js';

const out = process.argv[2] || 'zoom-session.json';
const browser = await chromium.launch({ headless: false, proxy: proxyFromEnv() });
const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: 'en-US' });
const page = await context.newPage();
await page.goto('https://zoom.us/signin');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
await rl.question('\nLog into Zoom in the browser window. When you can see your Zoom profile page, press Enter here… ');
rl.close();

await page.goto('https://zoom.us/profile', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
if (/signin|login/i.test(page.url())) {
  console.error('\n✗ Still not logged in. Run the script again and finish the login first.');
  await browser.close();
  process.exit(1);
}

await context.storageState({ path: out });
await browser.close();

const b64 = zlib.gzipSync(fs.readFileSync(out)).toString('base64');
fs.writeFileSync('zoom-session.b64', b64);
console.log(`\n✓ Saved ${out} and zoom-session.b64 (${(b64.length / 1024).toFixed(1)} KB, GitHub limit is 48 KB)`);
console.log('\nPut it in the repo secret ZOOM_SESSION_B64:');
console.log('  gh secret set ZOOM_SESSION_B64 < zoom-session.b64');
console.log('  (or open zoom-session.b64, copy everything, paste it in GitHub → Settings → Secrets → Actions)');
console.log('\nThen DELETE zoom-session.json and zoom-session.b64 from this laptop – they work like your Zoom password.');
