# Setup guide: from demo to live

Everything you need to do, once, so the dashboard shows **real** data and the agent runs real webinars. Takes about 45–60 minutes. Do the steps in order. Each one ends with a ✅ check, so you know it worked before moving on.

> You handle the Vercel deploy of the dashboard. This guide covers everything else: Zoom, OpenAI, Google, GitHub and the dashboard connection.
> The repo already has a `vercel.json`, so Vercel serves `dashboard/index.html` as the site and skips installing the agent's packages. Import the repo with the root directory left as the repo root.

---

## What you'll have at the end

| Piece | Where it lives | What it does |
|---|---|---|
| **Agent** | GitHub Actions (`webinar-agent.yml`) | Joins the webinar, posts timed chats, replies, collects numbers |
| **Zoom login** | GitHub secret `ZOOM_SESSION_B64` | Lets the agent open Zoom already signed in |
| **AI** | GitHub secret `OPENAI_API_KEY` | Writes every reply |
| **Sheet access (agent)** | GitHub secret `GOOGLE_SERVICE_ACCOUNT_JSON` | Agent reads the chat tabs and writes Agent Log / Numbers |
| **Sheet feed (dashboard)** | Apps Script web app in the sheet | Dashboard reads tabs, conversations, numbers and history |
| **Webinar History sheet** | A separate Google Sheet | One row per webinar (attendees, live leads, live lead %, engagement %) plus every question with its reply. Written when the webinar ends |
| **Dashboard** | Vercel | Launch / stop / watch everything |

## Before you start

- [ ] Admin access to the GitHub repo **Sarthak-B/webinar-chat-automation** (ideally logged in as the account that owns it)
- [ ] Edit access to the **chat Google Sheet**
- [ ] A **Zoom account for the agent** (see step 2)
- [ ] An **OpenAI account**, where you can add a payment method
- [ ] A **Mac with Chrome** (for the one-time Zoom login in step 5)

---

## Step 1: Make the repo private (2 min)

GitHub → **Sarthak-B/webinar-chat-automation** → **Settings** → **General** → scroll to **Danger Zone** → **Change repository visibility** → **Make private**.

Secrets stay hidden either way, but the repo shows your webinar flow and sheet structure. Vercel can still deploy a private repo.

✅ The repo page shows a **Private** badge.

---

## Step 2: Zoom account for the agent (10 min)

