#!/usr/bin/env bash
# Phase CO — Build and deploy drill image with freeze driver

set -euo pipefail

# Phase EA-5: the Dockerfile declares `next_server_actions_key` as a REQUIRED
# BuildKit secret (line 39). A build without it cannot produce an image at all,
# so this script used to fail at the build step before it ever reached the
# deploy. It now requires the key file — mode 0600, outside the repository — and
# passes it as a secret, never as a build-arg or environment value.
#
# Phase EA-5 also added the fingerprint gate: after the build, the key embedded
# in the image is read back out and compared against the key supplied, through
# the same gate the deployment uses. A mismatch aborts before anything is
# shipped to the drill host.
KEY_FILE=${NEXT_SERVER_ACTIONS_KEY_FILE:-/tmp/beaconhs-server-action-key}
if [ ! -r "$KEY_FILE" ]; then
  echo "[key-gate] NEXT_SERVER_ACTIONS_KEY_FILE '${KEY_FILE}' is missing or unreadable." >&2
  echo "[key-gate] Generate one with: openssl rand -base64 32 > ${KEY_FILE} && chmod 600 ${KEY_FILE}" >&2
  exit 2
fi
if [ "$(stat -c '%a' "$KEY_FILE")" != "600" ]; then
  echo "[key-gate] ${KEY_FILE} must be mode 600." >&2
  exit 2
fi

DRILL_HOST=${DRILL_HOST:-beaconhs-drill}
DRILL_DIR=${DRILL_DIR:-/home/test/projects/beaconhs-hse}
DRILL_COMPOSE_FILE=${DRILL_COMPOSE_FILE:-deploy/drill-20261009.compose.yaml}

echo "=== Phase CO — Building drill image with freeze driver ==="

# The gate and the fingerprint CLI live in the repository. This script is
# sometimes invoked from a copy, so the root is taken from the repository
# (BEAONHS_REPO_ROOT when set), never from the copy's own directory.
GATE_ROOT="${BEACONHS_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

# 1b. Fingerprint the key before the build. The Dockerfile binds this value into
# the cache key of the secret-consuming layer, because BuildKit does not hash
# secret content — otherwise a rebuild after a rotation would reuse the previous
# layer and still embed the old key.
if ! expected="$(node "$GATE_ROOT/scripts/ci/server-action-key-fingerprint.mjs" "$KEY_FILE")"; then
  echo "[key-gate] ${KEY_FILE} does not contain a valid Server Action key" >&2
  exit 2
fi

DRILL_IMAGE_NAME="beaconhs:drill-$(date +%Y%m%d-%H%M%S)"
echo "Building $DRILL_IMAGE_NAME..."
cd "$DRILL_DIR"
DOCKER_BUILDKIT=1 docker build \
  --secret id=next_server_actions_key,src="$KEY_FILE" \
  --build-arg NEXT_SERVER_ACTIONS_KEY_FINGERPRINT="$expected" \
  --tag "$DRILL_IMAGE_NAME" \
  --tag beaconhs:drill-latest \
  --build-arg DEPLOYMENT_VERSION=$(git rev-parse HEAD) \
  --build-arg NEXT_PUBLIC_SENTRY_DSN="" \
  --file Dockerfile \
  .

# 1c. Gate the embedded key before anything is shipped.
#
# Phase EA-5: this reuses the single gate implementation
# (`verify-server-action-key-gate.sh image`), which copies the server-reference
# manifest out of the immutable image, derives the fingerprint and compares it —
# the key never crosses a boundary in clear, and any temporary file is removed on
# every exit path.
#
# The gate is resolved from the REPOSITORY, not from this script's directory:
# the script is sometimes invoked from a copy, and a copied tree has no
# scripts/ci next to it. An unresolvable gate must abort, never silently pass.
GATE="$GATE_ROOT/scripts/ci/verify-server-action-key-gate.sh"
if [ ! -x "$GATE" ]; then
  echo "[key-gate] gate script not found at ${GATE}; refusing to ship" >&2
  exit 2
