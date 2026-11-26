import fs from 'node:fs';
import { loadConfig } from './config.js';
import { Sheet, SheetLogger } from './sheets.js';
import { parseFifteen, startDate, isDayTab, parseSchedule, parseReplies, parseObjections, parseNumberBank, parseSessionStart, isPricingChat } from './schedule.js';
import { Brain, FALLBACK, findPhone, isTrivial, needsReply, stripQuote, PROBLEM_WORDS, firstName, asksForNumber, detectLang, mentionsPrice } from './brain.js';
import { Zoom } from './zoom.js';
import { ChatSync } from './chatsync.js';
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
// facts the AI can always use: when this session runs (from the timesheet)
const sessionFacts = () => {
  const end = schedule.at(-1).at, hrs = Math.round(((end - sessionStart) / 3600e3) * 2) / 2;
  return [{ when: 'Asks how long the session is / when it ends / what time it started', reply: `Today's session started at ${clock(sessionStart).replace(/:00(?= )/, '')} and runs till about ${clock(end).replace(/:\d\d(?= )/, '')} (around ${hrs} hours) – please stay connected till the end.` }];
};
brain.setReplies([...replies, ...sessionFacts()]);
// answers the team saves from the dashboard land in the Attendee Replies tab – picked up every 5 min
setInterval(async () => {
  try {
    const fresh = parseReplies(await (cfg.buyers ? schedSheet : sheet).read(cfg.repliesTab));
    if (fresh.length && fresh.length !== replies.length) {
      log(`Answers updated: ${fresh.length - replies.length > 0 ? '+' : ''}${fresh.length - replies.length} (now ${fresh.length})`);
      replies = fresh;
      brain.setReplies([...replies, ...sessionFacts()]);
    }
  } catch {}
}, 5 * 60_000).unref();
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
  // A run that starts hours before its webinar (e.g. a second launch that waited in GitHub's queue until the first
  // agent finished at midnight) would sit idle all night – stop it cleanly instead.
  const early = schedule[0].at.getTime() - Date.now();
  if (!cfg.directUrl && !cfg.testFromNow && early > 3 * 3600e3) {
    const msg = `Started ${Math.round(early / 3600e3)} h before the first chat (${clock(schedule[0].at)}) – this looks like an extra launch, so it stops. The next webinar starts on its own.`;
    log(`TOO EARLY: ${msg}`);
    record('NO WEBINAR', '', '', '', msg);
    await agentLog.close().catch(() => {});
    await zoom.close();
    process.exit(0);
  }
  // Stays idle until the webinar is live, then joins. Keeps trying until JOIN_WAIT_MIN (default 75) after
  // the first timed chat – so a late start is still picked up.
  // keep trying until 75 min after the first chat – or, when (re)started mid-webinar, until the last timed chat
  const deadline = cfg.directUrl && cfg.testFromNow ? Date.now() + 60 * 60_000 : Math.max(schedule[0].at.getTime() + cfg.joinWaitMin * 60_000, schedule.at(-1).at.getTime());
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
// "Crowd mode": Sir (in the recording or a timed chat) asked everyone to type something, so dozens of
// people answer at once. Then only clear, real questions get an AI reply.
let lastPromptAt = 0;
let lastIncomingAt = Date.now();
const arrivals = []; // { at, sender }
function crowdMode() {
  const now = Date.now();
  while (arrivals.length && now - arrivals[0].at > 60_000) arrivals.shift();
  return now - lastPromptAt < 3 * 60_000 || new Set(arrivals.map((a) => a.sender)).size >= 6;
}
const STRONG_QUESTION = /[?？]|\b(what|how|why|when|where|which|kya|kaise|kese|kaisa|kyu|kyun|kab|kahan|kitna|kitni|kitne|price|cost|fee|fees|emi|refund|payment|pay|link|login|access|problem|issue|error|support|hindi)\b|क्या|कैसे|कितना|कब|कहाँ|क्यों/i;

