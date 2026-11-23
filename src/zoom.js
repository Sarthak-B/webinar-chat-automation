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
  chatToggle: ['button[aria-label*="chat" i]', 'button:has-text("Chat")', '.footer-button__button[aria-label*="Chat" i]'],
  chatPanel: ['.chat-container', '#chat-list-content', '[class*="chat-list"]'],
  // one rendered message block
  chatItem: ['.chat-item-container', '.new-chat-item__container', '[class*="chat-item"][class*="container"]'],
  chatSender: ['.chat-item__sender', '.new-chat-message__sender', '[class*="chat-item__sender"]'],
  chatText: ['.new-chat-message__text-content', '.chat-message__text-content', '[class*="text-content"]'],
  chatReceiverLabel: ['.chat-receiver-list__receiver', '.chat-receiver-list__chat-control-receiver', '[class*="receiver"]'],
  chatInput: ['.chat-rtf-box__editor-outer [contenteditable="true"]', '.chat-box__chat-textarea', 'div[contenteditable="true"][class*="chat"]', 'textarea[class*="chat"]'],
  receiverButton: ['.chat-receiver-list__receiver', 'button[aria-label*="send to" i]', '#chatReceiverMenu', '[class*="chat-receiver"] button'],
  receiverSearch: ['.chat-receiver-list__search input', 'input[placeholder*="search" i]'],
  receiverEveryone: ['text=/^(Everyone|All panelists and attendees)$/i'],
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

export class Zoom {
  constructor({ sessionFile, agentName, headless, dryRun }) {
    Object.assign(this, { sessionFile, agentName, headless, dryRun });
    this.currentReceiver = null;
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

  async join(joinUrl) {
    const page = this.page;
    await page.goto(toWebClientUrl(joinUrl), { waitUntil: 'domcontentloaded', timeout: 60_000 });

    const name = await first(page, SEL.nameInput, { timeout: 8000 });
    if (name && (await name.isVisible().catch(() => false)) && !(await name.inputValue().catch(() => ''))) {
      await name.fill(this.agentName);
    }
    const join = await first(page, SEL.joinButton, { timeout: 5000 });
    if (join) await join.click().catch(() => {});

    // Wait for the meeting UI (footer with Chat button). Webinars that haven't started show a waiting page.
    for (let i = 0; i < 120; i++) {
      const chat = await first(page, SEL.chatToggle);
      if (chat && (await chat.isVisible().catch(() => false))) break;
      await page.waitForTimeout(5000);
      if (i === 119) throw new Error('Timed out waiting to get into the webinar');
    }
    const audio = await first(page, SEL.audioDialogClose);
    if (audio) await audio.click().catch(() => {});
    await this.openChat();
  }

  async openChat() {
    if (await first(this.page, SEL.chatInput)) return;
    const btn = await first(this.page, SEL.chatToggle);
    if (btn) await btn.click().catch(() => {});
    await this.page.waitForTimeout(1500);
  }

  async hasEnded() {
    return Boolean(await first(this.page, SEL.meetingEnded)) || this.page.isClosed();
  }

  // Returns the messages currently rendered in the chat panel: [{ sender, text }]
  async readChat() {
    await this.openChat();
    return this.page.evaluate((SEL) => {
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
        const sender = (senderEl?.textContent || lastSender).trim();
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
    const page = this.page;
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
        await page.keyboard.press('Escape');
        throw new Error(`attendee "${name}" not found in receiver list`);
      }
      await opt.click();
    } else {
      const all = await first(page, SEL.receiverEveryone);
      if (!all) {
        await page.keyboard.press('Escape');
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
    const box = await first(this.page, SEL.chatInput);
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
