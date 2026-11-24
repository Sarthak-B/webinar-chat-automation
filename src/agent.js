import fs from 'node:fs';
import { loadConfig } from './config.js';
import { Sheet, SheetLogger } from './sheets.js';
import { parseFifteen, startDate, isDayTab, parseSchedule, parseReplies, parseObjections, parseNumberBank, parseSessionStart, isPricingChat } from './schedule.js';
import { Brain, FALLBACK, findPhone, isTrivial, firstName, asksForNumber, detectLang, mentionsPrice } from './brain.js';
import { Zoom } from './zoom.js';
import { History } from './history.js';

const cfg = loadConfig();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clock = (d = new Date()) => d.toLocaleTimeString('en-IN', { hour12: true, timeZone: 'Asia/Kolkata' });
const log = (...a) => console.log(`[${clock()}]`, ...a);
const startedAt = Date.now();
const mask = (e) => String(e || '').replace(/^(.{2}).*(@.*)$/, '$1***$2') || 'unknown account';


// ---------- Sheet + knowledge ----------
const sheet = new Sheet(cfg);
// 15 Days challenge: the day tabs live in their own sheet (same service account); logs stay in the main sheet.
const schedSheet = cfg.scheduleSheetId ? new Sheet({ ...cfg, sheetId: cfg.scheduleSheetId }) : sheet;
const readSchedule = async () => {
  const rows = await schedSheet.read(cfg.scheduleTab, cfg.buyers ? 'A1:H800' : 'A1:D600');
  return { rows, items: cfg.buyers ? parseFifteen(rows, cfg.sessionStartClock) : parseSchedule(rows) };
};
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
  const tabs = cfg.buyers ? await schedSheet.listDayTabs() : await sheet.listScheduleTabs();
  if (!tabs.length) throw new Error(cfg.buyers ? 'No "Day …" tabs found in the 15 Days sheet' : 'No schedule tabs (with a "Video Time" header) found in the sheet');
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
// ---------- Automatic runs (GitHub schedule) ----------
// AUTO_SLOT = evening (every day 7:30 PM) or morning (Sunday 11 AM). Which tab/mode each slot uses, and
// whether it's on, lives in the sheet's "Auto Schedule" tab, so the team can change it without GitHub.
const AUTO_TAB = 'Auto Schedule';
const AUTO_HEADER = ['Slot', 'When', 'Tab to read', 'Mode (dry / timed / full)', 'On (yes / no)'];
async function autoSlotSettings(slot) {
  const tabs = await sheet.listScheduleTabs();
  const guess = (re) => tabs.find((t) => re.test(t)) || '';
  const defaults = {
    evening: ['evening', 'Every day 7:30 PM (agent starts ~6:35 PM)', tabs.includes('Variant 4 – 7:30 PM') ? 'Variant 4 – 7:30 PM' : guess(/7[:.]?30\s*pm/i), 'full', 'yes'],
    morning: ['morning', 'Sunday 11 AM (agent starts ~10:05 AM)', guess(/\b11\s*am\b/i), 'full', 'yes'],
  };
  let rows = [];
  try {
    rows = await sheet.read(AUTO_TAB, 'A1:E20');
  } catch {
    await sheet.ensureTab(AUTO_TAB, AUTO_HEADER);
    await sheet.append(AUTO_TAB, [defaults.evening, defaults.morning], true);
    log(`Created the "${AUTO_TAB}" tab in the sheet – edit it to change the automatic runs`);
    rows = [AUTO_HEADER, defaults.evening, defaults.morning];
  }
  const row = rows.find((r) => String(r[0] || '').trim().toLowerCase() === slot) || defaults[slot];
  return { tab: String(row[2] || '').trim(), mode: String(row[3] || 'full').trim().toLowerCase(), on: !/^(no|off|false|0)$/i.test(String(row[4] || 'yes').trim()) };
}
log(`Zoom account for this run: ${cfg.zoomAccount}@ (${process.env.ZOOM_ACCOUNT && process.env.ZOOM_ACCOUNT !== 'auto' ? 'chosen on the dashboard' : 'default for this webinar'})`);
log(`Webinar: ${cfg.webinarName}${cfg.buyers ? ' (buyers – timed chats + doubt clearing, no number asks, no pricing lock)' : ''}`);
if (process.env.AUTO_SLOT && !cfg.buyers) {
  const slot = process.env.AUTO_SLOT;
  const a = await autoSlotSettings(slot);
  if (!a.on) {
    log(`Automatic ${slot} run is switched OFF in the "${AUTO_TAB}" tab – nothing to do`);
    process.exit(0);
  }
  if (!a.tab) throw new Error(`Automatic ${slot} run: no tab set. Write the tab name in the "${AUTO_TAB}" tab of the sheet (column C).`);
  const mode = ['dry', 'timed', 'full'].includes(a.mode) ? a.mode : 'full';
  cfg.scheduleTab = a.tab;
  cfg.mode = mode;
  cfg.dryRun = mode === 'dry';
  cfg.autoReply = mode === 'full';
  log(`Automatic ${slot} run → tab "${a.tab}", mode ${mode}`);
}
cfg.scheduleTab = await chooseTab();
log(`Using tab "${cfg.scheduleTab}"`);

