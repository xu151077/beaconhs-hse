#!/usr/bin/env bash
# Shared configuration and checks for the BeaconHS lifecycle scripts.
#
# Every path is resolved from an explicit root, never from the caller's working
# directory, so the scripts behave identically over SSH and from a terminal.
#
# Nothing in here prints a secret. The runtime env files are sourced only to
# read non-secret settings (the project name and the deployment id), and every
# value that could carry a credential is passed to the container as an
# `--env-file` reference, never as an argument.

set -euo pipefail

# --- Layout -----------------------------------------------------------------

# The deployment root. Overridable so the scripts can be exercised against a
# fixture tree without touching a real deployment.
BEACONHS_ROOT="${BEACONHS_ROOT:-$HOME/.beaconhs}"

# An operator-owned layout file, read before the defaults below so a host whose
# canonical files live somewhere else can say so once instead of exporting six
# variables on every call.
#
# It is PARSED, not sourced: it may only assign BEACONHS_* keys, it never
# executes anything, and a value the caller already set in the environment wins.
# That keeps the file safe to hand to an operator and keeps an explicit override
# authoritative.
#
# It must contain LAYOUT only — never a credential. Secrets belong in the
# runtime env files, which this file is not.
BEACONHS_CONFIG_FILE="${BEACONHS_CONFIG_FILE:-$BEACONHS_ROOT/lifecycle.env}"
if [ -f "$BEACONHS_CONFIG_FILE" ]; then
  while IFS='=' read -r config_key config_value || [ -n "$config_key" ]; do
    case "$config_key" in
      '' | '#'*) continue ;;
      BEACONHS_[A-Z_]*) ;;
      *) continue ;;
    esac
    if [ -z "${!config_key+x}" ]; then
      export "$config_key=$config_value"
    fi
  done <"$BEACONHS_CONFIG_FILE"
fi

BEACONHS_COMPOSE_DIR="${BEACONHS_COMPOSE_DIR:-$BEACONHS_ROOT/compose}"
BEACONHS_RUNTIME_DIR="${BEACONHS_RUNTIME_DIR:-$BEACONHS_ROOT/runtime}"
BEACONHS_COMPOSE_FILE="${BEACONHS_COMPOSE_FILE:-$BEACONHS_COMPOSE_DIR/local-production.compose.yaml}"
BEACONHS_MANIFEST_FILE="${BEACONHS_MANIFEST_FILE:-$BEACONHS_COMPOSE_DIR/gate5.manifest.yaml}"
BEACONHS_ENV_FILE="${BEACONHS_ENV_FILE:-$BEACONHS_RUNTIME_DIR/local-prod.env}"
BEACONHS_KEY_ENV_FILE="${BEACONHS_KEY_ENV_FILE:-$BEACONHS_RUNTIME_DIR/server-action-key.env}"
BEACONHS_LOCK_FILE="${BEACONHS_LOCK_FILE:-$BEACONHS_ROOT/.lifecycle.lock}"
BEACONHS_GATE5_SCRIPT="${BEACONHS_GATE5_SCRIPT:-$BEACONHS_ROOT/scripts/ci/reconcile-compose-digest.sh}"
BEACONHS_GATE5_RESULT="${BEACONHS_GATE5_RESULT:-$BEACONHS_ROOT/runtime/gate5-last-result.txt}"

# --- The deployment this manages --------------------------------------------

BEACONHS_PROJECT="${BEACONHS_PROJECT:-beaconhs-local-prod}"

# The ONE public entry point. It is the only non-local host the runtime env is
# allowed to name: everything else must be a loopback address, a Compose service
# name, or a `.local` / `.test` / `.internal` name. An override exists so the
# check can be pointed at a different deployment, never so a second public host
# can be added alongside this one.
BEACONHS_PUBLIC_ORIGIN="${BEACONHS_PUBLIC_ORIGIN:-https://beaconhs-test.xuhaoqing.top}"

# The projects this host's scripts may act on. The live project is the only
# one in production; the test suite adds its own fixture project so a fixture
# run can never reach the live deployment's containers.
BEACONHS_ALLOWED_PROJECTS="${BEACONHS_ALLOWED_PROJECTS:-beaconhs-local-prod}"

# The four infrastructure images. They are pinned HERE because they never
# change with an application release, and a change to one of them is a
# deployment decision that must be reviewed in this file.
BEACONHS_INFRA_IMAGES=(
  "postgres@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea"
  "redis@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499"
  "minio/minio@sha256:b187417eee0a495ed45ff0e2d5f0c9810ae35705319c0d2fb46dd93e4ac1501c"
  "collabora/code@sha256:4e983196eb9878f339cc506c38c21f1cc3473bca3d6de883c5de08f9c0cc3a6c"
)

