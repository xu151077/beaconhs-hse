#!/usr/bin/env bash
# EA-66D.3.1 — the lifecycle scripts' own test suite.
#
# WHAT IT EXERCISES
# -----------------
#   * the preconditions refuse to start when Docker, the compose file, an
#     image, a volume or the env file's permissions are wrong;
#   * the start script is idempotent;
#   * the stop script is idempotent;
#   * a failed start leaves the scene in place and never removes a volume;
#   * the lock refuses a concurrent run;
#   * a container belonging to ANOTHER Compose project is never touched;
#   * the external volumes survive a stop and the data is still readable.
#
# HOW IT IS ISOLATED
# ------------------
# It runs against a FIXTURE tree, never against the live deployment: a
# throwaway compose file, a throwaway env file, a throwaway volume set and
# throwaway container names. The real deployment's volumes, images, containers
# and database are never referenced.
#
# The destructive negative tests run against the fixture's own containers only.

set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"

PASS=0
FAIL=0
FIXTURE=""

ok() {
  PASS=$((PASS + 1))
  printf '  ok    %s\n' "$1"
}

bad() {
  FAIL=$((FAIL + 1))
  printf '  FAIL  %s\n' "$1"
}

check_contains() {
  local description="$1"
  local needle="$2"
  local haystack="$3"
  case "$haystack" in
    *"$needle"*) ok "$description" ;;
    *)
      bad "$description (output did not contain '$needle')"
      printf '        ---- output ----\n'
      printf '%s\n' "$haystack" | sed 's/^/        /'
      printf '        -----------------\n'
      ;;
  esac
}

check() {
  local description="$1"
  local expected="$2"
  local actual="$3"
  if [ "$expected" = "$actual" ]; then
    ok "$description"
  else
    bad "$description (expected '$expected', got '$actual')"
  fi
}

cleanup() {
  if [ -n "$FIXTURE" ] && [ -d "$FIXTURE" ]; then
    docker rm -f "$(docker ps -aq --filter "name=beaconhs-fixture-")" >/dev/null 2>&1 || true
    for volume in beaconhs-fixture-postgres-data beaconhs-fixture-redis-data beaconhs-fixture-minio-data; do
      docker volume rm -f "$volume" >/dev/null 2>&1 || true
    done
    rm -rf "$FIXTURE"
  fi
}
trap cleanup EXIT

# --- Fixture ----------------------------------------------------------------

make_fixture() {
  FIXTURE="$(mktemp -d /tmp/beaconhs-fixture-XXXXXX)"
  mkdir -p "$FIXTURE/compose" "$FIXTURE/runtime" "$FIXTURE/scripts/ci"

  cat >"$FIXTURE/compose/local-production.compose.yaml" <<'YAML'
name: beaconhs-fixture
services:
  postgres:
    image: postgres@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea
  redis:
    image: redis@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499
  minio:
    image: minio/minio@sha256:b187417eee0a495ed45ff0e2d5f0c9810ae35705319c0d2fb46dd93e4ac1501c
  web:
    image: beaconhs@sha256:1834f86796195d9b97d5d6b737de57405f0183e6a36857c7c78a9bcdab6f6795
  worker:
    image: beaconhs@sha256:1834f86796195d9b97d5d6b737de57405f0183e6a36857c7c78a9bcdab6f6795
  scheduler:
    image: beaconhs@sha256:1834f86796195d9b97d5d6b737de57405f0183e6a36857c7c78a9bcdab6f6795
  collabora:
    image: collabora/code@sha256:4e983196eb9878f339cc506c38c21f1cc3473bca3d6de883c5de08f9c0cc3a6c
  storage-init:
    image: beaconhs@sha256:1834f86796195d9b97d5d6b737de57405f0183e6a36857c7c78a9bcdab6f6795
volumes:
  postgres-data:
    external: true
    name: beaconhs-fixture-postgres-data
  redis-data:
    external: true
    name: beaconhs-fixture-redis-data
  minio-data:
    external: true
    name: beaconhs-fixture-minio-data
YAML

  cat >"$FIXTURE/compose/gate5.manifest.yaml" <<'YAML'
project: beaconhs-local-prod
compose_file: deploy/local-production.compose.yaml
services: {}
YAML

  cat >"$FIXTURE/runtime/local-prod.env" <<'ENV'
BEACONHS_DEPLOYMENT_ID=406f0c00d0e42bc1e578acf0e5af86b14bd7e175-20261031-001
BEACONHS_IMAGE=beaconhs@sha256:1834f86796195d9b97d5d6b737de57405f0183e6a36857c7c78a9bcdab6f6795
BEACONHS_IMAGE_DIGEST=sha256:1834f86796195d9b97d5d6b737de57405f0183e6a36857c7c78a9bcdab6f6795
R2_ENDPOINT=https://minio.beaconhs-test.local
R2_INTERNAL_ENDPOINT=http://minio:9000
DATABASE_URL=postgresql://beaconhs_app:fixture@postgres:5432/beaconhs
ENV
  chmod 600 "$FIXTURE/runtime/local-prod.env"

  printf 'NEXT_SERVER_ACTIONS_ENCRYPTION_KEY=fixture\n' >"$FIXTURE/runtime/server-action-key.env"
  chmod 600 "$FIXTURE/runtime/server-action-key.env"

  for volume in beaconhs-fixture-postgres-data beaconhs-fixture-redis-data beaconhs-fixture-minio-data; do
    docker volume create "$volume" >/dev/null 2>&1 || true
  done
}