let replies = [];
let objections = [];
let numberBank = [];
if (cfg.buyers) {
  // optional "Attendee Replies" tab in the 15 Days sheet (same 2 columns as the business sheet)
  replies = parseReplies(await schedSheet.read(cfg.repliesTab).catch(() => []));
} else {
  replies = parseReplies(await sheet.read(cfg.repliesTab));
  objections = parseObjections(await sheet.read(cfg.objectionsTab));
  try {
    numberBank = parseNumberBank(await sheet.read(cfg.numberBankTab));
  } catch (e) {
    log(`No "${cfg.numberBankTab}" tab – using built-in number asks`);
  }
}
if (!numberBank.length && !cfg.buyers) {
  numberBank = [
    { angle: 'Free clarity', line: 'Drop your WhatsApp number here – a senior mentor will call you and map your personal roadmap, FREE 👇' },
    { angle: 'Commitment', line: "that's your first step. Step 2: share your contact number and our team will guide you 👇" },
    { angle: 'Trust', line: 'no spam, no pressure – just one call from a senior mentor. Share your contact number 📞' },
  ];
}
const brain = new Brain({ ...cfg, replies, objections, numberBank });
log(`Loaded ${replies.length} reply facts, ${objections.length} objection lines, ${numberBank.length} number-ask angles · voice: ${cfg.personaName} · AI: ${cfg.aiName}`);

const first = await readSchedule();
const scheduleRows = first.rows;
let schedule = first.items;
if (!schedule.length) throw new Error(`No timed chats found in "${cfg.scheduleTab}"`);
log(`"${cfg.scheduleTab}": ${schedule.length} timed chats, ${clock(schedule[0].at)} → ${clock(schedule.at(-1).at)}${schedule.skipped ? ` · ${schedule.skipped} non-chat rows (Poll/Q&A…) left out` : ''}`);

// TEST MODE (dashboard "Play the tab's chats from now"): the whole tab is moved so its first chat goes
// out ~2 minutes after start. The pricing lock moves with it, so the 1h15m rule still holds.
const testShiftMs = cfg.testFromNow ? Date.now() + 2 * 60_000 - schedule[0].at.getTime() : 0;
const shiftRows = (list) => list.map((x) => ({ ...x, at: new Date(x.at.getTime() + testShiftMs) }));
if (testShiftMs) {
  schedule = shiftRows(schedule);
  log(`TEST MODE: chats moved to start from now → ${clock(schedule[0].at)} → ${clock(schedule.at(-1).at)}`);
}

// ---------- HARD RULE: no pricing before 1h15m into the session ----------
let sessionStart = (cfg.buyers && startDate(cfg.sessionStartClock)) || parseSessionStart(scheduleRows) || schedule.find((x) => !/pre/i.test(x.video))?.at || schedule[0].at;
if (testShiftMs && (cfg.buyers || parseSessionStart(scheduleRows))) sessionStart = new Date(sessionStart.getTime() + testShiftMs);
let unlockAt = new Date(sessionStart.getTime() + cfg.priceUnlockMin * 60_000);
if (cfg.buyers) unlockAt = new Date(0); // no pricing hold at all
// HARD RULE: no number asks of any kind before 1 hour into the session (NUMBER_UNLOCK_MIN, default 60)
const numberLocked = () => !cfg.buyers && Date.now() < sessionStart.getTime() + cfg.numberUnlockMin * 60_000;
const pricingLocked = () => !cfg.buyers && Date.now() < unlockAt.getTime();
log(cfg.buyers ? `Session start ${clock(sessionStart)} · buyers session – no pricing lock` : `Session start ${clock(sessionStart)} → number asks from ${clock(new Date(sessionStart.getTime() + cfg.numberUnlockMin * 60_000))} (${cfg.numberUnlockMin} min) · pricing unlocks at ${clock(unlockAt)} (${cfg.priceUnlockMin} min)`);
const sentKeys = new Set();