# The APPLICATION image is the deployment's identity, not the script's: it is
# recorded in the runtime env beside the deployment id, which is where every
# other deployment fact already lives.
#
# It is read from there rather than pinned here for a concrete reason. The
# deployment id is derived from the source archive, and the source archive
# contains this script. Pinning the application digest here would mean that
# shipping a release required editing this file, which would change the archive,
# which would change the deployment id, which would change the image the new
# archive builds — a cycle that can never converge. The four infrastructure
# images are pinned because they do not take part in that cycle.
BEACONHS_IMAGE_REF=""
BEACONHS_IMAGE_DIGEST_REF=""

# Read one non-secret setting from the runtime env file.
#
# Only the named key is read, and only its value is printed. The file itself is
# never sourced into the caller's shell: a sourced env file would export every
# credential in it to every child process.
beaconhs_env_value() {
  local key="$1"
  local file="${2:-$BEACONHS_ENV_FILE}"
  [ -f "$file" ] || return 0
  grep -E "^${key}=" "$file" 2>/dev/null | head -1 | cut -d= -f2- || true
}

# Resolve the deployment's application image identity from the runtime env.
beaconhs_load_image_identity() {
  BEACONHS_IMAGE_REF="$(beaconhs_env_value BEACONHS_IMAGE)"
  BEACONHS_IMAGE_DIGEST_REF="$(beaconhs_env_value BEACONHS_IMAGE_DIGEST)"
}

# The image references this deployment requires, one per line.
#
# The test suite overrides the whole list so a fixture run never inspects the
# live deployment's images. An override arrives as a space-separated STRING, so
# it is split back into an array; using the string directly would make
# "${arr[@]}" expand to one element and every lookup would fail.
beaconhs_expected_images() {
  if [ -n "${BEACONHS_EXPECTED_IMAGES+x}" ]; then
    local override=()
    read -r -a override <<<"$BEACONHS_EXPECTED_IMAGES"
    printf '%s\n' "${override[@]}"
    return 0
  fi
  [ -n "$BEACONHS_IMAGE_REF" ] && printf '%s\n' "$BEACONHS_IMAGE_REF"
  printf '%s\n' "${BEACONHS_INFRA_IMAGES[@]}"
  return 0
}

# The external data volumes. They are declared `external: true` in the Compose
# file, so Compose never creates or removes them.
if [ -z "${BEACONHS_EXPECTED_VOLUMES+x}" ]; then
  BEACONHS_EXPECTED_VOLUMES=(
    "beaconhs-hse_postgres-data"
    "beaconhs-hse_redis-data"
    "beaconhs-hse_minio-data"
  )
else
  read -r -a BEACONHS_EXPECTED_VOLUMES <<<"$BEACONHS_EXPECTED_VOLUMES"
fi

# The long-running Compose services, in the order the status output lists them.
# The one-shot services are listed separately: they must not be restarted by a
# repeated start once they have completed for the current image.
if [ -z "${BEACONHS_SERVICES+x}" ]; then
  BEACONHS_SERVICES=(postgres redis minio web worker collabora)
else
  read -r -a BEACONHS_SERVICES <<<"$BEACONHS_SERVICES"
fi

# Services that are expected to have EXITED once they have run, per the Gate 5
# manifest (`one_shot: true`).
if [ -z "${BEACONHS_ONE_SHOT_SERVICES+x}" ]; then
  BEACONHS_ONE_SHOT_SERVICES=(scheduler storage-init)
else
  read -r -a BEACONHS_ONE_SHOT_SERVICES <<<"$BEACONHS_ONE_SHOT_SERVICES"
fi

# --- Output helpers ---------------------------------------------------------

beaconhs_log() { printf '%s %s\n' "[beaconhs]" "$*"; }
beaconhs_warn() { printf '%s %s\n' "[beaconhs] WARNING:" "$*" >&2; }
beaconhs_fail() {
  printf '%s %s\n' "[beaconhs] FAIL:" "$*" >&2
  exit 1
}

# --- Dependency checks ------------------------------------------------------

beaconhs_require_docker() {
  command -v docker >/dev/null 2>&1 || beaconhs_fail "docker is not installed or not on PATH"
  docker info >/dev/null 2>&1 || beaconhs_fail "the Docker daemon is not reachable"
}

beaconhs_require_compose() {
  docker compose version >/dev/null 2>&1 || beaconhs_fail "docker compose is not usable"
}

beaconhs_require_file() {
  [ -f "$1" ] || beaconhs_fail "required file is missing: $1"
}

# The runtime env files must be present, owned by the invoking user and NOT
# group- or world-readable. A world-readable env file is a credential leak.
beaconhs_require_private_file() {
  local file="$1"
  [ -f "$file" ] || beaconhs_fail "required file is missing: $file"
  local mode
  mode="$(stat -c '%a' "$file")"
  case "$mode" in
    600 | 400) ;;
    *) beaconhs_fail "$file has mode $mode; it must be 600 or 400" ;;
  esac
}