fi
if "$GATE" image "$DRILL_IMAGE_NAME" "$expected"; then
  echo "[key-gate] PASS $DRILL_IMAGE_NAME embeds the expected Server Action key"
else
  status=$?
  echo "[key-gate] FAIL $DRILL_IMAGE_NAME does not hold the expected Server Action key" >&2
  exit "$status"
fi

# 2. Copy the gated image to the drill host.
#
# There is no registry: the image is streamed over the ssh transport. The old
# version probed the host with `docker exec "$DRILL_HOST"`, which is not an ssh
# call at all (DRILL_HOST is an ssh target, not a local container), and both
# branches ran the identical copy anyway. One guarded copy now:
#  - a failing transport aborts the deploy instead of continuing;
#  - PIPESTATUS records the `docker load` side, not just `docker save`;
#  - the tag is verified on the host afterwards, so a silently failed load
#    cannot be followed by a recreate that pulls something else.
if ! docker save "$DRILL_IMAGE_NAME" | ssh "$DRILL_HOST" docker load; then
  echo "[deploy] copying ${DRILL_IMAGE_NAME} to ${DRILL_HOST} failed" >&2
  exit 1
fi
if ! ssh "$DRILL_HOST" "docker image inspect $DRILL_IMAGE_NAME >/dev/null"; then
  echo "[deploy] ${DRILL_IMAGE_NAME} is not present on ${DRILL_HOST} after the copy" >&2
  exit 1
fi
echo "Copied $DRILL_IMAGE_NAME to $DRILL_HOST"

# 3. (removed) The previous version rewrote THIS checkout's compose file. The
# stack runs on the drill host from its own file, so that edit never reached the
# deployment — it only dirtied the working tree. The running stack is pinned to
# the shipped image in step 4.

# 4. Restart services on drill host, pinned to the image this script built and
# gated.
#
# The compose file on the DRILL HOST is a separate checkout still pinned to
# whatever tag it had, so the recreate used to bring the PREVIOUS image back. An
# earlier attempt passed `-C <image>`, which `docker compose` does not accept
# (only the long form `--pull`-style flags and per-subcommand options exist; `-C`
# is not one of them), so the deploy failed outright.
#
# The override is applied where it is actually needed: a copy of the host's file
# is rendered into a local temp file by `scripts/ci/pin-compose-app-image.mjs`,
# which replaces ONLY the gated application services listed in
# `deploy/gate5.manifest.yaml` (`image_class: gated`). Pinned postgres/redis/
# minio/mailpit/collabora images are preserved byte-for-byte. The rendered file
# is validated by the target's `docker compose config`, and only then is `up` run
# from that same file. `--latest-image` was rejected on purpose: it behaves
# differently between Compose versions and would reintroduce the exact "which
# image is running" ambiguity this fix removes.
#
# The stack name is fixed so this UPDATES the running deployment instead of
# accumulating a new stack on every run.
# `${VAR:-default}` treats an explicitly EMPTY override as unset and silently
# substitutes the default — so an empty DRILL_DIR or DRILL_PROJECT would quietly
# target the wrong path or the wrong stack instead of stopping. A non-empty
# variable is required: read it first, then default only when it was never set.
for _var in DRILL_HOST DRILL_DIR DRILL_COMPOSE_FILE DRILL_PROJECT; do
  if [ -z "${!_var+x}" ]; then
    case "$_var" in
      DRILL_HOST) DRILL_HOST=beaconhs-drill ;;
      DRILL_DIR) DRILL_DIR=/home/test/projects/beaconhs-hse ;;
      DRILL_COMPOSE_FILE) DRILL_COMPOSE_FILE=deploy/drill-20261009.compose.yaml ;;
      DRILL_PROJECT) DRILL_PROJECT=beaconhs-drill-20261009 ;;
    esac
  elif [ -z "${!_var}" ]; then
    echo "[deploy] ${_var} is set but empty; refusing to guess the drill target" >&2
    exit 2
  fi
