# Setup guide: from demo to live

Everything you need to do, once, so the dashboard shows **real** data and the agent runs real webinars. Takes about 45–60 minutes. Do the steps in order. Each one ends with a ✅ check, so you know it worked before moving on.

> You handle the Vercel deploy of the dashboard. This guide covers everything else: Zoom, OpenAI, Google, GitHub and the dashboard connection.
> The repo already has a `vercel.json`, so Vercel serves `dashboard/index.html` as the site and skips installing the agent's packages. Import the repo with the root directory left as the repo root.

---

## What you'll have at the end

| Piece | Where it lives | What it does |
|---|---|---|
| **Agent** | GitHub Actions (`webinar-agent.yml`) | Joins via https://sb.flexifunnels.com/genie-demo, posts timed chats, replies, collects numbers |
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

The universal link **https://sb.flexifunnels.com/genie-demo** is an **attendee** link. Attendees can't see other people's chats, can't reply privately and can't see the participant count. So the agent needs **host or panelist access**. Pick **one** of these two options:

**Option A: alternative host (nothing to update per webinar)**
1. The agent's Zoom account must be a **licensed user in the same Zoom account/organisation** as the webinar's host. That's Zoom's rule for alternative hosts.
2. Add it as an **alternative host** of the webinar. If aEvent uses a recurring webinar or a template, set it there once.
3. How it works: the agent opens the universal link to find the live webinar, then joins it **as its own logged-in account** instead of as the audience. Zoom recognises the alternative host and gives it host powers.

**Option A2: the webinar's host account itself**
- Save the login of the account the webinar is hosted from (step 5). The agent then joins as the host.
- ⚠️ If aEvent's presenter bot runs on that same account, a second login can kick the presenter out. Test it on a practice or low-stakes session first. If the presenter drops, use Option A or B instead.

**Option B: panelist (works with any Zoom account)**
1. Add the agent account's email as a **panelist** of the webinar (in aEvent / Zoom → Invitations → Panelists).
2. Zoom emails it a personal **panelist join link**. Save that link as the GitHub secret **`ZOOM_PANELIST_URL`** (step 7).
3. If the webinar is recurring with the same ID, the link stays the same. If aEvent creates a new webinar each time, the panelist link changes and you'd update the secret. In that case Option A is easier.

For either option:
- Use a separate Zoom account, **not** the one aEvent's presenter bot runs on. Logging the same account in twice can kick the presenter out.
- Set its display name to what attendees will see, e.g. **FlexiFunnels Team**.
- Allow **"Join from your browser"** in its Zoom web settings.

✅ Check during a live webinar, logged in as the agent account in Chrome:
- **Option A:** open https://sb.flexifunnels.com/genie-demo, note the webinar ID in the Zoom page's URL, then open `https://app.zoom.us/wc/<ID>/join`.
- **Option B:** open the panelist link.

You should see the **Participants** button, which means host or panelist powers. On every run, the **Agent Log** gets a `JOINED` row (how it joined + role). If it ever gets in only as an attendee, a **WARNING** row tells you.

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
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Open the JSON file from step 4 and paste its **entire** contents, `{` to `}` |
| `OPENAI_API_KEY` | The `sk-…` key from step 3 |
| `SECRETS_PAT` | Token A from step 6 |

| `ZOOM_PANELIST_URL` | **Only for Option B** (step 2): the agent account's personal panelist link |

✅ The Secrets tab lists the 4 required names, plus `ZOOM_PANELIST_URL` if you chose Option B. The universal link is built in.

---

## Step 8: Add the repo **variables** (3 min)

Same page → tab **Variables** → **New repository variable**.

| Name | Value | Notes |
|---|---|---|
| `SHEET_ID` | The ID from the sheet's URL: `docs.google.com/spreadsheets/d/`**`THIS_PART`**`/edit` | Optional: the FlexiGenie chat sheet is built in |
| `HISTORY_SHEET_ID` | The **Webinar History** sheet's ID (step 4.7) | Optional: your Webinar History sheet is built in |
| `AGENT_NAME` | Exactly the agent account's Zoom display name, e.g. `FlexiFunnels Team` | required, so it ignores its own messages |
| `AGENT_EMAIL` | Optional. An email the agent can register with if it can't find the webinar in the host account (last-resort fallback) | optional |
| `PERSONA_NAME` | `Saurabh Sir` | The presenter the team replies on behalf of |
| `TEAM_NAMES` | e.g. `Arman,Support` | Names whose chat messages are never answered (your team members in the webinar) |
| `OPENAI_MODEL` | e.g. `gpt-4o-mini` | Optional. Leave unset to use the default |

Optional tuning (number asks per person, messages per minute, etc.) can also be set here. See **Tuning** in the README. Leave them unset to use the defaults.

✅ The Variables tab shows at least `AGENT_NAME`. Every variable also works if you added it under **Secrets** by mistake; the workflow checks both.

---

## Step 9: Turn on GitHub Actions and check the Zoom login (3 min)

