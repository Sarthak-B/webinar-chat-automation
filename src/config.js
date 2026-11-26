// All settings come from environment variables (GitHub secrets / repo variables).
const env = (k, d) => (process.env[k] ?? '').trim() || d;
// A sheet setting may be pasted as the full link – keep only the ID part
const sheetIdOf = (v) => String(v || '').match(/\/d\/([A-Za-z0-9_-]{20,})/)?.[1] || String(v || '').trim();
const req = (k) => {
  const v = env(k);
  if (!v) {
    throw new Error(
      `Missing setting ${k}. Add it in GitHub → repo Settings → Secrets and variables → Actions ` +
        `(${/KEY|JSON|TOKEN|SESSION/.test(k) ? 'Secrets' : 'Variables'} tab), name exactly "${k}".`,
    );
  }
  return v;
};
const num = (k, d) => Number(env(k, String(d)));
const bool = (k, d = false) => {
  const v = env(k);
  return v ? ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()) : d;
};
const list = (k) => env(k, '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

// The two webinars the agent can run. WEBINAR = business (default) | fifteen
export const WEBINARS = {
  business: { name: '10 Min Business', joinUrl: 'https://sb.flexifunnels.com/genie-demo' },
  fifteen: {
    name: '15 Days First Sale Challenge',
    joinUrl: 'https://sb.flexifunnels.com/fifteendays',
    sheetId: '1T4UCbX34Yyxw14VFcN1xsTMlMnH-ffR0f21BgYegZ5w', // "15 Days Challenge Chats" – one tab per day
    start: '7:00 PM', // the Minute/Second columns count from here
  },
};

export function loadConfig() {
  const webinar = /^(fifteen|15)/i.test(env('WEBINAR', '')) ? 'fifteen' : 'business';
  const W = WEBINARS[webinar];
  return {
    webinar,
    webinarName: W.name,
    buyers: webinar === 'fifteen', // buyers' session: timed chats + doubt clearing only, no number asks, no pricing lock
    // where the timed chats come from (logs, numbers etc. always go to the main chat sheet)
    scheduleSheetId: webinar === 'fifteen' ? sheetIdOf(env('FIFTEEN_SHEET_ID', W.sheetId)) : '',
    sessionStartClock: webinar === 'fifteen' ? env('FIFTEEN_START', W.start) : '',
    // Zoom
    // One universal link for every webinar (redirects to the live Zoom webinar). Override with the ZOOM_JOIN_URL variable if it ever changes.
    joinUrl: webinar === 'fifteen' ? env('FIFTEEN_JOIN_URL', W.joinUrl) : env('ZOOM_JOIN_URL', W.joinUrl),
    // Optional: the agent account's personal PANELIST link (Zoom emails it when you add the account as a panelist).
    panelistUrl: env('ZOOM_PANELIST_URL', ''),
    testFromNow: /^(1|true|yes)$/i.test(env('TEST_FROM_NOW', '')), // test: move the tab's chats to start now
    directUrl: env('ZOOM_DIRECT_URL', ''),
    // Zoom account: auto = 10 Min Business → ZOOM_EMAIL (marketing@), 15 Days → ZOOM_EMAIL_FIFTEEN (arman@);
    // the dashboard can override it per run (tests): ZOOM_ACCOUNT = marketing | arman
    ...(() => {
      const acc = env('ZOOM_ACCOUNT', 'auto');
      const useFifteen = acc === 'arman' || (acc !== 'marketing' && webinar === 'fifteen');
      return {
        zoomAccount: useFifteen ? 'arman' : 'marketing',
        zoomEmail: useFifteen ? env('ZOOM_EMAIL_FIFTEEN', '') : env('ZOOM_EMAIL', ''),
        zoomPassword: useFifteen ? env('ZOOM_PASSWORD_FIFTEEN', '') : env('ZOOM_PASSWORD', ''),
      };
    })(),
    // no switching to the other webinar's account: 10 Min Business = marketing@ only, 15 Days = arman@ only
    altZoomEmail: '',
    altZoomPassword: '',
    sessionFile: env('ZOOM_SESSION_FILE', 'zoom-session.json'),
    agentName: env('AGENT_NAME', 'FlexiFunnels Support'),
    // chats from these names are never answered or counted. The agent, the host and the panelist all use the
    // presenter's name in Zoom (attendees see Saurabh Bhatnagar replying), so that name is always the team.
    teamNames: [...new Set([...list('TEAM_NAMES'), ...list('PRESENTER_ZOOM_NAMES'), 'saurabh bhatnagar'])],
    headless: bool('HEADLESS', false), // CI runs headed inside xvfb; Zoom is friendlier to that
    joinEarlyMin: num('JOIN_EARLY_MIN', 5), // start trying to join this many minutes before the first chat row
    joinWaitMin: num('JOIN_WAIT_MIN', 75), // keep waiting for the webinar to go live until this long after the first chat

    // Google Sheet
    // FlexiGenie chat sheet (built-in default; a SHEET_ID variable overrides it). The ID alone gives no access.
    // 10 Min Business → FlexiGenie chat sheet · 15 Days → 15 Days Challenge Chats sheet (logs, numbers, everything)
    sheetId: sheetIdOf(webinar === 'fifteen' ? env('FIFTEEN_SHEET_ID', W.sheetId) : env('SHEET_ID', '1sx70CnDmaDxci5xJ81UiAuZ1ZgoVLAKgOAX_cJOa4l8')),
    googleCreds: req('GOOGLE_SERVICE_ACCOUNT_JSON'),
    scheduleTab: env('SCHEDULE_TAB', ''), // empty = ask which tab (terminal) – the dashboard always passes one
    repliesTab: env('REPLIES_TAB', 'Attendee Replies'),
    objectionsTab: env('OBJECTIONS_TAB', 'Objection Handling'),
    numberBankTab: env('NUMBER_BANK_TAB', 'Number Drop Bank'),
    logTab: env('LOG_TAB', 'Agent Log'),
    numbersTab: env('NUMBERS_TAB', 'Numbers'),

    // Webinar History sheet (Summary / Q&A / Leads tabs). Empty = use the main chat sheet.
    historySheetId: sheetIdOf(env('HISTORY_SHEET_ID', '1mm1gDGITxgqOHHKr_sz_kGRA0_skORh6StMTG_wNrno')),
    mode: env('MODE', ''),
    runUrl: process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : '',

    // AI
    // AI providers, tried in this order – if one fails (limit hit, no credits, outage) the next one answers:
    //   Groq (GROQ_API_KEY, free tier) → Kimi (KIMI_API_KEY) → DeepSeek (DEEPSEEK_API_KEY) → OpenAI (OPENAI_API_KEY)
    // All speak the OpenAI chat format; same prompts and rules for every one.
    ...(() => {
      const chain = [];
      if (env('GROQ_API_KEY', '')) {
        const k = env('GROQ_API_KEY', ''), base = 'https://api.groq.com/openai/v1';
        chain.push({ name: 'Groq', base, key: k, model: env('GROQ_MODEL', 'openai/gpt-oss-120b') });
        chain.push({ name: 'Groq', base, key: k, model: env('GROQ_MODEL_BACKUP', 'openai/gpt-oss-20b') }); // separate free limit
        // more Groq models – each has its own free per-minute limit, so a burst of questions doesn't stop the AI
        chain.push({ name: 'Groq', base, key: k, model: 'llama-3.3-70b-versatile' });
        chain.push({ name: 'Groq', base, key: k, model: 'meta-llama/llama-4-scout-17b-16e-instruct' });
        chain.push({ name: 'Groq', base, key: k, model: 'llama-3.1-8b-instant' });
      }
      if (env('KIMI_API_KEY', '')) chain.push({ name: 'Kimi', base: env('KIMI_BASE_URL', 'https://api.moonshot.ai/v1'), key: env('KIMI_API_KEY', ''), model: env('KIMI_MODEL', 'kimi-k3') });
      if (env('DEEPSEEK_API_KEY', '')) chain.push({ name: 'DeepSeek', base: 'https://api.deepseek.com', key: env('DEEPSEEK_API_KEY', ''), model: env('DEEPSEEK_MODEL', 'deepseek-chat') });
      if (env('OPENAI_API_KEY', '')) chain.push({ name: 'OpenAI', base: 'https://api.openai.com/v1', key: env('OPENAI_API_KEY', ''), model: env('OPENAI_MODEL', 'gpt-4o-mini') });
      if (!chain.length) req('GROQ_API_KEY'); // clear "Missing setting" error
      const f = chain[0];
      return { aiChain: chain, aiName: chain.map((c) => `${c.name} ${c.model}`).join(' → '), aiBase: f.base, openaiKey: f.key, model: f.model };
    })(),
    aiConcurrency: num('AI_CONCURRENCY', 4),

    // Behaviour
    dryRun: bool('DRY_RUN', true), // safe default: read + log only, send nothing
    autoReply: bool('AUTO_REPLY', true),
    lateGraceSec: num('LATE_GRACE_SEC', 90), // skip timed chats more overdue than this
    // HARD RULE: no pricing (amounts, EMI, token, offers, payment links) before this many minutes into the session.
    numberUnlockMin: num('NUMBER_UNLOCK_MIN', 60), // HARD RULE: no number asks before this many minutes into the session
    priceUnlockMin: num('PRICE_UNLOCK_MIN', 75),
    // CLOSING PUSH: from this many minutes into the session (7:30 PM session → 9:15 PM) only the most engaged people
    // are left, so EVERY message from someone without a number ("1", "yes", "ok sir"…) gets a soft, motivating
    // "thanks for staying – share your number" reply. People who already shared a number only get answers to real questions.
    closingPushMin: num('CLOSING_PUSH_MIN', 105),
    closingNudgeMax: num('CLOSING_NUDGE_MAX', 3), // max closing nudges per person
    closingNudgeGapMin: num('CLOSING_NUDGE_GAP_MIN', 3), // at least this many minutes between two nudges to the same person
    priceDeferMin: num('PRICE_DEFER_MIN', 5), // pricing timed chats up to this many min early are held and posted at unlock
    sendGapMs: num('SEND_GAP_MS', 2500), // min gap between any two chat sends
    attendeeCooldownSec: num('ATTENDEE_COOLDOWN_SEC', 45),
    socialProofEveryMin: num('SOCIAL_PROOF_EVERY_MIN', 12),
    // Getting the number comes first: every attendee who chats but hasn't shared a number gets asked privately.
    numberNudges: bool('NUMBER_NUDGES', false), // off: only genuine questions get a reply (with the number ask in it)
    nudgeAfterMessages: num('NUDGE_AFTER_MESSAGES', 2), // only ask people who've typed at least this many messages
    nudgeMax: num('NUDGE_MAX', 2), // max number asks per person (AI replies that ask count too)
    nudgeGapMin: num('NUDGE_GAP_MIN', 20), // min minutes between two asks to the same person

    // Natural, not spammy: professional team replies at a human pace, never a burst of bot messages.
    personaName: env('PERSONA_NAME', 'Sir'), // the presenter the team replies on behalf of
    humanize: bool('HUMANIZE', true), // wait a human-like "read + type" time before each private reply
    maxPrivatePerMin: num('MAX_PRIVATE_PER_MIN', 6), // cap on private messages per minute (replies + thanks + asks)
    maxAsksPerMin: num('MAX_ASKS_PER_MIN', 2), // of which unprompted number asks
    objectionThreshold: num('OBJECTION_THRESHOLD', 3), // distinct people within 5 min
    objectionCooldownMin: num('OBJECTION_COOLDOWN_MIN', 15),
    endAfterLastMin: num('END_AFTER_LAST_MIN', 10),
    maxRuntimeMin: num('MAX_RUNTIME_MIN', 340), // stay under GitHub's 6h job limit
  };
}
