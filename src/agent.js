import fs from 'node:fs';
import { loadConfig } from './config.js';
import { Sheet, SheetLogger } from './sheets.js';
import { parseSchedule, parseReplies, parseObjections, parseNumberBank } from './schedule.js';
import { Brain, findPhone, isTrivial, firstName, asksForNumber, detectLang } from './brain.js';
import { Zoom } from './zoom.js';
import { History } from './history.js';

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
let numberBank = [];
try {
  numberBank = parseNumberBank(await sheet.read(cfg.numberBankTab));
} catch (e) {
  log(`No "${cfg.numberBankTab}" tab – using built-in number asks`);
}
if (!numberBank.length) {
  numberBank = [
    { angle: 'Free clarity', line: 'Drop your WhatsApp number here – a senior mentor will call you and map your personal roadmap, FREE 👇' },
    { angle: 'Commitment', line: "that's your first step. Step 2: share your contact number and our team will guide you 👇" },
    { angle: 'Trust', line: 'no spam, no pressure – just one call from a senior mentor. Share your contact number 📞' },
  ];
}
const brain = new Brain({ ...cfg, replies, objections, numberBank });
log(`Loaded ${replies.length} reply facts, ${objections.length} objection lines, ${numberBank.length} number-ask angles · voice: ${cfg.personaName}`);

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
const history = new History({ cfg, today, clock, log });
await history.init();

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
// Timed chats go out exactly on cue. Private messages wait a human "read + type" time and are
// rate-limited, so the chat feels like Sir answering people one by one – never a burst of bot replies.
const queue = []; // { prio, text, to, kind, said, at, notBefore, skipIf }
const rand = (a, b) => a + Math.random() * (b - a);
function humanDelay(text) {
  if (!cfg.humanize) return 0;
  const typing = Math.min(25_000, String(text).length * rand(45, 80)); // ~13–22 chars/sec
  return rand(4_000, 9_000) + typing; // read, think, type
}
const enqueue = (job) => {
  const at = Date.now();
  queue.push({ at, notBefore: job.to ? at + humanDelay(job.text) : at, ...job });
};
const privateSent = []; // timestamps of private sends (for the per-minute caps)
const asksSent = [];
const perMin = (arr) => {
  const cut = Date.now() - 60_000;
  while (arr.length && arr[0] < cut) arr.shift();
  return arr.length;
};
let lastSend = 0;