async function reloadSchedule() {
  try {
    const { rows, items } = await readSchedule();
    schedule = shiftRows(items);
    const st = cfg.buyers ? null : parseSessionStart(rows);
    if (st) {
      sessionStart = new Date(st.getTime() + testShiftMs);
      unlockAt = new Date(sessionStart.getTime() + cfg.priceUnlockMin * 60_000);
    }
  } catch (e) {
    log('schedule reload failed, keeping previous copy:', e.message);
  }
}

await agentLog.init();
await numbers.init();
record('START', '', '', '', `tab="${cfg.scheduleTab}" dryRun=${cfg.dryRun} autoReply=${cfg.autoReply} · pricing unlocks ${clock(unlockAt)}`);
const history = new History({ cfg, today, clock, log }); // written once, when the webinar ends

// ---------- Wait until it's time to join ----------
const joinAt = schedule[0].at.getTime() - cfg.joinEarlyMin * 60_000;
if (cfg.directUrl) log('Direct Zoom link given – joining right away as the host account');
else if (Date.now() < joinAt) {
  log(`Waiting until ${clock(new Date(joinAt))} to join`);
  while (Date.now() < joinAt) await sleep(Math.min(30_000, joinAt - Date.now()));
}

// ---------- Zoom ----------
const zoom = new Zoom(cfg);
await zoom.launch();
let loggedIn = await zoom.isLoggedIn();
if (!loggedIn && cfg.zoomEmail && cfg.zoomPassword) {
  log(`Zoom session expired – signing in with ${cfg.zoomAccount === 'arman' ? 'ZOOM_EMAIL_FIFTEEN / ZOOM_PASSWORD_FIFTEEN' : 'ZOOM_EMAIL / ZOOM_PASSWORD'}…`);
  const r = await zoom.login(cfg.zoomEmail, cfg.zoomPassword);
  loggedIn = r.ok;
  if (r.ok) {
    log('Signed in to Zoom again – the fresh session is saved back to GitHub after this run');
    record('LOGIN', '', '', '', 'session expired – signed in automatically');
  } else log(`Automatic sign-in failed: ${r.reason}`);
}
// HARD RULE: each webinar uses ITS OWN Zoom account (10 Min Business = ZOOM_EMAIL, 15 Days = ZOOM_EMAIL_FIFTEEN).
// If the saved login belongs to another account, sign out and sign in with the right one.
if (loggedIn && cfg.zoomEmail) {
  const me = await zoom.whoAmI().catch(() => '');
  if (me && me.toLowerCase() !== cfg.zoomEmail.trim().toLowerCase()) {
    log(`Saved Zoom login is ${mask(me)}, but this run must use ${mask(cfg.zoomEmail)} – switching account…`);
    await zoom.signOut();
    const r = cfg.zoomPassword ? await zoom.login(cfg.zoomEmail, cfg.zoomPassword) : { ok: false, reason: 'no password secret' };
    loggedIn = r.ok;
    if (r.ok) record('LOGIN', '', '', '', `switched from ${mask(me)} to ${mask(cfg.zoomEmail)} (right account for ${cfg.webinarName})`);
    else log(`Could not sign in as ${mask(cfg.zoomEmail)}: ${r.reason}`);
  }
}
if (loggedIn) {
  fs.writeFileSync('.session-ok', 'ok'); // tells the workflow it's safe to save the refreshed session
  log(`Zoom session is logged in as ${mask(await zoom.whoAmI().catch(() => ''))}`);
} else {
  // Logged out = Zoom would let it in only as an attendee, who can't see other people's chats or
  // reply privately. Stop with a clear message instead of sitting in the webinar doing nothing.
  const msg = 'Zoom login has expired and automatic sign-in did not work. On your Mac run: bash ~/webinar-chat-automation/scripts/refresh-session.sh, paste into the ' + (cfg.buyers ? 'ZOOM_SESSION_B64_FIFTEEN' : 'ZOOM_SESSION_B64') + ' secret and launch again.';
  log(`ERROR: ${msg}`);
  record('ERROR', '', '', '', msg);
  await agentLog.close().catch(() => {});
  await zoom.close();
  process.exit(1);
}

