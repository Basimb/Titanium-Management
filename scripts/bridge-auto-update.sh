#!/bin/sh
# WhatsApp bridge updater only. The old management dashboard was cancelled.
# IDARA runs directly from public_html/idara and is maintained separately.
# Never invoke the retired dashboard deploy script from this updater.
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
# Preserve direct server development. Never merge over local edits or untracked files.
[ -z "$(git status --porcelain)" ] || exit 0
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

