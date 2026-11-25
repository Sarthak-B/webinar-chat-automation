// Keep-alive: opens Zoom with the saved login. If it has expired and the account's email + password are set,
// signs in again and saves the fresh login – so the webinar agent starts already logged in.
// Exit 0 = logged in (session file refreshed), exit 1 = logged out and could not sign in.
import { Zoom } from '../src/zoom.js';

const file = process.env.ZOOM_SESSION_FILE || 'zoom-session.json';
const email = process.env.ZOOM_EMAIL || '';
const password = process.env.ZOOM_PASSWORD || '';
const mask = (e) => String(e || '').replace(/^(.{2}).*(@.*)$/, '$1***$2');
const zoom = new Zoom({ sessionFile: file, agentName: 'keep-alive', headless: false, dryRun: true });
let ok = false;
try {
  await zoom.launch();
  ok = await zoom.isLoggedIn().catch(() => false);
  if (ok) {
    const me = await zoom.whoAmI().catch(() => '');
    // logged in, but as the wrong account → sign out and use the right one
    if (email && me && me.toLowerCase() !== email.toLowerCase()) {
      console.log(`Saved login is ${mask(me)}, not ${mask(email)} – switching`);
      await zoom.signOut().catch(() => {});
      ok = false;
    } else console.log(`Logged in as ${mask(me) || 'unknown account'}`);
  }
  if (!ok && email && password) {
    console.log(`Saved login has expired – signing in again as ${mask(email)}…`);
    const r = await zoom.login(email, password);
    ok = r.ok && (await zoom.isLoggedIn().catch(() => false));
    console.log(ok ? '✓ Signed in again' : `✗ Could not sign in: ${r.reason || 'still logged out'}`);
  }
  if (ok) await zoom.saveSession();
} catch (e) {
  console.error('check failed:', e.message);
}
await zoom.close();
console.log(ok ? '✓ Zoom session is logged in (saved)' : '✗ Zoom session is LOGGED OUT – run scripts/refresh-session.sh on the Mac');
process.exit(ok ? 0 : 1);