let triedAlt = false;
async function joinWithRetry() {
  // Stays idle until the webinar is live, then joins. Keeps trying until JOIN_WAIT_MIN (default 75) after
  // the first timed chat – so a late start is still picked up.
  const deadline = cfg.directUrl && cfg.testFromNow ? Date.now() + 60 * 60_000 : schedule[0].at.getTime() + cfg.joinWaitMin * 60_000;
  log(`Waiting for the webinar to go live – will keep trying until ${clock(new Date(deadline))}`);
  for (let i = 1; Date.now() < deadline; i++) {
    try {
      const how = await zoom.join(cfg.joinUrl, { panelistUrl: cfg.panelistUrl, directUrl: cfg.directUrl, deadline, onWait: (m) => log(m) });
      const role = await zoom.role().catch(() => 'unknown');
      log(`Joined the webinar via ${how} as ${role}`);
      record('JOINED', '', '', '', `via ${how} · role: ${role}`);
      const probe = await zoom.readChat().catch(() => []);
      log(`Chat check: ${probe.length} message(s) visible · ${await zoom.diagnose('after-join').catch((e) => 'diag failed ' + e.message)}`);
      if (role === 'attendee' || how === 'audience link') {
        // This Zoom account is not a host/panelist of this webinar. Never stay as an attendee:
        // 1) sign in with the other Zoom account and rejoin  2) otherwise stop with a clear message.
        const me = await zoom.whoAmI().catch(() => '');
        log(`This Zoom account (${mask(me)}) is NOT a host of this webinar – Zoom let it in only as an attendee`);
        if (!triedAlt && cfg.altZoomEmail && cfg.altZoomPassword && cfg.altZoomEmail.toLowerCase() !== me.toLowerCase()) {
          triedAlt = true;
          log(`Switching to the other Zoom account (${mask(cfg.altZoomEmail)}) and joining again…`);
          await zoom.signOut();
          const r = await zoom.login(cfg.altZoomEmail, cfg.altZoomPassword);
          if (r.ok) {
            fs.rmSync('.session-ok', { force: true }); // don't save this account over the other webinar's saved login
            record('LOGIN', '', '', '', `switched to ${mask(cfg.altZoomEmail)} – first account was not a host`);
            i = 0; // fresh attempts with the new account
            continue;
          }
          log(`Could not sign in to the other account: ${r.reason}`);
        }
        const msg = `Joined only as an ATTENDEE (no host powers with ${mask(me)}${triedAlt ? ' or ' + mask(cfg.altZoomEmail) : ''}). Stopped so nothing goes wrong. This run uses ${mask(cfg.zoomEmail)} – start the webinar from that Zoom account (or make it an alternative host / panelist), or choose the other Zoom account in step 03 on the dashboard.`;
        log(`ERROR: ${msg}`);
        record('ERROR', '', '', '', msg);
        await agentLog.close().catch(() => {});
        await zoom.close();
        process.exit(1);
      }
      return;
    } catch (e) {
      log(`Join attempt ${i} failed: ${e.message}`);
      await sleep(20_000);
    }
  }
  // No live webinar (holiday, cancelled, not scheduled today): finish cleanly instead of failing.
  const msg = `No live webinar found to join (waited until ${clock()}). Nothing was sent. If there is no webinar on some days, set "On" to no in the Auto Schedule tab.`;
  log(`NO WEBINAR: ${msg}`);
  record('NO WEBINAR', '', '', '', msg);
  await agentLog.close().catch(() => {});
  await zoom.close();
  process.exit(0);
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
      ownTexts.add(norm(job.text));
      record(job.kind, job.to, job.text, job.said || '', job.note || '');
      if (job.qa) history.qaRow({ ...job.qa, reply: job.text });
      if (job.to) {
        privateSent.push(Date.now());
        if (job.kind === 'NUMBER ASK') asksSent.push(Date.now());
        remember(job.to, 'me', job.text);
        recentSent.push(job.text);
        if (recentSent.length > 8) recentSent.shift();
      }
    } catch (e) {
      if (/sent privately/i.test(e.message)) ownTexts.add(norm(job.text));
      // a message for Everyone held because "to:" wasn't Everyone → try once more in a few seconds
      if (!job.to && /held/i.test(e.message) && !job.retried) {
        job.retried = true;
        job.notBefore = Date.now() + 5000;
        queue.push(job);
        log(`"to:" wasn't Everyone – holding "${job.text.slice(0, 40)}…" and retrying`);
      } else {
        log(`send failed (${job.kind} → ${job.to || 'Everyone'}): ${e.message}`);
        record('FAILED', job.to, job.text, job.said || '', e.message);
      }
      zoom.currentReceiver = undefined; // force re-selecting the receiver next time
    }
    lastSend = Date.now();
  }
}