beaconhs_require_volumes() {
  local missing=()
  for volume in "${BEACONHS_EXPECTED_VOLUMES[@]}"; do
    docker volume inspect "$volume" >/dev/null 2>&1 || missing+=("$volume")
  done
  if [ ${#missing[@]} -gt 0 ]; then
    beaconhs_fail "external data volumes are missing: ${missing[*]}"
  fi
}

# Every required image must be present locally. A missing image is a hard stop:
# the scripts never pull and never rebuild.
beaconhs_require_images() {
  local missing=() reference
  while IFS= read -r reference; do
    [ -n "$reference" ] || continue
    if ! docker image inspect "$reference" >/dev/null 2>&1; then
      missing+=("$reference")
    fi
  done < <(beaconhs_expected_images)
  if [ ${#missing[@]} -gt 0 ]; then
    beaconhs_fail "pinned images are not present locally: ${missing[*]} (this script never pulls)"
  fi
}

# The application image the runtime env names must be the image that is actually
# present. A stale tag or a digest from a different build is a hard stop: the
# deployment would otherwise run code nobody reviewed under a name that says
# otherwise.
beaconhs_require_image_identity() {
  beaconhs_load_image_identity
  [ -n "$BEACONHS_IMAGE_REF" ] ||
    beaconhs_fail "BEACONHS_IMAGE is not set in $BEACONHS_ENV_FILE"
  [ -n "$BEACONHS_IMAGE_DIGEST_REF" ] ||
    beaconhs_fail "BEACONHS_IMAGE_DIGEST is not set in $BEACONHS_ENV_FILE"
  case "$BEACONHS_IMAGE_DIGEST_REF" in
    sha256:*) ;;
    *) beaconhs_fail "BEACONHS_IMAGE_DIGEST is not a sha256 digest: $BEACONHS_IMAGE_DIGEST_REF" ;;
  esac
  case "$BEACONHS_IMAGE_REF" in
    *@"$BEACONHS_IMAGE_DIGEST_REF") ;;
    *) beaconhs_fail "BEACONHS_IMAGE '$BEACONHS_IMAGE_REF' does not name BEACONHS_IMAGE_DIGEST '$BEACONHS_IMAGE_DIGEST_REF'" ;;
  esac
  local actual
  actual="$(docker image inspect -f '{{.Id}}' "$BEACONHS_IMAGE_REF" 2>/dev/null || true)"
  [ "$actual" = "$BEACONHS_IMAGE_DIGEST_REF" ] ||
    beaconhs_fail "the application image identity does not match the deployment: '$BEACONHS_IMAGE_REF' resolves to '${actual:-missing}', the env declares '$BEACONHS_IMAGE_DIGEST_REF'"
}

# The Compose file must be the reviewed one. A drift in this file changes the
# deployment, so it is a hard stop rather than a warning.
beaconhs_require_compose_hash() {
  local expected="${1:-}"
  [ -n "$expected" ] || return 0
  local actual
  actual="$(sha256sum "$BEACONHS_COMPOSE_FILE" | cut -d' ' -f1)"
  [ "$actual" = "$expected" ] ||
    beaconhs_fail "the compose file hash changed: expected $expected, found $actual"
}

# The deployment must not point at a production endpoint. The runtime env is
# the only place the endpoints live, so it is the place to check.
beaconhs_require_no_production_endpoint() {
  local offenders public_host
  public_host="${BEACONHS_PUBLIC_ORIGIN#https://}"
  public_host="${public_host#http://}"
  public_host="${public_host%%/*}"
  # A hostname is accepted only when it is a LOOPBACK name, exactly one of the
  # internal Compose service names (optionally with a port), the ONE public entry
  # point, or a `.local` / `.test` / `.internal` name. A name that merely STARTS
  # with a service name — minio.production.example.com — is NOT internal and must
  # be refused.
  offenders="$(grep -ioE 'https?://[A-Za-z0-9._:-]+' "$BEACONHS_ENV_FILE" 2>/dev/null |
    sed -E 's|^https?://||' |
    grep -vE '^(127\.0\.0\.1|localhost|\[::1\]|minio|web|redis|postgres|collabora)(:[0-9]+)?$' |
    grep -vF -x "$public_host" |
    grep -vE '\.(local|test|internal)$' || true)"
  if [ -n "$offenders" ]; then
    beaconhs_fail "the runtime env names a non-local endpoint; refusing to deploy: $(printf '%s' "$offenders" | tr '\n' ' ')"
  fi
}

# --- Compose invocation -----------------------------------------------------

