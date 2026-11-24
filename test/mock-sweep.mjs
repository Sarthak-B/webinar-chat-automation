// The end-of-webinar number sweep against a chat that only draws the rows in view (like Zoom).
import { chromium } from 'playwright';
import { Zoom } from '../src/zoom.js';
import { findPhone } from '../src/brain.js';
const b = await chromium.launch();
const page = await b.newPage();
await page.setContent(`<div class="chat-list" style="height:300px;overflow-y:auto;position:relative"><div id="sp"></div></div><script>
  const all = []; for (let i = 0; i < 200; i++) all.push({ s: 'P' + (i % 37), t: i % 17 === 5 ? 'my no 98' + String(76543200 + i).padStart(8, '0') : 'msg ' + i });
  const list = document.querySelector('.chat-list'), sp = document.getElementById('sp'); const H = 40;
  sp.style.height = all.length * H + 'px';
  function draw() { [...list.querySelectorAll('.chat-item-container')].forEach((e) => e.remove());
    const a = Math.max(0, Math.floor(list.scrollTop / H) - 2), z = Math.min(all.length, a + 12);
    for (let i = a; i < z; i++) { const d = document.createElement('div'); d.className = 'chat-item-container'; d.style.cssText = 'position:absolute;top:' + i * H + 'px';
      d.innerHTML = (i === a || all[i].s !== all[i - 1].s ? '<span class="chat-item__sender">' + all[i].s + ' to Hosts and Panelists</span>' : '') + '<div class="new-chat-message__text-content">' + all[i].t + '</div>'; list.appendChild(d); } }
  list.addEventListener('scroll', draw); list.scrollTop = list.scrollHeight; draw();
  window.expected = all.filter((m) => /98\\d{8}/.test(m.t)).map((m) => m.s + ':' + m.t);
</script>`);
const fake = { root: page.mainFrame(), ui: page.mainFrame(), page, sending: true, openChat: async () => {}, scrollChatToBottom: async () => {} };
await Zoom.prototype.readChatWindows.call(fake); // installs the in-page reader
fake.sending = false;
const msgs = await Zoom.prototype.sweepChat.call(fake);
const got = new Set(msgs.filter((m) => findPhone(m.text)).map((m) => m.sender + ':' + m.text));
const expected = await page.evaluate(() => window.expected);
const missing = expected.filter((e) => !got.has(e));
console.log(`sweep read ${msgs.length} rows · numbers expected ${expected.length} · found ${got.size} · missing ${missing.length}`, missing);
await b.close();
process.exit(missing.length ? 1 : 0);