// ---------- Timed chats from the sheet ----------
// When a timed chat goes out. Pricing chats (Price rows, money in Pitch rows, checkout links) never go out
// before the unlock: a few minutes early → held and posted at the unlock, in order; earlier → skipped.
function sendTime(item) {
  if (!isPricingChat(item) || item.at >= unlockAt) return item.at;
  const early = unlockAt - item.at;
  return early <= cfg.priceDeferMin * 60_000 ? new Date(unlockAt.getTime() + Math.max(0, cfg.priceDeferMin * 60_000 - early) / 60) : null;
}

async function scheduleLoop() {
  let lastReload = Date.now();
  while (running) {
    const now = Date.now();
    for (const item of schedule) {
      if (sentKeys.has(item.key)) continue;
      const at = sendTime(item);
      if (!at) {
        if (item.at.getTime() <= now) {
          sentKeys.add(item.key);
          record('SKIPPED', '', item.text, '', `row ${item.row} @ ${item.host}: pricing is locked until ${clock(unlockAt)}`);
        }
        continue;
      }
      if (at.getTime() > now) continue;
      sentKeys.add(item.key);
      const lateSec = (now - at.getTime()) / 1000;
      if (lateSec > cfg.lateGraceSec) {
        record('SKIPPED', '', item.text, '', `row ${item.row} was ${Math.round(lateSec)}s overdue`);
        continue;
      }
      const held = at.getTime() !== item.at.getTime() ? ` · held until pricing unlock ${clock(unlockAt)}` : '';
      enqueue({ prio: 0, text: item.text, to: null, kind: `TIMED ${item.type}`.trim(), note: `row ${item.row} @ ${item.host}${held}` });
    }
    if (now - lastReload > 60_000) {
      lastReload = now;
      await reloadSchedule();
    }
    await sleep(500);
  }
}

// ---------- Attendee chats ----------
const seen = new Map(); // "sender|text" → how many copies of it have been handled
const pending = new Map(); // sender → { texts: [], timer }
const lastReplyTo = new Map();
const objectionHits = []; // { key, sender, at }
const objectionPosted = new Map();
const newNumberNames = [];
let aiBusy = 0;

