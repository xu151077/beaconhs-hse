#!/usr/bin/env bash
# Deployment gate for the Next.js Server Action encryption key.
#
# WHY THIS EXISTS
#
# Next.js requires every web instance to hold the same Server Action key, but it
# cannot detect a mismatch itself: the failure surfaces later as "Failed to find
# Server Action" on whichever request crosses instances. The application proves
# that one instance's key is valid (readiness) and can compare two configurations
# (the fingerprint script). This wrapper turns that primitive into a gate the
# deployment actually runs:
#
#   * before traffic: the key embedded in the immutable image must equal the
#     expected build-time secret;
#   * after rollout: every running web task must either use that verified
#     build-time key or log the same expected runtime fingerprint.
#
# The key itself is never printed. Only the 128-bit HMAC fingerprint (see
# apps/web/src/lib/server-action-key.ts) crosses a process boundary, and the
# temporary manifest/key files are removed on every exit path.
#
# USAGE
#   verify-server-action-key-gate.sh fingerprint --env
#   verify-server-action-key-gate.sh fingerprint --key-file <path>
#   verify-server-action-key-gate.sh image <image-ref> <expected-fingerprint>
#   verify-server-action-key-gate.sh manifest <manifest-path> <expected-fingerprint>
#   verify-server-action-key-gate.sh log <log-file> <expected-fingerprint>
#   verify-server-action-key-gate.sh replica <container-id> <expected-fingerprint>
#   verify-server-action-key-gate.sh replicas <stack-name> <expected-fingerprint> [expected-version]
#   verify-server-action-key-gate.sh compare <expected-fingerprint> <observed-fingerprint>
#
# Exit codes: 0 pass, 1 mismatch/not-ready, 2 configuration or usage error.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MANIFEST_PATH="/app/apps/web/.next/server/server-reference-manifest.json"
FINGERPRINT_RE='^[0-9a-f]{32}$'

usage() {
  cat >&2 <<'EOF'
usage:
  verify-server-action-key-gate.sh fingerprint --env
  verify-server-action-key-gate.sh fingerprint --key-file <path>
  verify-server-action-key-gate.sh image <image-ref> <expected-fingerprint>
  verify-server-action-key-gate.sh manifest <manifest-path> <expected-fingerprint>
  verify-server-action-key-gate.sh log <log-file> <expected-fingerprint>
  verify-server-action-key-gate.sh replica <container-id> <expected-fingerprint>
  verify-server-action-key-gate.sh replicas <stack-name> <expected-fingerprint> [expected-version]
  verify-server-action-key-gate.sh compare <expected-fingerprint> <observed-fingerprint>
EOF
}

fail_config() {
  echo "server-action-key-gate: $*" >&2
  exit 2
}

fail_gate() {
  echo "server-action-key-gate: $*" >&2
  exit 1
}

require_fingerprint() {
  local value="${1:-}"
  if [[ ! "$value" =~ $FINGERPRINT_RE ]]; then
    fail_config "expected fingerprint is missing or malformed"
  fi
}

# Print only the fingerprint line. The key is read from the environment or a
# file and never echoed. The value comes from the dependency-free CLI
# (`scripts/ci/server-action-key-fingerprint.mjs`), which is pinned to the
# canonical implementation in `apps/web/src/lib/server-action-key.ts`, so the
# gate also runs on build hosts that hold the source tree without
# `node_modules` — exactly where image builds happen.
fingerprint() {
  local mode="${1:-}"
  local key_file temp_file=''
  case "$mode" in
    --env)
      [[ -n "${NEXT_SERVER_ACTIONS_ENCRYPTION_KEY:-}" ]] \
        || fail_config "no Server Action key is configured in the environment"
      temp_file="$(mktemp)"
      (
        umask 077
        printf '%s' "$NEXT_SERVER_ACTIONS_ENCRYPTION_KEY" > "$temp_file"
      )
      key_file="$temp_file"
      ;;
    --key-file)
      key_file="${2:-}"
      [[ -n "$key_file" && -r "$key_file" ]] || fail_config "key file is missing or unreadable"
      ;;
    *)
      fail_config "fingerprint needs --env or --key-file <path>"
      ;;
  esac
  local value
  if ! value="$( cd "$REPO_ROOT" && node scripts/ci/server-action-key-fingerprint.mjs "$key_file" )"; then
    if [[ -n "$temp_file" ]]; then
      rm -f "$temp_file"
    fi
    fail_config "the Server Action key is not a valid base64-encoded AES key (16, 24, or 32 bytes)"
  fi
  if [[ -n "$temp_file" ]]; then
    rm -f "$temp_file"
  fi
  printf 'fingerprint=%s\n' "$value"
}

# Compare an expected fingerprint with an observed one. This is the single
# implementation used by both the image gate and the replica gate.
compare_fingerprints() {
  local expected="${1:-}"
  local observed="${2:-}"
  require_fingerprint "$expected"
  [[ -n "$observed" ]] || fail_gate "no fingerprint was observed"
  if [[ "$observed" != "$expected" ]]; then
    fail_gate "fingerprint mismatch: the target does not hold the expected key"
  fi
}

