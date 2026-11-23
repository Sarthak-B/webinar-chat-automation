# FlexiFunnels Webinar Chat Agent

Joins the aEvent Zoom webinar as a logged-in Zoom account and does three jobs:

1. **Timed chats.** It posts every row of the chosen variant tab (e.g. `Variant 3 – 11 AM`) at its **Host Time**, to Everyone. Host Time is the column your sheet already works out from the yellow cells. Change the yellow cells and the agent follows, since it re-reads the sheet every minute.
2. **Private replies.** It reads attendee chats and answers each question **privately** with AI. The AI can only use the **Attendee Replies** tab, with `{Name}` replaced by the attendee's first name. It never sends a link that isn't in the sheet. Anything it can't answer is logged as **NEEDS TEAM** for a human to pick up.
3. **Number drops.**
   - Phone numbers in chat go to a **Numbers** tab, and the person gets the "Shared phone number" thank-you privately.
   - Every 12 minutes it posts the social-proof line, *"Thank you A, B & C…"*, using only real names of people who shared a number.
   - When 3+ different people raise the same objection within 5 minutes, it posts that line from **Objection Handling** to Everyone, at most once every 15 minutes per objection.

Everything the agent sends, skips or can't handle is written to an **Agent Log** tab. The agent creates **Agent Log** and **Numbers** itself, and never edits your existing tabs.

Simple reactions like "Yes", "1", "T/F" answers and emojis are ignored without calling the AI. If someone sends several messages in a few seconds, they get one combined reply.

---

## The dashboard (`dashboard/index.html`)

This is the control room for the whole system. Open the file in Chrome. It runs from your computer and needs no hosting.

1. **Pick the tab:** shows every tab with a "Video Time" header, read live from the sheet.
2. **Pick the Zoom link:** chosen automatically from the tab name.
3. **Pick the mode:** Dry run / Timed chats / Everything.
4. **Launch.** You can launch up to 45 minutes before the first chat, because GitHub jobs max out at 6 hours. Before that, **Arm** it and keep the tab open, and it launches itself when the window opens.

While a run is going you get a live status orb with a **Stop** button, run progress, a timeline with a "next chat" countdown, counters, the full agent log with filters, today's numbers (copy one or all), the "needs the team" list, run history, and one-click buttons for the other workflows in the repo (e.g. the Zoom session check).

It opens in **demo mode** with sample data until you connect it with the ⚙ button:
- **GitHub:** owner, repo, and a fine-grained token for this repo with *Actions: Read and write* and *Contents: Read*. The token is stored only in that browser.
- **Sheet feed:** paste `apps-script/Code.gs` into the sheet (Extensions → Apps Script) and change `KEY`. Deploy it as a web app (Execute as: Me, Who has access: Anyone). Paste the URL and key into the dashboard. The key is what keeps strangers out, so make it long.

The agent **always asks which tab first**. From the dashboard, it's the tab you picked. When you run it from a terminal without `SCHEDULE_TAB`, it lists the schedule tabs and asks for a number before reading anything.

---

## One-time setup

### 1. Zoom account for the agent
Use a Zoom account that aEvent adds as an **alternative host or panelist**. Don't use the account aEvent's presenter bot runs on, because logging the same account in twice can kick the presenter out. Set its Zoom display name to whatever attendees should see, e.g. *FlexiFunnels Support*.

### 2. Save the Zoom login (on your laptop)
```bash
npm install
npx playwright install chromium
npm run save-session
```
A browser opens. Log into that Zoom account yourself, including the OTP, then press Enter in the terminal. You get `zoom-session.b64`. Put it in the secret (step 4), then **delete both session files from your laptop**. They work like the account password.

### 3. Google Sheet access
Use the same service account as the AiSensy sync. Share the chat sheet with the service account's email as **Editor**. It needs Editor so it can add the Agent Log and Numbers tabs.

### 4. GitHub repo (private) → Settings → Secrets and variables → Actions

