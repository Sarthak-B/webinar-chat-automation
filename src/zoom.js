import fs from 'node:fs';
import { chromium } from 'playwright';
import { proxyFromEnv } from './proxy.js';

// ---------------------------------------------------------------------------
// Zoom web-client selectors. Zoom changes these from time to time, so they all
// live here. Each entry is a list of fallbacks, tried in order. Check them on a
// live session with DRY_RUN=true HEADLESS=false (see README → "Checking selectors").
// ---------------------------------------------------------------------------
export const SEL = {
  nameInput: ['#input-for-name', 'input[placeholder*="name" i]'],
  joinButton: ['button.preview-join-button', 'button:has-text("Join")'],
  audioDialogClose: ['.join-dialog button[aria-label*="close" i]', 'button:has-text("Continue without audio")', 'button:has-text("Join Audio by Computer")'],
  // meeting footer Chat button (NOT the Workplace sidebar "Chat" = team chat)
  chatToggle: ['.footer-button-base__button[aria-label*="chat" i]', '.footer-button__button[aria-label*="chat" i]', 'button[aria-label*="open the chat" i]', 'button[aria-label*="chat panel" i]', '#foot-bar button:has-text("Chat")', 'footer button:has-text("Chat")'],
  // only present once you're really inside the meeting
  inMeeting: ['button[aria-label*="leave" i]', '.footer__leave-btn', 'button.footer__leave-btn-container', '#foot-bar', '.footer-button-base__button', 'button:has-text("Leave")'],
  chatPanel: ['.chat-container', '#chat-list-content', '[class*="chat-list"]'],
  // one rendered message block
  chatItem: ['.chat-item-container', '.new-chat-item__container', '[class*="chat-item"][class*="container"]', '[class*="chat-message"][class*="container"]', '[role="listitem"][class*="chat"]'],
  chatSender: ['.chat-item__sender', '.new-chat-message__sender', '[class*="chat-item__sender"]', '[class*="sender"]'],
  chatText: ['.new-chat-message__text-content', '.chat-message__text-content', '[class*="text-content"]'],
  chatReceiverLabel: ['.chat-receiver-list__receiver', '.chat-receiver-list__chat-control-receiver', '[class*="receiver"]'],
  chatInput: ['.chat-rtf-box__editor-outer [contenteditable="true"]', '.chat-box__chat-textarea', 'div[contenteditable="true"][class*="chat"]', 'textarea[class*="chat"]', '[contenteditable="true"][aria-label*="message" i]', 'textarea[placeholder*="message" i]', '[data-placeholder*="Type message" i]', '[placeholder*="Type message" i]'],
  receiverButton: ['.chat-receiver-list__receiver', 'button[aria-label*="to:" i]', '[class*="receiver"] button', 'button:has-text("Everyone")', 'button:has-text("Hosts and Panelists")', 'button[aria-label*="send to" i]', '#chatReceiverMenu', '[class*="chat-receiver"] button'],
  receiverSearch: ['.chat-receiver-list__search input', 'input[placeholder*="search" i]'],
  receiverEveryone: ['text=/^(Everyone|All panelists and attendees)$/i'],
  // the number on the footer "Participants" button (webinar attendee count, as the panelist/host sees it)
  participantCount: ['.footer-button__participants-icon .footer-button__number-counter', '.footer-button__number-counter', 'button[aria-label*="participant" i] [class*="counter"]', 'button[aria-label*="participant" i]'],
  registration: ['input[type="email"]:visible', 'input[name*="email" i]:visible', 'button:has-text("Register")'],
  meetingEnded: ['text=/meeting has been ended|webinar has ended|This meeting has ended/i'],
  // the agent is no longer really in the webinar (Zoom often leaves the old screen up, so typing still "works")
  disconnected: /joined (this|the) (meeting|webinar) (from|on) another device|signed in (on|from) another device|you have been removed|removed (you )?from (this|the) (meeting|webinar)|connection (was|has been|is) lost|lost connection|unable to connect|reconnecting|you are offline|network (is )?unstable.*reconnect/i,
};

async function first(page, list, { timeout = 0 } = {}) {
  for (const s of list) {
    const loc = page.locator(s).first();
    if (await loc.count().catch(() => 0)) return loc;
  }
  if (timeout) {
    await page.waitForTimeout(timeout);
    return first(page, list);
  }
  return null;
}

// zoom.us/j/123?pwd=x  →  app.zoom.us/wc/123/join?pwd=x   (keeps tk / pwd / uname)
export function toWebClientUrl(url) {
  const u = new URL(url);
  if (u.pathname.startsWith('/wc/')) return url.replace(/(\/wc\/\d+)\/start\b/, '$1/join'); // never the host "start" URL
  const m = u.pathname.match(/\/(?:j|w|s|webinar\/register)\/(\d+)/);
  if (!m) return url;
  const params = new URLSearchParams(u.search);
  return `https://app.zoom.us/wc/${m[1]}/join?${params.toString()}`;
}

// The universal link carries the *audience's* registration token (tk). Without it, Zoom identifies the
// agent by its logged-in account – so an alternative host joins with host powers.
export function asSelf(url) {
  const u = new URL(url);
  ['tk', 'uname', 'un'].forEach((k) => u.searchParams.delete(k));
  return u.toString();
}

export class Zoom {
  constructor({ sessionFile, agentName, headless, dryRun }) {
    Object.assign(this, { sessionFile, agentName, headless, dryRun });
    this.currentReceiver = null;
    this.ui = null; // the frame that holds the meeting UI (Zoom Workplace puts it inside an iframe)
  }

  // Zoom's new web app (app.zoom.us/wc/…) shows the meeting inside an iframe next to the Workplace
  // sidebar. Everything meeting-related (chat, participants, footer) must be searched in that frame.
  async findMeetingFrame() {
    const frames = this.page.frames();
    for (const f of [...frames].reverse()) {
      for (const s of SEL.inMeeting) {
        const el = f.locator(s).first();
        if ((await el.count().catch(() => 0)) && (await el.isVisible().catch(() => false))) return f;
      }
    }
    return null;
  }
  get root() {
    return this.ui && !this.ui.isDetached() ? this.ui : this.page.mainFrame();
  }

