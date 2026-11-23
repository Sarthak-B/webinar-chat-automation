import fs from 'node:fs';
import { loadConfig } from './config.js';
import { Sheet, SheetLogger } from './sheets.js';
import { parseSchedule, parseReplies, parseObjections } from './schedule.js';
import { Brain, findPhone, isTrivial, firstName } from './brain.js';
import { Zoom } from './zoom.js';

const cfg = loadConfig();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clock = (d = new Date()) => d.toLocaleTimeString('en-IN', { hour12: true, timeZone: 'Asia/Kolkata' });
const log = (...a) => console.log(`[${clock()}]`, ...a);
const startedAt = Date.now();

// ---------- Sheet + knowledge ----------
const sheet = new Sheet(cfg);
const agentLog = new SheetLogger(sheet, cfg.logTab, ['Date', 'Time', 'Kind', 'To', 'Message sent', 'Attendee said', 'Note']);
const numbers = new SheetLogger(sheet, cfg.numbersTab, ['Date', 'Time', 'Name', 'Number', 'Message', 'Webinar tab']);
const today = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });
const record = (kind, to, sent, said = '', note = '') => {
  // "IN" rows are what attendees typed – not something the agent sends, so they never get the DRY prefix.
  const k = cfg.dryRun && kind !== 'IN' ? `DRY ${kind}` : kind;
  agentLog.add([today, clock(), k, to || 'Everyone', sent || '', said, note]);
};

// ---------- Step 1: which tab? (asked before any schedule data is read) ----------
async function chooseTab() {
  const tabs = await sheet.listScheduleTabs();
  if (!tabs.length) throw new Error('No schedule tabs (with a "Video Time" header) found in the sheet');
  if (cfg.scheduleTab) {
    if (!tabs.includes(cfg.scheduleTab)) throw new Error(`Tab "${cfg.scheduleTab}" not found. Schedule tabs: ${tabs.join(' | ')}`);
    return cfg.scheduleTab;
  }
  if (!process.stdin.isTTY) {
    throw new Error(`No tab chosen. Start the agent from the dashboard (it asks for the tab) or set SCHEDULE_TAB. Tabs: ${tabs.join(' | ')}`);
  }
  console.log('\nWhich tab should the agent read the chats from?\n');
  tabs.forEach((t, i) => console.log(`  ${i + 1}. ${t}`));
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  for (;;) {
    const a = (await rl.question('\nType the number and press Enter: ')).trim();
    const t = tabs[Number(a) - 1];
    if (t) {
      rl.close();
      return t;
    }
    console.log('Not a valid number, try again.');
  }
}
cfg.scheduleTab = await chooseTab();
log(`Using tab "${cfg.scheduleTab}"`);

const replies = parseReplies(await sheet.read(cfg.repliesTab));
const objections = parseObjections(await sheet.read(cfg.objectionsTab));
const brain = new Brain({ ...cfg, replies, objections });
log(`Loaded ${replies.length} reply templates and ${objections.length} objection lines`);

let schedule = parseSchedule(await sheet.read(cfg.scheduleTab, 'A1:D600'));
if (!schedule.length) throw new Error(`No timed chats found in "${cfg.scheduleTab}"`);
log(`"${cfg.scheduleTab}": ${schedule.length} timed chats, ${clock(schedule[0].at)} → ${clock(schedule.at(-1).at)}`);
const sentKeys = new Set();

async function reloadSchedule() {
  try {
    schedule = parseSchedule(await sheet.read(cfg.scheduleTab, 'A1:D600'));
  } catch (e) {
    log('schedule reload failed, keeping previous copy:', e.message);
  }
}

await agentLog.init();
await numbers.init();
record('START', '', '', '', `tab="${cfg.scheduleTab}" dryRun=${cfg.dryRun} autoReply=${cfg.autoReply}`);

// ---------- Wait until it's time to join ----------
const joinAt = schedule[0].at.getTime() - cfg.joinEarlyMin * 60_000;
if (Date.now() < joinAt) {
  log(`Waiting until ${clock(new Date(joinAt))} to join`);
  while (Date.now() < joinAt) await sleep(Math.min(30_000, joinAt - Date.now()));
}

// ---------- Zoom ----------
const zoom = new Zoom(cfg);
await zoom.launch();
const loggedIn = await zoom.isLoggedIn();
if (loggedIn) {
  fs.writeFileSync('.session-ok', 'ok'); // tells the workflow it's safe to save the refreshed session
  log('Zoom session is logged in');
} else {
  log('WARNING: Zoom session is logged out. Joining with the link only; re-run save-session soon.');
  record('WARNING', '', '', '', 'Zoom session logged out – run save-session again');
}