# Extract the build-time key from a Next.js server-reference manifest, compute
# its fingerprint, and compare. The manifest contains the key, so both the copy
# and the derived key file are 0600 and removed on exit.
verify_manifest() {
  local manifest="${1:-}"
  local expected="${2:-}"
  require_fingerprint "$expected"
  [[ -r "$manifest" ]] || fail_gate "server-reference manifest not found at $manifest"

  local key
  key="$(jq -er '.encryptionKey | select(type == "string" and length > 0)' "$manifest")" \
    || fail_gate "the image manifest has no Server Action encryptionKey"

  local key_file
  key_file="$(mktemp)"
  local old_umask
  old_umask="$(umask)"
  umask 077
  printf '%s' "$key" > "$key_file"
  umask "$old_umask"

  local line observed
  line="$(fingerprint --key-file "$key_file")" || {
    rm -f "$key_file"
    fail_gate "the embedded Server Action key is not a usable key"
  }
  rm -f "$key_file"
  observed="${line#fingerprint=}"
  compare_fingerprints "$expected" "$observed"
  echo "server-action-key-gate: embedded build-time key matches the expected fingerprint"
}

# Read the most recent Server Action key line from a captured log. A missing
# runtime override is acceptable only because the image gate has already proved
# the embedded key; the caller must run that gate first.
verify_log() {
  local log_file="${1:-}"
  local expected="${2:-}"
  require_fingerprint "$expected"
  [[ -r "$log_file" ]] || fail_gate "log file not found at $log_file"

  local line observed
  line="$(grep -F '[server-action-key]' "$log_file" | tail -n 1 || true)"
  [[ -n "$line" ]] || fail_gate "the instance has not logged a Server Action key state"
  case "$line" in
    *"no runtime override"*)
      # The image gate proved the embedded key; record the source so the fleet
      # contract can require a homogeneous fleet rather than a mixture.
      LAST_KEY_STATE='build'
      echo "server-action-key-gate: instance uses the verified build-time key"
      ;;
    *"configuration fingerprint: "*)
      observed="${line##*configuration fingerprint: }"
      compare_fingerprints "$expected" "$observed"
      LAST_KEY_STATE="$observed"
      echo "server-action-key-gate: runtime override matches the expected fingerprint"
      ;;
    *)
      fail_gate "the instance logged an unrecognised Server Action key state"
      ;;
  esac
}

# Inspect the immutable image's embedded key. `docker create` does not start the
# container; only the manifest is copied out.
verify_image() {
  local image="${1:-}"
  local expected="${2:-}"
  require_fingerprint "$expected"
  [[ -n "$image" ]] || fail_config "image reference is required"

  local container
  container="$(docker create --entrypoint /bin/true "$image")" \
    || fail_gate "could not create a container from $image"

  (
    manifest="$(mktemp)"
    trap 'docker rm -f "$container" >/dev/null 2>&1 || true; rm -f "$manifest"' EXIT
    docker cp "${container}:${MANIFEST_PATH}" "$manifest" >/dev/null \
      || fail_gate "the image does not contain the Server Action manifest"
    verify_manifest "$manifest" "$expected"
  )
}

# Force one web task to evaluate readiness (which logs the key state once per
# process), then inspect that task's own logs.
verify_replica() {
  local container="${1:-}"
  local expected="${2:-}"
  local expected_version="${3:-}"
  require_fingerprint "$expected"
  [[ -n "$container" ]] || fail_config "container id is required"

  # A single readiness sample proves only the task the load balancer happened to
  # reach. The version assertion is what catches a FLEET that is half on the new
  # build: during a rolling update every task can be "ready" while some still run
  # the previous commit (Phase EA-8 reproduced exactly that).
  local body
  body="$(docker exec "$container" curl -fsS --max-time 10 \
    http://127.0.0.1:3000/api/health/ready 2>/dev/null)" \
    || fail_gate "web task $container did not report ready"
  if [[ -n "$expected_version" ]]; then
    local observed
    observed="$(printf '%s' "$body" | jq -er '.version // empty' 2>/dev/null || true)"
    if [[ "$observed" != "$expected_version" ]]; then
      fail_gate "web task $container reports version '${observed:-none}', expected '$expected_version'"
    fi
    LAST_VERSION="$observed"
  else
    LAST_VERSION="$(printf '%s' "$body" | jq -er '.version // empty' 2>/dev/null || true)"
  fi

  # The key evidence is read in a subshell so its temporary log is removed on
  # every exit path; the decision is handed back through a small file.
  (
    log_file="$(mktemp)"
    state_file="$LAST_STATE_FILE"
    trap 'rm -f "$log_file"' EXIT
    docker logs --since 15m "$container" > "$log_file" 2>&1 || true
    verify_log "$log_file" "$expected"
    printf '%s' "$LAST_KEY_STATE" > "$state_file"
  )
  LAST_KEY_STATE="$(cat "$LAST_STATE_FILE")"
}

