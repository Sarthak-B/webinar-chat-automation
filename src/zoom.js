import { chromium } from 'playwright';

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
  if (u.pathname.startsWith('/wc/')) return url;
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
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--disable-blink-features=AutomationControlled', '--window-size=1440,900'],
    });
    this.context = await this.browser.newContext({
      storageState: this.sessionFile,
      viewport: { width: 1440, height: 900 },
      locale: 'en-US',
      timezoneId: 'Asia/Kolkata',
    });
    this.page = await this.context.newPage();
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
  async join(joinUrl, { panelistUrl = '', directUrl = '' } = {}) {
    // Direct link from the dashboard: no redirect, no registration lookup, no audience token –
    // straight into that webinar as the logged-in (host) account.
    if (directUrl) {
      const bare = String(directUrl).replace(/[\s-]/g, '');
      const target = /^\d{9,12}$/.test(bare) ? `https://app.zoom.us/wc/${bare}/join` : asSelf(toWebClientUrl(directUrl.trim()));
      await this.enter(target);
      return 'direct link (host account)';
    }
    if (panelistUrl) {
      await this.enter(toWebClientUrl(panelistUrl));
      return 'panelist link';
    }
    const audience = await this.resolveZoomUrl(joinUrl);
    const self = asSelf(audience);
    if (self !== audience) {
      try {
        await this.enter(self, { failOnRegistration: true });
        return 'logged-in account';
      } catch (e) {
        if (!/registration/i.test(e.message)) throw e;
      }
    }
    await this.enter(audience);
    // no audience token in the link → Zoom sees the logged-in account (host/alt host) anyway
    return self === audience ? 'logged-in account' : 'audience link';
  }

  async enter(zoomUrl, { failOnRegistration = false } = {}) {
    const page = this.page;
    await page.goto(zoomUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });

    const name = await first(page, SEL.nameInput, { timeout: 8000 });
    if (name && (await name.isVisible().catch(() => false)) && !(await name.inputValue().catch(() => ''))) {
      await name.fill(this.agentName);
    }
    const join = await first(page, SEL.joinButton, { timeout: 5000 });
    if (join) await join.click().catch(() => {});

    // Wait for the meeting UI (footer with Leave/End). Webinars that haven't started show a waiting page.
    // The join form / join button can also be inside the iframe, so try those in every frame too.
    this.ui = null;
    for (let i = 0; i < 120; i++) {
      this.ui = await this.findMeetingFrame();
      if (this.ui) break;
      for (const f of page.frames()) {
        const n = await first(f, SEL.nameInput);
        if (n && (await n.isVisible().catch(() => false)) && !(await n.inputValue().catch(() => ''))) await n.fill(this.agentName).catch(() => {});
        const j = await first(f, SEL.joinButton);
        if (j && (await j.isVisible().catch(() => false))) await j.click().catch(() => {});
      }
      if (failOnRegistration && i < 6 && (await first(page, SEL.registration))) throw new Error('registration required');
      await page.waitForTimeout(5000);
      if (i === 119) throw new Error('Timed out waiting to get into the webinar');
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
    await this.openChat();
    return this.root.evaluate((SEL) => {
      const q = (root, list) => {
        for (const s of list) {
          const el = root.querySelector(s);
          if (el) return el;
        }
        return null;
      };
      const qa = (list) => {
        for (const s of list) {
          const els = document.querySelectorAll(s);
          if (els.length) return [...els];
        }
        return [];
      };
      let lastSender = '';
      const out = [];
      for (const item of qa(SEL.chatItem)) {
        const senderEl = q(item, SEL.chatSender);
        // Zoom groups consecutive messages from one person and shows the name only once.
        let sender = (senderEl?.textContent || lastSender).trim().replace(/\s+/g, ' ');
        sender = sender.replace(/\s+to\s+(Everyone|Hosts? and Panelists|All Panelists.*|Me|You)\b.*$/i, '').replace(/\s*\((Privately|Direct Message)\)\s*$/i, '').trim();
        lastSender = sender;
        const textEls = [];
        for (const s of SEL.chatText) {
          const found = item.querySelectorAll(s);
          if (found.length) {
            textEls.push(...found);
            break;
          }
        }
        for (const t of textEls) {
          const text = (t.innerText || t.textContent || '').trim();
          if (text) out.push({ sender, text });
        }
      }
      return out;
    }, SEL);
  }

  // Picks who the next message goes to: null = everyone, otherwise an attendee's display name.
  async setReceiver(name) {
    const page = this.root;
    const btn = await first(page, SEL.receiverButton);
    if (!btn) throw new Error('chat receiver button not found');
    await btn.click();
    await page.waitForTimeout(400);
    if (name) {
      const search = await first(page, SEL.receiverSearch);
      if (search) await search.fill(name);
      await page.waitForTimeout(500);
      const opt = page.getByRole('menuitem', { name, exact: false }).or(page.locator(`[role="option"]:has-text("${name.replace(/"/g, '\\"')}")`)).first();
      if (!(await opt.count())) {
        await this.page.keyboard.press('Escape');
        throw new Error(`attendee "${name}" not found in receiver list`);
      }
      await opt.click();
    } else {
      const all = await first(page, SEL.receiverEveryone);
      if (!all) {
        await this.page.keyboard.press('Escape');
        throw new Error('"Everyone" option not found');
      }
      await all.click();
    }
    this.currentReceiver = name;
  }

  async send(text, to = null) {
    if (this.dryRun) {
      console.log(`[DRY RUN] → ${to || 'Everyone'}: ${text.replace(/\n/g, ' ⏎ ')}`);
      return;
    }
    await this.openChat();
    if (this.currentReceiver !== to) await this.setReceiver(to);
    const box = await first(this.root, SEL.chatInput);
    if (!box) throw new Error('chat input not found');
    await box.click();
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (i) await this.page.keyboard.press('Shift+Enter');
      if (lines[i]) await this.page.keyboard.insertText(lines[i]);
    }
    await this.page.keyboard.press('Enter');
  }

  async saveSession() {
    if (this.context) await this.context.storageState({ path: this.sessionFile });
  }

  async close() {
    await this.browser?.close().catch(() => {});
  }
}
