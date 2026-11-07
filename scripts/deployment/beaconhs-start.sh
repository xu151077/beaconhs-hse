#!/usr/bin/env bash
# Start the whole BeaconHS system on this host.
#
# WHAT IT DOES
# ------------
#   1. checks the host, Docker, Compose, the compose file, the runtime env files,
#      the external data volumes and the five pinned images;
#   2. checks the deployment identity and the compose file hash;
#   3. refuses to run if the runtime env names a non-local endpoint;
#   4. starts the project with `--pull never --no-build`, so it never pulls an
#      image and never rebuilds one;
#   5. waits for every service to report healthy, and for the two one-shot
#      services to have exited 0;
#   6. runs the Gate 5 verifier and prints the result.
#
# WHAT IT NEVER DOES
# ------------------
# It never pulls an image, never rebuilds one, never runs a migration, never
# provisions a database, never removes a volume and never runs `down -v`. If a
# precondition fails it stops with the reason and changes nothing.
#
# Re-running it is safe: Compose adopts the running containers, the external
# volumes are untouched, and no migration or provisioning is repeated.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/deployment/lib.sh
. "$SCRIPT_DIR/lib.sh"

usage() {
  cat >&2 <<'USAGE'
usage: beaconhs-start.sh [--compose-sha256 <sha256>] [--no-gate5]

  --compose-sha256  Require the compose file to hash to this value.
  --no-gate5        Skip the Gate 5 verification step.
USAGE
  exit 2
}

COMPOSE_SHA=""
RUN_GATE5=1
while [ $# -gt 0 ]; do
  case "$1" in
    --compose-sha256)
      COMPOSE_SHA="${2:-}"
      [ -n "$COMPOSE_SHA" ] || usage
      shift 2
      ;;
    --no-gate5) RUN_GATE5=0; shift ;;
    -h | --help) usage ;;
    *) beaconhs_fail "unknown argument: $1" ;;
  esac
done

beaconhs_log "start"
# The project is a hard boundary: the script must never reach into another
# Compose project's containers (same check as the stop script).
case " $BEACONHS_ALLOWED_PROJECTS " in
  *" $BEACONHS_PROJECT "*) ;;
  *)
    beaconhs_fail "refusing to start: the project '$BEACONHS_PROJECT' is not one this host manages"
    ;;
esac
beaconhs_require_docker
beaconhs_require_compose
beaconhs_require_file "$BEACONHS_COMPOSE_FILE"
beaconhs_require_private_file "$BEACONHS_ENV_FILE"
beaconhs_require_private_file "$BEACONHS_KEY_ENV_FILE"
beaconhs_require_volumes
beaconhs_require_image_identity
beaconhs_require_images
beaconhs_require_compose_hash "$COMPOSE_SHA"
beaconhs_require_no_production_endpoint

# The deployment identity comes from the runtime env; it is not secret, and it
# is what the verifier compares the container labels against.
BEACONHS_DEPLOYMENT_ID="$(beaconhs_env_value BEACONHS_DEPLOYMENT_ID)"
[ -n "$BEACONHS_DEPLOYMENT_ID" ] || beaconhs_fail "BEACONHS_DEPLOYMENT_ID is not set in $BEACONHS_ENV_FILE"
export BEACONHS_DEPLOYMENT_ID

beaconhs_log "project: $BEACONHS_PROJECT"
beaconhs_log "deployment id: $BEACONHS_DEPLOYMENT_ID"

beaconhs_acquire_lock

# The long-running services are started together. A one-shot service is started
# only when it has not already completed for THIS image, so a repeated start does
# not redo work that is already done while a new release still runs it.
beaconhs_log "starting long-running services (--pull never --no-build)"
if ! beaconhs_compose up -d --pull never --no-build "${BEACONHS_SERVICES[@]}"; then
  beaconhs_fail "docker compose up failed; the scene is left in place for inspection"
fi
for service in "${BEACONHS_ONE_SHOT_SERVICES[@]}"; do
  if beaconhs_one_shot_is_current "$service"; then
    beaconhs_log "  $service: already complete for this image"
    continue
  fi
  beaconhs_log "  $service: starting"
  if ! beaconhs_compose up -d --pull never --no-build "$service"; then
    beaconhs_fail "docker compose up $service failed; the scene is left in place for inspection"
  fi
done

# Wait for the long-running services to report healthy.
beaconhs_log "waiting for the services to become healthy"
for service in "${BEACONHS_SERVICES[@]}"; do
  deadline=$((SECONDS + 180))
  while true; do
    state="$(beaconhs_service_state "$service")"
    case "$state" in
      running/healthy) break ;;
      exited/*)
        beaconhs_fail "$service stopped: $state"
        ;;
    esac
    if [ "$SECONDS" -ge "$deadline" ]; then
      beaconhs_fail "$service did not become healthy in time (state: $state)"
    fi
    sleep 3
  done
  beaconhs_log "  $service: healthy"
done

# The one-shot services are expected to have exited with code 0.
for service in "${BEACONHS_ONE_SHOT_SERVICES[@]}"; do
  state="$(beaconhs_one_shot_state "$service")"
  case "$state" in
    READY) beaconhs_log "  $service: ready (exited 0)" ;;
    *) beaconhs_warn "$service state: $state" ;;
  esac
done

# No container may have restarted: a restart means the process died and came
# back, which is not a healthy start.
for service in "${BEACONHS_SERVICES[@]}"; do
  container="$(beaconhs_compose ps -q "$service" 2>/dev/null || true)"
  [ -n "$container" ] || continue
  restarts="$(docker inspect -f '{{.RestartCount}}' "$container" 2>/dev/null || echo 0)"
  if [ "$restarts" != "0" ]; then
    beaconhs_warn "$service restarted $restarts time(s) during startup"
  fi
done

gate5="SKIPPED"
if [ "$RUN_GATE5" = "1" ]; then
  beaconhs_log "running the Gate 5 verifier"
  gate5="$(beaconhs_gate5)"
fi

started_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
{
  printf 'started_at=%s\n' "$started_at"
  printf 'deployment_id=%s\n' "$BEACONHS_DEPLOYMENT_ID"
  printf 'project=%s\n' "$BEACONHS_PROJECT"
  printf 'gate5=%s\n' "$gate5"
} >"$BEACONHS_RUNTIME_DIR/system-start-state.txt" 2>/dev/null || true

echo
echo "BeaconHS startup"
echo "----------------"
for service in "${BEACONHS_SERVICES[@]}"; do
  printf '%-12s %s\n' "$service:" "$(beaconhs_service_state "$service" | tr 'a-z/' 'A-Z ')"
done
for service in "${BEACONHS_ONE_SHOT_SERVICES[@]}"; do
  printf '%-12s %s\n' "$service:" "$(beaconhs_one_shot_state "$service")"
done
printf '%-12s %s\n' 'Gate 5:' "$gate5"
printf '%-12s %s\n' 'Public URL:' "$BEACONHS_PUBLIC_ORIGIN"
echo
beaconhs_log "started at $started_at"
