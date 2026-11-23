# Webinar Chat Agent · FlexiFunnels

An AI agent that runs the chat of FlexiFunnels' automated aEvent × Zoom webinars, controlled from one dashboard.

> **Setting it up?** Follow **[SETUP.md](SETUP.md)**: the step-by-step guide to go from demo to live (Zoom, OpenAI, Google, GitHub secrets and variables, dashboard).

It joins the webinar as a logged-in Zoom account. It posts Sir's timed chats from the Google Sheet on cue, replies privately to attendees' questions, and collects phone numbers, so the team doesn't have to work the chat by hand.

```
 ┌──────────────────────┐   launch (tab · link · mode)    ┌───────────────────────────┐
 │  Autopilot dashboard │ ─────────────────────────────▶ │ GitHub Actions             │
 │  dashboard/index.html│ ◀───── run status / stop ────── │ webinar-agent.yml          │
 └──────────┬───────────┘                                 │  └ src/agent.js (Playwright)│
            │ reads tabs, Agent Log, Numbers              └─────┬───────────────┬─────┘
            ▼                                                   │ joins + chats │ reads / writes
 ┌──────────────────────┐                                       ▼               ▼
 │ Apps Script feed     │ ◀──────────── same Google Sheet ──── Zoom webinar   Google Sheet
 │ apps-script/Code.gs  │                                      (aEvent)       (chat tabs)
 └──────────────────────┘
```

---

## What the agent does

> **Getting the phone number is the #1 goal. Clearing doubts comes second.** Every interaction is used to get the attendee's number, so a senior mentor can call them.
>
> **Professional, not a bot.** Every private message is written fresh by AI as the FlexiFunnels team, on behalf of the presenter (`PERSONA_NAME`). It speaks as "our team" / "humari team" / "हमारी टीम", is polite ("aap"/"आप", no slang), answers in the attendee's own language, keeps it short and varied, and is sent at a human pace. No templates are pasted and no bursts of replies go out.


| Job | How |
|---|---|
| **Asks for the tab first** | Before reading any schedule data it needs a tab. From the dashboard, that's the tab you click. From a terminal, it lists every tab with a `Video Time` header and asks you to pick a number. |
| **Timed chats** | Posts every row of that tab at its **Host Time** (column B) to Everyone. Host Time is calculated by the sheet from the yellow cells. The agent re-reads the sheet every minute, so edits made during the webinar are picked up. Multi-line messages stay as one message. |
| **Language** | **Hindi → Hindi** (Devanagari), **English → English**, **Hinglish → Hinglish**. It's detected from what each person writes and remembered, so a Hinglish speaker who later types "Yes" still gets Hinglish. |
| **Private replies (all AI)** | Answers each question **privately**, in 1–2 short, professional sentences in the team's voice ("our team will send the recording to your number" / "humari team aapke number par bhejwa degi"; never "I" or "meri team"; the code corrects it if the AI slips), using only the facts in the **Attendee Replies** tab, reworded every time. It **always ends by asking for their number** (the code adds an ask in their language if the AI forgets). Once they've shared it, replies say the team will call instead. It sees the last few messages with that person and avoids phrasing it just used with others. If asked "is this a bot?", it says the FlexiFunnels team is assisting on Sir's behalf. Thank-yous for numbers are AI-written too. with `{Name}` replaced by their first name. It replies in Hinglish if they write in Hinglish. It never sends a link that isn't in the sheet. Anything it can't answer confidently is marked **NEEDS TEAM**. |
| **Numbers (top priority)** | A number typed in chat is saved to the **Numbers** tab the moment the agent reads it, and the person gets the "Shared phone number" thank-you privately. Every 12 min it posts *"Thank you A, B & C…"* using only real names. |
| **Number asks** | People who keep engaging (2+ messages, e.g. "Yes", their city, "1") without sharing a number get one natural, AI-written private ask in their language. The angle is inspired by your **Number Drop Bank** tab, never copied. Each person gets at most 2 asks, 20+ min apart, and the asks stop the moment they share a number. People with a problem for the team get a reply saying the team will sort it out, plus a number ask, so the team can call. |
| **Pacing (no bombing)** | Timed chats go out exactly on cue. Every private message waits a human "read + type" time (about 5–30 s, depending on length). Private messages are capped at 6 a minute, and unprompted number asks at 2 a minute. Replies that would arrive more than 15 min late are dropped. |
| **Objections** | When 3+ different people raise the same objection within 5 min, it posts the matching line from **Objection Handling** to Everyone, at most once per 15 min per objection. |
| **Logging** | Every attendee message (kind `IN`) and everything the agent sends, skips, fails or hands to the team goes into an **Agent Log** tab. The agent creates **Agent Log** and **Numbers** itself and never edits your other tabs. |

