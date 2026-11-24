import { chromium } from 'playwright';
import { Zoom } from '../src/zoom.js';
import { ChatSync } from '../src/chatsync.js';
const b = await chromium.launch(); const page = await b.newPage();
await page.setContent(`<div class="chat-list"></div><script>
  const all=[]; const list=document.querySelector('.chat-list');
  function render(){ // only the newest 5 are drawn; consecutive same sender shows name once
    list.innerHTML=''; const vis=all.slice(-5); let prev=null;
    for(const [i,m] of vis.entries()){ const d=document.createElement('div'); d.className='chat-item-container';
      if(m.s!==prev || i===0 && false) d.innerHTML='<span class="chat-item__sender">'+m.s+' to Everyone</span>';
      d.innerHTML+='<div class="new-chat-message__text-content">'+m.t+'</div>'; list.appendChild(d); prev=m.s; }
  }
  window.add=(s,t)=>{all.push({s,t}); if(!window.up) render();};
  window.scrollUp=()=>{window.up=true; const save=all.slice(); list.innerHTML=''; for(const m of save.slice(-14,-8)){const d=document.createElement('div'); d.className='chat-item-container'; d.innerHTML='<span class="chat-item__sender">'+m.s+'</span><div class="new-chat-message__text-content">'+m.t+'</div>'; list.appendChild(d);} setTimeout(()=>{window.up=false; render();},120);};
</script>`);
const fake = { sending: true, ui: page.mainFrame(), root: page.mainFrame() };
const read = () => Zoom.prototype.readChatWindows.call(fake);
const sync = new ChatSync(); const got = [];
const ingest = (ws) => { for (const w of ws) { const r = sync.ingest(w); if (r.gap) got.push('GAP'); got.push(...r.fresh.map(m => m.sender + ':' + m.text)); } };
await page.evaluate(() => { add('Old','hello'); add('Old2','hi'); });
ingest(await read());
// burst: 40 messages, some repeats, 25ms apart (only 5 on screen at once), while we read every 400ms
const N = +(process.argv[2]||40), GAP = +(process.argv[3]||25), UP = process.argv[4] === 'up';
const sent = [];
const burst = (async () => { for (let i = 0; i < N; i++) { const s = 'P' + Math.floor(Math.random()*12), t = ['0','ok','yes','price?','9876543210'][Math.floor(Math.random()*5)]; if (UP && i % 37 === 20) await page.evaluate(() => scrollUp()); sent.push(s + ':' + t); await page.evaluate(([s, t]) => add(s, t), [s, t]); await new Promise(r => setTimeout(r, GAP)); } })();

for (let k = 0; k < Math.ceil(N*GAP/400)+2; k++) { await new Promise(r => setTimeout(r, 400)); ingest(await read()); }
await burst; ingest(await read());
const caps = got.filter(x => x !== 'GAP'); let j = 0; for (const x of sent) if (x === caps[j]) j++;
console.log('in-order subsequence (no wrong/duplicate messages):', j === caps.length);
if (process.env.DBG) { console.log(sent.join(' ')); console.log(got.join(' ')); }
console.log('sent', sent.length, 'captured', got.length, got.includes('GAP') ? 'GAP!' : 'no gap', JSON.stringify(got) === JSON.stringify(sent) ? 'EXACT MATCH' : 'MISMATCH');
await b.close();