// Proof the agent is still connected: a message it sends to Everyone must appear in its own chat.
// Two in a row that don't → the Zoom window has dropped out of the webinar → the watchdog rejoins.
let echoMisses = 0;
let echoProven = false; // the check only counts once it has worked at least once (Zoom markup can change)
function checkEcho(text) {
  setTimeout(async () => {
    if (!running) return;
    if (await zoom.seenInChat(text)) {
      echoMisses = 0;
      echoProven = true;
    } else if (echoProven) {
      echoMisses++;
      log(`⚠ Sent "${text.slice(0, 40)}…" but it did not appear in the chat (${echoMisses} in a row)`);
    }
  }, 6000);
}

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
      .filter((j) => !j.to || !privateFull || j.kind === 'TEAM REPLY') // public timed chats and team replies are never held back
      .filter((j) => j.kind !== 'NUMBER ASK' || !asksFull)
      .sort((a, b) => a.prio - b.prio || a.notBefore - b.notBefore);
    const job = ready[0];
    if (!job) {
      await sleep(250);
      continue;
    }
    queue.splice(queue.indexOf(job), 1);
    if (job.skipIf?.()) continue; // e.g. a number ask for someone who has since shared their number
    if (job.to && job.kind !== 'NUMBER' && job.kind !== 'TEAM REPLY' && now - job.at > 15 * 60_000) {
      record('SKIPPED', job.to, job.text, job.said || '', 'reply waited over 15 min – too late to feel natural');
      continue;
    }
    try {
      await zoom.send(job.text, job.to);
      ownTexts.add(norm(job.text));
      if (!job.to) checkEcho(job.text);
      if (!job.to && /^TIMED/.test(job.kind) && /\b(type|comment|write|tell|reply|drop|answer|share your (city|goal|business|niche|experience))\b/i.test(job.text) && !asksForNumber(job.text)) lastPromptAt = Date.now();
      record(job.kind, job.to, job.text, job.said || '', job.note || '');
      job.onDone?.(true);
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
        job.onDone?.(false, e.message);
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

const runStartedAt = Date.now();
let quietSkipped = 0;
async function scheduleLoop() {
  setTimeout(() => { if (quietSkipped) log(`${quietSkipped} timed chats were already past when this run started – skipped (the next one goes out on time)`); }, 20_000);
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
        // chats that were already past when this run started (e.g. a restart mid-webinar) are skipped quietly
        if (at.getTime() < runStartedAt - 60_000) { quietSkipped++; continue; }
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
// numbers already saved today (by an earlier run of the same webinar) – never saved, chimed or asked again
if (!cfg.buyers) {
  try {
    const rows = await sheet.read(cfg.numbersTab, 'A1:F3000');
    let n = 0;
    for (const r of rows.slice(1)) {
      if (String(r[0]).trim() !== today || String(r[5] || '').trim() !== cfg.scheduleTab) continue;
      const name = String(r[2] || '').trim(), phone = String(r[3] || '').replace(/\D/g, '');
      if (!name || phone.length < 10) continue;
      savedNumbers.add(`${name.toLowerCase()}|${phone.slice(-10)}`);
      thankedNumbers.add(phone.slice(-10));
      hasNumber.add(name);
      n++;
    }
    if (n) log(`Loaded ${n} number(s) already saved today – they won't be saved or asked again`);
  } catch {}
}
// attendee messages already logged today (by an earlier run) – a restart never logs or answers them twice
const loggedToday = new Map(); // "sender|text" → count
try {
  const rows = await sheet.read(cfg.logTab, 'A1:F20000');
  for (const r of rows) if (String(r[0]).trim() === today && String(r[2]).trim() === 'IN') { const k = `${String(r[3]).trim()}|${String(r[5]).trim()}`; loggedToday.set(k, (loggedToday.get(k) || 0) + 1); }
  if (loggedToday.size) log(`Loaded today's chat so far (${[...loggedToday.values()].reduce((a, b) => a + b, 0)} attendee messages) – none of them is logged or answered twice`);
} catch {}
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

function saveNumber(sender, text, when = '') {
  if (cfg.buyers) return; // buyers' session: no lead collection
  const phone = findPhone(text);
  if (!phone) return;
  hasNumber.add(sender);
  // same attendee + same number → once; new number from the same person, or same number from someone else → saved
  const key = `${sender.toLowerCase()}|${phone.slice(-10)}`;
  if (savedNumbers.has(key)) return;
  savedNumbers.add(key);
  numbers.add([today, zoomTime(when) || clock(), sender, phone, text, cfg.scheduleTab]); // the time they SENT it in Zoom
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
const lastHoldTo = new Map();
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
  // City names, "first time", "type 2", "Cosmetic", "thank you sir"… are answers to Sir, not questions:
  // no AI call (saves the free AI limit for real questions) and no reply.
  if (!needsReply(text)) {
    record('NO REPLY', sender, '', text, 'not a question – no reply needed');
    return;
  }
  if (crowdMode() && !STRONG_QUESTION.test(text) && !PROBLEM_WORDS.test(text)) {
    record('NO REPLY', sender, '', text, "answer to Sir's prompt (many people typing) – no reply needed");
    return;
  }

  // Answer first, then – in the SAME reply – a smooth transition to the number (only after the 1-hour mark,
  // max NUDGE_MAX times per person, at least NUDGE_GAP_MIN apart, never once they've shared it).
  const askNow = !cfg.buyers && !numberLocked() && canAsk(sender);
  const d = await aiSlot(() => brain.decide({ text, hasNumber: hasNumber.has(sender), askNow, ...ctx() }));
  if (d.objection) noteObjection(d.objection, sender);
  if ((d.action === 'reply' || d.action === 'escalate') && d.reply) {
    // The AI answers as much as it can. A general answer (not from the sheet's facts) or a case a person should
    // look at is still SENT – and once it's out, the dashboard shows "check this reply" so the team can follow up.
    history.question();
    const check = d.action === 'escalate' ? `needs a person – ${String(d.reason || '').slice(0, 100)}` : d.from_facts === false ? 'general answer – not from the sheet' : '';
    enqueue({
      prio: 2, text: d.reply, to: sender, kind: 'REPLY', said: text, note: lang, qa: { name: sender, lang, question: text, status: 'Answered' },
      onDone: check ? (ok) => ok && record('REVIEW', sender, d.reply, text, `Check this reply once (${check}) – send a better one from the dashboard if needed`) : undefined,
    });
    if (!cfg.buyers && !numberLocked() && asksForNumber(d.reply)) noteAsk(sender);
    lastReplyTo.set(sender, Date.now());
  } else if (d.action === 'escalate') {
    history.question();
    // nothing sendable (AI down, or its reply was only a promise) → alert so a person replies
    const aiFailed = /^AI error/i.test(d.reason || '');
    record(aiFailed ? 'AI FAILED' : 'NEEDS TEAM', sender, '', text, aiFailed ? `AI did not answer – reply manually · ${String(d.reason).slice(0, 160)}` : d.reason || '');
    log(`${aiFailed ? 'AI FAILED' : 'NEEDS TEAM'}: ${sender}: ${text}`);
    history.qaRow({ question: text });
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
    // Not posted to Everyone any more – only the timesheet's chats go public. Logged for the team instead.
    record('NEEDS TEAM', 'Everyone', '', o.objection, `${people.size} people raised this – suggested answer: ${o.chat}`);
  }
}

// ---------- Replies typed on the dashboard ----------
// The dashboard (through the sheet's Apps Script) adds rows to the "Outbox" tab:
//   A sent at (ISO) · B to (attendee name, empty = Everyone) · C message · D status · E id · F from
// The agent picks up "pending" rows every few seconds, sends them in Zoom (private reply or to Everyone)
// and writes the status back: queued → sent / failed: reason.
const OUTBOX = 'Outbox';
const outboxSeen = new Set();
async function outboxLoop() {
  const startedAtMs = Date.now();
  while (running) {
    await sleep(3000);
    let rows = [];
    try {
      rows = await sheet.read(OUTBOX, 'A1:F2000');
    } catch {
      continue; // no Outbox tab yet – created by the first reply from the dashboard
    }
    rows.forEach((r, i) => {
      if (i === 0) return; // header
      const [at, to, text, status, id] = r;
      const key = id || `${at}|${to}|${text}`;
      if (outboxSeen.has(key) || String(status || '').toLowerCase() !== 'pending' || !String(text || '').trim()) return;
      outboxSeen.add(key);
      const rowNo = i + 1;
      const setStatus = (st) => sheet.updateRow(OUTBOX, rowNo, [at, to, text, st, id, r[5] || '']).catch(() => {});
      // only replies typed during this run (an old pending row from another day is never sent)
      if (Date.parse(at) && Date.parse(at) < startedAtMs - 15 * 60_000) return void setStatus('expired – typed before this run');
      if (cfg.dryRun) return void setStatus('not sent – dry run');
      const name = String(to || '').trim();
      log(`Team reply from the dashboard → ${name || 'Everyone'}: ${String(text).slice(0, 60)}`);
      setStatus('queued');
      queue.push({ at: Date.now(), notBefore: Date.now(), prio: 0, text: String(text).trim(), to: name && name.toLowerCase() !== 'everyone' ? name : null, kind: 'TEAM REPLY', note: 'typed on the dashboard', onDone: (ok, why) => setStatus(ok ? 'sent' : `failed: ${String(why || '').slice(0, 120)}`) });
    });
  }
}

// Number safety net: read the whole chat from the top and save any number that isn't saved yet.
let sweepSoon = false;
let lastSweep = Date.now();
async function sweepNumbers(why) {
  lastSweep = Date.now();
  sweepSoon = false;
  const msgs = await zoom.sweepChat().catch((e) => (log('chat sweep failed:', e.message), []));
  const withIds = msgs.filter((m) => m.id && m.idx != null);
  let found = 0;
  if (withIds.length) found = intake(withIds, { catchup: true });
  else {
    // older Zoom markup without message ids: numbers only
    for (const m of msgs) {
      const { name, isTeam } = cleanSender(m.sender || '');
      if (!name || isTeam || ownTexts.has(norm(m.text))) continue;
      const said = stripQuote(m.text);
      const phone = findPhone(said);
      if (!phone || savedNumbers.has(`${name.toLowerCase()}|${phone.slice(-10)}`)) continue;
      found++;
      record('IN', name, '', m.text, `found in chat check (${why})`);
      saveNumber(name, said, m.time);
    }
  }
  const total = maxIdx >= 0 ? maxIdx + 1 : msgs.length;
  log(`Chat check (${why}): read ${new Set(withIds.map((m) => m.idx)).size || msgs.length} of ${total} messages · ${found} not seen before · ${missingPositions()} still missing`);
}

// ---------- Every message, exactly once (by Zoom's message id and position) ----------
const seenIds = new Set(); // Zoom message ids already taken in
const byIdx = new Map(); // chat position → { sender, to, time }
const pendingIds = new Map(); // id → message whose sender isn't known yet (group header off-screen)
let firstIdx = null; // first chat position this run has seen
let maxIdx = -1;
let lastGapSweep = 0;
// Takes in a batch of messages ({id, idx, sender, to, time, text}); returns how many were new.
//   catchup: the chat as it was when this run joined, and everything the full-chat check finds – logged (unless an
//            earlier run already logged it today), numbers saved, answered only if sent in the last 10 minutes
//   otherwise: live messages – logged, numbers saved, answered
function intake(list, { catchup = false } = {}) {
  let fresh = 0;
  const items = list.filter((m) => m && m.id && m.idx != null).sort((a, b) => a.idx - b.idx);
  for (const m of items) if (m.sender) byIdx.set(m.idx, { sender: m.sender, to: m.to, time: m.time });
  const take = (m) => {
    if (seenIds.has(m.id)) return true;
    let r = m;
    if (!r.sender) {
      const prev = byIdx.get(m.idx - 1); // a group continuation: same sender as the message above it
      if (!prev?.sender) return false;
      r = { ...m, sender: prev.sender, to: m.to || prev.to, time: m.time || prev.time };
    }
    byIdx.set(r.idx, { sender: r.sender, to: r.to, time: r.time });
    seenIds.add(r.id);
    pendingIds.delete(r.id);
    if (firstIdx == null || r.idx < firstIdx) firstIdx = r.idx;
    if (r.idx > maxIdx) maxIdx = r.idx;
    fresh++;
    if (catchup) {
      const { name, isTeam } = cleanSender(r.sender);
      const k = `${name}|${String(r.text).trim()}`;
      if (name && !isTeam && loggedToday.get(k) > 0) {
        loggedToday.set(k, loggedToday.get(k) - 1); // an earlier run logged it already
        saveNumber(name, stripQuote(r.text), r.time); // (no-op if saved)
        fresh--;
      } else {
        const sentAt = zoomDate(r.time);
        const recent = sentAt && Date.now() - sentAt < 10 * 60_000;
        handleIncoming(r, { note: `found in chat check${r.time ? ` · sent ${zoomTime(r.time)}` : ''}`, noReply: !recent });
      }
    } else handleIncoming(r);
    return true;
  };
  for (const m of items) if (!take(m)) pendingIds.set(m.id, m);
  for (const m of [...pendingIds.values()]) take(m); // a later batch may have filled in the sender
  return fresh;
}
// positions between the first and newest message this run has seen, that it never got → fetch them
function missingPositions() {
  if (firstIdx == null) return 0;
  let n = 0;
  for (let i = firstIdx; i <= maxIdx; i++) if (!byIdx.has(i)) n++;
  return n;
}

let joinedSeen = false;
async function chatLoop() {
  let sync = new ChatSync();
  let joinSeen = zoom.joinCount;
  let emptySince = Date.now();
  let diagN = 0;
  let dumped = false;
  let lastGapLog = 0;
  while (running) {
    let windows = [];
    try {
      windows = await zoom.readChatWindows();
    } catch (e) {
      log('readChat failed:', e.message);
    }
    if (zoom.joinCount !== joinSeen) {
      joinSeen = zoom.joinCount; // rejoined: start fresh, so chat from before is not answered again
      sync = new ChatSync();
      byIdx.clear(); pendingIds.clear(); firstIdx = null; maxIdx = -1; // positions restart after a rejoin (ids don't)
    }
    const now = windows.at(-1) || [];
    // Nothing readable for 5 min → log what the page looks like (max 3 times) so selectors can be fixed
    if (now.length) emptySince = Date.now();
    else if (Date.now() - emptySince > 5 * 60_000 && diagN < 3) {
      emptySince = Date.now();
      diagN++;
      log(`Chat panel still shows 0 messages · ${await zoom.diagnose(`empty-chat-${diagN}`).catch(() => 'diag failed')}`);
    }
    if (now.length && !dumped) {
      dumped = true;
      zoom.dumpChatItems().catch(() => {});
    }
    // Every snapshot of the panel since the last read, oldest first. New messages are matched by their
    // order in the chat, so repeats ("ok", "0", the same question twice) are each handled exactly once.
    let idPath = false;
    for (const win of windows) {
      if (win.some((m) => m.id && m.idx != null)) {
        idPath = true;
        if (!joinedSeen) {
          joinedSeen = true;
          intake(win, { catchup: true });
          sweepSoon = true; // then read the whole chat once: nothing typed before/while joining is lost
        } else intake(win);
        continue;
      }
      const { fresh, gap } = sync.ingest(win.filter((m) => m.sender));
      if (gap && Date.now() - lastGapLog > 60_000) {
        lastGapLog = Date.now();
        log(`⚠ Chat moved faster than Zoom keeps on screen – a few messages before "${String(fresh[0]?.text || '').slice(0, 40)}" may have been missed`);
        record('NEEDS TEAM', 'Zoom chat', '', 'Chat burst', 'A few messages may have scrolled past the agent – please glance at the Zoom chat');
      }
      for (const m of fresh) handleIncoming(m);
      if (gap) sweepSoon = true;
    }
    // a skipped position in the chat → fetch it right away (at most once a minute)
    const missing = idPath ? missingPositions() : 0;
    if (missing && Date.now() - lastGapSweep > 60_000) {
      lastGapSweep = Date.now();
      log(`${missing} message(s) scrolled past before they were read – fetching them`);
      sweepSoon = true;
    }
    if (running && (sweepSoon || Date.now() - lastSweep > 5 * 60_000)) await sweepNumbers(sweepSoon ? 'fetching missed messages' : 'every 5 min');
    await sleep(400);
  }
}

// "7:15:22 PM" (Zoom) → "7:15:22 pm" (sheet style)
const zoomTime = (t) => { const m = String(t || '').match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]M)$/i); return m ? `${Number(m[1])}:${m[2]}:${m[3] || '00'} ${m[4].toLowerCase()}` : ''; };
const zoomDate = (t) => { const c = zoomTime(t); if (!c) return null; const [hms, ap] = c.split(' '); let [h, mi, se] = hms.split(':').map(Number); if (ap === 'pm' && h < 12) h += 12; if (ap === 'am' && h === 12) h = 0; const d = new Date(); d.setHours(h, mi, se, 0); return d; };
function handleIncoming(m, { note = '', noReply = false } = {}) {
  if (ownTexts.has(norm(m.text))) {
    const self = cleanSender(m.sender).name.toLowerCase();
    if (self && !teamSet.has(self)) {
      teamSet.add(self);
      log(`Recognised "${self}" as the agent's own Zoom name – its messages are ignored`);
    }
    return;
  }
  const { name, isTeam } = cleanSender(m.sender);
  if (!name || isTeam) return;
  record('IN', name, '', m.text, note || (m.time ? `sent ${zoomTime(m.time)}` : '')); // every attendee message, so the dashboard can show full conversations
  const said = stripQuote(m.text); // without Zoom's 'Replying to "…"' part
  arrivals.push({ at: Date.now(), sender: name });
  lastIncomingAt = Date.now();
  noteIncoming(name, said);
  history.chatter(name);
  saveNumber(name, said, m.time);
  if (!noReply) queueAttendee(name, said);
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

// Social proof ("Rahul, Iqra & Pradnya – your numbers have been shared…" to Everyone) is switched OFF for good:
// it named attendees publicly and was not in the timesheet. Only the sheet's timed chats go to Everyone.
const workers = [senderLoop(), scheduleLoop(), chatLoop(), attendeeLoop(), outboxLoop()];

async function shutdown(reason) {
  if (!running) return;
  running = false;
  log('Stopping:', reason);
  if (!/SIGTERM|SIGINT/.test(reason) && !(await zoom.hasEnded().catch(() => true))) await sweepNumbers('end of webinar'); // every number, before leaving
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

// Every 15 s: is the agent still really in the webinar? If not, rejoin by itself (timed chats that came
// due meanwhile are sent if still within the grace time, otherwise skipped – nothing is sent twice).
let problemSince = 0;
let rejoins = 0;
async function watchdog() {
  let why = await zoom.connectionProblem().catch(() => '');
  if (!why && echoMisses >= 2) why = `${echoMisses} sent messages did not appear in the chat`;
  if (!why) {
    problemSince = 0;
    return;
  }
  if (!problemSince) {
    problemSince = Date.now();
    log(`⚠ Connection check: ${why} – checking again`);
    if (echoMisses < 2) return; // a screen-text hint gets one more check before rejoining
  }
  if (rejoins >= 6) return;
  rejoins++;
  echoMisses = 0;
  problemSince = 0;
  log(`⚠ The agent dropped out of the webinar (${why}) – rejoining (attempt ${rejoins})`);
  record('NEEDS TEAM', 'Zoom', '', 'Agent disconnected', `Agent dropped out of the webinar (${why}) – rejoining by itself. If this repeats, check nobody else opened the webinar with the agent's Zoom account.`);
  const deadline = Date.now() + 10 * 60_000;
  for (let i = 1; Date.now() < deadline && running; i++) {
    try {
      const how = await zoom.join(cfg.joinUrl, { panelistUrl: cfg.panelistUrl, directUrl: cfg.directUrl, deadline, onWait: (m) => log(m) });
      const role = await zoom.role().catch(() => 'unknown');
      log(`Rejoined via ${how} as ${role}`);
      record('JOINED', '', '', '', `rejoined via ${how} · role: ${role}`);
      return;
    } catch (e) {
      log(`Rejoin attempt ${i} failed: ${e.message}`);
      await sleep(15_000);
    }
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM').then(() => process.exit(0)));
process.on('SIGINT', () => shutdown('SIGINT').then(() => process.exit(0)));

while (running) {
  await sleep(15_000);
  const last = schedule.at(-1).at.getTime();
  // With a direct link it stays until the webinar itself ends (handy for tests outside the tab's times)
  // After the last timed chat people still share numbers – keep listening until the chat has been quiet for
  // 10 min (or 90 min after the last timed chat), unless Zoom ends the webinar first.
  const quiet = Date.now() - lastIncomingAt > 10 * 60_000;
  if (!cfg.directUrl && Date.now() > last + cfg.endAfterLastMin * 60_000 && !queue.length && (quiet || Date.now() > last + 90 * 60_000)) await shutdown('all timed chats done and the chat has gone quiet');
  else if (Date.now() - startedAt > cfg.maxRuntimeMin * 60_000) await shutdown('max runtime reached');
  else if (await zoom.hasEnded().catch(() => false)) await shutdown('webinar ended');
  else await watchdog();
}
await Promise.allSettled(workers);
process.exit(0);
