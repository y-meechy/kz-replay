#!/usr/bin/env bash
#
# Deploy origin/main if it has moved. Run by kz-replay-autodeploy.timer.
#
# Pull based on purpose. The alternative, a CI job that connects in and deploys,
# needs a key for this host stored at GitHub, and this host also runs unrelated
# services, so that key would be worth far more than the thing it deploys. Here
# nothing leaves the box: the host holds a read-only deploy key, asks GitHub
# whether main has moved, and only then does any work.
#
# Everything lives inside main(), which bash parses before it runs a single line
# of it. That matters because the pull below rewrites this very file.

set -euo pipefail

REPO_DIR=${KZ_REPO_DIR:-/opt/kz-replay}
COMPOSE_FILE=docker-compose.prod.yml
HEALTH_URL=${KZ_HEALTH_URL:-http://127.0.0.1:8081/healthz}
# Touch this file to stop deployments without disabling the timer: a map
# reconversion runs for hours and replacing the container would kill it.
HOLD_FILE=${KZ_HOLD_FILE:-/var/lib/kz-replay/.deploy-hold}
# The commit that last failed to build or come up. Without remembering it, a broken
# push would be retried every two minutes, and each retry is a full image build.
FAILED_FILE=${KZ_FAILED_FILE:-/var/lib/kz-replay/.deploy-failed-sha}
HEALTH_TIMEOUT_SECONDS=90

log() { echo "[$(date --iso-8601=seconds)] $*"; }

main() {
  if [ -e "$HOLD_FILE" ]; then
    log "held by $HOLD_FILE, skipping"
    return 0
  fi

  cd "$REPO_DIR"

  # A refresh converts maps for hours and writes into the shared volume. Taking
  # the container away mid-conversion loses that work, so wait for a quiet moment.
  if curl --silent --max-time 10 "$HEALTH_URL" | grep -q '"refreshing":true'; then
    log "a refresh is running, skipping"
    return 0
  fi

  git fetch --quiet origin main
  local current target
  current=$(git rev-parse HEAD)
  target=$(git rev-parse origin/main)
  if [ "$current" = "$target" ]; then
    return 0
  fi

  if [ "$target" = "$(cat "$FAILED_FILE" 2>/dev/null || true)" ]; then
    # Already tried this one and it did not work. Waiting for a new commit rather
    # than rebuilding it every two minutes until someone notices.
    return 0
  fi

  log "main moved ${current:0:8} -> ${target:0:8}, deploying"

  # The image that is serving right now, so there is something to go back to.
  # Missing on a first ever deploy, which is not a reason to stop.
  docker image tag kz-replay:latest kz-replay:rollback 2>/dev/null ||
    log "no current image to keep as rollback"

  git reset --quiet --hard origin/main
  log "building"
  if ! docker compose -f "$COMPOSE_FILE" build --pull; then
    log "BUILD FAILED, still serving ${current:0:8}"
    echo "$target" > "$FAILED_FILE"
    git reset --quiet --hard "$current"
    return 1
  fi

  log "restarting"
  docker compose -f "$COMPOSE_FILE" up -d --no-deps --scale kz-replay=1

  local waited=0
  while [ "$waited" -lt "$HEALTH_TIMEOUT_SECONDS" ]; do
    if curl --silent --fail --max-time 5 "$HEALTH_URL" >/dev/null 2>&1; then
      log "deployed ${target:0:8}, healthy after ${waited}s"
      rm -f "$FAILED_FILE"
      return 0
    fi
    sleep 5
    waited=$((waited + 5))
  done

  log "UNHEALTHY after ${HEALTH_TIMEOUT_SECONDS}s, rolling back to ${current:0:8}"
  echo "$target" > "$FAILED_FILE"
  docker image tag kz-replay:rollback kz-replay:latest
  git reset --quiet --hard "$current"
  docker compose -f "$COMPOSE_FILE" up -d --no-deps --scale kz-replay=1
  return 1
}

main "$@"