async function joinWithRetry() {
  for (let i = 1; i <= 4; i++) {
    try {
      await zoom.join(cfg.joinUrl);
      log('Joined the webinar');
      return;
    } catch (e) {
      log(`Join attempt ${i} failed: ${e.message}`);
      await sleep(20_000);
    }
  }
  throw new Error('Could not join the webinar after 4 attempts');
}
await joinWithRetry();

// ---------- Send queue (one sender, so nothing types over anything else) ----------
const queue = []; // { prio, text, to, kind, said, at }
const enqueue = (job) => queue.push({ at: Date.now(), ...job });
let lastSend = 0;

async function senderLoop() {
  while (running) {
    if (!queue.length || Date.now() - lastSend < cfg.sendGapMs) {
      await sleep(250);
      continue;
    }
    queue.sort((a, b) => a.prio - b.prio || a.at - b.at);
    const job = queue.shift();
    try {
      await zoom.send(job.text, job.to);
      record(job.kind, job.to, job.text, job.said || '', job.note || '');
    } catch (e) {
      log(`send failed (${job.kind} → ${job.to || 'Everyone'}): ${e.message}`);
      record('FAILED', job.to, job.text, job.said || '', e.message);
      zoom.currentReceiver = undefined; // force re-selecting the receiver next time
    }
    lastSend = Date.now();
  }
}

// ---------- Timed chats from the sheet ----------
async function scheduleLoop() {
  let lastReload = Date.now();
  while (running) {
    const now = Date.now();
    for (const item of schedule) {
      if (sentKeys.has(item.key) || item.at.getTime() > now) continue;
      sentKeys.add(item.key);
      const lateSec = (now - item.at.getTime()) / 1000;
      if (lateSec > cfg.lateGraceSec) {
        record('SKIPPED', '', item.text, '', `row ${item.row} was ${Math.round(lateSec)}s overdue`);
        continue;
      }
      enqueue({ prio: 0, text: item.text, to: null, kind: `TIMED ${item.type}`.trim(), note: `row ${item.row} @ ${item.host}` });
    }
    if (now - lastReload > 60_000) {
      lastReload = now;
      await reloadSchedule();
    }
    await sleep(500);
  }
}

// ---------- Attendee chats ----------
const seen = new Map(); // "sender|text" → time first seen
const pending = new Map(); // sender → { texts: [], timer }
const lastReplyTo = new Map();
const objectionHits = []; // { key, sender, at }
const objectionPosted = new Map();
const newNumberNames = [];
let aiBusy = 0;

const teamSet = new Set([cfg.agentName.toLowerCase(), 'me', ...cfg.teamNames]);
function cleanSender(raw) {
  const role = /\((host|co-host|panelist|panelists)\)/i.test(raw);
  const name = raw.replace(/\s+to\s+(everyone|me|all .*|hosts? and panelists.*|panelists?.*)$/i, '').replace(/\((host|co-host|panelist|me)\)/gi, '').trim();
  return { name, isTeam: role || teamSet.has(name.toLowerCase()) };
}

// Saved the moment the number appears in chat (not when the thank-you goes out), so it shows up right away.
const savedNumbers = new Set();
const thankedNumbers = new Set();
function saveNumber(sender, text) {
  const phone = findPhone(text);
  if (!phone || savedNumbers.has(phone)) return;
  savedNumbers.add(phone);
  numbers.add([today, clock(), sender, phone, text, cfg.scheduleTab]);
  numbers.flush().catch((e) => log('numbers flush failed:', e.message));
  log(`Number from ${sender}: ${phone}`);
}

async function handle(sender, text) {
  const name = firstName(sender);
  const phone = findPhone(text);
  if (phone) {
    if (!thankedNumbers.has(phone)) {
      thankedNumbers.add(phone);
      newNumberNames.push(name);
      const thanks = brain.replyFor(/shared phone number/i, name) || `${name}, thank you. We've asked our senior mentoring team to connect with you.`;
      enqueue({ prio: 1, text: thanks, to: sender, kind: 'NUMBER', said: text });
      lastReplyTo.set(sender, Date.now());
    }
    // "9876543210, EMI hai?" → thank them AND answer the question
    text = text.replace(/\+?\d[\d\s-]{8,16}\d/g, ' ').replace(/^[\s,.;:-]+/, '').trim();
  }
  if (isTrivial(text)) return;
  if (!cfg.autoReply) {
    record('QUESTION', sender, '', text, 'auto-reply off');
    return;
  }

  while (aiBusy >= cfg.aiConcurrency) await sleep(200);
  aiBusy++;
  let d;
  try {
    d = await brain.decide({ sender, text });
  } catch (e) {
    d = { action: 'escalate', reason: `AI error: ${e.message}` };
  } finally {
    aiBusy--;
  }

  if (d.objection) noteObjection(d.objection, sender);
  if (d.action === 'reply') {
    enqueue({ prio: 2, text: d.reply, to: sender, kind: 'REPLY', said: text });
    lastReplyTo.set(sender, Date.now());
  } else if (d.action === 'escalate') {
    record('NEEDS TEAM', sender, '', text, d.reason || '');
    log(`NEEDS TEAM: ${sender}: ${text}`);
  }
}