# Run one of the scripts against the fixture.
run_script() {
  local script="$1"
  shift
  env \
    BEACONHS_ROOT="$FIXTURE" \
    BEACONHS_COMPOSE_DIR="$FIXTURE/compose" \
    BEACONHS_RUNTIME_DIR="$FIXTURE/runtime" \
    BEACONHS_LOCK_FILE="$FIXTURE/lifecycle.lock" \
    BEACONHS_GATE5_SCRIPT="$FIXTURE/scripts/ci/reconcile-compose-digest.sh" \
    BEACONHS_GATE5_RESULT="$FIXTURE/runtime/gate5.txt" \
    BEACONHS_PROJECT="beaconhs-fixture" \
    BEACONHS_ALLOWED_PROJECTS="beaconhs-local-prod beaconhs-fixture" \
    BEACONHS_EXPECTED_VOLUMES="beaconhs-fixture-postgres-data beaconhs-fixture-redis-data beaconhs-fixture-minio-data" \
    bash "$SCRIPT_DIR/$script" "$@" 2>&1
}

echo "BeaconHS lifecycle script tests"
echo "==============================="
echo

make_fixture

# The fixture's own volumes must exist, or every later precondition check
# would be testing the wrong thing.
for volume in beaconhs-fixture-postgres-data beaconhs-fixture-redis-data beaconhs-fixture-minio-data; do
  if docker volume inspect "$volume" >/dev/null 2>&1; then
    ok "fixture volume $volume exists"
  else
    bad "fixture volume $volume was not created"
  fi
done

# --- 1. The preconditions refuse to start on a missing compose file ----------

mv "$FIXTURE/compose/local-production.compose.yaml" "$FIXTURE/compose/hidden.yaml"
out="$(run_script beaconhs-start.sh --no-gate5)"
check_contains "a missing compose file refuses the start" 'required file is missing' "$out"

# --- 2. A missing env file refuses the start ------------------------------

out="$(run_script beaconhs-start.sh --no-gate5)"
check_contains "a missing compose file is reported" 'required file is missing' "$out"
mv "$FIXTURE/compose/hidden.yaml" "$FIXTURE/compose/local-production.compose.yaml"

mv "$FIXTURE/runtime/local-prod.env" "$FIXTURE/runtime/hidden.env"
out="$(run_script beaconhs-start.sh --no-gate5)"
check_contains "a missing runtime env refuses the start" 'required file is missing' "$out"
mv "$FIXTURE/runtime/hidden.env" "$FIXTURE/runtime/local-prod.env"

# --- 3. A world-readable env file refuses the start -----------------------

chmod 644 "$FIXTURE/runtime/local-prod.env"
out="$(run_script beaconhs-start.sh --no-gate5)"
check_contains "a world-readable runtime env refuses the start" 'it must be 600 or 400' "$out"
chmod 600 "$FIXTURE/runtime/local-prod.env"

# --- 4. A missing volume refuses the start ---------------------------------

docker volume rm beaconhs-fixture-minio-data >/dev/null 2>&1 || true
out="$(run_script beaconhs-start.sh --no-gate5)"
check_contains "a missing external volume refuses the start" 'external data volumes are missing' "$out"
docker volume create beaconhs-fixture-minio-data >/dev/null 2>&1 || true