  // One-line summary for the run log + files for the "debug" artifact – so selector problems can be
  // fixed from the run instead of guessing.
  async diagnose(tag = 'diag') {
    const out = { tag, url: this.page.url(), frames: [], chosen: this.root.url() };
    for (const f of this.page.frames()) {
      const info = await f
        .evaluate(() => ({
          buttons: [...document.querySelectorAll('button,[role="button"]')]
            .filter((b) => b.offsetParent)
            .map((b) => (b.getAttribute('aria-label') || b.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 40))
            .filter(Boolean)
            .slice(0, 60),
          editable: [...document.querySelectorAll('[contenteditable="true"],textarea')].map((e) => `${e.tagName}.${e.className}`.slice(0, 80)),
          chatish: [...new Set([...document.querySelectorAll('[class*="chat" i]')].map((e) => String(e.className).split(' ')[0]))].slice(0, 60),
        }))
        .catch(() => null);
      out.frames.push({ url: f.url().slice(0, 120), ...info });
    }
    try {
      const fs = await import('node:fs');
      fs.mkdirSync('debug', { recursive: true });
      fs.writeFileSync(`debug/${tag}.json`, JSON.stringify(out, null, 2));
      await this.page.screenshot({ path: `debug/${tag}.png` }).catch(() => {});
      const chatHtml = await this.root
        .evaluate(() => {
          const el = document.querySelector('[class*="chat-list"], [class*="chat-container"], [class*="chat-content"], [aria-label*="chat" i]');
          return (el?.closest('[class*="chat"]')?.outerHTML || el?.outerHTML || '').slice(0, 60000);
        })
        .catch(() => '');
      if (chatHtml) fs.writeFileSync(`debug/${tag}-chat.html`, chatHtml);
    } catch {}
    const f = out.frames.find((x) => x.url === out.chosen.slice(0, 120)) || out.frames[0] || {};
    return `frames=${out.frames.length} meetingFrame=${this.ui ? 'yes' : 'no'} chatClasses=${(f.chatish || []).slice(0, 8).join(',') || 'none'} editable=${(f.editable || []).length}`;
  }

  async launch() {
    this.browser = await chromium.launch({
      headless: this.headless,
      proxy: proxyFromEnv(),
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--disable-blink-features=AutomationControlled', '--window-size=1440,900'],
    });
    let state;
    try {
      state = JSON.parse(fs.readFileSync(this.sessionFile, 'utf8')).cookies ? this.sessionFile : undefined;
    } catch {
      state = undefined; // missing/broken session file → start logged out (auto-login may fix it)
    }
    this.context = await this.browser.newContext({
      storageState: state,
      viewport: { width: 1440, height: 900 },
      locale: 'en-US',
      timezoneId: 'Asia/Kolkata',
    });
    this.page = await this.context.newPage();
  }