1. Repo → **Actions** tab. If you see "Workflows aren't being run on this repository", click **I understand my workflows, go ahead and enable them**.
2. **Settings → Actions → General** → *Actions permissions*: **Allow all actions and reusable workflows** → Save.
3. **Actions → Zoom session check → Run workflow → Run workflow.** Wait ~2 minutes.

✅ The run is **green** and the "Check login" step says "✓ Zoom session is logged in". Red means: redo step 5 and update `ZOOM_SESSION_B64`. From now on this check runs by itself every morning at 8:05 AM. If it ever fails, GitHub emails you.

---

## Step 10: Apps Script, the dashboard's backend (10 min)

The Apps Script feeds the dashboard from your sheets **and** makes the GitHub calls for it. The GitHub token lives inside the script, so teammates only ever need **one team password**.

1. Pick a team password. A long random one is best: on Mac, `openssl rand -hex 12`.
2. Open the **chat Google Sheet** → **Extensions → Apps Script**.
3. Delete everything in `Code.gs` and paste the contents of [`apps-script/Code.gs`](apps-script/Code.gs). The dashboard's ⚙ panel also has a **Copy** button for it.
4. Set two lines:
   - `const KEY = '…';` → your **team password**
   - `const HISTORY_SHEET_ID = '…';` → the Webinar History sheet's ID

   Then **Save** (💾).
5. **Project Settings** (⚙ in the left bar) → **Script properties** → **Add script property**:
   - Property: `GITHUB_TOKEN`
   - Value: **token B** from step 6 (*Actions: Read and write*, *Contents: Read*)

   → **Save script properties**. The token stays private inside the script; it's never shown on the page or stored in the repo.
6. **Deploy → New deployment** → ⚙ → **Web app**, with *Execute as: **Me*** and *Who has access: **Anyone*** → **Deploy**.
   - Already deployed? Use **Deploy → Manage deployments → ✏️ → Version: New version → Deploy** instead. The URL stays the same.
7. Google asks for permissions, including "connect to an external service" (that's GitHub): **Authorize access → Advanced → Go to … → Allow**.
8. Copy the **Web app URL** (ends with `/exec`).
9. Test, in Chrome:
   - `YOUR_URL?key=TEAM_PASSWORD&action=whoami` → `{"ok":true,"github":true,…}`
   - `"github":false` means the `GITHUB_TOKEN` script property is missing.

✅ `whoami` shows `"github":true`.

## Step 10b: Host the dashboard on FlexiFunnels (optional, instead of or alongside Vercel)

1. In FlexiFunnels, create a page (e.g. *Webinar Automation Dashboard*) and add a **Custom Code** element.
2. Open [`dashboard/flexifunnels-loader.html`](dashboard/flexifunnels-loader.html). Your Apps Script `/exec` URL is already set in `APPS_SCRIPT_URL` (change it only if you redeploy as a *new* deployment). Copy **all** of it, paste it into the Custom Code box → **Save** → **Publish**. You only do this **once**.
   Anyone who opens the page then sees just a **team password** screen, once per browser. No tokens or links to set up.
3. Open the published page or **Preview**. The editor canvas may only show the placeholder. The dashboard fills the screen.

**It stays connected to GitHub.** Every time the page opens, the loader fetches the **latest** `dashboard/index.html` from the repo, so every push shows up within about 5 minutes, with no re-pasting. It tries, in order:

| Order | Source | When it's used |
|---|---|---|
| 1 | GitHub, public file (`raw.githubusercontent.com`) | the repo is public |
| 2 | GitHub API with the token saved in the dashboard's ⚙ settings | the repo is private (token B needs *Contents: Read*, which it already has) |
| 3 | The Vercel deployment | neither of the above worked (e.g. a private repo, opened for the first time on a new browser) |

> **Private repo, new browser:** the first time, the page shows the Vercel copy. Settings saved there belong to Vercel's address, so to use the FlexiFunnels address with a private repo, open the page, save the token once in ⚙, and reload.

Notes:
- FlexiFunnels squashes custom code onto one line when it publishes. The loader is written to survive that (block comments only, every statement ends with a semicolon), so don't add `//` comments to it.
- Settings (tokens and keys) are saved in your browser for that page's domain. Use a page on a domain without third-party scripts you don't trust.
- `dashboard/flexifunnels-embed.html` is a full **offline snapshot** (no GitHub needed). It doesn't update by itself, so use the loader unless you specifically need that.

## Step 11: Open the dashboard (1 min)

- **FlexiFunnels page (loader with `APPS_SCRIPT_URL` set):** type the **team password** → **Unlock**. Done. The DEMO badge disappears, the dots turn green, and your real tabs appear.
- **Vercel / opened as a file:** same password screen. The Apps Script URL is built into the dashboard too.
- **Sign out** (in ⚙) forgets the password on that browser, e.g. on a shared computer.

✅ No DEMO badge, GitHub and Sheet dots green, real tabs in Launch.

## Step 12: First live test: dry run (during a real webinar)

1. Up to **45 minutes before** the webinar's first chat, open the dashboard → **Launch**:
   - **01** Pick the tab (e.g. `Variant 3 – 11 AM`)
   - **02** Mode **Dry run**
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
| Dashboard still says DEMO | Enter the team password (FlexiFunnels page), or ⚙ → Apps Script URL + team password, "Use demo data" **off** → Save |
| "That password isn't right" / "Sheet: Wrong key" | The team password ≠ `KEY` in the Apps Script (redeploy a **new version** after changing it) |
| "GITHUB_TOKEN is not set…" | Apps Script → Project Settings → Script properties → add `GITHUB_TOKEN` (step 10.5) |
| "GitHub: Bad credentials" / "Not Found" | Token B (the `GITHUB_TOKEN` script property) expired, or doesn't cover this repo with Actions read and write |
| Launch fails with "Unexpected inputs" | The workflow file on GitHub is outdated. Pull the latest `main` |
| Run fails at "Restore Zoom session" | `ZOOM_SESSION_B64` missing or broken → step 5 |
| Agent Log has a WARNING "Joined as an ATTENDEE" | The account isn't an alternative host / panelist of this webinar → step 2 (Option A or B) |
| Agent joins but nothing in Conversations | Zoom selectors changed → see step 12.4 |
| Replies FAILED · "attendee not found" | Zoom's "To:" dropdown changed → send me the Inspect HTML of it |
| "Tab not found" | Pick the tab from the dashboard (names must match exactly, including the `–` dash) |

More details are in the [README](README.md).


## If the join link is a Zoom registration page

The universal link (or a link you paste) can end on `zoom.us/webinar/register/WN_…`. The agent doesn't register like an attendee. Instead it opens the logged-in host account's webinar list, finds the webinar that uses that registration link, and joins it by its ID as the host.

If it can't find it (for example, the saved Zoom session isn't the account that hosts the webinar), the run stops with a clear message. Quick fix for a test: put the **webinar ID** (like `812 3456 7890`, shown in Zoom → Webinars) in the `join_url` box when you run the workflow.