const teamSet = new Set([cfg.agentName.toLowerCase(), 'me', ...cfg.teamNames]);
// The agent's own messages show up in the chat under the Zoom account's name (e.g. the host's name).
// Anyone who "says" exactly what the agent just sent is the agent itself → treated as team from then on.
const ownTexts = new Set();
const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim().toLowerCase();
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
  if (!cfg.autoReply || !cfg.numberNudges || numberLocked() || !canAsk(sender)) return;
  if (person(sender).msgs < cfg.nudgeAfterMessages) return; // one "Yes" isn't enough – don't bomb everyone
  noteAsk(sender);
  const angle = numberBank.length ? numberBank[bankIdx++ % numberBank.length] : null;
  const text = await brain.compose({ purpose: 'ask', sender, said, lang: langOf(sender), history: person(sender).history, recent: recentSent, angle: angle && `${angle.angle} – ${angle.line}`, pricingLocked: pricingLocked() });
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
  if (cfg.buyers) return; // buyers' session: no lead collection
  const phone = findPhone(text);
  if (!phone) return;
  hasNumber.add(sender);
  // same attendee + same number → once; new number from the same person, or same number from someone else → saved
  const key = `${sender.toLowerCase()}|${phone.slice(-10)}`;
  if (savedNumbers.has(key)) return;
  savedNumbers.add(key);
  numbers.add([today, clock(), sender, phone, text, cfg.scheduleTab]);
  history.lead(phone);
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
  const ctx = () => ({ sender, lang, history: person(sender).history.slice(0, -1), recent: recentSent, pricingLocked: pricingLocked(), numberLocked: numberLocked() });
  const rest = phone ? text.replace(/\+?\d[\d\s-]{8,16}\d/g, ' ').replace(/^[\s,.;:-]+/, '').trim() : text;

  if (!cfg.autoReply) {
    // Timed-chats mode: no private messages at all. Numbers are still saved; real questions are logged for the team.
    if (!isTrivial(rest)) {
      record('QUESTION', sender, '', text, 'timed mode – answer manually');
      history.question();
      history.qaRow({ question: rest });
    }
    return;
  }

  if (phone && !thankedNumbers.has(phone) && !cfg.buyers) {
    thankedNumbers.add(phone);
    newNumberNames.push(firstName(sender));
    if (isTrivial(rest)) {
      // They shared their number: a short professional confirmation that the number went to our senior mentors.
      const thanks = await aiSlot(() => brain.compose({ purpose: 'thanks', said: text, ...ctx() }));
      enqueue({ prio: 1, text: thanks, to: sender, kind: 'NUMBER', said: text, note: lang });
      lastReplyTo.set(sender, Date.now());
      return;
    }
    text = rest; // "9876543210, EMI hai?" → one reply that thanks them AND answers (hasNumber is already set)
  }
  if (isTrivial(text)) {
    record('NO REPLY', sender, '', text, 'engagement answer ("1", "yes", emoji…) – no reply needed');
    return;
  }

  // Answer first, then – in the SAME reply – a smooth transition to the number (only after the 1-hour mark,
  // max NUDGE_MAX times per person, at least NUDGE_GAP_MIN apart, never once they've shared it).
  const askNow = !cfg.buyers && !numberLocked() && canAsk(sender);
  const d = await aiSlot(() => brain.decide({ text, hasNumber: hasNumber.has(sender), askNow, ...ctx() }));
  if (d.objection) noteObjection(d.objection, sender);
  if (d.action === 'reply' && d.reply) {
    history.question();
    enqueue({ prio: 2, text: d.reply, to: sender, kind: 'REPLY', said: text, note: lang, qa: { name: sender, lang, question: text, status: 'Answered' } });
    if (!cfg.buyers && !numberLocked() && asksForNumber(d.reply)) noteAsk(sender);
    lastReplyTo.set(sender, Date.now());
  } else if (d.action === 'escalate') {
    history.question();
    // AI didn't answer (no credits, outage, timeout…) → its own alert on the dashboard so a person replies
    const aiFailed = /^AI error/i.test(d.reason || '');
    record(aiFailed ? 'AI FAILED' : 'NEEDS TEAM', sender, '', text, aiFailed ? `AI did not answer – reply manually · ${String(d.reason).slice(0, 160)}` : d.reason || '');
    log(`${aiFailed ? 'AI FAILED' : 'NEEDS TEAM'}: ${sender}: ${text}`);
    const qa = { name: sender, lang, question: text, status: 'Needs team' };
    if (!aiFailed) history.qaRow({ question: text });
    else if (d.safe_to_ask !== false) enqueue({ prio: 1, text: fallbackReply(sender, lang, { aiFailed, askNow }), to: sender, kind: 'REPLY', said: text, note: `AI failed · fallback · ${lang}`, qa });
  } else if (d.safe_to_ask !== false && !phone && cfg.numberNudges && !cfg.buyers) {
    await aiSlot(() => askForNumber(sender, text, 'chatting, no number yet'));
  }
  // action "ignore" (greetings, compliments, chit-chat): no reply – logged so the dashboard shows why
  if (d.action === 'ignore') record('NO REPLY', sender, '', text, d.reason ? `no reply needed · ${String(d.reason).slice(0, 80)}` : 'no reply needed');
}

// When the AI can't answer: acknowledge the doubt politely and (after the 1-hour mark) add the approved transition:
//   "Sir will cover this in today's session – please stay connected till the end. If you'd like a mentor to guide
//    your first steps personally, you can share your number here."
function fallbackReply(sender, lang, { aiFailed, askNow }) {
  const n = firstName(sender);
  const first = (aiFailed || numberLocked() ? FALLBACK.later : FALLBACK.help)[lang] || FALLBACK.later.english;
  const base = first(n);
  return askNow && !numberLocked() ? `${base} ${(FALLBACK.ask[lang] || FALLBACK.ask.english)('')}` : base;
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
    if (pricingLocked() && mentionsPrice(o.chat)) return; // e.g. "EMI from Rs. 59/day" – not before the pricing section
    objectionPosted.set(key, now);
    record('NEEDS TEAM', 'Everyone', '', o.objection, `${people.size} people raised this – suggested answer: ${o.chat}`);
  }
}