  // Logs in with ZOOM_EMAIL / ZOOM_PASSWORD when the saved session has expired.
  // Returns { ok, reason }. It never tries to get past a verification code or CAPTCHA – if Zoom asks
  // for one, it stops and says so (then refresh the session from the Mac with refresh-session.sh).
  async login(email, password) {
    const p = await this.context.newPage();
    try {
      await p.goto('https://zoom.us/signin', { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await p.waitForTimeout(3000);
      for (const b of ['button:has-text("Accept Cookies")', 'button:has-text("Accept")', '#onetrust-accept-btn-handler']) {
        const c = p.locator(b).first();
        if (await c.isVisible().catch(() => false)) await c.click().catch(() => {});
      }
      const emailBox = await first(p, ['#email', 'input[type="email"]', 'input[name="email"]'], { timeout: 4000 });
      if (!emailBox) return { ok: false, reason: 'sign-in page did not show an email box' };
      await emailBox.fill(email);
      let pass = await first(p, ['#password', 'input[type="password"]']);
      if (!pass || !(await pass.isVisible().catch(() => false))) {
        const next = await first(p, ['button:has-text("Next")', 'button:has-text("Continue")', 'button[type="submit"]']);
        if (next) await next.click().catch(() => {});
        await p.waitForTimeout(3000);
        pass = await first(p, ['#password', 'input[type="password"]'], { timeout: 4000 });
      }
      if (!pass) return { ok: false, reason: 'no password box (Zoom may want a code or SSO)' };
      await pass.fill(password);
      const go = await first(p, ['button:has-text("Sign In")', 'button:has-text("Sign in")', '#js_btn_login', 'button[type="submit"]']);
      if (go) await go.click().catch(() => {});
      else await pass.press('Enter');
      // Wait for Zoom to leave the sign-in page (= signed in). Only stop early for a REAL blocker:
      // a visible code box, a visible CAPTCHA challenge, or a wrong-password error. (The page always shows a
      // small "protected by reCAPTCHA" notice – that alone is not a challenge.)
      let blocker = '';
      for (let i = 0; i < 30; i++) {
        await p.waitForTimeout(1500);
        if (!/signin|login/i.test(p.url())) break;
        const codeBox = await first(p, ['input[autocomplete="one-time-code"]:visible', 'input[name*="code" i]:visible', 'input[id*="code" i]:visible', 'input[placeholder*="code" i]:visible']);
        const challenge = await p.locator('iframe[title*="challenge" i]:visible, iframe[src*="recaptcha/api2/bframe"]:visible, iframe[src*="hcaptcha"]:visible').count().catch(() => 0);
        const body = ((await p.locator('body').innerText().catch(() => '')) || '').slice(0, 4000);
        if (codeBox) blocker = 'Zoom asked for a verification code';
        else if (challenge) blocker = 'Zoom showed a CAPTCHA challenge';
        else if (/incorrect (email|password)|wrong password|invalid (email|password)|password is incorrect/i.test(body)) blocker = 'Zoom says the email or password is wrong';
        if (blocker && i >= 2) break; // give the page a moment before deciding
      }
      if (/signin|login/i.test(p.url())) {
        await this.debugShot(p, 'login-failed');
        if (blocker) return { ok: false, reason: blocker };
      }
    } catch (e) {
      return { ok: false, reason: e.message };
    } finally {
      await p.close().catch(() => {});
    }
    return (await this.isLoggedIn()) ? { ok: true } : { ok: false, reason: 'still on the sign-in page after submitting (screenshot saved in the run\'s agent-debug files)' };
  }

  // Which Zoom account is signed in (masked, for the log) – '' if unknown
  async whoAmI() {
    const p = await this.context.newPage();
    try {
      await p.goto('https://zoom.us/profile', { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await p.waitForTimeout(3000);
      const t = (await p.locator('body').innerText().catch(() => '')) || '';
      return (t.match(/[\w.+-]+@[\w-]+\.[\w.]+/) || [''])[0];
    } catch {
      return '';
    } finally {
      await p.close().catch(() => {});
    }
  }

  // Sign out completely (used before switching to the other Zoom account)
  async signOut() {
    await this.context.clearCookies().catch(() => {});
    await this.page.goto('about:blank').catch(() => {});
    this.ui = null;
    this.currentReceiver = null;
  }

  async debugShot(p, tag) {
    try {
      fs.mkdirSync('debug', { recursive: true });
      await p.screenshot({ path: `debug/${tag}.png`, fullPage: true });
    } catch {}
  }

  async isLoggedIn() {
    const p = await this.context.newPage();
    try {
      await p.goto('https://zoom.us/profile', { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await p.waitForTimeout(3000);
      return !/signin|login/i.test(p.url());
    } catch {
      return false;
    } finally {
      await p.close();
    }
  }

  // Follows redirect links (e.g. https://sb.flexifunnels.com/genie-demo → zoom.us/…) and opens the
  // Zoom *web client* for the meeting it lands on. Also accepts a bare webinar ID ("812 3456 7890").
  // If the link ends on a Zoom *registration* page (zoom.us/webinar/register/WN_…), the agent finds
  // the webinar's ID itself (see webinarIdFromRegistration) instead of registering like an attendee.
  async resolveZoomUrl(link) {
    const page = this.page;
    const bare = String(link).replace(/[\s-]/g, '');
    if (/^\d{9,12}$/.test(bare)) return `https://app.zoom.us/wc/${bare}/join`;
    const reg = (u) => (String(u).match(/webinar\/register\/(WN_[\w-]+)/) || [])[1];
    if (reg(link)) return this.webinarIdFromRegistration(link, reg(link));
    if (/zoom\.us\//i.test(link)) return toWebClientUrl(link);
    await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    for (let i = 0; i < 60; i++) {
      // JS redirects can take a moment; some pages open Zoom via a link/button or a zoommtg:// handoff
      const url = page.url();
      if (reg(url)) return this.webinarIdFromRegistration(url, reg(url));
      if (/zoom\.us\/(j|w|s|wc)\//i.test(url)) return toWebClientUrl(url);
      const href = await page
        .evaluate(() => [...document.querySelectorAll('a[href*="zoom.us/"], iframe[src*="zoom.us/"]')].map((a) => a.href || a.src)[0] || '')
        .catch(() => '');
      if (reg(href)) return this.webinarIdFromRegistration(href, reg(href));
      if (/zoom\.us\/(j|w|s|wc)\//i.test(href)) return toWebClientUrl(href);
      await page.waitForTimeout(1000);
    }
    throw new Error(`The join link didn't lead to a Zoom meeting (ended on ${page.url()})`);
  }

  // A registration link (WN_…) doesn't contain the webinar's number. Three ways to find it, in order:
  //  1. the registration page's own data (Zoom often embeds the number)
  //  2. the logged-in account's webinar list – open each upcoming webinar and match the WN_ code
  //     (works because the agent is logged in as the account that hosts the webinar)
  //  3. if AGENT_EMAIL is set, register with it and take the number from the confirmation link
  async webinarIdFromRegistration(regUrl, code) {
    const page = this.page;
    const wc = (id) => `https://app.zoom.us/wc/${id}/join`;
    const log = (m) => console.log(`[${new Date().toLocaleTimeString('en-IN')}] ${m}`);
    log(`Join link is a registration page (${code}) – looking up the webinar ID as the host account…`);

    // 1. embedded on the registration page
    await page.goto(regUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
    await page.waitForTimeout(4000);
    const html = await page.content().catch(() => '');
    const m = html.match(/["']?(?:meetingNumber|meetingId|mtgNumber|webinarNumber|webinarId|meeting_number|number)["']?\s*[:=]\s*["']?(\d{9,12})\b/i);
    if (m) {
      log(`Found webinar ID on the registration page`);
      return wc(m[1]);
    }

    // 2. the host's own webinar list
    const ids = new Set();
    for (const list of ['https://zoom.us/webinar/list', 'https://zoom.us/webinar/list?type=live', 'https://zoom.us/webinar/list?type=previous']) {
      await page.goto(list, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
      await page.waitForTimeout(5000);
      const found = await page
        .evaluate(() => [...document.querySelectorAll('a[href]')].map((a) => (a.href.match(/\/webinar\/(\d{9,12})(?:[/?#]|$)/) || [])[1]).filter(Boolean))
        .catch(() => []);
      const text = await page.content().catch(() => '');
      if (text.includes(code)) {
        // the list itself sometimes shows the registration link next to the ID
        const near = text.slice(Math.max(0, text.indexOf(code) - 3000), text.indexOf(code) + 3000).match(/\b(\d{3}\s?\d{4}\s?\d{4})\b/);
        if (near) return wc(near[1].replace(/\s/g, ''));
      }
      found.forEach((id) => ids.add(id));
      if (ids.size >= 15) break;
    }
    for (const id of [...ids].slice(0, 15)) {
      await page.goto(`https://zoom.us/webinar/${id}`, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {});
      await page.waitForTimeout(3000);
      if ((await page.content().catch(() => '')).includes(code)) {
        log(`Matched the registration link to webinar ${id.slice(0, 3)}…${id.slice(-2)} in the host account`);
        return wc(id);
      }
    }
    if (ids.size) log(`Checked ${ids.size} webinar(s) in this Zoom account – none uses ${code}`);
    else log(`This Zoom account's webinar list is empty or unreadable (is the saved session the host account?)`);

    // 3. register with AGENT_EMAIL
    const email = process.env.AGENT_EMAIL || '';
    if (email) {
      await page.goto(regUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
      await page.waitForTimeout(4000);
      const fill = async (sels, v) => {
        const el = await first(page, sels);
        if (el) await el.fill(v).catch(() => {});
      };
      const [fn, ...ln] = (this.agentName || 'FlexiFunnels Support').split(' ');
      await fill(['#question_first_name', 'input[name="first_name"]', 'input[aria-label*="first name" i]'], fn);
      await fill(['#question_last_name', 'input[name="last_name"]', 'input[aria-label*="last name" i]'], ln.join(' ') || 'Team');
      await fill(['#question_email', 'input[name="email"]', 'input[type="email"]'], email);
      await fill(['#question_confirm_email', 'input[name="confirm_email"]', 'input[aria-label*="confirm" i]'], email);
      const btn = await first(page, ['#btnSubmit', 'button[type="submit"]', 'button:has-text("Register")']);
      if (btn) await btn.click().catch(() => {});
      for (let i = 0; i < 20; i++) {
        await page.waitForTimeout(1500);
        const href = await page
          .evaluate(() => [...document.querySelectorAll('a[href]')].map((a) => a.href).find((h) => /zoom\.us\/(w|j)\/\d+/.test(h)) || '')
          .catch(() => '');
        if (href) {
          log('Registered with AGENT_EMAIL and got the webinar link');
          return toWebClientUrl(href);
        }
      }
    }
    throw new Error(
      `The join link opens a Zoom registration page (${code}) and the agent couldn't find that webinar in the logged-in Zoom account. ` +
        `Fix: make sure the saved Zoom session is the account that HOSTS this webinar, or paste the webinar ID (e.g. 812 3456 7890) in the join_url box when you run the workflow.`
    );
  }

  // How the agent gets in (it needs host or panelist powers to read every chat and reply privately):
  //  1. ZOOM_PANELIST_URL set → its personal panelist link (Zoom gives panelist powers)
  //  2. otherwise → the universal link, minus the audience token, joined as the logged-in account
  //     (works when that account is an alternative host); if Zoom asks to register, fall back to the
  //     audience link and the agent logs a WARNING (attendees can't read other people's chats).
  async join(joinUrl, { panelistUrl = '', directUrl = '', deadline, onWait } = {}) {
    const opts = { deadline, onWait };
    this.ui = null;
    this.joinCount = (this.joinCount || 0) + 1; // the chat reader starts fresh after every (re)join
    // Direct link from the dashboard: no redirect, no registration lookup, no audience token –
    // straight into that webinar as the logged-in (host) account.
    if (directUrl) {
      const bare = String(directUrl).replace(/[\s-]/g, '');
      const target = /^\d{9,12}$/.test(bare) ? `https://app.zoom.us/wc/${bare}/join` : asSelf(toWebClientUrl(directUrl.trim()));
      await this.enter(target, opts);
      return 'direct link (host account)';
    }
    if (panelistUrl) {
      await this.enter(toWebClientUrl(panelistUrl), opts);
      return 'panelist link';
    }
    const audience = await this.resolveZoomUrl(joinUrl);
    const self = asSelf(audience);
    if (self !== audience) {
      try {
        await this.enter(self, { failOnRegistration: true, ...opts });
        return 'logged-in account';
      } catch (e) {
        if (!/registration/i.test(e.message)) throw e;
      }
    }
    await this.enter(audience, opts);
    // no audience token in the link → Zoom sees the logged-in account (host/alt host) anyway
    return self === audience ? 'logged-in account' : 'audience link';
  }

  // Is Zoom offering this (host) account a "Start" button – i.e. the webinar is NOT live yet?
  // The agent never presses it: starting the webinar is the team's job. It just waits.
  async hostStartOffered() {
    for (const f of this.page.frames()) {
      const hit = await f
        .evaluate(() =>
          [...document.querySelectorAll('button, [role="button"], a')].some((b) => {
            const t = (b.innerText || b.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
            return b.offsetParent && /^(start|start (this )?(webinar|meeting)|start practice session)$/i.test(t);
          }),
        )
        .catch(() => false);
      if (hit) return true;
    }
    return false;
  }

  // Waits (idle) until the webinar is live, then goes in. deadline = when to give up (ms timestamp).
  async enter(zoomUrl, { failOnRegistration = false, deadline = Date.now() + 10 * 60_000, onWait = () => {} } = {}) {
    const page = this.page;
    zoomUrl = toWebClientUrl(zoomUrl);
    await page.goto(zoomUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });

    const name = await first(page, SEL.nameInput, { timeout: 8000 });
    if (name && (await name.isVisible().catch(() => false)) && !(await name.inputValue().catch(() => ''))) {
      await name.fill(this.agentName);
    }
    const join = await first(page, SEL.joinButton, { timeout: 5000 });
    if (join && !(await this.hostStartOffered())) await join.click().catch(() => {});

    // Wait for the meeting UI (footer with Leave/End). Webinars that haven't started show a waiting page.
    // The join form / join button can also be inside the iframe, so try those in every frame too.
    this.ui = null;
    let lastReload = Date.now();
    let lastNote = 0;
    for (let i = 0; ; i++) {
      // never step into a webinar that isn't live: if Zoom offers "Start", wait and check again
      if (await this.hostStartOffered()) {
        if (Date.now() - lastNote > 5 * 60_000) {
          lastNote = Date.now();
          onWait('Webinar not started yet – waiting for the team to start it (the agent never starts it)');
        }
        if (Date.now() > deadline) throw new Error('webinar was never started');
        if (Date.now() - lastReload > 60_000) {
          lastReload = Date.now();
          await page.goto(zoomUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
        }
        await page.waitForTimeout(10_000);
        continue;
      }
      this.ui = await this.findMeetingFrame();
      if (this.ui) break;
      for (const f of page.frames()) {
        const n = await first(f, SEL.nameInput);
        if (n && (await n.isVisible().catch(() => false)) && !(await n.inputValue().catch(() => ''))) await n.fill(this.agentName).catch(() => {});
        const j = await first(f, SEL.joinButton);
        if (j && (await j.isVisible().catch(() => false))) await j.click().catch(() => {});
      }
      if (failOnRegistration && i < 6 && (await first(page, SEL.registration))) throw new Error('registration required');
      const body = ((await page.locator('body').innerText().catch(() => '')) || '').slice(0, 2000);
      if (/not started|will begin soon|waiting for the host|please wait for the host/i.test(body) && Date.now() - lastNote > 5 * 60_000) {
        lastNote = Date.now();
        onWait('Webinar not started yet – waiting');
      }
      if (Date.now() > deadline) throw new Error('Timed out waiting to get into the webinar');
      // a waiting page can sit there forever: reload every 2 minutes so a newly started webinar is picked up
      if (Date.now() - lastReload > 120_000) {
        lastReload = Date.now();
        await page.goto(zoomUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
      }
      await page.waitForTimeout(5000);
    }
    await page.waitForTimeout(3000);
    const audio = await first(this.root, SEL.audioDialogClose);
    if (audio) await audio.click().catch(() => {});
    for (const ok of ['button:has-text("OK")', 'button:has-text("Got it")']) {
      const b = this.root.locator(ok).first();
      if (await b.isVisible().catch(() => false)) await b.click().catch(() => {});
    }
    await this.openChat();
  }

  // Attendees get a "Raise Hand" button and no Participants list; hosts/panelists see the Participants button.
  async role() {
    if (!this.ui) this.ui = await this.findMeetingFrame();
    const participants = await first(this.root, SEL.participantCount);
    const raiseHand = await first(this.root, ['button[aria-label*="raise hand" i]', 'button:has-text("Raise Hand")']);
    if (participants && (await participants.isVisible().catch(() => false))) return 'host/panelist';
    if (raiseHand && (await raiseHand.isVisible().catch(() => false))) return 'attendee';
    const parts = this.root.locator('button:has-text("Participants")').first();
    if (await parts.isVisible().catch(() => false)) return 'host/panelist';
    return 'unknown';
  }

  async openChat() {
    if (!this.ui) this.ui = await this.findMeetingFrame();
    const input = await first(this.root, SEL.chatInput);
    if (input && (await input.isVisible().catch(() => false))) return;
    let btn = await first(this.root, SEL.chatToggle);
    if (!btn) {
      // last resort: a visible "Chat" button in the bottom part of the meeting (the footer)
      const all = this.root.locator('button:has-text("Chat"), [role="button"]:has-text("Chat")');
      const n = await all.count().catch(() => 0);
      const vh = this.page.viewportSize()?.height || 900;
      for (let i = n - 1; i >= 0; i--) {
        const box = await all.nth(i).boundingBox().catch(() => null);
        if (box && box.y > vh * 0.6) {
          btn = all.nth(i);
          break;
        }
      }
    }
    if (btn) await btn.click().catch(() => {});
    await this.page.waitForTimeout(1500);
  }

  // '' when fine, otherwise why the agent is no longer really in the webinar
  async connectionProblem() {
    if (this.page.isClosed()) return 'browser page closed';
    const texts = await Promise.all(
      [this.page.mainFrame(), this.root].map((f) => f.evaluate(() => document.body?.innerText || '').catch(() => '')),
    );
    const m = texts.join('\n').match(SEL.disconnected);
    if (m) return `Zoom says: "${m[0]}"`;
    if (!(await first(this.root, SEL.inMeeting))) return 'meeting controls are gone';
    return '';
  }

  // Did a message we just sent really show up in the chat? (proves the agent is still connected)
  async seenInChat(text) {
    const want = String(text).replace(/\s+/g, ' ').trim().slice(0, 60).toLowerCase();
    return this.root
      .evaluate(
        ([SEL, want]) => {
          for (const s of SEL.chatText) {
            const els = document.querySelectorAll(s);
            if (!els.length) continue;
            return [...els].slice(-40).some((e) => (e.innerText || e.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase().startsWith(want));
          }
          return false;
        },
        [SEL, want],
      )
      .catch(() => false);
  }

  async hasEnded() {
    return this.page.isClosed() || Boolean(await first(this.root, SEL.meetingEnded)) || Boolean(await first(this.page, SEL.meetingEnded));
  }

  // Current attendee count shown in Zoom (null if it can't be read).
  async participantCount() {
    for (const sel of SEL.participantCount) {
      const el = this.root.locator(sel).first();
      if (!(await el.count().catch(() => 0))) continue;
      const text = `${(await el.textContent().catch(() => '')) || ''} ${(await el.getAttribute('aria-label').catch(() => '')) || ''}`;
      const m = text.replace(/,/g, '').match(/\d+/);
      if (m) return Number(m[0]);
    }
    return null;
  }

  // Returns the messages currently rendered in the chat panel: [{ sender, text }]
  async readChat() {
    return (await this.readChatWindows()).at(-1) || [];
  }

  // Every state of the chat panel since the last call, oldest first: [[{sender,text}...], ...].
  // Zoom only draws the messages near the bottom of the list, so a burst of messages (e.g. 30 people
  // typing "0" at once) can push some out of view between two reads. A watcher inside the page
  // snapshots the panel every time Zoom changes it, so each message is captured while it is on screen.
  // The last entry is always the panel right now.
  async readChatWindows() {
    // While a reply is being sent (name click → type → back to Everyone) don't touch the panel –
    // just read it. The watcher inside the page keeps capturing messages meanwhile.
    if (!this.sending && !this.sweeping) {
      await this.openChat();
      // If the list was left scrolled up (e.g. after clicking someone's name), new messages are not drawn.
      await this.scrollChatToBottom();
      // a "new messages" / "jump to latest" button means the list is not at the bottom – click it
      for (const sel of ['button:has-text("new message")', '[class*="new-message"] button', '[class*="unread"][class*="button"]']) {
        const b = this.root.locator(sel).first();
        if (await b.isVisible().catch(() => false)) {
          await b.click().catch(() => {});
          break;
        }
      }
    }
    if (!this.ui) this.ui = await this.findMeetingFrame();
    return this.root.evaluate((SEL) => {
      if (!window.__agentExtract) {
        window.__agentExtract = () => {
          const q = (root, list) => {
            for (const s of list) {
              const el = root.querySelector(s);
              if (el) return el;
            }
            return null;
          };
          let items = [];
          for (const s of SEL.chatItem) {
            const els = document.querySelectorAll(s);
            if (els.length) {
              items = [...els];
              break;
            }
          }
          let lastSender = '';
          const out = [];
          for (const item of items) {
            const senderEl = q(item, SEL.chatSender);
            // Zoom groups consecutive messages from one person and shows the name only once.
            let sender = (senderEl?.textContent || lastSender).trim().replace(/\s+/g, ' ');
            sender = sender.replace(/\s+to\s+(Everyone|Hosts? and Panelists|All Panelists.*|Me|You)\b.*$/i, '').replace(/\s*\((Privately|Direct Message)\)\s*$/i, '').trim();
            lastSender = sender;
            let textEls = [];
            for (const s of SEL.chatText) {
              const found = item.querySelectorAll(s);
              if (found.length) {
                textEls = [...found];
                break;
              }
            }
            for (const t of textEls) {
              const text = (t.innerText || t.textContent || '').trim();
              // messages at the very top whose name is drawn above the visible part have no sender – skip
              if (text && sender) out.push({ sender, text });
            }
          }
          return out;
        };
      }
      if (!window.__agentObs) {
        window.__agentSnaps = [];
        window.__agentLast = '';
        // snapshot right inside the observer callback (runs once per batch of DOM changes, before the
        // browser paints) – so every state Zoom draws is captured, however fast messages arrive
        const toBottom = () => {
          for (const el of document.querySelectorAll('[class*="chat-list"], [class*="chat-container"] [class*="scroll"], [class*="chat-content"]')) {
            if (el.scrollHeight - el.clientHeight - el.scrollTop > 4) el.scrollTop = el.scrollHeight;
          }
        };
        const snap = () => {
          try {
            // keep the list at the newest message (Zoom doesn't draw new ones while scrolled up),
            // except in the moment the agent is clicking someone's name to reply
            if (!window.__agentHold) toBottom();
            const w = window.__agentExtract();
            const sig = JSON.stringify(w);
            if (!w.length || sig === window.__agentLast) return;
            window.__agentLast = sig;
            window.__agentSnaps.push(w);
            if (window.__agentSnaps.length > 2000) window.__agentSnaps.splice(0, window.__agentSnaps.length - 2000);
          } catch {}
        };
        window.__agentObs = new MutationObserver(snap);
        window.__agentObs.observe(document.body, { childList: true, subtree: true, characterData: true });
      }
      const snaps = window.__agentSnaps.splice(0);
      snaps.push(window.__agentExtract());
      return snaps;
    }, SEL);
  }

  // Saves the markup of the newest chat messages once (debug/chat-items.html) so selectors can be tuned.
  async dumpChatItems() {
    const html = await this.root
      .evaluate((SEL) => {
        for (const s of SEL.chatItem) {
          const els = document.querySelectorAll(s);
          if (els.length) return [...els].slice(-4).map((e) => e.outerHTML).join('\n<!-- next -->\n');
        }
        return '';
      }, SEL)
      .catch(() => '');
    if (!html) return;
    await fs.promises.mkdir('debug', { recursive: true }).catch(() => {});
    await fs.promises.writeFile('debug/chat-items.html', html).catch(() => {});
  }

  // Picks who the next message goes to: null = everyone, otherwise an attendee's display name.
  // Zoom's "to:" dropdown has changed markup many times, so the option is found by its visible text
  // (anywhere in the open dropdown, not in the chat messages) instead of a fixed class name.
  async setReceiver(name) {
    // 1st choice: click the attendee's blue name on their latest chat message – Zoom then switches
    // "to:" to that person directly (no dropdown, no search).
    if (name && (await this.clickSenderName(name))) {
      this.currentReceiver = name;
      return;
    }
    return this.setReceiverFromList(name);
  }

  async clickSenderName(name) {
    const ui = this.root;
    const marked = await ui.evaluate((want) => {
      const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const target = norm(want);
      document.querySelectorAll('[data-agent-name]').forEach((e) => e.removeAttribute('data-agent-name'));
      const items = [...document.querySelectorAll('[class*="chat-item"], [class*="chat-message"], [class*="chat-list"] > *')];
      // all elements inside the chat list whose own text is exactly the attendee's name
      const hits = [];
      for (const it of items) {
        for (const el of it.querySelectorAll('span, a, button, div')) {
          if (norm(el.innerText || el.textContent) !== target) continue;
          if ([...el.children].some((c) => norm(c.innerText) === target)) continue; // keep the innermost
          const r = el.getBoundingClientRect();
          if (r.width && r.height) hits.push(el);
        }
      }
      const el = hits.at(-1); // newest message
      if (!el) return false;
      el.scrollIntoView({ block: 'center' });
      el.setAttribute('data-agent-name', '1');
      return true;
    }, name).catch(() => false);
    if (!marked) return false;
    const loc = ui.locator('[data-agent-name="1"]').first();
    await loc.hover().catch(() => {});
    await loc.click({ timeout: 3000 }).catch(() => {});
    await this.page.waitForTimeout(500);
    // check the "to:" now shows the name (if it can't be read, trust the click)
    const label = await first(ui, SEL.receiverButton);
    const text = label ? ((await label.innerText().catch(() => '')) || '').toLowerCase() : '';
    if (!text || text.includes(name.toLowerCase())) return true;
    // clicking the name may open a small menu (e.g. "Chat privately") – pick that option
    const opt = ui.locator('text=/^(chat|message|reply)( privately)?$/i').first();
    if (await opt.isVisible().catch(() => false)) {
      await opt.click().catch(() => {});
      await this.page.waitForTimeout(400);
      const t2 = label ? ((await label.innerText().catch(() => '')) || '').toLowerCase() : '';
      if (!t2 || t2.includes(name.toLowerCase())) return true;
    }
    await this.page.keyboard.press('Escape').catch(() => {});
    return false;
  }

  // 2nd choice: open the "to:" dropdown and pick the attendee by the text it shows.
  async setReceiverFromList(name) {
    const ui = this.root;
    const btn = await first(ui, SEL.receiverButton);
    if (!btn) throw new Error('chat receiver button not found');
    await btn.evaluate((e) => e.setAttribute('data-agent-recv', '1')).catch(() => {});
    await btn.click();
    await this.page.waitForTimeout(600);
    if (name) {
      const search = await first(ui, SEL.receiverSearch);
      if (search && (await search.isVisible().catch(() => false))) {
        await search.fill(name).catch(() => {});
        await this.page.waitForTimeout(600);
      }
    }
    const want = name || null;
    // The "to:" list shows only part of the attendees at a time – scroll through it until the name appears.
    let picked = { ok: false, seen: [] };
    for (let step = 0; step < 25 && !picked.ok; step++) {
      picked = await ui.evaluate(([want, step]) => {
        const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const target = want ? norm(want) : null;
        const isEveryone = (t) => /^(everyone|all panelists and attendees|everyone \(in meeting\))$/.test(t);
        const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
        const inMessages = (el) => el.closest('[class*="chat-item"], [class*="chat-message"], [class*="new-chat-message"], [class*="chat-list"]');
        const cands = [...document.querySelectorAll('[role="menuitem"], [role="option"], [role="menuitemradio"], li, a, button, div, span')]
          .filter((el) => vis(el) && !inMessages(el) && !el.closest('[data-agent-recv]') && !el.querySelector('input, textarea'))
          .map((el) => ({ el, t: norm(el.innerText || el.textContent) }))
          .filter(({ t }) => (target ? t === target || t === `${target} (attendee)` || t.replace(/\s*\(.*?\)\s*$/, '') === target : isEveryone(t)));
        cands.sort((a, b) => (/(option|menuitem)/.test(b.el.getAttribute('role') || '') - /(option|menuitem)/.test(a.el.getAttribute('role') || '')) || a.el.contains(b.el) - b.el.contains(a.el));
        const hit = cands[0];
        if (hit) {
          (hit.el.closest('[role="menuitem"], [role="option"], [role="menuitemradio"], li') || hit.el).click();
          return { ok: true };
        }
        // not visible yet: scroll the open list (the scrollable box that holds the "Everyone" option) one page down
        const everyone = [...document.querySelectorAll('li, [role="menuitem"], [role="option"], [role="menuitemradio"], div, span')].find((el) => vis(el) && !inMessages(el) && isEveryone(norm(el.innerText)));
        let box = everyone?.parentElement;
        while (box && !(box.scrollHeight > box.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(box).overflowY))) box = box.parentElement;
        const atEnd = !box || box.scrollTop + box.clientHeight >= box.scrollHeight - 2;
        if (box && !atEnd) box.scrollTop += Math.max(60, box.clientHeight * 0.8);
        const seen = [...(box || document).querySelectorAll('li, [role="menuitem"], [role="option"], [role="menuitemradio"]')].filter(vis).map((e) => norm(e.innerText)).filter(Boolean);
        return { ok: false, end: atEnd || step > 0 && !box, seen: [...new Set(seen)].slice(0, 15) };
      }, [want, step]);
      if (picked.ok || picked.end) break;
      await this.page.waitForTimeout(250);
    }
    if (!picked.ok) {
      if (!this.receiverDiag) {
        this.receiverDiag = true; // snapshot the open dropdown once, for the debug artifact
        await this.diagnose('receiver-not-found').catch(() => {});
      }
      await this.page.keyboard.press('Escape').catch(() => {});
      throw new Error(`"${name || 'Everyone'}" not in the chat's "to" list (it shows: ${picked.seen.join(' | ') || 'nothing readable'})`);
    }
    await this.page.waitForTimeout(300);
    this.currentReceiver = name;
  }

  // What the chat's "to:" currently says ('' if it can't be read)
  async receiverLabel() {
    const el = await first(this.root, ['.chat-receiver-list__receiver', '[class*="chat-receiver"] button', 'button[aria-label*="to:" i]', ...SEL.receiverButton]);
    return el ? ((await el.innerText().catch(() => '')) || (await el.getAttribute('aria-label').catch(() => '')) || '').replace(/\s+/g, ' ').trim() : '';
  }
  isEveryoneLabel(t) {
    return /(^|\b)(everyone|all panelists and attendees)\b/i.test(t || '');
  }

  // HARD RULE: after every private reply the chat goes straight back to "Everyone", and nothing is
  // ever posted to Everyone unless "to:" really says Everyone. Otherwise timed chats would quietly
  // go to one attendee only.
  async ensureEveryone() {
    for (let i = 0; i < 4; i++) {
      const label = await this.receiverLabel();
      if (this.isEveryoneLabel(label)) {
        this.currentReceiver = null;
        return true;
      }
      await this.setReceiverFromList(null).catch(() => {});
      await this.page.waitForTimeout(400 + i * 400);
    }
    const label = await this.receiverLabel();
    // label unreadable = can't prove it's wrong; trust the switch we just made
    if (!label || this.isEveryoneLabel(label)) {
      this.currentReceiver = null;
      return true;
    }
    return false;
  }

  // Closes Zoom pop-ups that can cover the chat ("Reclaim host", hardware-acceleration tip, OK/Got it dialogs)
  async dismissPopups() {
    for (const sel of ['button:has-text("Stay Co-Host")', 'button:has-text("Got it")', 'button:has-text("OK")', 'button:has-text("Close")', '[aria-label="close" i]', '[aria-label="Close" i]']) {
      const b = this.root.locator(sel).first();
      if (await b.isVisible().catch(() => false)) await b.click({ timeout: 2000 }).catch(() => {});
    }
  }

  // Number safety net: scrolls through the WHOLE chat from the top, so every message Zoom has – even ones that
  // scrolled past during a busy moment – is read once. Returns every message seen.
  async sweepChat() {
    if (this.sending) return [];
    await this.openChat();
    this.sweeping = true;
    try {
      const all = [];
      await this.root.evaluate(() => (window.__agentHold = true));
      for (let step = 0; step < 400; step++) {
        const r = await this.root.evaluate((step) => {
          const lists = [...document.querySelectorAll('[class*="chat-list"], [class*="chat-container"] [class*="scroll"], [class*="chat-content"]')].filter((el) => el.scrollHeight > el.clientHeight + 4);
          const el = lists.sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
          if (!el) return { msgs: window.__agentExtract ? window.__agentExtract() : [], done: true };
          if (step === 0) el.scrollTop = 0;
          else el.scrollTop += Math.max(80, el.clientHeight * 0.6);
          return { done: el.scrollTop + el.clientHeight >= el.scrollHeight - 2 };
        }, step);
        await this.page.waitForTimeout(step === 0 ? 600 : 220); // let Zoom draw that part of the list
        const msgs = await this.root.evaluate(() => (window.__agentExtract ? window.__agentExtract() : [])).catch(() => []);
        all.push(...msgs, ...(r.msgs || []));
        if (r.done && step > 0) break;
      }
      return all;
    } finally {
      await this.root.evaluate(() => (window.__agentHold = false)).catch(() => {});
      await this.scrollChatToBottom();
      this.sweeping = false;
    }
  }

  // keep the chat scrolled to the newest message (clicking a name can scroll it up)
  async scrollChatToBottom() {
    await this.root
      .evaluate(() => {
        for (const el of document.querySelectorAll('[class*="chat-list"], [class*="chat-container"] [class*="scroll"], [class*="chat-content"]')) {
          if (el.scrollHeight > el.clientHeight) el.scrollTop = el.scrollHeight;
        }
      })
      .catch(() => {});
  }

  async typeAndSend(text) {
    let box = await first(this.root, SEL.chatInput);
    if (!box) throw new Error('chat input not found');
    try {
      await box.click({ timeout: 8000 });
    } catch {
      // something is covering the chat box (a Zoom pop-up, the panel closed…): close it, reopen the chat, try again
      await this.page.keyboard.press('Escape').catch(() => {});
      await this.dismissPopups().catch(() => {});
      await this.openChat();
      box = await first(this.root, SEL.chatInput);
      if (!box) throw new Error('chat input not found');
      await box.click({ timeout: 8000, force: true });
    }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (i) await this.page.keyboard.press('Shift+Enter');
      if (lines[i]) await this.page.keyboard.insertText(lines[i]);
    }
    await this.page.keyboard.press('Enter');
    await this.page.waitForTimeout(300);
  }

  // Flow for a private reply:  click attendee's name → check "to:" = attendee → send →
  // scroll down → switch "to:" back to Everyone (checked).  Same loop for every reply.
  async send(text, to = null) {
    if (this.dryRun) {
      console.log(`[DRY RUN] → ${to || 'Everyone'}: ${text.replace(/\n/g, ' ⏎ ')}`);
      return;
    }
    for (let i = 0; this.sweeping && i < 150; i++) await this.page.waitForTimeout(200); // a chat sweep is running
    this.sending = true;
    try {
      await this.#send(text, to);
    } finally {
      this.sending = false;
    }
  }

  async #hold(on) {
    await this.root.evaluate((v) => (window.__agentHold = v), on).catch(() => {});
  }

  async #send(text, to) {
    await this.openChat();
    if (to) {
      await this.#hold(true);
      try {
        await this.setReceiver(to); // always re-select – never trust an old selection
      } finally {
        await this.#hold(false);
      }
      await this.scrollChatToBottom(); // back to the newest messages straight away – "to:" stays selected
      const label = await this.receiverLabel();
      if (label && !label.toLowerCase().includes(to.toLowerCase())) {
        await this.ensureEveryone();
        throw new Error(`"to:" shows "${label}" instead of ${to} – private reply not sent`);
      }
      try {
        await this.typeAndSend(text);
      } finally {
        await this.scrollChatToBottom();
        if (!(await this.ensureEveryone())) throw new Error('sent privately, but could NOT switch "to:" back to Everyone');
        await this.scrollChatToBottom();
      }
      return;
    }
    if (!(await this.ensureEveryone())) throw new Error('"to:" is not Everyone – message held so it doesn\'t go to one person');
    await this.typeAndSend(text);
    await this.scrollChatToBottom();
  }

  async saveSession() {
    if (this.context) await this.context.storageState({ path: this.sessionFile });
  }

  async close() {
    await this.browser?.close().catch(() => {});
  }
}
