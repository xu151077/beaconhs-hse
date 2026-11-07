#!/usr/bin/env bash
# EA-63 — Compose Gate 5: prove that a Docker Compose deployment on a single
# host is running the image this run built and promoted.
#
# Independent of the Swarm reconciler (scripts/ci/reconcile-running-digest.sh),
# which stays in place. This one speaks only Docker Compose / Docker Engine.
#
# Design: docs/evidence/ea62/compose-gate5-design.md
# Manifest: deploy/gate5.manifest.yaml
#
# Usage:
#   reconcile-compose-digest.sh \
#     --project <compose-project> \
#     --image <repository> \
#     --digest <sha256:...> \
#     --deployment-id <sha-runid-attempt> \
#     --manifest deploy/gate5.manifest.yaml \
#     [--source-deployment-id <40-hex archive-derived id>] \
#     [--compose-file <path>] [--timeout <seconds>] [--poll-interval <seconds>] \
#     [--lock <path> | --lock-fd <n>] [--json]
#
# Exit codes (EA-63 contract):
#   0  PASS
#   1  FAIL            evidence contradicts the deployment
#   2  NOT VERIFIED    a required fact could not be established
#   3  usage / parameter error
#
# NOT VERIFIED outranks PASS: no fact is ever guessed to reach a verdict.
#
# Dependencies: bash 4+, docker CLI + daemon, docker compose v2 (config
# --format json), jq, flock (util-linux). A missing dependency is NOT VERIFIED,
# never a pass. `docker compose config` is rendered with this process's
# environment so the deployment labels and both image classes are checked as
# resolved values, not as unresolved variable strings.
set -euo pipefail

PROJECT=""
IMAGE=""
DIGEST=""
DEPLOYMENT_ID=""
SOURCE_DEPLOYMENT_ID=""
MANIFEST=""
COMPOSE_FILE=""
TIMEOUT=600
POLL_INTERVAL=5
LOCK_PATH=/var/lock/beaconhs-deploy.lock
LOCK_FD=""
EMIT_JSON=0

usage() {
  cat >&2 <<'USAGE'
usage: reconcile-compose-digest.sh --project <name> --image <repository> --digest <sha256:...>
                                   --deployment-id <sha-runid-attempt>
                                   --manifest <path> [options]

  --source-deployment-id <40-hex>
                          archive-derived build identity from the source manifest.
                          When supplied, --deployment-id must start with it and the
                          gated image must carry the matching
                          com.beaconhs.deployment-id label.
  --compose-file <path>   default: compose_file from the manifest
  --timeout <seconds>     convergence deadline (default 600; 0 = single pass)
  --poll-interval <secs>  delay between passes (default 5)
  --lock <path>           acquire this exclusive lock (default /var/lock/beaconhs-deploy.lock)
  --lock-fd <n>           caller already holds the lock on fd n; do not re-acquire
  --json                  print the evidence record as JSON
  -h, --help              this text

  --image is the gated repository: 'ghcr.io/org/name', 'host:port/name' or
  'repo@sha256:...'. A digest must equal --digest; a tag is rejected.
  Pinned images are read from the manifest and verified against their own
  expected_image + expected_digest; they are never compared to --image.
USAGE
  exit 0
}

usage_error() {
  printf '::error::%s\n' "$*" >&2
  printf 'VERDICT: USAGE ERROR\n'
  exit 3
}

not_verified() {
  local reason="$*"
  printf '::error::%s\n' "$reason" >&2
  if [ "$EMIT_JSON" = 1 ]; then
    emit_json_record "NOT VERIFIED" "$reason"
    printf 'VERDICT: NOT VERIFIED\nREASON: %s\n' "$reason" >&2
  else
    printf 'VERDICT: NOT VERIFIED\n'
    printf 'REASON: %s\n' "$reason"
  fi
  exit 2
}

fail_verdict() {
  local reason="$*"
  printf '::error::%s\n' "$reason" >&2
  if [ "$EMIT_JSON" = 1 ]; then
    emit_json_record FAIL "$reason"
    printf 'VERDICT: FAIL\nREASON: %s\n' "$reason" >&2
  else
    printf 'VERDICT: FAIL\n'
    printf 'REASON: %s\n' "$reason"
  fi
  exit 1
}