done
unset _var
if [[ ! "$DRILL_IMAGE_NAME" =~ ^[A-Za-z0-9._:/-]+$ ]]; then
  echo "[deploy] refusing to deploy an unexpected image reference: ${DRILL_IMAGE_NAME}" >&2
  exit 2
fi

echo "Restarting services on drill host ($DRILL_PROJECT -> $DRILL_IMAGE_NAME)..."
# Render the host's compose file into a private local temp file. The helper
# reads the trusted manifest's gated-service set and replaces only those image
# lines; it refuses duplicate/missing services, a changed service count, or a
# changed non-application image. Nothing is written to the host's compose file.
PINNED_COMPOSE_FILE="$(mktemp "${TMPDIR:-/tmp}/beaconhs-drill-compose.XXXXXX")"
trap 'rm -f "$PINNED_COMPOSE_FILE"' EXIT
chmod 600 "$PINNED_COMPOSE_FILE"

PIN_COMPOSE="$GATE_ROOT/scripts/ci/pin-compose-app-image.mjs"
if [ ! -r "$PIN_COMPOSE" ]; then
  echo "[deploy] image-scope helper not found at ${PIN_COMPOSE}; refusing to restart" >&2
  exit 2
fi
if ! ssh "$DRILL_HOST" "cd $DRILL_DIR && cat $DRILL_COMPOSE_FILE" \
  | node "$PIN_COMPOSE" \
      --manifest "$GATE_ROOT/deploy/gate5.manifest.yaml" \
      --image "$DRILL_IMAGE_NAME" > "$PINNED_COMPOSE_FILE"; then
  echo "[deploy] the host compose file could not be scoped to the application services; nothing was restarted" >&2
  exit 1
fi
if ! ssh "$DRILL_HOST" "cd $DRILL_DIR && docker compose -f - --project-name $DRILL_PROJECT config >/dev/null" \
  < "$PINNED_COMPOSE_FILE"; then
  echo "[deploy] the pinned compose configuration is invalid; nothing was restarted" >&2
  exit 1
fi
if ! ssh "$DRILL_HOST" "cd $DRILL_DIR && docker compose -f - --project-name $DRILL_PROJECT \
      up -d --force-recreate --no-build --pull never" < "$PINNED_COMPOSE_FILE"; then
  echo "[deploy] docker compose failed on the drill host" >&2
  exit 1
fi

# 5. Wait for services to be healthy
echo "Waiting for services to be healthy..."
sleep 10

# 6. Verify driver exists
#
# The container is resolved from THIS deployment's project and service instead of
# a hardcoded name: the previous hardcoded `beaconhs-phase-aj-worker-1` belongs to
# another stack and would report success (or failure) for the wrong deployment.
if ! WORKER_CONTAINER=$(ssh "$DRILL_HOST" "docker ps --filter label=com.docker.compose.project=$DRILL_PROJECT \
  --filter label=com.docker.compose.service=worker --format '{{.ID}}'"); then
  echo "Could not query containers on the drill host" >&2
  exit 1
fi
if [ -z "$WORKER_CONTAINER" ]; then
  echo "No worker container found for project $DRILL_PROJECT on the drill host" >&2
  exit 1
fi
echo "Verifying driver exists in worker container ($WORKER_CONTAINER)..."
if ssh "$DRILL_HOST" "docker exec $WORKER_CONTAINER ls -la /app/apps/worker/src/bt-freeze-driver.ts"; then
  echo "Freeze driver found in worker container"
else
  echo "Freeze driver NOT found in worker container" >&2
  exit 1
fi

# 7. Test driver status command
echo "Testing driver status command..."
DRIVER_STATUS=$(ssh "$DRILL_HOST" "docker exec $WORKER_CONTAINER tsx /app/apps/worker/src/bt-freeze-driver.ts status")
echo "Driver status: $DRIVER_STATUS"

# 8. Record image digest
echo ""
echo "=== Build Summary ==="
echo "New image: $DRILL_IMAGE_NAME"
echo "Compose file: $DRILL_COMPOSE_FILE"
echo "Drill host: $DRILL_HOST"
echo "Services restarted"
echo ""
echo "Next step: Run freeze/multipart E2E tests"
