#!/bin/bash
# Mac: refresh the agent's Zoom login in one go.
#   bash scripts/refresh-session.sh
# Opens Zoom → you log in (host account) → press Enter → the session is copied to your clipboard,
# the GitHub secret page opens in Chrome (just paste + Update), and the local files are deleted.
set -e
DIR="$HOME/webinar-chat-automation"
SECRET_URL="https://github.com/Sarthak-B/webinar-chat-automation/settings/secrets/actions/ZOOM_SESSION_B64"

if [ ! -d "$DIR/.git" ]; then
  echo "→ Downloading the project to $DIR"
  git clone -q https://github.com/Sarthak-B/webinar-chat-automation.git "$DIR"
fi
cd "$DIR"
echo "→ Updating the project"
git pull -q || true
npm install --silent
npx playwright install chromium >/dev/null

echo ""
echo "→ A Chrome window will open. Log into the HOST Zoom account (incl. OTP)."
echo "  When you see your Zoom profile, come back here and press Enter."
npm run --silent save-session

if [ ! -s zoom-session.b64 ]; then
  echo "✗ No session file was created – run this again." && exit 1
fi
pbcopy < zoom-session.b64
rm -f zoom-session.json zoom-session.b64
echo ""
echo "✓ Zoom session copied to your clipboard (local files deleted)."
echo "→ Opening the GitHub secret page: click in the Value box, press Cmd+V, then 'Update secret'."
open -a "Google Chrome" "$SECRET_URL" 2>/dev/null || open "$SECRET_URL"