# --- 5. A missing image refuses the start ----------------------------------

out="$(env BEACONHS_EXPECTED_IMAGES='postgres@sha256:0000000000000000000000000000000000000000000000000000000000000000' bash -c '
  export BEACONHS_ROOT="'"$FIXTURE"'"
  export BEACONHS_COMPOSE_DIR="'"$FIXTURE"'/compose"
  export BEACONHS_RUNTIME_DIR="'"$FIXTURE"'/runtime"
  export BEACONHS_LOCK_FILE="'"$FIXTURE"'/lifecycle.lock"
  export BEACONHS_EXPECTED_VOLUMES="beaconhs-fixture-postgres-data beaconhs-fixture-redis-data beaconhs-fixture-minio-data"
  bash "'"$SCRIPT_DIR"'/beaconhs-start.sh" --no-gate5' 2>&1)"
check_contains "a missing pinned image refuses the start" 'pinned images are not present locally' "$out"

# --- 6. A compose file whose hash changed refuses the start ---------------

out="$(run_script beaconhs-start.sh --no-gate5 --compose-sha256 0000000000000000000000000000000000000000000000000000000000000000)"
check_contains "a changed compose file hash refuses the start" 'compose file hash changed' "$out"

# --- 6b. A digest that does not match the image refuses the start ----------

# The env names the deployment's image identity. If the digest is not the image
# that is actually present, the deployment would run unreviewed code under a
# reviewed name.
WRONG=sha256:1111111111111111111111111111111111111111111111111111111111111111
cp "$FIXTURE/runtime/local-prod.env" "$FIXTURE/runtime/local-prod.env.keep"

# (a) A digest that the image reference itself contradicts.
sed -i "s/^BEACONHS_IMAGE_DIGEST=.*/BEACONHS_IMAGE_DIGEST=$WRONG/" \
  "$FIXTURE/runtime/local-prod.env"
out="$(run_script beaconhs-start.sh --no-gate5)"
check_contains "an image reference that contradicts its digest refuses the start" \
  'does not name BEACONHS_IMAGE_DIGEST' "$out"

# (b) A consistent but WRONG identity: both halves say the same thing, and the
#     image that is actually present is not it.
sed -i "s|^BEACONHS_IMAGE=.*|BEACONHS_IMAGE=beaconhs@$WRONG|" \
  "$FIXTURE/runtime/local-prod.env"
out="$(run_script beaconhs-start.sh --no-gate5)"
check_contains "an image identity the host does not hold refuses the start" \
  'does not match the deployment' "$out"

mv "$FIXTURE/runtime/local-prod.env.keep" "$FIXTURE/runtime/local-prod.env"

# --- 7. A non-local endpoint refuses the start ----------------------------

printf 'R2_ENDPOINT=https://minio.production.example.com\n' >>"$FIXTURE/runtime/local-prod.env"
out="$(run_script beaconhs-start.sh --no-gate5)"
check_contains "a production endpoint refuses the start" 'non-local endpoint' "$out"
sed -i '/production.example.com/d' "$FIXTURE/runtime/local-prod.env"

# The ONE public entry point is legitimate; a SECOND public host is not.
printf 'APP_URL=https://beaconhs-test.xuhaoqing.top\n' >>"$FIXTURE/runtime/local-prod.env"
out="$(run_script beaconhs-start.sh --no-gate5)"
check_contains "the public entry point is accepted" 'starting long-running services' "$out"
printf 'SECOND_URL=https://s3-test.xuhaoqing.top\n' >>"$FIXTURE/runtime/local-prod.env"
out="$(run_script beaconhs-start.sh --no-gate5)"
check_contains "a second public host is refused" 'non-local endpoint' "$out"
sed -i '/APP_URL/d;/SECOND_URL/d' "$FIXTURE/runtime/local-prod.env"

# --- 8. The lock refuses a concurrent run ---------------------------------

(
  exec 9>"$FIXTURE/lifecycle.lock"
  flock -n 9 || exit 1
  sleep 6
) &
locker=$!
sleep 1
out="$(run_script beaconhs-start.sh --no-gate5)"
check_contains "a concurrent run is refused" 'refusing to run concurrently' "$out"
wait "$locker" 2>/dev/null || true

# --- 9. The stop script leaves the volumes and the data alone --------------