emit_json_record() {
  # Optional machine-readable evidence record (EA-62 §9). Best effort: a
  # malformed intermediate value must not change the verdict.
  local verdict="$1" reason="$2"
  [ "$EMIT_JSON" = 1 ] || return 0
  local containers='[]'
  if [ -n "${CONTAINER_TSV:-}" ]; then
    containers="$(printf '%s' "$CONTAINER_TSV" | jq -R -s '
      split("\n") | map(select(length > 0) | split("\u001f") | {
        id: .[0], reference: .[1], image_id: .[2], state: .[3],
        exit_code: ((.[4] // "0") | tonumber? // 0),
        restarts: ((.[5] | tonumber?) // null),
        health: .[6], service: .[7], deployment: .[8],
        digest_label: .[9], role: .[10], started_at: .[11]
      })' 2>/dev/null)" || containers='[]'
    [ -n "$containers" ] || containers='[]'
  fi
  local services='{}'
  if [ "${#SERVICE_ORDER[@]}" -gt 0 ]; then
    services="$(for role in "${SERVICE_ORDER[@]}"; do
      printf '%s\t%s\t%s\t%s\t%s\n' \
        "$role" "${SVC_IMAGE_CLASS[$role]:-}" "${SVC_EXPECTED_REF[$role]:-}" \
        "${SVC_EXPECTED_DIGEST_VALUE[$role]:-}" "${SVC_EXPECTED_IMAGE_ID[$role]:-}"
    done | jq -R -s '
      split("\n") | map(select(length > 0) | split("\t") | {
        service: .[0], image_class: .[1], expected_reference: .[2],
        expected_digest: .[3], expected_image_id: .[4]
      }) | map({key: .service, value: .}) | from_entries' 2>/dev/null)" || services='{}'
    [ -n "$services" ] || services='{}'
  fi
  jq -n --arg project "$PROJECT" --arg deployment "$DEPLOYMENT_ID" \
    --arg source_deployment "${SOURCE_DEPLOYMENT_ID:-}" \
    --arg image_source_deployment "${GATED_SOURCE_DEPLOYMENT_ID:-}" \
    --arg digest "$DIGEST" --arg image_id "${EXPECTED_IMAGE_ID:-}" \
    --arg verdict "$verdict" --arg reason "$reason" \
    --arg repo_digests "${REPO_DIGESTS:-}" \
    --argjson containers "$containers" --argjson services "$services" \
    '{contract_version:"ea63-compose-1", project:$project,
      deployment_id:$deployment, source_deployment_id:$source_deployment,
      image_source_deployment_id:$image_source_deployment,
      expected_digest:$digest,
      expected_image_id:$image_id, repo_digests:$repo_digests,
      verdict:$verdict, reason:$reason, services:$services,
      containers:$containers}' 2>/dev/null || true
}

pass_verdict() {
  local reason="$*"
  if [ "$EMIT_JSON" = 1 ]; then
    emit_json_record PASS "$reason"
    printf 'VERDICT: PASS\nREASON: %s\n' "$reason" >&2
  else
    printf 'VERDICT: PASS\n'
    printf 'REASON: %s\n' "$reason"
  fi
  exit 0
}

# ---------------------------------------------------------------------------
# Arguments
# ---------------------------------------------------------------------------
while [ "$#" -gt 0 ]; do
  case "$1" in
    --project) [ "$#" -ge 2 ] || usage_error "--project needs a value"; PROJECT="$2"; shift 2 ;;
    --image) [ "$#" -ge 2 ] || usage_error "--image needs a value"; IMAGE="$2"; shift 2 ;;
    --digest) [ "$#" -ge 2 ] || usage_error "--digest needs a value"; DIGEST="$2"; shift 2 ;;
    --deployment-id) [ "$#" -ge 2 ] || usage_error "--deployment-id needs a value"; DEPLOYMENT_ID="$2"; shift 2 ;;
    --source-deployment-id) [ "$#" -ge 2 ] || usage_error "--source-deployment-id needs a value"; SOURCE_DEPLOYMENT_ID="$2"; shift 2 ;;
    --manifest) [ "$#" -ge 2 ] || usage_error "--manifest needs a value"; MANIFEST="$2"; shift 2 ;;
    --compose-file) [ "$#" -ge 2 ] || usage_error "--compose-file needs a value"; COMPOSE_FILE="$2"; shift 2 ;;
    --timeout) [ "$#" -ge 2 ] || usage_error "--timeout needs a value"; TIMEOUT="$2"; shift 2 ;;
    --poll-interval) [ "$#" -ge 2 ] || usage_error "--poll-interval needs a value"; POLL_INTERVAL="$2"; shift 2 ;;
    --lock) [ "$#" -ge 2 ] || usage_error "--lock needs a value"; LOCK_PATH="$2"; shift 2 ;;
    --lock-fd) [ "$#" -ge 2 ] || usage_error "--lock-fd needs a value"; LOCK_FD="$2"; shift 2 ;;
    --json) EMIT_JSON=1; shift ;;
    -h|--help) usage ;;
    *) usage_error "unknown argument '$1'" ;;
  esac
done

[ -n "$PROJECT" ] || usage_error "--project is required"
[ -n "$IMAGE" ] || usage_error "--image is required"
[ -n "$DIGEST" ] || usage_error "--digest is required"
[ -n "$DEPLOYMENT_ID" ] || usage_error "--deployment-id is required"
[ -n "$MANIFEST" ] || usage_error "--manifest is required"

[[ "$DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] \
  || usage_error "--digest must be a canonical sha256 digest"

[[ "$PROJECT" =~ ^[a-z0-9][a-z0-9_-]{0,62}$ ]] \
  || usage_error "--project must be a Compose project name (lowercase, digits, _ or -)"

# ---------------------------------------------------------------------------
# Image reference validation (EA-64.1, F-64-2)
# ---------------------------------------------------------------------------
# `--image` is a repository reference without a tag. A registry may carry a
# port (`127.0.0.1:5055/ea64/app`, `ghcr.io/org/name`); the colon that separates
# a port must never be mistaken for a tag separator. A digest may be appended
# (`repo@sha256:...`) but it must equal --digest; a tag is never accepted.
#
# A first segment is treated as a registry exactly when it contains a dot or a
# colon, or is `localhost` — the same rule the Docker CLI uses. Anything else is
# part of the repository path (Docker Hub). IPv6 registry hosts are explicitly
# rejected rather than guessed at.

validate_registry_host() {
  local host="$1" allow_single_label="$2"
  local remaining label octet
  case "$host" in
    localhost) return 0 ;;
  esac
  if [[ "$host" =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]]; then
    for octet in "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}" "${BASH_REMATCH[4]}"; do
      [ "$octet" -le 255 ] || usage_error "--image registry host '$host' has an invalid IPv4 octet"
    done
    return 0
  fi
  case "$host" in
    *..*|.*|*.) usage_error "--image registry host '$host' has an empty label" ;;
  esac
  if [ "$allow_single_label" != 1 ] && [[ "$host" != *.* ]]; then
    usage_error "--image '$host' is not a registry host; a registry needs a dot, a port, or the name 'localhost'"
  fi
  remaining="$host"
  while [ -n "$remaining" ]; do
    label="${remaining%%.*}"
    [ -n "$label" ] || usage_error "--image registry host '$host' has an empty label"
    [ "${#label}" -le 63 ] || usage_error "--image registry host '$host' has a label longer than 63 characters"
    [[ "$label" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]] \
      || usage_error "--image registry host '$host' has an invalid label '$label'"
    [ "$remaining" = "$label" ] && break
    remaining="${remaining#*.}"
  done
}

validate_repository_path() {
  local path="$1" remaining="$1" component
  [ -n "$path" ] || usage_error "--image needs a repository path"
  while [ -n "$remaining" ]; do
    component="${remaining%%/*}"
    [ -n "$component" ] || usage_error "--image '$path' has an empty path component"
    [ "${#component}" -le 255 ] || usage_error "--image path component is longer than 255 characters"
    [[ "$component" =~ ^[a-z0-9]+(([._]|__|-+)[a-z0-9]+)*$ ]] \
      || usage_error "--image path component '$component' is not a valid repository component"
    [ "$remaining" = "$component" ] && break
    remaining="${remaining#*/}"
  done
}