1. **Pick the account.** Use a separate Zoom account, **not** the one aEvent's presenter bot runs on. Logging the same account in twice can kick the presenter out of the webinar.
2. **Set its display name** to what attendees will see, e.g. **FlexiFunnels Team**. Zoom web → Profile → Edit name.
3. **Give it chat powers in the webinar.** In aEvent / Zoom, add this account as an **alternative host** or **panelist** for the 11 AM and 7:30 PM webinars. Panelists can see every attendee message and reply privately.
4. **Copy its join links.** Use the panelist invite link (or the normal join link, if it's an alternative host) for:
   - the **11 AM** webinar → you'll save it as `ZOOM_JOIN_URL_11AM`
   - the **7:30 PM** webinar → `ZOOM_JOIN_URL_730PM`
5. In Zoom web settings for this account, make sure **"Join from your browser"** is allowed.

> **Does aEvent give a new link every session?** Then just paste the link into the dashboard when you launch. There's a "paste this session's Zoom link" box in step 02 of the launch screen. The secrets are only the default.

✅ Logged in as this account in Chrome, the join link opens the webinar as panelist / host.

---

## Step 3: OpenAI API key (5 min)

1. Go to **https://platform.openai.com** → sign in.
2. **Settings → Billing** → add a payment method and some credit (₹500–₹1,000 is plenty to start).
3. **Settings → Limits** → set a **monthly budget** so costs can never run away.
4. **API keys** → **Create new secret key** → name it `webinar-agent` → **copy it now**. It's shown only once and starts with `sk-`.

With the default model (`gpt-4o-mini`), a full webinar usually costs very little, a few rupees to a few tens of rupees depending on how busy the chat is. Check usage after the first runs.

✅ You have a key starting with `sk-…` saved somewhere safe for step 7.

---

## Step 4: Google service account, for the agent's sheet access (10 min)

> If you already have a service account for the AiSensy sync, you can reuse its JSON key. Just do item 6 (share the sheet with it).

1. Go to **https://console.cloud.google.com** → top bar → **Select a project** → **New project** → name it `webinar-agent` → **Create**.
2. **APIs & Services → Library** → search **Google Sheets API** → **Enable**.
3. **IAM & Admin → Service accounts** → **Create service account** → name `webinar-agent` → **Create and continue** → skip the roles → **Done**.
4. Click the new service account → **Keys** tab → **Add key → Create new key → JSON** → **Create**. A `.json` file downloads.
5. Open that file and copy the `client_email` value (looks like `webinar-agent@webinar-agent-12345.iam.gserviceaccount.com`).
6. Open the **chat Google Sheet** → **Share** → paste that email → role **Editor** → untick "Notify people" → **Share**.

The agent needs **Editor** to create the **Agent Log** and **Numbers** tabs. It never edits your other tabs.

7. **Webinar History sheet:** create a new Google Sheet named **Webinar History** and **share it with the same service-account email as Editor**. Leave it empty; the agent creates the **Summary** and **Q&A** tabs when the first webinar ends. Copy its ID from the URL (`/spreadsheets/d/`**`THIS_PART`**`/edit`) for step 8.

✅ Both the chat sheet and the Webinar History sheet show the service-account email as Editor. Keep the JSON file for step 7.

---

## Step 5: Save the agent's Zoom login (10 min, on your Mac)

1. **Install Node.js 20 or newer:** from https://nodejs.org (LTS installer) or `brew install node`. Check with `node -v`.
2. Open **Terminal** and run:
   ```bash
   git clone https://github.com/Sarthak-B/webinar-chat-automation.git
   cd webinar-chat-automation
   npm install
   npx playwright install chromium
   npm run save-session
   ```
3. A Chrome window opens on Zoom's sign-in page. **Log in as the agent's Zoom account** (from step 2), including the OTP. Wait until you see your Zoom profile, then go back to Terminal and press **Enter**.
4. It prints "✓ Saved … zoom-session.b64". Copy it to the clipboard:
   ```bash
   pbcopy < zoom-session.b64
   ```
   Paste it into the `ZOOM_SESSION_B64` secret in step 7 straight away. **Then delete both files:**
   ```bash
   rm zoom-session.json zoom-session.b64
   ```
   They work like the account's password.

✅ Terminal printed the ✓ line and the file was under 48 KB.

---

## Step 6: Two GitHub tokens (5 min)

Create them at **https://github.com/settings/personal-access-tokens/new** (fine-grained tokens), logged in as the account that owns the repo.

**Token A, `SECRETS_PAT`** (used by the workflows to keep the Zoom login fresh):
- Name: `webinar-agent-secrets` · Expiration: **1 year** (add a calendar reminder)
- Resource owner: **Sarthak-B** · Repository access: **Only select repositories → webinar-chat-automation**
- Permissions → Repository → **Secrets: Read and write**
- **Generate** → copy

**Token B, the dashboard token** (used by the dashboard to launch, stop and watch runs):
- Name: `webinar-dashboard` · Expiration: 1 year
- Same repository selection
- Permissions → Repository → **Actions: Read and write**, **Contents: Read-only** (Metadata is added automatically)
- **Generate** → copy. It goes into the dashboard in step 11, not into GitHub.

> **Not the repo owner, just a collaborator?** Fine-grained tokens can't reach another person's repo. Either have the owner create the tokens, or use a **classic token** (https://github.com/settings/tokens/new) with the **`repo`** and **`workflow`** scopes for both A and B.

✅ You have two tokens starting with `github_pat_…` (or `ghp_…` for classic).

---

## Step 7: Add the repo **secrets** (5 min)

GitHub repo → **Settings** → **Secrets and variables** → **Actions** → tab **Secrets** → **New repository secret**. Add each one. Names must match exactly.

| Name | Value |
|---|---|
| `ZOOM_SESSION_B64` | Paste from step 5 (`pbcopy` output) |
| `ZOOM_JOIN_URL_11AM` | 11 AM join link for the agent account (step 2) |
| `ZOOM_JOIN_URL_730PM` | 7:30 PM join link for the agent account (step 2) |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Open the JSON file from step 4 and paste its **entire** contents, `{` to `}` |
| `OPENAI_API_KEY` | The `sk-…` key from step 3 |
| `SECRETS_PAT` | Token A from step 6 |

✅ The Secrets tab lists all 6 names.

---

## Step 8: Add the repo **variables** (3 min)

Same page → tab **Variables** → **New repository variable**.

| Name | Value | Notes |
|---|---|---|
| `SHEET_ID` | The ID from the sheet's URL: `docs.google.com/spreadsheets/d/`**`THIS_PART`**`/edit` | required |
| `HISTORY_SHEET_ID` | The **Webinar History** sheet's ID (step 4.7) | Recommended. If unset, the Summary / Q&A tabs go into the chat sheet |
| `AGENT_NAME` | Exactly the agent account's Zoom display name, e.g. `FlexiFunnels Team` | required, so it ignores its own messages |
| `PERSONA_NAME` | `Saurabh Sir` | The presenter the team replies on behalf of |
| `TEAM_NAMES` | e.g. `Arman,Support` | Names whose chat messages are never answered (your team members in the webinar) |
| `OPENAI_MODEL` | e.g. `gpt-4o-mini` | Optional. Leave unset to use the default |

Optional tuning (number asks per person, messages per minute, etc.) can also be set here. See **Tuning** in the README. Leave them unset to use the defaults.

✅ The Variables tab shows at least `SHEET_ID` and `AGENT_NAME`.

---

## Step 9: Turn on GitHub Actions and check the Zoom login (3 min)

1. Repo → **Actions** tab. If you see "Workflows aren't being run on this repository", click **I understand my workflows, go ahead and enable them**.
2. **Settings → Actions → General** → *Actions permissions*: **Allow all actions and reusable workflows** → Save.
3. **Actions → Zoom session check → Run workflow → Run workflow.** Wait ~2 minutes.

✅ The run is **green** and the "Check login" step says "✓ Zoom session is logged in". Red means: redo step 5 and update `ZOOM_SESSION_B64`. From now on this check runs by itself every morning at 8:05 AM. If it ever fails, GitHub emails you.

---

## Step 10: Sheet feed for the dashboard: Apps Script (7 min)

1. Make a long random key. On Mac: `openssl rand -hex 24` → copy the output.
2. Open the **chat Google Sheet** → **Extensions → Apps Script**.
3. Delete everything in `Code.gs` and paste the contents of [`apps-script/Code.gs`](apps-script/Code.gs). The dashboard's ⚙ panel also has a **Copy** button for it.
4. On the line `const KEY = 'CHANGE-ME-to-a-long-random-key';`, replace the text inside the quotes with your key.
   On the line `const HISTORY_SHEET_ID = '';`, put the **Webinar History** sheet's ID between the quotes. You need edit access to that sheet. → **Save** (💾).
5. **Deploy → New deployment** → ⚙ next to "Select type" → **Web app**:
   - Description: `dashboard feed`
   - **Execute as: Me**
   - **Who has access: Anyone**
   → **Deploy**
6. Google asks for permission: **Authorize access** → choose your account. If it says "Google hasn't verified this app", click **Advanced → Go to (project name)**. It's your own script. Then **Allow**.
7. Copy the **Web app URL** (ends with `/exec`).
8. Test it: open `YOUR_URL?key=YOUR_KEY&action=tabs` in Chrome. You should see JSON that lists your tabs, e.g. `"Variant 3 – 11 AM"`.
   History test: `YOUR_URL?key=YOUR_KEY&action=history` should show `{"header":[],"rows":[]}` before the first webinar, and the Summary rows after it. If it says it can't open the sheet, check the `HISTORY_SHEET_ID` in the script and that your Google account can open it.

> **Changed the script later?** Apps Script keeps serving the old version until you go to **Deploy → Manage deployments → ✏️ → Version: New version → Deploy**. The URL stays the same.
> **Using a company Google Workspace account?** If "Anyone" isn't offered, your admin blocks public web apps. Deploy from a personal Google account that has edit access to the sheet.

✅ The test URL shows your tab names. "Wrong key" means the key in the URL doesn't match the one in the script.

---

## Step 11: Connect the dashboard (3 min)

Open your Vercel dashboard URL → **⚙** (top right):

| Field | Value |
|---|---|
| Owner / Repo | Already filled: `Sarthak-B` / `webinar-chat-automation` |
| Access token | **Token B** from step 6 |
| Agent workflow file | `webinar-agent.yml` |
| Apps Script web-app URL | From step 10 |
| Feed key | Your key from step 10 |
| Chat sheet link | The chat sheet's normal link (for the "Open sheet" button) |
| Webinar History sheet link | Its normal link (for the History section's "Open sheet" button) |
| Use demo data | **Off** |

Click **Test connection** → it should say `GitHub ✓ … · Sheet ✓ (N schedule tabs)` → **Save**.

✅ The purple **DEMO** badge and banner disappear, the **GitHub** and **Sheet** dots turn green, and the tab cards show your real variant tabs. Settings are saved in that browser only. Each computer that uses the dashboard needs its own setup.

---

## Step 12: First live test: dry run (during a real webinar)

1. Up to **45 minutes before** the webinar's first chat, open the dashboard → **Launch**:
   - **01** Pick the tab (e.g. `Variant 3 – 11 AM`)
   - **02** Check the Zoom link (or paste today's link)
   - **03** Mode **Dry run**
   - → **Launch the agent**
2. Your team handles the chat as usual. The agent joins, reads everything, and **logs what it would send, without sending anything**.
3. Watch **Live** and **Conversations**:
   - Attendee messages appearing in **Conversations** = reading the Zoom chat works ✅
   - **Agent Log** filling with `DRY TIMED …` at the right times = the schedule works ✅
   - Dashed reply bubbles = what the AI would have said. Read 20–30 of them in all three languages.
4. **If no attendee messages appear** within a few minutes of chat activity, Zoom's page layout has changed. Send me a screenshot of the Zoom web chat plus the HTML of one chat message (right-click a message → Inspect → right-click the highlighted line → Copy → Copy element), and I'll update the selectors in `src/zoom.js`.

## Step 13: Go live, gradually

1. **Next webinar:** mode **Timed chats**. Sir's timed chats go out automatically and numbers are saved. Your team still answers questions. Check that messages really appear in Zoom and land at the right time.
2. **After that:** mode **Everything**. The AI replies privately in the attendee's language and goes for the number. Keep one person watching **Conversations → Team** and **No number**.

---

## What the History section shows

When a webinar ends, the agent adds it to the Webinar History sheet: one **Summary** row, plus its **Q&A** rows. The dashboard's History section shows:

| Number | Meaning |
|---|---|
| **Attendees** | Highest attendee count Zoom showed during the webinar |
| **Live leads** | Phone numbers captured (count only; the names and numbers stay in the chat sheet's **Numbers** tab for the team) |
| **Live lead %** and **ratio** | Live leads ÷ attendees, e.g. *8% · 1 in 13 attendees* |
| **Engagement %** | People who sent at least one chat message ÷ attendees |

Below that is **Questions & replies**: every genuine question asked and the reply it was given. "Type 1" / "Yes" answers aren't questions, so they aren't listed. **Copy** pastes it straight into a sheet.

> If **Attendees** is blank, the agent couldn't read Zoom's participant counter. Type the number from aEvent / Zoom into that Summary row's *Attendees* cell, and the dashboard recalculates the percentages from it.

## Every webinar: 30-second checklist

- [ ] The **Zoom login** dot is green (the 8:05 AM check passed)
- [ ] Launch **≤ 45 min before** the first chat, or **Arm** it earlier and keep the tab open
- [ ] New Zoom link today? Paste it in step **02**
- [ ] After the webinar: **Numbers today → Copy all** (`Name - Number`, one per line)

## Things that expire, and what to do

| What | When | Fix |
|---|---|---|
| Zoom login | When Zoom signs it out (the morning check emails you) | Step 5 again → update `ZOOM_SESSION_B64` |
| GitHub tokens A and B | After 1 year | Create new ones (step 6) → update `SECRETS_PAT` / the dashboard ⚙ |
| OpenAI credit | When used up | Top up in OpenAI Billing |
| Apps Script | Only when you change the code | Deploy → Manage deployments → New version |

## Quick troubleshooting

| You see | Fix |
|---|---|
| Dashboard still says DEMO | ⚙ → make sure "Use demo data" is **off** and all fields are filled → Save |
| "Sheet: Wrong key" | The key in ⚙ ≠ `KEY` in the Apps Script (and redeploy a **new version** after changing it) |
| "GitHub: Bad credentials" / "Not Found" | Token B expired, or doesn't cover this repo with Actions read and write |
| Launch fails with "Unexpected inputs" | The workflow file on GitHub is outdated. Pull the latest `main` |
| Run fails at "Restore Zoom session" | `ZOOM_SESSION_B64` missing or broken → step 5 |
| Agent joins but nothing in Conversations | Zoom selectors changed → see step 12.4 |
| Replies FAILED · "attendee not found" | Zoom's "To:" dropdown changed → send me the Inspect HTML of it |
| "Tab not found" | Pick the tab from the dashboard (names must match exactly, including the `–` dash) |

More details are in the [README](README.md).
