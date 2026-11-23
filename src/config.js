// All settings come from environment variables (GitHub secrets / repo variables).
const env = (k, d) => (process.env[k] ?? '').trim() || d;
const req = (k) => {
  const v = env(k);
  if (!v) throw new Error(`Missing required env var ${k}`);
  return v;
};
const num = (k, d) => Number(env(k, String(d)));
const bool = (k, d = false) => {
  const v = env(k);
  return v ? ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()) : d;
};
const list = (k) => env(k, '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

export function loadConfig() {
  return {
    // Zoom
    // One universal link for every webinar (redirects to the live Zoom webinar). Override with the ZOOM_JOIN_URL variable if it ever changes.
    joinUrl: env('ZOOM_JOIN_URL', 'https://sb.flexifunnels.com/genie-demo'),
    // Optional: the agent account's personal PANELIST link (Zoom emails it when you add the account as a panelist).
    panelistUrl: env('ZOOM_PANELIST_URL', ''),
    sessionFile: env('ZOOM_SESSION_FILE', 'zoom-session.json'),
    agentName: env('AGENT_NAME', 'FlexiFunnels Support'),
    teamNames: list('TEAM_NAMES'), // chats from these names are never answered
    headless: bool('HEADLESS', false), // CI runs headed inside xvfb; Zoom is friendlier to that
    joinEarlyMin: num('JOIN_EARLY_MIN', 5), // join this many minutes before the first chat row

    // Google Sheet
    sheetId: req('SHEET_ID'),
    googleCreds: req('GOOGLE_SERVICE_ACCOUNT_JSON'),
    scheduleTab: env('SCHEDULE_TAB', ''), // empty = ask which tab (terminal) – the dashboard always passes one
    repliesTab: env('REPLIES_TAB', 'Attendee Replies'),
    objectionsTab: env('OBJECTIONS_TAB', 'Objection Handling'),
    numberBankTab: env('NUMBER_BANK_TAB', 'Number Drop Bank'),
    logTab: env('LOG_TAB', 'Agent Log'),
    numbersTab: env('NUMBERS_TAB', 'Numbers'),

    // Webinar History sheet (Summary / Q&A / Leads tabs). Empty = use the main chat sheet.
    historySheetId: env('HISTORY_SHEET_ID', ''),
    mode: env('MODE', ''),
    runUrl: process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : '',

    // AI
    openaiKey: req('OPENAI_API_KEY'),
    model: env('OPENAI_MODEL', 'gpt-4o-mini'),
    aiConcurrency: num('AI_CONCURRENCY', 4),

    // Behaviour
    dryRun: bool('DRY_RUN', true), // safe default: read + log only, send nothing
    autoReply: bool('AUTO_REPLY', true),
    lateGraceSec: num('LATE_GRACE_SEC', 90), // skip timed chats more overdue than this
    // HARD RULE: no pricing (amounts, EMI, token, offers, payment links) before this many minutes into the session.
    priceUnlockMin: num('PRICE_UNLOCK_MIN', 75),
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