validate_image_repository() {
  local ref="$1" repo="$1" declared_digest=""
  local first rest colons host port
  local path=""

  case "$ref" in
    *"@"*)
      repo="${ref%%@*}"
      declared_digest="${ref#*@}"
      [ -n "$repo" ] || usage_error "--image '$ref' has no repository before '@'"
      [ -n "$declared_digest" ] || usage_error "--image '$ref' has no digest after '@'"
      [ "$declared_digest" = "$DIGEST" ] \
        || usage_error "--image digest '$declared_digest' does not match --digest '$DIGEST'"
      ;;
  esac

  case "$repo" in
    \[*\]*) usage_error "--image IPv6 registry hosts are not supported; use an IPv4 address or a DNS name" ;;
    *" "*) usage_error "--image must not contain spaces" ;;
  esac
  # Lowercase OCI repository characters plus at most one registry-port colon.
  [[ "$repo" =~ ^[a-z0-9][a-z0-9._/:-]*$ ]] \
    || usage_error "--image must be a lowercase repository reference such as ghcr.io/org/name or host:port/name"
  case "$repo" in
    */|/*|*//*) usage_error "--image '$repo' has an empty path component" ;;
  esac

  colons="${repo//[^:]/}"
  [ "${#colons}" -le 1 ] \
    || usage_error "--image '$repo' has more than one ':'; IPv6 registries are not supported"

  first="${repo%%/*}"
  rest=""
  [ "$repo" = "$first" ] || rest="${repo#*/}"

  if [ "${#colons}" -eq 1 ]; then
    case "$first" in
      *:*) ;;
      *) usage_error "--image '$repo' contains a tag; only a registry host:port may carry ':' (pass the digest with --digest)" ;;
    esac
    host="${first%%:*}"
    port="${first#*:}"
    path="$rest"
    [ -n "$host" ] || usage_error "--image '$repo' has an empty registry host"
    [ -n "$path" ] || usage_error "--image '$repo' is 'name:port' without a repository path; a tag is not accepted"
    [[ "$port" =~ ^[0-9]{1,5}$ ]] || usage_error "--image registry port '$port' must be 1-65535"
    { [ "$port" -ge 1 ] && [ "$port" -le 65535 ]; } || usage_error "--image registry port '$port' must be 1-65535"
    validate_registry_host "$host" 1
  elif [ "$repo" != "$first" ]; then
    case "$first" in
      localhost|*.*)
        host="$first"
        path="$rest"
        validate_registry_host "$host" 0
        ;;
    esac
  fi

  [ -n "$path" ] || path="$repo"
  validate_repository_path "$path"

  # Normalise to the bare repository; EXPECTED_REF appends the digest once.
  IMAGE="$repo"
}

validate_image_repository "$IMAGE"

# Deployment identity: <40-hex sha>-<run id>-<attempt>. The format is what makes
# two GitHub Actions runs distinguishable, so it is enforced rather than assumed.
[[ "$DEPLOYMENT_ID" =~ ^[0-9a-f]{40}-[0-9]{1,20}-[0-9]{1,10}$ ]] \
  || usage_error "--deployment-id must be <40-hex sha>-<run id>-<attempt>"

if [ -n "$SOURCE_DEPLOYMENT_ID" ]; then
  [[ "$SOURCE_DEPLOYMENT_ID" =~ ^[0-9a-f]{40}$ ]] \
    || usage_error "--source-deployment-id must be 40 lowercase hex"
  case "$DEPLOYMENT_ID" in
    "$SOURCE_DEPLOYMENT_ID"-*) ;;
    *)
      usage_error "--deployment-id '$DEPLOYMENT_ID' does not start with --source-deployment-id '$SOURCE_DEPLOYMENT_ID'"
      ;;
  esac
fi

[[ "$TIMEOUT" =~ ^[0-9]+$ ]] || usage_error "--timeout must be a non-negative integer"
[[ "$POLL_INTERVAL" =~ ^[0-9]+([.][0-9]+)?$ ]] || usage_error "--poll-interval must be a non-negative number"

if [ -n "$LOCK_FD" ]; then
  [[ "$LOCK_FD" =~ ^[0-9]+$ ]] || usage_error "--lock-fd must be a file descriptor number"
  [ -e "/proc/self/fd/$LOCK_FD" ] || usage_error "--lock-fd $LOCK_FD is not open in this process"
fi

# ---------------------------------------------------------------------------
# Trusted manifest — strict subset parser. Anything unexpected is a defect in
# the expectation, so it is NOT VERIFIED rather than silently ignored.
# ---------------------------------------------------------------------------
declare -A SVC_REQUIRED=() SVC_CONTAINERS=() SVC_ONESHOT=()
declare -A SVC_HEALTH=() SVC_EXIT=() SVC_IMAGE_CLASS=()
declare -A SVC_ROLE=() SVC_EXPECTED_IMAGE=() SVC_EXPECTED_DIGEST=()
declare -A SVC_DEPLOY_LABEL=() SVC_DIGEST_LABEL=() SVC_SEEN=()
declare -A SVC_EXPECTED_REF=() SVC_EXPECTED_IMAGE_ID=() SVC_EXPECTED_DIGEST_VALUE=()
declare -a SERVICE_ORDER=()
MANIFEST_PROJECT=""
MANIFEST_COMPOSE_FILE=""
GATED_COUNT=0
PINNED_COUNT=0