# Every running web task in the stack. This deployment is a single-node Swarm,
# so the local container list is the full task set; a future multi-node stack
# would need the task's node in the docker exec call.
verify_replicas() {
  local stack="${1:-}"
  local expected="${2:-}"
  local expected_version="${3:-}"
  require_fingerprint "$expected"
  [[ -n "$stack" ]] || fail_config "stack name is required"

  # The rollout is asynchronous (`docker service update --detach` / the Dokploy
  # compose deploy), so WAIT until every task reports the desired state instead of
  # sampling the first visible task. Otherwise a replaced task that is still
  # running the previous image passes the gate while its replacement has not
  # converged yet.
  local containers=()
  local replicas=''
  local update_state=''
  local settled=0
  local deadline=$((SECONDS + 300))
  while [ "$SECONDS" -lt "$deadline" ]; do
    mapfile -t containers < <(
      docker ps --filter "label=com.docker.swarm.service.name=${stack}_web" \
        --format '{{.ID}}' 2>/dev/null || true
    )
    replicas="$(docker service inspect "${stack}_web" \
      --format '{{.Spec.Mode.Replicated.Replicas}}' 2>/dev/null || true)"
    update_state="$(docker service inspect "${stack}_web" \
      --format '{{if .UpdateStatus}}{{.UpdateStatus.State}}{{end}}' 2>/dev/null || true)"
    # Converged means: the service wants N replicas, N tasks are running, and no
    # update is in flight (empty = never updated, completed = finished cleanly).
    if [ "${#containers[@]}" -ge 1 ] \
      && [[ "$replicas" =~ ^[0-9]+$ ]] \
      && [ "${#containers[@]}" -eq "$replicas" ] \
      && { [ -z "$update_state" ] || [ "$update_state" = "completed" ]; }; then
      settled=1
      break
    fi
    containers=()
    sleep 5
  done
  if [ "$settled" -ne 1 ]; then
    fail_gate "${stack}_web did not settle within 300s (desired ${replicas:-?}, running ${#containers[@]}, update ${update_state:-unknown}); refusing to certify a mid-rollout fleet"
  fi

  local container
  local tasks_file state_file
  tasks_file="$(mktemp)"
  state_file="$(mktemp)"
  LAST_STATE_FILE="$state_file"
  LAST_KEY_STATE=''
  LAST_VERSION=''

  for container in "${containers[@]}"; do
    verify_replica "$container" "$expected" "$expected_version"

    # Record what the gate actually observed, then let the tested contract module
    # decide whether the list is a complete, homogeneous fleet. Node ids come from
    # the swarm labels: `docker ps` only lists tasks scheduled to THIS node, so the
    # module reports that scope instead of implying fleet-wide coverage.
    local task_id node_id container_state
    task_id="$(docker inspect -f '{{index .Config.Labels "com.docker.swarm.task.id"}}' "$container" 2>/dev/null || true)"
    node_id="$(docker inspect -f '{{index .Config.Labels "com.docker.swarm.node.id"}}' "$container" 2>/dev/null || true)"
    container_state="$(docker inspect -f '{{.State.Status}}' "$container" 2>/dev/null || true)"
    jq -nc --arg c "$container" --arg t "$task_id" --arg n "$node_id" --arg s "$container_state" \
      --arg v "$LAST_VERSION" --arg k "$LAST_KEY_STATE" \
      '{containerId:$c,taskId:$t,nodeId:$n,state:$s,ready:true,version:$v,keyState:$k}' \
      >> "$tasks_file"
  done
  rm -f "$state_file"

  local -a version_arg=()
  if [[ -n "$expected_version" ]]; then
    version_arg=(--version "$expected_version")
  fi
  if ! node "$REPO_ROOT/scripts/ci/replica-coverage.mjs" check \
    --replicas "$replicas" \
    ${version_arg[@]+"${version_arg[@]}"} \
    --fingerprint "$expected" \
    "$tasks_file"; then
    rm -f "$tasks_file"
    fail_gate "the observed web fleet did not satisfy the replica contract"
  fi
  rm -f "$tasks_file"
}

main() {
  local command="${1:-}"
  case "$command" in
    fingerprint)
      shift
      fingerprint "$@"
      ;;
    image)
      shift
      verify_image "$@"
      ;;
    manifest)
      shift
      verify_manifest "$@"
      ;;
    log)
      shift
      verify_log "$@"
      ;;
    replica)
      shift
      verify_replica "$@"
      ;;
    replicas)
      shift
      verify_replicas "$@"
      ;;
    compare)
      shift
      compare_fingerprints "$@"
      echo "server-action-key-gate: fingerprints match"
      ;;
    *)
      usage
      exit 2
      ;;
  esac
}

main "$@"