// Collect messages from one person for a few seconds, so "hi" + "price?" + "emi?" gets one reply.
function queueAttendee(sender, text) {
  const p = pending.get(sender) || { texts: [] };
  p.texts.push(text);
  clearTimeout(p.timer);
  const cooldownLeft = (lastReplyTo.get(sender) || 0) + cfg.attendeeCooldownSec * 1000 - Date.now();
  p.timer = setTimeout(() => {
    pending.delete(sender);
    handle(sender, p.texts.join('\n')).catch((e) => log('handle error', e.message));
  }, Math.max(4000, cooldownLeft));
  pending.set(sender, p);
}

function noteObjection(key, sender) {
  const now = Date.now();
  objectionHits.push({ key, sender, at: now });
  while (objectionHits.length && now - objectionHits[0].at > 5 * 60_000) objectionHits.shift();
  const people = new Set(objectionHits.filter((h) => h.key === key).map((h) => h.sender));
  const cooled = now - (objectionPosted.get(key) || 0) > cfg.objectionCooldownMin * 60_000;
  if (people.size >= cfg.objectionThreshold && cooled) {
    const o = objections.find((x) => x.key === key);
    objectionPosted.set(key, now);
    enqueue({ prio: 3, text: o.chat, to: null, kind: 'OBJECTION', note: `${people.size} people: ${o.objection}` });
  }
}

async function chatLoop() {
  let first = true;
  while (running) {
    let msgs = [];
    try {
      msgs = await zoom.readChat();
    } catch (e) {
      log('readChat failed:', e.message);
    }
    const now = Date.now();
    for (const m of msgs) {
      const key = `${m.sender}|${m.text}`;
      const t = seen.get(key);
      if (t && now - t < 10 * 60_000) continue; // same person, same text, within 10 min = same message
      seen.set(key, now);
      if (first) continue; // don't answer chat history from before we joined
      const { name, isTeam } = cleanSender(m.sender);
      if (!name || isTeam) continue;
      record('IN', name, '', m.text); // every attendee message, so the dashboard can show full conversations
      saveNumber(name, m.text);
      queueAttendee(name, m.text);
    }
    first = false;
    await sleep(1500);
  }
}

// "Thank you A, B & C. Our team is calling you shortly." – only real names of people who shared numbers.
async function socialProofLoop() {
  while (running) {
    await sleep(cfg.socialProofEveryMin * 60_000);
    if (!running || !newNumberNames.length) continue;
    const names = [...new Set(newNumberNames.splice(0))].filter((n) => n !== 'there').slice(-3);
    if (!names.length) continue;
    const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} & ${names.at(-1)}`;
    enqueue({ prio: 3, text: `Thank you ${list}. Our team is calling you shortly. Others, drop your number 🙏`, to: null, kind: 'SOCIAL PROOF' });
  }
}

// ---------- Run ----------
let running = true;
const workers = [senderLoop(), scheduleLoop(), chatLoop(), socialProofLoop()];

async function shutdown(reason) {
  if (!running) return;
  running = false;
  log('Stopping:', reason);
  record('STOP', '', '', '', reason);
  await zoom.saveSession().catch((e) => log('could not save session', e.message));
  await Promise.all([agentLog.close(), numbers.close()]);
  await zoom.close();
}

process.on('SIGTERM', () => shutdown('SIGTERM').then(() => process.exit(0)));
process.on('SIGINT', () => shutdown('SIGINT').then(() => process.exit(0)));

while (running) {
  await sleep(15_000);
  const last = schedule.at(-1).at.getTime();
  if (Date.now() > last + cfg.endAfterLastMin * 60_000 && !queue.length) await shutdown('all timed chats done');
  else if (Date.now() - startedAt > cfg.maxRuntimeMin * 60_000) await shutdown('max runtime reached');
  else if (await zoom.hasEnded().catch(() => false)) await shutdown('webinar ended');
}
await Promise.allSettled(workers);
process.exit(0);