parse_manifest() {
  local file="$1"
  local line stripped indent key value svc="" lineno=0
  local seen_services=" " top_seen=" "
  local have_project=0 have_compose=0 have_services=0
  local role field last

  [ -r "$file" ] || not_verified "Gate 5 manifest '$file' is not readable"

  while IFS= read -r line || [ -n "$line" ]; do
    lineno=$((lineno + 1))
    line="${line%$'\r'}"
    case "$line" in
      *$'\t'*) not_verified "manifest line $lineno contains a tab; this format uses spaces only" ;;
    esac
    stripped="${line#"${line%%[! ]*}"}"
    [ -z "$stripped" ] && continue
    case "$stripped" in \#*) continue ;; esac

    indent=$(( ${#line} - ${#stripped} ))
    case "$indent" in
      0)
        svc=""
        case "$stripped" in
          *:*) key="${stripped%%:*}"; value="${stripped#*:}"; value="${value# }" ;;
          *) not_verified "manifest line $lineno is not 'key: value'" ;;
        esac
        case " $top_seen " in
          *" $key "*) not_verified "manifest: duplicate top-level key '$key'" ;;
        esac
        top_seen="$top_seen$key "
        case "$key" in
          project) MANIFEST_PROJECT="$value"; have_project=1 ;;
          compose_file) MANIFEST_COMPOSE_FILE="$value"; have_compose=1 ;;
          services)
            [ -z "$value" ] || not_verified "manifest: 'services' must be a mapping, not a scalar"
            have_services=1
            ;;
          *) not_verified "manifest: unknown top-level key '$key'" ;;
        esac
        ;;
      2)
        case "$stripped" in
          *:*) key="${stripped%%:*}"; value="${stripped#*:}"; value="${value# }" ;;
          *) not_verified "manifest line $lineno: service entry is not 'name:'" ;;
        esac
        [ -z "$value" ] || not_verified "manifest: service '$key' must be a mapping"
        [[ "$key" =~ ^[a-z][a-z0-9_-]*$ ]] || not_verified "manifest: invalid service name '$key'"
        case "$seen_services" in
          *" $key "*) not_verified "manifest: duplicate service '$key'" ;;
        esac
        seen_services="$seen_services$key "
        SERVICE_ORDER+=("$key")
        SVC_SEEN["$key"]=""
        svc="$key"
        ;;
      4)
        [ -n "$svc" ] || not_verified "manifest line $lineno: field outside a service"
        case "$stripped" in
          *:*) key="${stripped%%:*}"; value="${stripped#*:}"; value="${value# }" ;;
          *) not_verified "manifest line $lineno: field is not 'key: value'" ;;
        esac
        case " ${SVC_SEEN[$svc]:-} " in
          *" $key "*) not_verified "manifest: duplicate field '$key' for service '$svc'" ;;
        esac
        SVC_SEEN["$svc"]="${SVC_SEEN[$svc]:-} $key"
        case "$key" in
          role) SVC_ROLE["$svc"]="$value" ;;
          image_class) SVC_IMAGE_CLASS["$svc"]="$value" ;;
          expected_image) SVC_EXPECTED_IMAGE["$svc"]="$value" ;;
          expected_digest) SVC_EXPECTED_DIGEST["$svc"]="$value" ;;
          expected_container_count) SVC_CONTAINERS["$svc"]="$value" ;;
          required) SVC_REQUIRED["$svc"]="$value" ;;
          one_shot) SVC_ONESHOT["$svc"]="$value" ;;
          health) SVC_HEALTH["$svc"]="$value" ;;
          expected_exit_code) SVC_EXIT["$svc"]="$value" ;;
          deployment_label_required) SVC_DEPLOY_LABEL["$svc"]="$value" ;;
          image_digest_label_required) SVC_DIGEST_LABEL["$svc"]="$value" ;;
          *) not_verified "manifest: unknown field '$key' for service '$svc'" ;;
        esac
        ;;
      *)
        not_verified "manifest line $lineno: unexpected indentation ($indent spaces)"
        ;;
    esac
  done < "$file"

  [ "$have_project" = 1 ] || not_verified "manifest: 'project' is required"
  [ "$have_compose" = 1 ] || not_verified "manifest: 'compose_file' is required"
  [ "$have_services" = 1 ] || not_verified "manifest: 'services' is required"
  [ "${#SERVICE_ORDER[@]}" -gt 0 ] || not_verified "manifest: no services defined"

  [[ "$MANIFEST_PROJECT" =~ ^[a-z0-9][a-z0-9_-]{0,62}$ ]] \
    || not_verified "manifest: invalid project name '$MANIFEST_PROJECT'"
  [ -n "$MANIFEST_COMPOSE_FILE" ] || not_verified "manifest: 'compose_file' is empty"

  for role in "${SERVICE_ORDER[@]}"; do
    for field in role image_class expected_container_count required one_shot health \
      deployment_label_required image_digest_label_required; do
      case "$field" in
        role) value="${SVC_ROLE[$role]:-}" ;;
        image_class) value="${SVC_IMAGE_CLASS[$role]:-}" ;;
        expected_container_count) value="${SVC_CONTAINERS[$role]:-}" ;;
        required) value="${SVC_REQUIRED[$role]:-}" ;;
        one_shot) value="${SVC_ONESHOT[$role]:-}" ;;
        health) value="${SVC_HEALTH[$role]:-}" ;;
        deployment_label_required) value="${SVC_DEPLOY_LABEL[$role]:-}" ;;
        image_digest_label_required) value="${SVC_DIGEST_LABEL[$role]:-}" ;;
      esac
      [ -n "$value" ] || not_verified "manifest: service '$role' is missing '$field'"
    done

    [ "${SVC_ROLE[$role]}" = "$role" ] \
      || not_verified "manifest: service '$role' role '${SVC_ROLE[$role]}' must equal the service name"
    case "${SVC_REQUIRED[$role]}" in true|false) ;; *) not_verified "manifest: '$role.required' must be true or false" ;; esac
    [[ "${SVC_CONTAINERS[$role]}" =~ ^[1-9][0-9]*$ ]] || not_verified "manifest: '$role.expected_container_count' must be a positive integer"
    case "${SVC_ONESHOT[$role]}" in true|false) ;; *) not_verified "manifest: '$role.one_shot' must be true or false" ;; esac
    case "${SVC_HEALTH[$role]}" in required|none) ;; *) not_verified "manifest: '$role.health' must be required or none" ;; esac
    case "${SVC_DEPLOY_LABEL[$role]}" in
      true) ;;
      false) not_verified "manifest: '$role.deployment_label_required' must be true; every service must carry deployment identity" ;;
      *) not_verified "manifest: '$role.deployment_label_required' must be true or false" ;;
    esac
    case "${SVC_DIGEST_LABEL[$role]}" in
      true) ;;
      false) not_verified "manifest: '$role.image_digest_label_required' must be true; every service must carry image identity" ;;
      *) not_verified "manifest: '$role.image_digest_label_required' must be true or false" ;;
    esac

    case "${SVC_IMAGE_CLASS[$role]}" in
      gated)
        [ -z "${SVC_EXPECTED_IMAGE[$role]:-}" ] \
          || not_verified "manifest: gated service '$role' must not declare 'expected_image'; it comes from --image"
        [ -z "${SVC_EXPECTED_DIGEST[$role]:-}" ] \
          || not_verified "manifest: gated service '$role' must not declare 'expected_digest'; it comes from --digest"
        GATED_COUNT=$((GATED_COUNT + 1))
        ;;
      pinned)
        [ -n "${SVC_EXPECTED_IMAGE[$role]:-}" ] || not_verified "manifest: pinned service '$role' is missing 'expected_image'"
        [ -n "${SVC_EXPECTED_DIGEST[$role]:-}" ] || not_verified "manifest: pinned service '$role' is missing 'expected_digest'"
        case "${SVC_EXPECTED_IMAGE[$role]}" in
          *'@'*) not_verified "manifest: pinned '$role.expected_image' must not contain '@'; the digest is a separate field" ;;
          *'${'*) not_verified "manifest: pinned '$role.expected_image' must be a resolved repository, not a variable" ;;
        esac
        [[ "${SVC_EXPECTED_IMAGE[$role]}" =~ ^[a-z0-9][a-z0-9._/:-]*$ ]] \
          || not_verified "manifest: pinned '$role.expected_image' must be a lowercase repository reference"
        last="${SVC_EXPECTED_IMAGE[$role]##*/}"
        case "$last" in
          *:*) not_verified "manifest: pinned '$role.expected_image' must not contain a tag" ;;
        esac
        [[ "${SVC_EXPECTED_DIGEST[$role]}" =~ ^sha256:[0-9a-f]{64}$ ]] \
          || not_verified "manifest: '$role.expected_digest' must be a canonical sha256 digest"
        [ "${SVC_EXPECTED_IMAGE[$role]}@${SVC_EXPECTED_DIGEST[$role]}" != "${IMAGE}@${DIGEST}" ] \
          || not_verified "manifest: pinned service '$role' reuses the gated image identity; classes must stay separate"
        PINNED_COUNT=$((PINNED_COUNT + 1))
        ;;
      *)
        not_verified "manifest: '$role.image_class' must be gated or pinned"
        ;;
    esac

    if [ "${SVC_ONESHOT[$role]}" = "true" ]; then
      [ -n "${SVC_EXIT[$role]:-}" ] || not_verified "manifest: one-shot '$role' is missing 'expected_exit_code'"
      [[ "${SVC_EXIT[$role]}" =~ ^[0-9]{1,3}$ ]] || not_verified "manifest: '$role.expected_exit_code' must be 0-255"
      [ "${SVC_EXIT[$role]}" -le 255 ] || not_verified "manifest: '$role.expected_exit_code' must be 0-255"
      [ "${SVC_HEALTH[$role]}" = "none" ] \
        || not_verified "manifest: one-shot '$role' must declare health: none"
    else
      [ -z "${SVC_EXIT[$role]:-}" ] || not_verified "manifest: long-running '$role' must not define 'expected_exit_code'"
    fi
  done

  [ "$GATED_COUNT" -gt 0 ] || not_verified "manifest: at least one gated service is required"
}