async function chatLoop() {
  let first = true;
  let emptySince = Date.now();
  let diagN = 0;
  while (running) {
    let msgs = [];
    try {
      msgs = await zoom.readChat();
    } catch (e) {
      log('readChat failed:', e.message);
    }
    // Nothing readable for 5 min → log what the page looks like (max 3 times) so selectors can be fixed
    if (msgs.length) emptySince = Date.now();
    else if (Date.now() - emptySince > 5 * 60_000 && diagN < 3) {
      emptySince = Date.now();
      diagN++;
      log(`Chat panel still shows 0 messages · ${await zoom.diagnose(`empty-chat-${diagN}`).catch(() => 'diag failed')}`);
    }
    // New messages = more copies of a (sender, text) on screen than we've already handled. So a person who
    // types "what's the pricing" three times gets each one counted, and old messages are never re-answered.
    const onScreen = new Map();
    const fresh = [];
    for (const m of msgs) {
      const key = `${m.sender}|${m.text}`;
      const n = (onScreen.get(key) || 0) + 1;
      onScreen.set(key, n);
      if (n > (seen.get(key) || 0)) fresh.push(m);
    }
    for (const [key, n] of onScreen) if (n > (seen.get(key) || 0)) seen.set(key, n);
    for (const m of fresh) {
      if (first) continue; // don't answer chat history from before we joined
      if (ownTexts.has(norm(m.text))) {
        const self = cleanSender(m.sender).name.toLowerCase();
        if (self && !teamSet.has(self)) {
          teamSet.add(self);
          log(`Recognised "${self}" as the agent's own Zoom name – its messages are ignored`);
        }
        continue;
      }
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
    if (!running || !newNumberNames.length || numberLocked()) continue; // its "share your number" line waits for the 1-hour mark
    const names = [...new Set(newNumberNames.splice(0))].filter(Boolean).slice(-3);
    if (!names.length) continue;
    const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} & ${names.at(-1)}`;
    const lines = [
      `${list} – your numbers have been shared with our senior mentors, who will call you shortly. Anyone else who would like personal guidance, please share your contact number here.`,
      `${list} – aapke numbers humare senior mentors ko bhej diye gaye hain, jald hi call aayega. Baaki sabhi bhi guidance ke liye apna contact number share kar sakte hain.`,
      `Our senior mentors will be calling ${list} shortly. Others who would like a call, please share your number in the chat.`,
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

const workers = [senderLoop(), scheduleLoop(), chatLoop(), attendeeLoop()];

async function shutdown(reason) {
  if (!running) return;
  running = false;
  log('Stopping:', reason);
  record('STOP', '', '', '', reason);
  // Only keep the refreshed session if it's still logged in – never overwrite the good saved login
  // with a logged-out one.
  if (await zoom.isLoggedIn().catch(() => false)) await zoom.saveSession().catch((e) => log('could not save session', e.message));
  else {
    fs.rmSync('.session-ok', { force: true });
    log('WARNING: Zoom session is no longer logged in – not saving it (run save-session again)');
  }
  await Promise.all([agentLog.close(), numbers.close(), cfg.buyers ? null : history.write()]); // 15 Days: no webinar history
  await zoom.close();
}

process.on('SIGTERM', () => shutdown('SIGTERM').then(() => process.exit(0)));
process.on('SIGINT', () => shutdown('SIGINT').then(() => process.exit(0)));

while (running) {
  await sleep(15_000);
  const last = schedule.at(-1).at.getTime();
  // With a direct link it stays until the webinar itself ends (handy for tests outside the tab's times)
  if (!cfg.directUrl && Date.now() > last + cfg.endAfterLastMin * 60_000 && !queue.length) await shutdown('all timed chats done');
  else if (Date.now() - startedAt > cfg.maxRuntimeMin * 60_000) await shutdown('max runtime reached');
  else if (await zoom.hasEnded().catch(() => false)) await shutdown('webinar ended');
}
await Promise.allSettled(workers);
process.exit(0);