async function senderLoop() {
  while (running) {
    const now = Date.now();
    if (!queue.length || now - lastSend < cfg.sendGapMs) {
      await sleep(250);
      continue;
    }
    const privateFull = perMin(privateSent) >= cfg.maxPrivatePerMin;
    const asksFull = perMin(asksSent) >= cfg.maxAsksPerMin;
    const ready = queue
      .filter((j) => j.notBefore <= now)
      .filter((j) => !j.to || !privateFull) // public timed chats are never held back
      .filter((j) => j.kind !== 'NUMBER ASK' || !asksFull)
      .sort((a, b) => a.prio - b.prio || a.notBefore - b.notBefore);
    const job = ready[0];
    if (!job) {
      await sleep(250);
      continue;
    }
    queue.splice(queue.indexOf(job), 1);
    if (job.skipIf?.()) continue; // e.g. a number ask for someone who has since shared their number
    if (job.to && job.kind !== 'NUMBER' && now - job.at > 15 * 60_000) {
      record('SKIPPED', job.to, job.text, job.said || '', 'reply waited over 15 min – too late to feel natural');
      continue;
    }
    try {
      await zoom.send(job.text, job.to);
      record(job.kind, job.to, job.text, job.said || '', job.note || '');
      if (job.kind.startsWith('TIMED')) history.timed();
      if (job.qa) history.qaRow({ ...job.qa, reply: job.text });
      if (job.to) {
        privateSent.push(Date.now());
        if (job.kind === 'NUMBER ASK') asksSent.push(Date.now());
        remember(job.to, 'me', job.text);
        recentSent.push(job.text);
        if (recentSent.length > 8) recentSent.shift();
      }
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

// ---------- Per-person memory (language, short history) ----------
const people = new Map(); // name → { lang, msgs, history: [{who, text}] }
const recentSent = []; // last private messages to anyone – the AI avoids repeating their phrasing
function person(name) {
  if (!people.has(name)) people.set(name, { lang: null, msgs: 0, history: [] });
  return people.get(name);
}
function remember(name, who, text) {
  const p = person(name);
  p.history.push({ who, text: String(text).slice(0, 300) });
  if (p.history.length > 8) p.history.shift();
}
function noteIncoming(name, text) {
  const p = person(name);
  p.msgs++;
  const l = detectLang(text);
  // Hindi / Hinglish are strong signals; a one-word English "Yes" shouldn't flip a Hinglish speaker to English.
  if (l && (l !== 'english' || !p.lang || String(text).trim().split(/\s+/).length > 3)) p.lang = l;
  remember(name, 'them', text);
}
const langOf = (name) => person(name).lang || 'english';

// ---------- Numbers come first ----------
// Saved the moment the number appears in chat (not when the thank-you goes out), so it shows up right away.
const savedNumbers = new Set();
const thankedNumbers = new Set();
const hasNumber = new Set(); // attendee names who have shared a number
const asks = new Map(); // name → { count, last } number asks sent (replies that ask count too)
let bankIdx = 0;

function noteAsk(sender) {
  const a = asks.get(sender) || { count: 0, last: 0 };
  a.count++;
  a.last = Date.now();
  asks.set(sender, a);
}
function canAsk(sender) {
  if (hasNumber.has(sender)) return false;
  const a = asks.get(sender);
  return !a || (a.count < cfg.nudgeMax && Date.now() - a.last > cfg.nudgeGapMin * 60_000);
}
// AI-written private "share your number" line in their language, only for people who are really engaged.
async function askForNumber(sender, said, reason) {
  if (!cfg.autoReply || !cfg.numberNudges || !canAsk(sender)) return;
  if (person(sender).msgs < cfg.nudgeAfterMessages) return; // one "Yes" isn't enough – don't bomb everyone
  noteAsk(sender);
  const angle = numberBank.length ? numberBank[bankIdx++ % numberBank.length] : null;
  const text = await brain.compose({ purpose: 'ask', sender, said, lang: langOf(sender), history: person(sender).history, recent: recentSent, angle: angle && `${angle.angle} – ${angle.line}` });
  const queuedAt = Date.now();
  const skipIf = () => {
    if (hasNumber.has(sender)) return true;
    if (Date.now() - queuedAt > 10 * 60_000) {
      const a = asks.get(sender); // waited too long – drop it and let them be asked fresh later
      if (a) a.count = Math.max(0, a.count - 1);
      return true;
    }
    return false;
  };
  enqueue({ prio: 4, text, to: sender, kind: 'NUMBER ASK', said, note: `${reason}${angle ? ` · ${angle.angle}` : ''} · ${langOf(sender)}`, skipIf });
}

function saveNumber(sender, text) {
  const phone = findPhone(text);
  if (!phone) return;
  hasNumber.add(sender);
  if (savedNumbers.has(phone)) return;
  savedNumbers.add(phone);
  numbers.add([today, clock(), sender, phone, text, cfg.scheduleTab]);
  history.lead(sender, phone, text);
  numbers.flush().catch((e) => log('numbers flush failed:', e.message));
  log(`Number from ${sender}: ${phone}`);
}

async function aiSlot(fn) {
  while (aiBusy >= cfg.aiConcurrency) await sleep(200);
  aiBusy++;
  try {
    return await fn();
  } finally {
    aiBusy--;
  }
}

// Only genuine questions get a reply. "Type 1" / "Yes" / emojis / city names get nothing.
async function handle(sender, text) {
  const phone = findPhone(text);
  const lang = langOf(sender);
  const ctx = () => ({ sender, lang, history: person(sender).history.slice(0, -1), recent: recentSent });
  const rest = phone ? text.replace(/\+?\d[\d\s-]{8,16}\d/g, ' ').replace(/^[\s,.;:-]+/, '').trim() : text;

  if (!cfg.autoReply) {
    // Timed-chats mode: no private messages at all. Numbers are still saved; real questions are logged for the team.
    if (!isTrivial(rest)) {
      record('QUESTION', sender, '', text, 'timed mode – answer manually');
      history.question();
      history.qaRow({ name: sender, lang, question: rest, status: 'Not answered (timed mode)' });
    }
    return;
  }

  if (phone && !thankedNumbers.has(phone)) {
    thankedNumbers.add(phone);
    newNumberNames.push(firstName(sender));
    if (isTrivial(rest)) {
      // They shared their number: a short thank-you so they know the team will call.
      const thanks = await aiSlot(() => brain.compose({ purpose: 'thanks', said: text, ...ctx() }));
      enqueue({ prio: 1, text: thanks, to: sender, kind: 'NUMBER', said: text, note: lang });
      lastReplyTo.set(sender, Date.now());
      return;
    }
    text = rest; // "9876543210, EMI hai?" → one reply that thanks them AND answers (hasNumber is already set)
  }
  if (isTrivial(text)) return; // engagement replies ("1", "yes", 🔥) – no reply

  const d = await aiSlot(() => brain.decide({ text, hasNumber: hasNumber.has(sender), ...ctx() }));
  if (d.objection) noteObjection(d.objection, sender);
  if (d.action === 'reply' && d.reply) {
    history.question();
    enqueue({ prio: 2, text: d.reply, to: sender, kind: 'REPLY', said: text, note: lang, qa: { name: sender, lang, question: text, status: 'Answered' } });
    if (asksForNumber(d.reply)) noteAsk(sender);
    lastReplyTo.set(sender, Date.now());
  } else if (d.action === 'escalate') {
    history.question();
    record('NEEDS TEAM', sender, '', text, d.reason || '');
    log(`NEEDS TEAM: ${sender}: ${text}`);
    const qa = { name: sender, lang, question: text, status: 'Needs team' };
    if (d.safe_to_ask !== false) {
      // The team can only help if they can call – the AI's reply says so and (if needed) asks for the number.
      const reply = d.reply || (await aiSlot(() => brain.compose({ purpose: hasNumber.has(sender) ? 'thanks' : 'ask', said: text, ...ctx() })));
      enqueue({ prio: 1, text: reply, to: sender, kind: 'REPLY', said: text, note: `needs team · ${lang}`, qa });
      if (!hasNumber.has(sender)) noteAsk(sender);
    } else {
      history.qaRow(qa); // abusive/spam: logged for the team, no reply sent
    }
  } else if (d.safe_to_ask !== false && !phone && cfg.numberNudges) {
    await aiSlot(() => askForNumber(sender, text, 'chatting, no number yet'));
  }
  // action "ignore" (greetings, compliments, chit-chat): no reply
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
      noteIncoming(name, m.text);
      history.chatter(name);
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
    const names = [...new Set(newNumberNames.splice(0))].filter(Boolean).slice(-3);
    if (!names.length) continue;
    const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} & ${names.at(-1)}`;
    const lines = [
      `Thank you ${list} 🙏 Our team will contact you shortly. Anyone else who would like guidance, please share your contact number here.`,
      `${list} – thank you, our team will call you shortly. Baaki sabhi bhi guidance ke liye apna contact number share kar sakte hain.`,
      `Thank you ${list}. Our team will get in touch with you soon. Others who would like a call can share their number in the chat.`,
    ];
    enqueue({ prio: 3, text: lines[Math.floor(Math.random() * lines.length)], to: null, kind: 'SOCIAL PROOF' });
  }
}

// ---------- Run ----------
let running = true;
// Attendee count from Zoom's Participants button – the peak goes into the webinar history.
async function attendeeLoop() {
  while (running) {
    const n = await zoom.participantCount().catch(() => null);
    if (n) history.attendees(n);
    await sleep(60_000);
  }
}

const workers = [senderLoop(), scheduleLoop(), chatLoop(), socialProofLoop(), attendeeLoop()];

async function shutdown(reason) {
  if (!running) return;
  running = false;
  log('Stopping:', reason);
  record('STOP', '', '', '', reason);
  await zoom.saveSession().catch((e) => log('could not save session', e.message));
  await Promise.all([agentLog.close(), numbers.close(), history.close(/SIG|max runtime/.test(reason) ? 'Stopped' : 'Completed')]);
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