# A container of ANOTHER project must never be touched.
docker run -d --name beaconhs-fixture-other-project \
  -v beaconhs-fixture-postgres-data:/data \
  alpine:latest sh -c 'echo preserved > /data/marker.txt; sleep 300' >/dev/null 2>&1 || true
sleep 2

out="$(run_script beaconhs-stop.sh)"
check_contains "the stop reports the other project as untouched" 'NOT touched' "$out"
check "the other project's container is still running" "running" "$(
  docker inspect -f '{{.State.Status}}' beaconhs-fixture-other-project 2>/dev/null || echo missing
)"
check "the external volume survives the stop" "present" "$(
  docker volume inspect beaconhs-fixture-postgres-data >/dev/null 2>&1 && echo present || echo missing
)"
check "the data on the volume survives the stop" "preserved" "$(
  docker run --rm -v beaconhs-fixture-postgres-data:/data alpine:latest cat /data/marker.txt 2>/dev/null || echo missing
)"

# --- 10. The stop script is idempotent -------------------------------------

out="$(run_script beaconhs-stop.sh)"
check_contains "a repeated stop is safe" 'BeaconHS stopped' "$out"

docker rm -f beaconhs-fixture-other-project >/dev/null 2>&1 || true

# --- 10b. A repeated start is safe and the data survives it ----------------

# The fixture's compose has no healthchecks, so the start script cannot report
# the services healthy. It must therefore REFUSE rather than claim success.
out="$(run_script beaconhs-start.sh --no-gate5)"
check_contains "a start without healthchecks refuses to claim success" "yes" "$(
  printf '%s' "$out" | grep -q 'did not become healthy' && echo yes || echo no
)"

# The fixture containers are now created. A repeated stop and a repeated start
# must both be safe, and the volume data must still be there.
out="$(run_script beaconhs-stop.sh)"
check_contains "a stop after a start is safe" "BeaconHS stopped" "$out"
check_contains "the data survives a stop and a start" "preserved" "$(
  docker run --rm -v beaconhs-fixture-postgres-data:/data alpine:latest cat /data/marker.txt 2>/dev/null || echo missing
)"

# --- 11. The status script prints no secret -------------------------------

out="$(run_script beaconhs-status.sh)"
check_contains "the status names the public entry point" 'https://beaconhs-test.xuhaoqing.top' "$out"
check "the status does not print the runtime env" "yes" "$(
  printf '%s' "$out" | grep -q 'fixture@postgres' && echo no || echo yes
)"
check_contains "the status reports the volumes" 'Data volumes' "$out"

# --- 12. The layout file supplies paths, never code --------------------------

# A host whose canonical files live outside ~/.beaconhs states that once in
# lifecycle.env. The file is PARSED, so a value that looks like a command must
# stay literal.
printf 'BEACONHS_COMPOSE_DIR=%s\n# a comment\nIGNORED_KEY=1\nBEACONHS_MANIFEST_FILE=$(touch %s/pwned)\n' \
  "$FIXTURE/compose" "$FIXTURE" >"$FIXTURE/lifecycle.env"
out="$(env \
  BEACONHS_ROOT="$FIXTURE" \
  BEACONHS_RUNTIME_DIR="$FIXTURE/runtime" \
  BEACONHS_GATE5_SCRIPT="$FIXTURE/none.sh" \
  bash "$SCRIPT_DIR/beaconhs-status.sh" 2>&1)"
check_contains "the layout file supplies the compose directory" 'local-production.compose.yaml' "$out"
if [ -e "$FIXTURE/pwned" ]; then
  bad "the layout file was executed as code"
else
  ok "the layout file is parsed, never executed"
fi

# An explicit environment value must beat the file, so a one-off invocation can
# always correct the layout.
out="$(env \
  BEACONHS_ROOT="$FIXTURE" \
  BEACONHS_COMPOSE_DIR=/nonexistent-compose-dir \
  BEACONHS_RUNTIME_DIR="$FIXTURE/runtime" \
  BEACONHS_GATE5_SCRIPT="$FIXTURE/none.sh" \
  bash "$SCRIPT_DIR/beaconhs-status.sh" 2>&1)"
check_contains "an explicit override beats the layout file" '/nonexistent-compose-dir' "$out"
rm -f "$FIXTURE/lifecycle.env"

echo
printf 'passed: %d   failed: %d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
