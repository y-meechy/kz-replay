#!/usr/bin/env bash
#
# Deploy origin/main. Triggered by the GitHub Actions workflow over SSH
# (.github/workflows/deploy.yml) after the tests pass.
#
# The SSH key GitHub holds is restricted in authorized_keys to run exactly this
# script and nothing else (command="/opt/kz-replay/deploy/deploy.sh"), so the
# key is worth one deploy, not the host.
#
# Everything lives inside main(), which bash parses before it runs a single line
# of it. That matters because the pull below rewrites this very file.

set -euo pipefail

REPO_DIR=${KZ_REPO_DIR:-/opt/kz-replay}
COMPOSE_FILE=docker-compose.prod.yml
HEALTH_URL=${KZ_HEALTH_URL:-http://127.0.0.1:8081/healthz}
# Touch this file to stop deployments without touching GitHub: a map
# reconversion runs for hours and replacing the container would kill it.
HOLD_FILE=${KZ_HOLD_FILE:-/var/lib/kz-replay/.deploy-hold}
HEALTH_TIMEOUT_SECONDS=90

log() { echo "[$(date --iso-8601=seconds)] $*"; }

main() {
  if [ -e "$HOLD_FILE" ]; then
    log "held by $HOLD_FILE, refusing to deploy"
    return 1
  fi

  cd "$REPO_DIR"

  # A refresh converts maps for hours and writes into the shared volume. Taking
  # the container away mid-conversion loses that work.
  if curl --silent --max-time 10 "$HEALTH_URL" | grep -q '"refreshing":true'; then
    log "a refresh is running, refusing to deploy"
    return 1
  fi

  git fetch --quiet origin main
  local current target requested
  current=$(git rev-parse HEAD)
  target=$(git rev-parse origin/main)

  # The workflow sends "deploy <sha>" — the commit its tests actually ran on.
  # Deploying that instead of whatever main points at now closes the race where
  # a push lands mid-run and ships untested. Anything malformed is ignored and
  # the tip of main used, so a plain "deploy" keeps working.
  requested=$(printf '%s' "${SSH_ORIGINAL_COMMAND:-}" | sed -n 's/^deploy \([0-9a-f]\{40\}\)$/\1/p')
  if [ -n "$requested" ]; then
    if ! git merge-base --is-ancestor "$requested" origin/main 2>/dev/null; then
      log "requested commit ${requested:0:8} is not on origin/main, refusing"
      return 1
    fi
    target=$requested
  fi
  if [ "$current" = "$target" ]; then
    log "already at ${current:0:8}, nothing to do"
    return 0
  fi

  log "deploying ${current:0:8} -> ${target:0:8}"

  # The image that is serving right now, so there is something to go back to.
  # Missing on a first ever deploy, which is not a reason to stop.
  docker image tag kz-replay:latest kz-replay:rollback 2>/dev/null ||
    log "no current image to keep as rollback"

  git reset --quiet --hard "$target"
  log "building"
  if ! docker compose -f "$COMPOSE_FILE" build --pull; then
    log "BUILD FAILED, still serving ${current:0:8}"
    git reset --quiet --hard "$current"
    return 1
  fi

  log "restarting"
  docker compose -f "$COMPOSE_FILE" up -d --no-deps --scale kz-replay=1

  local waited=0
  while [ "$waited" -lt "$HEALTH_TIMEOUT_SECONDS" ]; do
    if curl --silent --fail --max-time 5 "$HEALTH_URL" >/dev/null 2>&1; then
      log "deployed ${target:0:8}, healthy after ${waited}s"
      return 0
    fi
    sleep 5
    waited=$((waited + 5))
  done

  log "UNHEALTHY after ${HEALTH_TIMEOUT_SECONDS}s, rolling back to ${current:0:8}"
  # On a first-ever deploy there is no rollback image; still reset the repo and
  # restart rather than dying here and leaving the broken commit checked out.
  docker image tag kz-replay:rollback kz-replay:latest 2>/dev/null ||
    log "no rollback image to restore"
  git reset --quiet --hard "$current"
  docker compose -f "$COMPOSE_FILE" up -d --no-deps --scale kz-replay=1
  return 1
}

main "$@"