It doesn't call the AI for simple reactions (they get a number ask instead, if needed): "Yes", "1", T/F answers, greetings and emojis. If one person sends several messages within a few seconds, they get one combined reply.

### Modes (picked per launch)

| Mode | Timed chats | Number thank-yous | AI replies | Use it for |
|---|---|---|---|---|
| `dry` | logged only | logged only | logged only | First live test. The agent sends nothing; compare its log with what the team did. |
| `timed` | ✅ | numbers saved, no messages | ❌ | Once timing and Zoom selectors are confirmed. The agent sends **no private messages**; questions are logged for the team. |
| `full` | ✅ | ✅ AI thank-yous + asks | ✅ | Once the AI replies look right. Keep someone watching **Needs the team**. |

---

## The dashboard: `dashboard/index.html`

The control room for everything. It's deployed on **Vercel** (the repo's `vercel.json` serves the `dashboard/` folder as a static site, with nothing to build), or you can open the file directly in Chrome. It's built for desktop.

1. **Pick the tab:** cards for every schedule tab, read live from the sheet, with chat count and first → last time.
2. **Pick the Zoom link:** 11 AM or 7:30 PM, chosen automatically from the tab name. If aEvent gives a new link per session, paste it instead.
3. **Pick the mode:** dry / timed / full.
4. **Launch**, or **Arm** it.

**Launch window:** GitHub jobs max out at 6 hours, so the agent can start at most **45 minutes before the first chat**. It then waits and joins 5 minutes early. Earlier than that, the button becomes **Arm**: keep the tab open and it launches itself when the window opens.

While a run is going, the dashboard shows:
- **Numbers captured**: the headline counter, with the capture rate (% of people who chatted) and how many asks were sent
- **Conversations**: a chat view with one thread per attendee. A **No number** filter lists everyone still without a number, so the team can chase them. What they typed is on the left and the agent's private replies are on the right. Their number is in the thread header with a copy button. You can search and filter by Replied / Team / Numbers, and timed chats and broadcasts sit in a pinned **Everyone** thread.
- Live status with a **Stop agent** button
- Each step of the GitHub run
- A countdown to the next timed chat, and a timeline of the whole tab
- Counters: chats sent, replies, numbers, needs-team
- The full chat feed with filters
- Today's numbers, copied as `Name - Number`, one per line, duplicates removed (one or all), and the questions left for the team
- Run history, and one-click buttons for the other workflows in the repo

Until you connect it, it shows **demo data** with a banner. To connect, click **⚙**:

| Field | Value |
|---|---|
| Owner / Repo | `Sarthak-B` / `webinar-chat-automation` |
| Access token | Fine-grained token for **this repo only** with *Actions: Read and write* + *Contents: Read* ([create one](https://github.com/settings/personal-access-tokens/new)). Saved only in that browser. |
| Agent workflow file | `webinar-agent.yml` |
| Apps Script URL + key | From step 4 of the setup below |

---

## One-time setup

### 1. Zoom account for the agent
Use a Zoom account that aEvent adds as an **alternative host or panelist**. Don't use the account aEvent's presenter bot runs on: logging the same account in twice can kick the presenter out. Set the account's display name to what attendees should see, e.g. *FlexiFunnels Team*, and set `AGENT_NAME` to the same.

### 2. Save the Zoom login (on your laptop, Node 20+)
```bash
git clone https://github.com/Sarthak-B/webinar-chat-automation.git
cd webinar-chat-automation
npm install
npx playwright install chromium
npm run save-session
```
A browser opens. Log into the agent's Zoom account yourself, including the OTP, and press Enter in the terminal. This creates `zoom-session.b64`. Save it as the `ZOOM_SESSION_B64` secret (step 5), then **delete `zoom-session.json` and `zoom-session.b64`**. They work like the account password.

### 3. Google service account
Use the same service account as the AiSensy sync. Share the chat sheet with its email as **Editor**, so it can add the Agent Log and Numbers tabs.

### 4. Sheet feed for the dashboard
1. Open the chat sheet → **Extensions → Apps Script**.
2. Paste in `apps-script/Code.gs` (the dashboard's ⚙ panel also has it with a copy button).
3. Change `KEY` to a long random string.
4. **Deploy → New deployment → Web app**, with *Execute as: Me* and *Who has access: Anyone*.
5. Put the web-app URL and the key into the dashboard.

The feed is read-only and answers only requests that carry the key.

> **Updated the script?** Apps Script keeps serving the old code until you go to **Deploy → Manage deployments → ✏️ → Version: New version → Deploy**. The URL stays the same.

### 5. Repo secrets and variables
In the repo, go to [Settings → Secrets and variables → Actions](https://github.com/Sarthak-B/webinar-chat-automation/settings/secrets/actions).

**Secrets**

| Name | Value |
|---|---|
| `ZOOM_SESSION_B64` | Contents of `zoom-session.b64`, or `gh secret set ZOOM_SESSION_B64 < zoom-session.b64` |
| `ZOOM_JOIN_URL_11AM` | The 11 AM webinar join link for the agent's account (panelist link, or the normal link if it's an alternative host) |
| `ZOOM_JOIN_URL_730PM` | Same for the 7:30 PM webinar |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | The service-account JSON key |
| `OPENAI_API_KEY` | OpenAI API key (only used in `full` mode) |
| `SECRETS_PAT` | Fine-grained token for this repo with **Secrets: Read and write**. Lets the agent save the refreshed Zoom login after each run, so it doesn't expire. |

**Variables**

| Name | Example | What it does |
|---|---|---|
| `SHEET_ID` | the long ID in the sheet's URL | Which sheet to use |
| `AGENT_NAME` | `FlexiFunnels Team` | The agent account's Zoom display name, so it ignores its own messages |
| `PERSONA_NAME` | `Saurabh Sir` | The presenter the team replies on behalf of (default `Sir`) |
| `TEAM_NAMES` | `Arman,Support` | Comma-separated names whose chats are never answered |
| `OPENAI_MODEL` | `gpt-4o-mini` | Any OpenAI chat model (default `gpt-4o-mini`) |

### 6. Check the Zoom selectors once
Zoom's web client changes its HTML now and then. Every selector the agent uses is in `SEL` at the top of `src/zoom.js`. Before the first real run, watch it on a live webinar:

```bash
cp .env.example .env    # fill it in; keep DRY_RUN=true and HEADLESS=false
npm run agent:local     # leave SCHEDULE_TAB empty and it asks which tab
```

A visible Chrome joins the webinar. Send a chat from your phone; the terminal should print `[DRY RUN] → <your name>: …`. If nothing appears, right-click a chat message → **Inspect** and update `chatItem`, `chatSender` and `chatText`. On the first `timed` run, also check `chatInput` (the message box) and `receiverButton` (the "To:" dropdown).

---

## Running it

- **Dashboard** (normal way): tab → link → mode → **Launch**.
- **GitHub:** [Actions → Webinar chat agent → Run workflow](https://github.com/Sarthak-B/webinar-chat-automation/actions/workflows/webinar-agent.yml). Type the exact tab name (en dash included, e.g. `Variant 3 – 11 AM`), then pick the slot and mode.
- **Stop:** **Stop agent** in the dashboard, or cancel the run on GitHub. Either way it leaves the webinar and saves the refreshed login.
- **Zoom login check:** `session-check.yml` runs daily at 8:05 AM IST, or on demand from the dashboard. If the login has expired, the run fails and GitHub emails you. Run `npm run save-session` again and update `ZOOM_SESSION_B64`.

Launch at least 10 minutes before the first chat, because GitHub runners take 1–3 minutes to start.

---

## Sheet layout it expects

**Schedule tabs** (any tab with a `Video Time` header row):

| A: Video Time | B: Host Time | C: Chat | D: Type |
|---|---|---|---|
| `Pre-session` | `10:45:00 am` | Welcome! We start in 15 minutes… | Hype |
| `00:07:35` | `11:02:37 am` | Hi everyone | Engagement |

The agent sends column C at the clock time in column B. Rows with an empty B or C are skipped.

**Attendee Replies:** a `When the attendee says… | Reply` table. The agent needs the **Shared phone number** row for number thank-yous.

**Objection Handling:** an `Objection | Chat to post` table.

**Number Drop Bank:** an `Angle | Line to post | When to use` table. The agent uses every line except "Social proof" as a private number ask. Add or edit lines and it picks them up next run.

After changing the layout, run `npm test -- <exported sheet file>` to confirm every tab still parses.

---

## Project map

```
.github/workflows/
  webinar-agent.yml     runs the agent (started from the dashboard: tab, slot, mode)
  session-check.yml     daily Zoom login check + refresh
dashboard/index.html    Autopilot dashboard (single self-contained file)
apps-script/Code.gs     keyed, read-only sheet feed for the dashboard
src/
  agent.js              main loop: asks for the tab, timed chats, replies, numbers, logging
  brain.js              AI writing in a professional team voice, language detection, phone detection, safety checks
  zoom.js               Playwright: join, read chat, send (all selectors in SEL)
  schedule.js           parses schedule / replies / objection tabs
  sheets.js             Google Sheets read + batched log writes
  config.js             all settings (env vars)
scripts/
  save-session.js       one-time Zoom login → zoom-session.b64
  check-session.js      verifies the saved login
test/schedule.test.js   parser tests (pass an exported sheet to test real tabs)
test/brain.test.js      language detection, number-ask guarantee, link blocking, AI-down fallbacks
```

## Tuning (optional)

Set any of these as a repo **Variable** ([Settings → Secrets and variables → Actions → Variables](https://github.com/Sarthak-B/webinar-chat-automation/settings/variables/actions)). The next launch uses them, with no code change. Leave a variable unset to keep its default. For local runs, put them in `.env`.

| Var | Default | Meaning |
|---|---|---|
| `LATE_GRACE_SEC` | 90 | Skip timed chats more overdue than this (e.g. after a restart) |
| `SEND_GAP_MS` | 2500 | Minimum gap between any two messages |
| `ATTENDEE_COOLDOWN_SEC` | 45 | Minimum gap between two AI replies to the same person |
| `SOCIAL_PROOF_EVERY_MIN` | 12 | How often the "Thank you A, B & C" line is posted |
| `OBJECTION_THRESHOLD` | 3 | People raising one objection within 5 min before it's posted |
| `OBJECTION_COOLDOWN_MIN` | 15 | Minimum gap between two posts of the same objection |
| `JOIN_EARLY_MIN` | 5 | Minutes before the first chat to join |
| `PERSONA_NAME` | Sir | The presenter the team is replying on behalf of (e.g. `Saurabh Sir`) |
| `HUMANIZE` | true | Wait a human read + type time before each private message |
| `MAX_PRIVATE_PER_MIN` | 6 | Cap on private messages per minute |
| `MAX_ASKS_PER_MIN` | 2 | Cap on unprompted number asks per minute |
| `NUMBER_NUDGES` | true | Privately ask engaged chatters without a number for it |
| `NUDGE_AFTER_MESSAGES` | 2 | Only ask people who've typed at least this many messages |
| `NUDGE_MAX` | 2 | Max number asks per person (AI replies that ask count too) |
| `NUDGE_GAP_MIN` | 20 | Minimum minutes between two asks to the same person |

## Troubleshooting

| Symptom | Fix |
|---|---|
| Dashboard: "Sheet: Wrong key" | The key in ⚙ doesn't match `KEY` in the Apps Script. After editing the script, deploy a **new version**. |
| Dashboard: "GitHub: Bad credentials" / 404 | Token expired, or it doesn't cover this repo with *Actions: Read and write*. |
| Run fails at "Restore Zoom session" | `ZOOM_SESSION_B64` is missing or broken. Run `npm run save-session` again. |
| Log says "Zoom session logged out" | The login expired. Run `save-session` again. Joining still works through the link, but without the account's powers. |
| Joins but nothing appears in the log | Chat selectors have changed. See setup step 6. |
| Messages logged as FAILED · "attendee not found" | Selector for the "To:" dropdown or its search box. See step 6. |
| "Tab not found" | The tab name must match exactly, including the en dash `–`. Pick it from the dashboard instead of typing it. |

## Security

- **Make this repo private** (Settings → General → Danger zone → Change visibility). It contains your webinar flow and sheet structure. Secrets are never in the code.
- The saved Zoom login gives full access to that account. It only lives in the `ZOOM_SESSION_B64` secret, and each job deletes it at the end. No screenshots, traces or logs with it are uploaded.
- Dashboard tokens are saved only in the browser you enter them in. Use it on your own computer.
- Messages from attendees are treated as data. The AI is told to ignore instructions inside them, and any link it writes that isn't in the sheet blocks the reply.