parse_manifest "$MANIFEST"

[ "$MANIFEST_PROJECT" = "$PROJECT" ] \
  || not_verified "manifest project '$MANIFEST_PROJECT' does not match --project '$PROJECT'"

[ -n "$COMPOSE_FILE" ] || COMPOSE_FILE="$MANIFEST_COMPOSE_FILE"
[ -r "$COMPOSE_FILE" ] || not_verified "compose file '$COMPOSE_FILE' is not readable"

# ---------------------------------------------------------------------------
# Dependencies and lock
# ---------------------------------------------------------------------------
command -v docker >/dev/null 2>&1 || not_verified "docker CLI is not installed"
command -v jq >/dev/null 2>&1 || not_verified "jq is not installed"
command -v flock >/dev/null 2>&1 || not_verified "flock is not installed (util-linux)"

if [ -z "$LOCK_FD" ]; then
  # Exclusive, non-blocking: a second deployment must be refused, never queued,
  # because a queued run would verify a fleet it did not deploy.
  exec {LOCK_FD}>"$LOCK_PATH" 2>/dev/null \
    || not_verified "cannot open lock file '$LOCK_PATH'"
  if ! flock -n "$LOCK_FD"; then
    fail_verdict "another deployment holds '$LOCK_PATH'; refusing to verify a fleet this run did not deploy"
  fi
fi

# ---------------------------------------------------------------------------
# Compose CLI, daemon, declared service set
# ---------------------------------------------------------------------------
docker compose version >/dev/null 2>&1 \
  || not_verified "docker compose CLI is not available"

docker info >/dev/null 2>&1 \
  || not_verified "Docker daemon is not reachable"

compose_stderr="$(mktemp)"
trap 'rm -f "$compose_stderr"' EXIT

if ! compose_json="$(docker compose -f "$COMPOSE_FILE" --project-name "$PROJECT" \
      config --format json 2>"$compose_stderr")"; then
  not_verified "docker compose config failed (the deployment environment must render every required variable): $(head -c 300 "$compose_stderr" | tr '\n' ' ')"
fi

if ! printf '%s' "$compose_json" | jq -e 'type == "object" and (.services | type == "object")' >/dev/null 2>&1; then
  not_verified "docker compose config did not return a parseable object with services"
fi

declared_project="$(printf '%s' "$compose_json" | jq -r '.name // ""')"
[ "$declared_project" = "$PROJECT" ] \
  || not_verified "compose project '$declared_project' does not match --project '$PROJECT'"

mapfile -t declared_services < <(printf '%s' "$compose_json" | jq -r '.services | keys[]')
[ "${#declared_services[@]}" -gt 0 ] || not_verified "compose config declares no services"

# Service sets must be identical: a manifest service missing from compose means
# the expectation is stale; a compose service missing from the manifest means an
# unmanaged container would be invisible to the gate.
for role in "${SERVICE_ORDER[@]}"; do
  found=0
  for declared in "${declared_services[@]}"; do
    [ "$declared" = "$role" ] && found=1 && break
  done
  [ "$found" = 1 ] || not_verified "manifest service '$role' is not declared in the compose file"
done
for declared in "${declared_services[@]}"; do
  found=0
  for role in "${SERVICE_ORDER[@]}"; do
    [ "$declared" = "$role" ] && found=1 && break
  done
  [ "$found" = 1 ] || not_verified "compose service '$declared' is not registered in the manifest"
done