## Direct Zoom link (dashboard → Launch → step 03)

Paste a Zoom webinar link (`zoom.us/j/…`, `/w/…`) or just the webinar ID. The agent then skips the universal link, the registration lookup and the launch window. It joins that webinar right away as the main (host) account in the saved session and stays until the webinar ends. Timed chats still follow the selected tab's times. Leave the box empty for normal webinars.

The `JOIN_EARLY_MIN` variable is not needed. Without it, the agent joins 5 minutes before the tab's first chat.

## Automatic runs (no laptop needed)

GitHub starts the agent by itself:

| Webinar | Agent starts (IST) | Cron (UTC) |
|---|---|---|
| Every day 7:30 PM | ~6:35 PM | `5 13 * * *` |
| Sunday 11 AM | ~10:05 AM | `35 4 * * 0` |

The first automatic run creates an **Auto Schedule** tab in the chat sheet. Set these there for each slot:
- **Tab to read** (column C): the exact tab name.
- **Mode** (column D): `dry`, `timed` or `full`.
- **On** (column E): `yes` or `no`. Set it to `no` to skip, for example on a holiday.

GitHub can start scheduled runs 5–15 minutes late, which is why they start about an hour early. GitHub also pauses schedules in repos with no activity for 60 days, so make any small commit if that ever happens.

## Automatic Zoom sign-in (when the saved session expires)

Add two **Secrets**: `ZOOM_EMAIL` (the host account's email) and `ZOOM_PASSWORD`. If the saved session has expired, the agent signs in with them and saves the fresh session back to `ZOOM_SESSION_B64` (this needs `SECRETS_PAT`).

If Zoom asks for a verification code or CAPTCHA (common on a new device or location), the agent does **not** try to get around it. It stops and says so. Then run `bash ~/webinar-chat-automation/scripts/refresh-session.sh` on the Mac.

## 15 Days First Sale Challenge webinar

- **Dashboard:** Launch → step 00 → **15 Days First Sale Challenge**, then pick the **day** tab. Times in the day tabs count from **7:00 PM**. Only rows with Mode `Chat` (or empty) are posted.
- **Sheet:** "15 Days Challenge Chats" (`1T4UCbX34Yyxw14VFcN1xsTMlMnH-ffR0f21BgYegZ5w`), shared as Editor with the service account. The agent's logs, Numbers and History still go to the main sheets.
- **Joins via:** https://sb.flexifunnels.com/fifteendays (or paste a direct Zoom link).
- **Rules (buyers' session):** timed chats plus short replies that clear doubts. No number asks, no lead saving, no pricing lock. If an optional `Attendee Replies` tab exists in the 15 Days sheet, its facts are used.
- **One-time:** the dashboard backend needs the updated `apps-script/Code.gs`.
  1. Open the Apps Script project and replace the code with the new file. **Keep your own `KEY` line** (the team password) and your `HISTORY_SHEET_ID`.
  2. Click **Deploy → Manage deployments → ✏️ (edit) → Version: New version → Deploy**. The URL stays the same.
  3. The first time, Google asks you to authorise access to the 15 Days sheet. Allow it.
