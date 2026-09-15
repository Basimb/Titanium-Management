#!/bin/sh
# Keeps the WhatsApp bridge's own checkout in step with main, and restarts the
# bridge only when the code actually changed.
#
# Why this exists (2026-09-15): the bridge does NOT run from the release the
# deploy cron installs. That release is the Next standalone build only -- no
# lib/, no services/ -- while services/whatsapp-bridge/src/main.mjs runs
# straight out of this checkout and imports lib/agent-followups.ts from it.
# So every reminder the bridge sends was built from whatever this directory
# happened to contain. It contained daf3a9b for three days: its origin was an
# SSH remote whose key no longer authenticates, so `git fetch` had been failing
# silently since 2026-09-12 and nobody saw it. Six commits of work reached
# GitHub, passed CI, deployed the dashboard, and never reached the bot.
#
# Install: one crontab line, e.g. every five minutes --
#   */5 * * * * /bin/sh ~/repositories/titanium-agent/scripts/bridge-auto-update.sh >> ~/logs/bridge-auto-update.log 2>&1
# The bridge itself is started by its own every-minute cron (run-bridge.sh
# under flock), so killing it here is all a restart takes.
set -eu

REPO=$(cd "$(dirname "$0")/.." && pwd)
LOCK=/home/titani24/.titanium-team-chat/auto-update.lock

# Never let two runs overlap: a fetch that outlives the five-minute window
# would otherwise stack, and two mid-merge checkouts is how a repo ends up in
# a state nobody can explain. -n means "skip this run", not "wait".
exec 9>"$LOCK"
flock -n 9 || exit 0

cd "$REPO"

# A network blip is not a failure worth restarting anything over -- leave the
# bridge on the code it already has and try again in five minutes.
git fetch --quiet origin main || exit 0

before=$(git rev-parse HEAD)
after=$(git rev-parse FETCH_HEAD)
[ "$before" = "$after" ] && exit 0

# --ff-only on purpose: if someone has committed directly on the server, this
# refuses and says so rather than discarding their work. The bridge keeps
# running the code it has until a person looks.
if ! git merge --ff-only FETCH_HEAD >/dev/null 2>&1; then
  echo "$(date -u '+%Y-%m-%d %H:%M:%S') UTC  refused: not a fast-forward, still at $before"
  exit 1
fi

echo "$(date -u '+%Y-%m-%d %H:%M:%S') UTC  updated $before -> $after, restarting bridge"
# The bridge is stateless across restarts (WhatsApp auth lives in
# TEAM_CHAT_STATE_DIR), so a kill is a clean restart: the every-minute cron
# brings it back within 60s on the new code.
pkill -f 'whatsapp-bridge/src' || true