# Health expectation must match the compose file, so a healthcheck added or
# removed on one side cannot silently weaken the gate.
for role in "${SERVICE_ORDER[@]}"; do
  if printf '%s' "$compose_json" | jq -e --arg s "$role" '.services[$s].healthcheck != null' >/dev/null 2>&1; then
    has_health=yes
  else
    has_health=no
  fi
  if [ "${SVC_HEALTH[$role]}" = "required" ] && [ "$has_health" != "yes" ]; then
    not_verified "manifest requires health for '$role' but the compose file defines no healthcheck"
  fi
  if [ "${SVC_HEALTH[$role]}" = "none" ] && [ "$has_health" = "yes" ]; then
    not_verified "manifest expects no health for '$role' but the compose file defines a healthcheck"
  fi
done

# ---------------------------------------------------------------------------
# Expected image identity — gated and pinned are separate namespaces
# ---------------------------------------------------------------------------
declare -a CONTAINER_IDS=()
CONTAINER_TSV=""
EXPECTED_IMAGE_ID=""
EXPECTED_REF="${IMAGE}@${DIGEST}"
INSPECTED_IMAGE_ID=""
INSPECTED_REPO_DIGESTS=""
INSPECTED_SOURCE_DEPLOYMENT_ID=""
GATED_SOURCE_DEPLOYMENT_ID=""

inspect_expected_image() {
  local ref="$1" label="$2" json
  if ! json="$(docker image inspect "$ref" 2>/dev/null)"; then
    not_verified "$label image '$ref' is not present locally; the running containers cannot be mapped to it"
  fi
  INSPECTED_IMAGE_ID="$(printf '%s' "$json" | jq -r '.[0].Id // ""')"
  [[ "$INSPECTED_IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]] \
    || not_verified "docker image inspect returned no usable image ID for $label image '$ref'"
  # Corroboration only: never the proof, and an empty value is not a failure.
  INSPECTED_REPO_DIGESTS="$(printf '%s' "$json" | jq -r '.[0].RepoDigests // [] | join(",")')"
  # EA-66B.1: the image's archive-derived build identity. The proof is the
  # embedded Next.js deploymentId (verified by verify-image-identity.mjs); this
  # label is the cheap manifest check Gate 5 can run before starting containers.
  INSPECTED_SOURCE_DEPLOYMENT_ID="$(printf '%s' "$json" | jq -r '.[0].Config.Labels["com.beaconhs.deployment-id"] // ""')"
}

for role in "${SERVICE_ORDER[@]}"; do
  if [ "${SVC_IMAGE_CLASS[$role]}" = "gated" ]; then
    SVC_EXPECTED_REF["$role"]="$EXPECTED_REF"
    SVC_EXPECTED_DIGEST_VALUE["$role"]="$DIGEST"
  else
    SVC_EXPECTED_REF["$role"]="${SVC_EXPECTED_IMAGE[$role]}@${SVC_EXPECTED_DIGEST[$role]}"
    SVC_EXPECTED_DIGEST_VALUE["$role"]="${SVC_EXPECTED_DIGEST[$role]}"
  fi
done

inspect_expected_image "$EXPECTED_REF" "gated"
EXPECTED_IMAGE_ID="$INSPECTED_IMAGE_ID"
REPO_DIGESTS="$INSPECTED_REPO_DIGESTS"
GATED_SOURCE_DEPLOYMENT_ID="$INSPECTED_SOURCE_DEPLOYMENT_ID"
if [ -n "$SOURCE_DEPLOYMENT_ID" ]; then
  [ "$GATED_SOURCE_DEPLOYMENT_ID" = "$SOURCE_DEPLOYMENT_ID" ] \
    || not_verified "gated image '${EXPECTED_REF}' carries source deployment label '${GATED_SOURCE_DEPLOYMENT_ID:-<none>}', expected '${SOURCE_DEPLOYMENT_ID}'"
fi
for role in "${SERVICE_ORDER[@]}"; do
  if [ "${SVC_IMAGE_CLASS[$role]}" = "gated" ]; then
    SVC_EXPECTED_IMAGE_ID["$role"]="$EXPECTED_IMAGE_ID"
  else
    inspect_expected_image "${SVC_EXPECTED_REF[$role]}" "pinned service '$role'"
    SVC_EXPECTED_IMAGE_ID["$role"]="$INSPECTED_IMAGE_ID"
  fi
done

# The rendered Compose definition must agree with the trusted manifest before
# the running fleet is inspected. This is where a missing label, a stale image,
# or an unresolved variable is caught.
for role in "${SERVICE_ORDER[@]}"; do
  declared_image="$(printf '%s' "$compose_json" | jq -r --arg s "$role" '.services[$s].image // ""')"
  case "$declared_image" in
    *'${'*) not_verified "compose service '$role' image is unresolved ('$declared_image'); render the Compose file with the deployment environment" ;;
  esac
  [ "$declared_image" = "${SVC_EXPECTED_REF[$role]}" ] \
    || not_verified "compose service '$role' declares image '$declared_image', expected '${SVC_EXPECTED_REF[$role]}'"

  declared_deploy_label="$(printf '%s' "$compose_json" | jq -r --arg s "$role" '.services[$s].labels["com.beaconhs.deployment"] // ""')"
  declared_digest_label="$(printf '%s' "$compose_json" | jq -r --arg s "$role" '.services[$s].labels["com.beaconhs.image-digest"] // ""')"
  declared_role_label="$(printf '%s' "$compose_json" | jq -r --arg s "$role" '.services[$s].labels["com.beaconhs.role"] // ""')"

  for label_value in "$declared_deploy_label" "$declared_digest_label" "$declared_role_label"; do
    case "$label_value" in
      *'${'*) not_verified "compose service '$role' has an unresolved label value '$label_value'; render the Compose file with the deployment environment" ;;
    esac
  done

  [ "$declared_deploy_label" = "$DEPLOYMENT_ID" ] \
    || not_verified "compose service '$role' deployment label is '${declared_deploy_label:-<none>}', expected '$DEPLOYMENT_ID'"
  [ "$declared_digest_label" = "${SVC_EXPECTED_DIGEST_VALUE[$role]}" ] \
    || not_verified "compose service '$role' image-digest label is '${declared_digest_label:-<none>}', expected '${SVC_EXPECTED_DIGEST_VALUE[$role]}'"
  [ "$declared_role_label" = "${SVC_ROLE[$role]}" ] \
    || not_verified "compose service '$role' role label is '${declared_role_label:-<none>}', expected '${SVC_ROLE[$role]}'"

  if [ "${SVC_ONESHOT[$role]}" = "true" ]; then
    declared_restart="$(printf '%s' "$compose_json" | jq -r --arg s "$role" '.services[$s].restart // "no"')"
    case "$declared_restart" in
      no) ;;
      *) not_verified "one-shot compose service '$role' must declare restart: 'no' (got '$declared_restart')" ;;
    esac
  fi
