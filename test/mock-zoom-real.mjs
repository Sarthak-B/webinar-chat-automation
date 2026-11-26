// Against Zoom's REAL chat markup (from the agent's debug snapshot): virtual list, chat-item-container-N,
// name shown once per group, aria-label "Name to Hosts and Panelists, 7:15:22 PM, text", message ids.
// Checks: live reading + full-chat check get EVERY message with the right sender, time and number.
import { chromium } from 'playwright';
import { Zoom } from '../src/zoom.js';
import { findPhone } from '../src/brain.js';
const b = await chromium.launch();
const page = await b.newPage();
await page.setContent(`<div id="list" style="height:420px;width:380px;overflow-y:auto;position:relative"><div id="sp" style="position:relative"></div></div><script>
  const all = []; let seq = 0;
  const list = document.getElementById('list'), sp = document.getElementById('sp'); const H = 56;
  const t0 = new Date(2026, 10, 26, 19, 30, 0);
  window.add = (name, text) => { const time = new Date(t0.getTime() + all.length * 1000).toLocaleTimeString('en-US'); all.push({ name, text, time, id: '5-{' + (++seq) + '}' }); sp.style.height = all.length * H + 'px'; if (!window.hold) list.scrollTop = list.scrollHeight; draw(); };
  function draw() {
    [...sp.children].forEach((e) => e.remove());
    const a = Math.max(0, Math.floor(list.scrollTop / H) - 1), z = Math.min(all.length, a + 10);
    for (let i = a; i < z; i++) { const m = all[i], first = i === 0 || all[i - 1].name !== m.name;
      const d = document.createElement('div'); d.id = 'chat-item-container-' + i; d.className = 'chat-item-container'; d.style.cssText = 'position:absolute;left:0;top:' + i * H + 'px;height:' + H + 'px';
      d.innerHTML = (first ? '<div class="chat-item__chat-info-header"><span class="chat-item__sender" data-name="' + m.name + '">' + m.name + '</span><span class="chat-item__to"> to </span><span class="chat-item__receiver" data-name="Hosts and Panelists">Hosts and Panelists</span><span class="chat-item__chat-info-time-stamp">' + m.time + '</span></div>' : '') +
        '<div class="chat-message__container" aria-label="' + m.name + ' to Hosts and Panelists, ' + m.time + ', ' + m.text + '"><div id="' + m.id + '" class="chat-message__text-box chat-message__text-content">' + m.text + '</div></div>';
      sp.appendChild(d); }
  }
  list.addEventListener('scroll', draw);
  window.expected = () => all.map((m, i) => ({ idx: i, ...m }));
</script>`);
const fake = Object.assign(Object.create(Zoom.prototype), { ui: page.mainFrame(), page, sending: true, openChat: async () => {}, scrollChatToBottom: async () => {} }); // root (getter) = ui
const got = new Map(); // id → message (live + sweep), senders resolved by position like the agent does
const byIdx = new Map();
const take = (list) => { list.filter((m) => m.id).sort((a, c) => a.idx - c.idx).forEach((m) => { if (m.sender) byIdx.set(m.idx, m.sender); const s = m.sender || byIdx.get(m.idx - 1); if (s) { byIdx.set(m.idx, s); if (!got.has(m.id)) got.set(m.id, { ...m, sender: s }); } }); };
// live: 400 messages in bursts (same people several times in a row), reading every 400 ms
const names = ['Asha', 'Ravi', 'Meena', 'Ravi', 'Ravi', 'Kiran', 'Asha', 'Zoya'];
const burst = (async () => { for (let i = 0; i < 400; i++) { const name = names[(i * 7 + (i >> 3)) % names.length]; const text = i % 9 === 4 ? `my no 98${String(76540000 + i).padStart(8, '0')}` : ['1', 'yes', 'T', 'F', 'mumbai', 'price?'][i % 6]; await page.evaluate(([n, t]) => add(n, t), [name, text]); await new Promise((r) => setTimeout(r, i % 50 < 30 ? 3 : 40)); } })();
const reader = (async () => { for (let k = 0; k < (process.env.NO_LIVE ? 0 : 60); k++) { take((await Zoom.prototype.readChatWindows.call(fake)).flat()); await new Promise((r) => setTimeout(r, 400)); } })();
await burst; await reader;
const liveCount = got.size;
// full-chat check fills any gap
fake.sending = false;
take(await Zoom.prototype.sweepChat.call(fake));
const exp = await page.evaluate(() => window.expected());
const wrong = exp.filter((e) => !got.has(e.id) || got.get(e.id).sender !== e.name || got.get(e.id).time !== e.time);
const nums = exp.filter((e) => findPhone(e.text));
const numsOk = nums.filter((e) => got.get(e.id)?.sender === e.name).length;
console.log(`messages ${exp.length} · live read ${liveCount} · after full-chat check ${got.size} · wrong/missing ${wrong.length} · numbers ${numsOk}/${nums.length} with the right name and time`);
if (wrong.length) console.log(wrong.slice(0, 5));
await b.close();
process.exit(wrong.length || numsOk !== nums.length ? 1 : 0);
