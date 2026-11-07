#!/usr/bin/env bash
# Stop the BeaconHS services on this host, safely.
#
# WHAT IT DOES
# ------------
#   1. checks Docker, Compose, the compose file and the project name;
#   2. confirms the project it is about to stop is the BeaconHS one, and lists
#      the containers it will stop;
#   3. reports the other Compose projects it can see, and leaves them alone;
#   4. stops the services in dependency order, giving each a chance to exit
#      cleanly;
#   5. verifies that the external data volumes, the images and the data are
#      still there.
#
# WHAT IT NEVER DOES
# ------------------
# It never runs `down -v`, never removes a volume, never removes an image,
# never prunes anything, never deletes a container and never stops the
# Cloudflare tunnel (which is a host service, not part of this project).
#
# Running it twice is safe: the second run finds everything already stopped and
# reports that.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/deployment/lib.sh
. "$SCRIPT_DIR/lib.sh"

usage() {
  cat >&2 <<'USAGE'
usage: beaconhs-stop.sh [--timeout <seconds>]

  --timeout  Seconds a service may take to stop cleanly (default 30).
USAGE
  exit 2
}

STOP_TIMEOUT=30
while [ $# -gt 0 ]; do
  case "$1" in
    --timeout)
      STOP_TIMEOUT="${2:-}"
      [[ "$STOP_TIMEOUT" =~ ^[0-9]+$ ]] || usage
      shift 2
      ;;
    -h | --help) usage ;;
    *) beaconhs_fail "unknown argument: $1" ;;
  esac
done

beaconhs_log "stop"
beaconhs_require_docker
beaconhs_require_compose
beaconhs_require_file "$BEACONHS_COMPOSE_FILE"

# The project is a hard boundary: the script must never reach into another
# Compose project's containers.
case " $BEACONHS_ALLOWED_PROJECTS " in
  *" $BEACONHS_PROJECT "*) ;;
  *)
    beaconhs_fail "refusing to stop: the project '$BEACONHS_PROJECT' is not one this host manages"
    ;;
esac

echo
beaconhs_log "containers that will be stopped:"
for service in "${BEACONHS_SERVICES[@]}" "${BEACONHS_ONE_SHOT_SERVICES[@]}"; do
  container="$(beaconhs_compose ps -aq "$service" 2>/dev/null || true)"
  [ -n "$container" ] || continue
  printf '  %-14s %s\n' "$service" "$(docker inspect -f '{{.Name}} ({{.State.Status}})' "$container" 2>/dev/null || echo "$container")"
done

other_projects="$(docker ps -a --format '{{.Label "com.docker.compose.project"}}' 2>/dev/null |
  grep -v "^${BEACONHS_PROJECT}$" | grep -v '^$' | sort -u || true)"
if [ -n "$other_projects" ]; then
  echo
  beaconhs_log "other Compose projects present and NOT touched:"
  printf '  %s\n' $other_projects
fi

echo
beaconhs_log "stopping services in dependency order (timeout ${STOP_TIMEOUT}s)"
# The web tier goes first, then the data tier, so a request in flight is
# refused by the web tier before the store it reads from goes away.
for service in web worker scheduler storage-init collabora minio redis postgres; do
  container="$(beaconhs_compose ps -aq "$service" 2>/dev/null || true)"
  [ -n "$container" ] || continue
  status="$(docker inspect -f '{{.State.Status}}' "$container" 2>/dev/null || echo unknown)"
  if [ "$status" = "running" ]; then
    beaconhs_compose stop -t "$STOP_TIMEOUT" "$service" >/dev/null 2>&1 ||
      beaconhs_warn "$service did not stop cleanly; it was left for inspection"
  fi
done

echo
beaconhs_log "verifying that nothing was destroyed"

# The external volumes must still exist.
missing=()
for volume in "${BEACONHS_EXPECTED_VOLUMES[@]}"; do
  docker volume inspect "$volume" >/dev/null 2>&1 || missing+=("$volume")
done
if [ ${#missing[@]} -gt 0 ]; then
  beaconhs_fail "external data volumes are missing after the stop: ${missing[*]}"
fi
beaconhs_log "  external data volumes: present (${#BEACONHS_EXPECTED_VOLUMES[@]})"

# The images must still be present.
image_missing=()
image_count=0
beaconhs_load_image_identity
while IFS= read -r reference; do
  [ -n "$reference" ] || continue
  image_count=$((image_count + 1))
  docker image inspect "$reference" >/dev/null 2>&1 || image_missing+=("$reference")
done < <(beaconhs_expected_images)
if [ ${#image_missing[@]} -gt 0 ]; then
  beaconhs_fail "pinned images are missing after the stop: ${image_missing[*]}"
fi
beaconhs_log "  pinned images: present ($image_count)"

# The database container must be STOPPED, not removed, and its volume must still
# be there. `ps -aq` includes stopped containers, so an absent result really means
# the container is gone rather than merely not running.
postgres_container="$(beaconhs_compose ps -aq postgres 2>/dev/null || true)"
if [ -z "$postgres_container" ]; then
  beaconhs_warn "the postgres container no longer exists; the stop should only have stopped it"
else
  postgres_status="$(docker inspect -f '{{.State.Status}}' "$postgres_container" 2>/dev/null || echo unknown)"
  if [ "$postgres_status" = "running" ]; then
    beaconhs_warn "the postgres container is still running; the stop did not complete"
  else
    beaconhs_log "  postgres container preserved and stopped (state: $postgres_status)"
  fi
fi

echo
echo "BeaconHS stopped"
echo "---------------"
for service in "${BEACONHS_SERVICES[@]}" "${BEACONHS_ONE_SHOT_SERVICES[@]}"; do
  container="$(beaconhs_compose ps -aq "$service" 2>/dev/null || true)"
  if [ -z "$container" ]; then
    printf '%-14s %s\n' "$service:" "ABSENT"
  else
    printf '%-14s %s\n' "$service:" "$(docker inspect -f '{{.State.Status}}' "$container" 2>/dev/null || echo unknown)"
  fi
done
echo
beaconhs_log "the public entry point will now answer 502 until the system is started again"