done

# ---------------------------------------------------------------------------
# Verification loop
# ---------------------------------------------------------------------------
START_EPOCH="$(date +%s)"
DEADLINE=$((START_EPOCH + TIMEOUT))

declare -a SNAP_IDS=()
declare -A SNAP_IMAGE=() SNAP_STARTED=() SNAP_RESTARTS=()

PENDING=0
REASONS=()


collect() {
  # Sets CONTAINER_TSV (one line per container) or returns 2 via not_verified.
  local ps_out
  if ! ps_out="$(docker ps -aq --filter "label=com.docker.compose.project=${PROJECT}" 2>/dev/null)"; then
    not_verified "docker ps failed; the container set is unknown"
  fi

  local -a ids=()
  local id
  while IFS= read -r id; do
    [ -n "$id" ] && ids+=("$id")
  done <<<"$ps_out"

  if [ "${#ids[@]}" -eq 0 ]; then
    CONTAINER_TSV=""
    CONTAINER_IDS=()
    return 0
  fi

  local inspect_json
  if ! inspect_json="$(docker inspect "${ids[@]}" 2>/dev/null)"; then
    # A container that disappeared between ps and inspect is a moving target,
    # not a verdict about the fleet.
    not_verified "docker inspect failed for the discovered containers (a container may have been replaced mid-query)"
  fi

  if ! printf '%s' "$inspect_json" | jq -e 'type == "array" and length > 0' >/dev/null 2>&1; then
    not_verified "docker inspect returned malformed JSON"
  fi

  CONTAINER_TSV="$(printf '%s' "$inspect_json" | jq -r '
    .[] | [
      .Id,
      (.Config.Image // ""),
      (.Image // ""),
      (.State.Status // ""),
      ((.State.ExitCode // 0) | tostring),
      (if (has("RestartCount") | not) then "<missing>"
       elif .RestartCount == null then "<null>"
       elif ((.RestartCount | type) != "number") then "<non-integer>"
       elif .RestartCount < 0 then "<negative>"
       elif .RestartCount != (.RestartCount | floor) then "<non-integer>"
       else (.RestartCount | tostring) end),
      (.State.Health.Status // "none"),
      (.Config.Labels["com.docker.compose.service"] // ""),
      (.Config.Labels["com.beaconhs.deployment"] // ""),
      (.Config.Labels["com.beaconhs.image-digest"] // ""),
      (.Config.Labels["com.beaconhs.role"] // ""),
      (.State.StartedAt // "")
    ] | join("\u001f")')"
  CONTAINER_IDS=("${ids[@]}")
}

evaluate() {
  # Returns 0 pass, 1 terminal failure, 2 still converging.
  local c_id c_ref c_img c_status c_exit c_restarts c_health c_service c_deploy c_digest_label c_role c_started
  local role expected_count actual_count
  local expected_ref expected_id expected_digest expected_role
  declare -A counts=()
  declare -A seen_ids=()

  REASONS=()
  PENDING=0

  if [ "${#CONTAINER_IDS[@]}" -eq 0 ]; then
    REASONS+=("project '$PROJECT' has no containers")
    return 1
  fi

  while IFS=$'\x1f' read -r c_id c_ref c_img c_status c_exit c_restarts c_health c_service c_deploy c_digest_label c_role c_started; do
    [ -n "$c_id" ] || continue

    if [ -n "${seen_ids[$c_id]:-}" ]; then
      not_verified "docker inspect returned container '$c_id' more than once"
    fi
    seen_ids["$c_id"]=1

    if [ -z "$c_service" ]; then
      REASONS+=("container ${c_id:0:12} carries no com.docker.compose.service label")
      return 1
    fi

    if [ -z "${SVC_REQUIRED[$c_service]:-}" ]; then
      REASONS+=("container ${c_id:0:12} belongs to unregistered service '$c_service'")
      return 1
    fi

    # Fail closed when the restart counter cannot be established. Docker 29.x
    # reports it at the top level; a missing, null, non-integer or negative
    # value is never treated as 0.
    case "$c_restarts" in
      "<missing>") not_verified "$c_service container ${c_id:0:12} has no RestartCount in docker inspect; its restart state cannot be established" ;;
      "<null>") not_verified "$c_service container ${c_id:0:12} has RestartCount=null; its restart state cannot be established" ;;
      "<non-integer>") not_verified "$c_service container ${c_id:0:12} has a non-integer RestartCount; its restart state cannot be established" ;;
      "<negative>") not_verified "$c_service container ${c_id:0:12} has a negative RestartCount; its restart state cannot be established" ;;
    esac
    [[ "$c_restarts" =~ ^[0-9]+$ ]] \
      || not_verified "$c_service container ${c_id:0:12} has an unusable RestartCount '$c_restarts'"

    counts["$c_service"]=$(( ${counts[$c_service]:-0} + 1 ))

    expected_ref="${SVC_EXPECTED_REF[$c_service]}"
    expected_id="${SVC_EXPECTED_IMAGE_ID[$c_service]}"
    expected_digest="${SVC_EXPECTED_DIGEST_VALUE[$c_service]}"
    expected_role="${SVC_ROLE[$c_service]}"

    if [ "$c_deploy" != "$DEPLOYMENT_ID" ]; then
      REASONS+=("$c_service container ${c_id:0:12} was created by deployment '${c_deploy:-<none>}', not '$DEPLOYMENT_ID'")
      return 1
    fi
    if [ "$c_role" != "$expected_role" ]; then
      REASONS+=("$c_service container ${c_id:0:12} carries role label '${c_role:-<none>}', expected '$expected_role'")
      return 1
    fi
    if [ "$c_digest_label" != "$expected_digest" ]; then
      REASONS+=("$c_service container ${c_id:0:12} carries image-digest label '${c_digest_label:-<none>}', expected '$expected_digest'")
      return 1
    fi
    if [ "$c_ref" != "$expected_ref" ]; then
      REASONS+=("$c_service container ${c_id:0:12} was created from '${c_ref:-<none>}', expected '$expected_ref'")
      return 1
    fi
    case "$c_ref" in
      *@sha256:*) ;;
      *) REASONS+=("$c_service container ${c_id:0:12} is not digest-pinned ('$c_ref')"); return 1 ;;
    esac
    if [ "$c_img" != "$expected_id" ]; then
      REASONS+=("$c_service container ${c_id:0:12} runs image '${c_img:-<none>}', expected '$expected_id'")
      return 1
    fi

    # A container created by this deployment must not have restarted. The
    # counter is 0 for a container that has run continuously since creation, so
    # any non-zero value is terminal evidence — including the brief `running`
    # window a crash loop shows between restarts. A normal first start is 0.
    if [ "$c_restarts" -ne 0 ]; then
      REASONS+=("$c_service container ${c_id:0:12} has restarted $c_restarts time(s) since it was created")
      return 1
    fi

    if [ "${SVC_ONESHOT[$c_service]}" = "true" ]; then
      case "$c_status" in
        exited)
          if [ "$c_exit" != "${SVC_EXIT[$c_service]}" ]; then
            REASONS+=("one-shot $c_service container ${c_id:0:12} exited $c_exit, expected ${SVC_EXIT[$c_service]}")
            return 1
          fi
          ;;
        created|running|restarting)
          REASONS+=("one-shot $c_service container ${c_id:0:12} is '$c_status', not finished")
          PENDING=1
          ;;
        *)
          REASONS+=("one-shot $c_service container ${c_id:0:12} is '$c_status'")
          return 1
          ;;
      esac
    else
      case "$c_status" in
        running)
          if [ "${SVC_HEALTH[$c_service]}" = "required" ]; then
            case "$c_health" in
              healthy) ;;
              starting) REASONS+=("$c_service container ${c_id:0:12} health is 'starting'"); PENDING=1 ;;
              *) REASONS+=("$c_service container ${c_id:0:12} health is '$c_health'"); return 1 ;;
            esac
          fi
          ;;
        created|restarting)
          REASONS+=("$c_service container ${c_id:0:12} is '$c_status'")
          PENDING=1
          ;;
        *)
          REASONS+=("$c_service container ${c_id:0:12} is '$c_status'")
          return 1
          ;;
      esac
    fi

    # Restart loops are already terminal above: a non-zero RestartCount is
    # evidence that the process died at least once under this deployment.
  done <<<"$CONTAINER_TSV"

  # Counts, in manifest order so the messages are stable.
  for role in "${SERVICE_ORDER[@]}"; do
    expected_count="${SVC_CONTAINERS[$role]}"
    actual_count="${counts[$role]:-0}"
    if [ "$actual_count" -eq 0 ]; then
      if [ "${SVC_REQUIRED[$role]}" = "true" ]; then
        REASONS+=("required service '$role' has no container")
        PENDING=1
      fi
      continue
    fi
    if [ "$actual_count" -lt "$expected_count" ]; then
      REASONS+=("service '$role' has $actual_count container(s), expected $expected_count")
      PENDING=1
    elif [ "$actual_count" -gt "$expected_count" ]; then
      REASONS+=("service '$role' has $actual_count container(s), expected $expected_count (unregistered instance)")
      return 1
    fi
  done

  if [ "$PENDING" = 1 ]; then
    return 2
  fi
  return 0
}