**Secrets**

| Name | Value |
|---|---|
| `ZOOM_SESSION_B64` | contents of `zoom-session.b64` (`gh secret set ZOOM_SESSION_B64 < zoom-session.b64`) |
| `ZOOM_JOIN_URL_11AM` | join link of the 11 AM webinar for the agent's account (panelist link, or the normal join link if it's an alternative host) |
| `ZOOM_JOIN_URL_730PM` | same for 7:30 PM |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | the service-account JSON |
| `OPENAI_API_KEY` | OpenAI key |
| `SECRETS_PAT` | fine-grained personal access token for **this repo only**, permission **Secrets: Read and write**. Lets the agent save the refreshed Zoom login after each run. |

**Variables**

| Name | Example | What it does |
|---|---|---|
| `SHEET_ID` | `1sx70CnDmaDxci5xJ81UiAuZ1ZgoVLAKgOAX_cJOa4l8` | the chat sheet |
| `SCHEDULE_TAB_11AM` | `Variant 3 – 11 AM` | tab used at 11 AM; must match the tab name exactly, en dash included |
| `SCHEDULE_TAB_730PM` | `Variant 4 – 7:30 PM` | tab used at 7:30 PM |
| `AGENT_NAME` | `FlexiFunnels Support` | the agent account's display name, so it ignores its own messages |
| `TEAM_NAMES` | `Arman,Presenter` | comma-separated names whose chats are never answered |
| `OPENAI_MODEL` | `gpt-4o-mini` | any OpenAI chat model |

---

## Running it

- **From the dashboard** (normal way): pick tab → link → mode → Launch. The mode sets dry run and auto-reply for that run.
- **From GitHub:** Actions → *Webinar chat agent* → Run workflow. Type the exact tab name, then pick the slot and mode.
- **Session check:** runs every morning at 8:05 AM, and you can also run it from the dashboard's Automations section. If the Zoom login has expired, it fails and GitHub emails you. Run `npm run save-session` again and update the secret.

### Rollout plan
1. **Dry run** on one live webinar while the team handles chat as usual. Afterwards, compare the dashboard's feed (or the Agent Log tab) with what the team actually did.
2. **Timed chats** mode once the timing and Zoom selectors are confirmed.
3. **Everything** once the AI replies look right. Keep one person watching "Needs the team".

---

## Checking selectors (do this before the first dry run)

Zoom's web client changes its HTML now and then. Every selector the agent uses is in `SEL` at the top of `src/zoom.js`. To check them on a real session:

```bash
cp .env.example .env     # fill it in, keep DRY_RUN=true and HEADLESS=false
npm run agent:local        # leave SCHEDULE_TAB empty and it asks which tab
```

A visible Chrome joins the webinar. Send a test chat from your phone and watch the terminal: you should see `[DRY RUN] → <your name>: …`. If nothing shows up, right-click a chat message → Inspect, and update `chatItem` / `chatSender` / `chatText` in `src/zoom.js`. Do the same for the message box (`chatInput`) and the "To:" dropdown (`receiverButton`) on the first non-dry run.

## Tuning (optional env vars)

`LATE_GRACE_SEC` (90): skip timed chats more overdue than this, e.g. after a restart · `SEND_GAP_MS` (2500): gap between sends · `ATTENDEE_COOLDOWN_SEC` (45) · `SOCIAL_PROOF_EVERY_MIN` (12) · `OBJECTION_THRESHOLD` (3) · `OBJECTION_COOLDOWN_MIN` (15) · `JOIN_EARLY_MIN` (5)

## Safety notes
- The Zoom session file gives full access to that account. It only ever lives in the GitHub secret and is deleted at the end of each job. No screenshots or traces are uploaded. Keep the repo private.
- GitHub runners usually take 1–3 minutes to start, so launch at least 10 minutes before the first chat.
- `npm test -- <exported sheet file>` checks that all tabs still parse after you edit the sheet's layout.