# Every compose call goes through here, so the flags can never drift between the
# three scripts.
beaconhs_compose() {
  docker compose \
    --env-file "$BEACONHS_ENV_FILE" \
    --env-file "$BEACONHS_KEY_ENV_FILE" \
    -f "$BEACONHS_COMPOSE_FILE" \
    -p "$BEACONHS_PROJECT" \
    "$@"
}

# --- Concurrency ------------------------------------------------------------

# One lifecycle change at a time. Two scripts racing over the same Compose
# project could interleave an up and a down.
beaconhs_acquire_lock() {
  mkdir -p "$(dirname "$BEACONHS_LOCK_FILE")"
  exec {BEACONHS_LOCK_FD}>"$BEACONHS_LOCK_FILE"
  if ! flock -n "$BEACONHS_LOCK_FD"; then
    beaconhs_fail "another lifecycle script holds $BEACONHS_LOCK_FILE; refusing to run concurrently"
  fi
}

# --- Status reporting -------------------------------------------------------

# Prints the state of one service. The state comes from the container itself,
# never from an assumption.
beaconhs_service_state() {
  local service="$1"
  local container
  container="$(beaconhs_compose ps -q "$service" 2>/dev/null || true)"
  if [ -z "$container" ]; then
    printf 'ABSENT'
    return
  fi
  local status health
  status="$(docker inspect -f '{{.State.Status}}' "$container" 2>/dev/null || echo unknown)"
  health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container" 2>/dev/null || echo unknown)"
  printf '%s/%s' "$status" "$health"
}

# A one-shot service is READY when it has exited with code 0.
beaconhs_one_shot_state() {
  local service="$1"
  local container
  container="$(beaconhs_compose ps -aq "$service" 2>/dev/null || true)"
  if [ -z "$container" ]; then
    printf 'ABSENT'
    return
  fi
  local status code
  status="$(docker inspect -f '{{.State.Status}}' "$container" 2>/dev/null || echo unknown)"
  code="$(docker inspect -f '{{.State.ExitCode}}' "$container" 2>/dev/null || echo 0)"
  if [ "$status" = "exited" ] && [ "$code" = "0" ]; then
    printf 'READY'
  else
    printf '%s/%s' "$status" "$code"
  fi
}

# True when a one-shot service has already completed, with THIS deployment's
# image. A repeated start must not redo work that is already done; a NEW image
# must still run it, because the work it performs can change with the release.
beaconhs_one_shot_is_current() {
  local service="$1"
  local container image
  container="$(beaconhs_compose ps -aq "$service" 2>/dev/null || true)"
  [ -n "$container" ] || return 1
  image="$(docker inspect -f '{{.Config.Image}}' "$container" 2>/dev/null || true)"
  [ "$image" = "$BEACONHS_IMAGE_REF" ] || return 1
  [ "$(beaconhs_one_shot_state "$service")" = "READY" ] || return 1
  return 0
}

beaconhs_gate5() {
  local output
  if [ ! -x "$BEACONHS_GATE5_SCRIPT" ]; then
    printf 'SKIPPED (verifier not installed)'
    return
  fi
  # The image identity comes from the deployment, not from this script: a new
  # release changes the runtime env, never the lifecycle code.
  beaconhs_load_image_identity
  if [ -z "$BEACONHS_IMAGE_DIGEST_REF" ]; then
    printf 'NOT VERIFIED (no image digest in the runtime env)'
    return
  fi
  local source_id="${BEACONHS_DEPLOYMENT_ID%%-*}"
  set +e
  output="$(
    # The verifier renders the Compose file, and the render needs BOTH env files:
    # the runtime settings and the Server Action key. They are exported into this
    # subshell only, so the key never reaches the caller's environment.
    set -a
    # shellcheck disable=SC1090
    . "$BEACONHS_ENV_FILE"
    # shellcheck disable=SC1090
    . "$BEACONHS_KEY_ENV_FILE"
    set +a
    "$BEACONHS_GATE5_SCRIPT" \
      --project "$BEACONHS_PROJECT" \
      --image beaconhs \
      --digest "$BEACONHS_IMAGE_DIGEST_REF" \
      --deployment-id "${BEACONHS_DEPLOYMENT_ID:-}" \
      --source-deployment-id "$source_id" \
      --manifest "$BEACONHS_MANIFEST_FILE" \
      --compose-file "$BEACONHS_COMPOSE_FILE" \
      --lock "$BEACONHS_ROOT/.gate5.lock" \
      --timeout 120 2>&1
  )"
  local code=$?
  set -e
  printf '%s\n' "$output" >"$BEACONHS_GATE5_RESULT" 2>/dev/null || true
  case "$code" in
    0) printf 'PASS' ;;
    1) printf 'FAIL' ;;
    2) printf 'NOT VERIFIED' ;;
    3) printf 'USAGE ERROR' ;;
    *) printf 'ERROR (%s)' "$code" ;;
  esac
}