snapshot_identity() {
  SNAP_IDS=("${CONTAINER_IDS[@]}")
  local c_id c_ref c_img c_status c_exit c_restarts c_health c_service c_deploy c_digest_label c_role c_started
  while IFS=$'\x1f' read -r c_id c_ref c_img c_status c_exit c_restarts c_health c_service c_deploy c_digest_label c_role c_started; do
    [ -n "$c_id" ] || continue
    SNAP_IMAGE["$c_id"]="$c_img"
    SNAP_STARTED["$c_id"]="$c_started"
    SNAP_RESTARTS["$c_id"]="$c_restarts"
  done <<<"$CONTAINER_TSV"
}

recheck_unchanged() {
  # The fleet must be the same fleet we just verified.
  collect
  local -a now_ids=("${CONTAINER_IDS[@]}")
  if [ "${#now_ids[@]}" -ne "${#SNAP_IDS[@]}" ]; then
    not_verified "the container set changed during verification (${#SNAP_IDS[@]} -> ${#now_ids[@]})"
  fi
  local id found cur
  for id in "${SNAP_IDS[@]}"; do
    found=0
    for cur in "${now_ids[@]}"; do
      [ "$cur" = "$id" ] && found=1 && break
    done
    [ "$found" = 1 ] || not_verified "container ${id:0:12} disappeared during verification"
  done
  local c_id c_ref c_img c_status c_exit c_restarts c_health c_service c_deploy c_digest_label c_role c_started
  while IFS=$'\x1f' read -r c_id c_ref c_img c_status c_exit c_restarts c_health c_service c_deploy c_digest_label c_role c_started; do
    [ -n "$c_id" ] || continue
    [ "${SNAP_IMAGE[$c_id]:-}" = "$c_img" ] \
      || not_verified "container ${c_id:0:12} image changed during verification"
    [ "${SNAP_RESTARTS[$c_id]:-}" = "$c_restarts" ] \
      || not_verified "container ${c_id:0:12} restart count changed during verification"
    [ "${SNAP_STARTED[$c_id]:-}" = "$c_started" ] \
      || not_verified "container ${c_id:0:12} restarted during verification"
  done <<<"$CONTAINER_TSV"
}

while :; do
  collect
  if evaluate; then
    snapshot_identity
    recheck_unchanged
    pass_verdict "all ${#CONTAINER_IDS[@]} container(s) match the manifest (gated image $EXPECTED_REF; pinned identities from the manifest; deployment '$DEPLOYMENT_ID')"
  else
    rc=$?
    if [ "$rc" -eq 1 ]; then
      fail_verdict "${REASONS[*]}"
    fi
    now="$(date +%s)"
    if [ "$now" -ge "$DEADLINE" ]; then
      fail_verdict "did not converge within ${TIMEOUT}s: ${REASONS[*]}"
    fi
    sleep "$POLL_INTERVAL" {LOCK_FD}>&-
  fi
done
