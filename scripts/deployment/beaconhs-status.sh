#!/usr/bin/env bash
# Report the state of the BeaconHS deployment on this host.
#
# It is strictly a READ: it starts nothing, stops nothing and changes nothing.
#
# It never prints the contents of an env file, a database password, an object
# store credential, an SMTP password or the Server Action key. It reports only
# the PRESENCE of those settings, and the fingerprints and identifiers the
# operator needs to tell two deployments apart.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/deployment/lib.sh
. "$SCRIPT_DIR/lib.sh"

usage() {
  cat >&2 <<'USAGE'
usage: beaconhs-status.sh

Prints the deployment state. Reads only.
USAGE
  exit 2
}

# The Server Action key fingerprint identifies WHICH key is deployed without
# revealing it. The tool is the repository's own fingerprint CLI; the installer
# copies it next to these scripts so the status works on a host that has no
# checkout.
beaconhs_key_fingerprint() {
  local key_file="$HOME/.beaconhs/next_server_actions_key"
  local tool=""
  for candidate in \
    "$SCRIPT_DIR/server-action-key-fingerprint.mjs" \
    "$SCRIPT_DIR/../../scripts/ci/server-action-key-fingerprint.mjs"; do
    if [ -f "$candidate" ]; then
      tool="$candidate"
      break
    fi
  done
  if [ ! -f "$key_file" ] || [ -z "$tool" ]; then
    printf '(unavailable)'
    return
  fi
  if ! command -v node >/dev/null 2>&1; then
    printf '(node unavailable)'
    return
  fi
  node "$tool" "$key_file" 2>/dev/null || printf '(unavailable)'
}

[ $# -eq 0 ] || usage

echo "BeaconHS status"
echo "==============="
echo

beaconhs_require_docker
beaconhs_require_compose

printf '%-26s %s\n' 'Docker engine:' "$(docker info >/dev/null 2>&1 && echo 'running' || echo 'NOT RUNNING')"
printf '%-26s %s\n' 'Docker compose:' "$(docker compose version --short 2>/dev/null || echo 'unavailable')"
printf '%-26s %s\n' 'Compose project:' "$BEACONHS_PROJECT"
printf '%-26s %s\n' 'Compose file:' "$BEACONHS_COMPOSE_FILE"
if [ -f "$BEACONHS_COMPOSE_FILE" ]; then
  printf '%-26s %s\n' 'Compose file sha256:' "$(sha256sum "$BEACONHS_COMPOSE_FILE" | cut -d' ' -f1)"
else
  printf '%-26s %s\n' 'Compose file sha256:' 'MISSING'
fi

# The deployment id is an identifier, not a credential.
deployment_id="(unset)"
if [ -f "$BEACONHS_ENV_FILE" ]; then
  deployment_id="$(beaconhs_env_value BEACONHS_DEPLOYMENT_ID)"
  [ -n "$deployment_id" ] || deployment_id="(unset)"
fi
printf '%-26s %s\n' 'Deployment id:' "$deployment_id"

if [ -f "$BEACONHS_RUNTIME_DIR/system-start-state.txt" ]; then
  printf '%-26s %s\n' 'Started at:' "$(grep -E '^started_at=' "$BEACONHS_RUNTIME_DIR/system-start-state.txt" | cut -d= -f2- || echo unknown)"
else
  printf '%-26s %s\n' 'Started at:' '(not recorded)'
fi

echo
echo "Services"
echo "--------"
for service in "${BEACONHS_SERVICES[@]}"; do
  # One-shot services are reported by the loop below, once.
  case " ${BEACONHS_ONE_SHOT_SERVICES[*]} " in
    *" $service "*) continue ;;
  esac
  printf '%-14s %s\n' "$service:" "$(beaconhs_service_state "$service" | tr 'a-z/' 'A-Z ')"
done
for service in "${BEACONHS_ONE_SHOT_SERVICES[@]}"; do
  printf '%-14s %s\n' "$service:" "$(beaconhs_one_shot_state "$service")"
done

echo
echo "Images (pinned set)"
echo "-------------------"
beaconhs_load_image_identity
while IFS= read -r reference; do
  [ -n "$reference" ] || continue
  if docker image inspect "$reference" >/dev/null 2>&1; then
    printf '%-14s %s\n' "${reference%%@*}" "present"
  else
    printf '%-14s %s\n' "${reference%%@*}" "MISSING"
  fi
done < <(beaconhs_expected_images)
if [ -n "$BEACONHS_IMAGE_DIGEST_REF" ]; then
  printf '%-14s %s\n' 'app digest:' "$BEACONHS_IMAGE_DIGEST_REF"
fi

echo
echo "Data volumes (external)"
echo "------------------------"
for volume in "${BEACONHS_EXPECTED_VOLUMES[@]}"; do
  if docker volume inspect "$volume" >/dev/null 2>&1; then
    printf '%-32s %s\n' "$volume" "present"
  else
    printf '%-32s %s\n' "$volume" "MISSING"
  fi
done

echo
echo "Disk"
echo "----"
df -h / | tail -1 | awk '{print "  / free: " $4 "  used: " $3 "  (" $5 ")"}'

echo
echo "Gate 5"
echo "-------"
if [ -f "$BEACONHS_GATE5_RESULT" ]; then
  printf '  last result: %s\n' "$(grep -E '^VERDICT:' "$BEACONHS_GATE5_RESULT" | head -1 | cut -d' ' -f2- || echo 'unknown')"
  printf '  recorded at: %s\n' "$(stat -c '%y' "$BEACONHS_GATE5_RESULT" | cut -d'.' -f1)"
else
  printf '  last result: (not recorded)\n'
fi

echo
echo "Network exposure"
echo "----------------"
printf '  %-26s %s\n' 'public entry point:' "$BEACONHS_PUBLIC_ORIGIN"
for service in postgres redis minio collabora web; do
  container="$(beaconhs_compose ps -q "$service" 2>/dev/null || true)"
  ports=""
  [ -n "$container" ] && ports="$(docker port "$container" 2>/dev/null || true)"
  if [ -n "$ports" ]; then
    printf '  %-26s %s\n' "${service} published:" "$(printf '%s' "$ports" | tr '\n' ' ')"
  else
    printf '  %-26s %s\n' "${service} published:" '(none)'
  fi
done

echo
echo "Cloudflare tunnel (host service, read-only)"
echo "--------------------------------------------"
if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files 2>/dev/null | grep -q '^cloudflared'; then
  printf '  %-26s %s\n' 'unit state:' "$(systemctl is-active cloudflared 2>/dev/null || echo unknown)"
else
  printf '  %-26s %s\n' 'unit state:' '(no cloudflared unit here)'
fi

echo
echo "Secrets (presence only, never values)"
echo "------------------------------------"
for file in "$BEACONHS_ENV_FILE" "$BEACONHS_KEY_ENV_FILE" "$BEACONHS_RUNTIME_DIR/provision-vars.env"; do
  if [ -f "$file" ]; then
    printf '  %-52s present mode=%s\n' "${file/#$HOME/~}" "$(stat -c '%a' "$file")"
  else
    printf '  %-52s absent\n' "${file/#$HOME/~}"
  fi
done
printf '  %-52s %s\n' 'Server Action key fingerprint:' "$(beaconhs_key_fingerprint)"
