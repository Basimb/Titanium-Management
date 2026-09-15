#!/bin/sh
# Keeps BOTH halves of the system in step with main: the WhatsApp bridge's own
# checkout (restarted only when the code actually changed) and the dashboard
# release the Next app serves.
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
# Why the app half is here too (2026-09-15): the bridge updated itself every
# five minutes while the Next app had no updater at all -- its deploy script
# was only ever run by hand. So after every push there was a window where the
# bot ran new code and the app ran old, and the app sat two commits behind for
# a day without anyone noticing. That window is not cosmetic: the bot builds
# the polls, the app resolves the taps, so a bot ahead of the app sends buttons
# the app does not recognize and every tap on them is refused. Both halves move
# together now, from one script, so there is one place to look and one thing to
# switch off -- rather than a second cron line doing almost the same job.
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

# The dashboard release advances on its own schedule -- GitHub Actions
# publishes it a few minutes AFTER the push this script's bridge half picks up
# -- so it is checked every run, never only when the bridge checkout moved.
# deploy-titanium-release.sh does its own no-op check (it compares the release's
# source-sha against the deployed one and exits 0 when they match), so the
# normal case costs one fetch and nothing else. A failure here must not stop the
# bridge half below from running, hence the guard rather than set -e.
DEPLOY=/home/titani24/deploy-titanium-release.sh
DEPLOYED_SHA=/home/titani24/management.titanium-pharmacy.com/.deployed-source-sha
if [ -f "$DEPLOY" ]; then
  app_before=$(cat "$DEPLOYED_SHA" 2>/dev/null || echo none)
  if deploy_output=$(bash "$DEPLOY" 2>&1); then
    app_after=$(cat "$DEPLOYED_SHA" 2>/dev/null || echo none)
    # Quiet on the ordinary run: this fires every five minutes and almost
    # always has nothing to say. Only an actual change is worth a line.
    [ "$app_before" = "$app_after" ] || echo "$(date -u '+%Y-%m-%d %H:%M:%S') UTC  app $app_before -> $app_after"
  else
    # A failure is never quiet -- a silently stuck app is the whole reason
    # this half exists. The bridge half below still runs.
    echo "$(date -u '+%Y-%m-%d %H:%M:%S') UTC  app deploy failed: $(echo "$deploy_output" | tail -3 | tr '\n' ' ')"
  fi
fi

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
