#!/usr/bin/env bash
# Phase EA-4 — Local image build with the Server Action key gate enforced.
#
# Phase EA-66B.1 — the image identity is derived from the exact source archive
# that is used as the Docker build context, not from `git rev-parse HEAD`.
#
# WHY THIS EXISTS
#
# `Dockerfile` requires the `next_server_actions_key` BuildKit secret
# (`required=true`), so a build without it fails immediately. The pre-existing
# `scripts/build-drill-image.sh` predated that contract: it built without the
# secret and never verified the key it embedded. EA-5 brought it onto the same
# contract (secret + fingerprint bound into the cache key + the shared gate);
# this file remains the entry point for generic local images.
#
# This script is the LOCAL entry point that enforces that contract end to end:
#
#   1. it takes a source archive, verifies it, and builds from its extracted
#      contents — so the Docker context is exactly the bytes that were hashed;
#   2. it derives a 40-hex deployment id from the archive SHA-256 and an explicit
#      release label, and passes that same value to Next.js, the image labels and
#      the post-build identity verifier;
#   3. it supplies the key as a BuildKit secret, never as a build-arg and never
#      in the image environment or history, and binds the key's fingerprint into
#      the build cache key so a rotation cannot reuse a layer holding the old key;
#   4. it reads the embedded key back out of the finished image and compares its
#      fingerprint against the key it was given, through the SAME gate the
#      deployment uses (`scripts/ci/verify-server-action-key-gate.sh`);
#   5. it refuses to report success when any identity or key check fails.
#
# The key file is read from `NEXT_SERVER_ACTIONS_KEY_FILE`, which defaults to a
# path OUTSIDE the repository. The key value is never printed, never exported to
# the build context, and never written into this repository.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

KEY_FILE=${NEXT_SERVER_ACTIONS_KEY_FILE:-/tmp/beaconhs-server-action-key}
IMAGE=${1:-beaconhs:local-$(date +%Y%m%d-%H%M%S)}
SOURCE_CONTEXT_ARCHIVE=${SOURCE_CONTEXT_ARCHIVE:-$ROOT/docs/evidence/ea66b/source/source-context.tar.zst}
RELEASE_ID=${RELEASE_ID:-local}
BUILD_EVIDENCE_DIR=${BUILD_EVIDENCE_DIR:-}

fail() {
  echo "[build] $*" >&2
  exit 2
}

for command_name in node jq tar sha256sum docker; do
  command -v "$command_name" >/dev/null 2>&1 || fail "required command '$command_name' is missing"
done

[ -r "$SOURCE_CONTEXT_ARCHIVE" ] || fail "SOURCE_CONTEXT_ARCHIVE '$SOURCE_CONTEXT_ARCHIVE' is missing or unreadable"
[ -f "$SOURCE_CONTEXT_ARCHIVE" ] || fail "SOURCE_CONTEXT_ARCHIVE '$SOURCE_CONTEXT_ARCHIVE' is not a regular file"

case "$SOURCE_CONTEXT_ARCHIVE" in
  *.tar.zst | *.tzst)
    command -v zstd >/dev/null 2>&1 || fail "zstd is required for '$SOURCE_CONTEXT_ARCHIVE'"
    TAR_LIST=(--zstd -tf)
    TAR_EXTRACT=(--zstd -xf)
    ;;
  *.tar.gz | *.tgz)
    TAR_LIST=(-tzf)
    TAR_EXTRACT=(-xzf)
    ;;
  *.tar)
    TAR_LIST=(-tf)
    TAR_EXTRACT=(-xf)
    ;;
  *)
    fail "unsupported source archive extension: '$SOURCE_CONTEXT_ARCHIVE' (use .tar, .tar.gz, .tgz or .tar.zst)"
    ;;
esac
[ -r "$ROOT/scripts/ci/source-deployment-id.mjs" ] || fail 'source-deployment-id helper is missing'
[ -r "$ROOT/scripts/ci/verify-image-identity.mjs" ] || fail 'verify-image-identity helper is missing'

case "$RELEASE_ID" in
  '' | *[!A-Za-z0-9._-]*) fail "RELEASE_ID '$RELEASE_ID' contains unsafe characters" ;;
esac

if [ "${PREPARE_ONLY:-0}" != "1" ] && [ -z "$BUILD_EVIDENCE_DIR" ]; then
  fail 'BUILD_EVIDENCE_DIR is required for a real build; it preserves the source manifest and build log'
fi

if [ ! -r "$KEY_FILE" ]; then
  echo "[key-gate] NEXT_SERVER_ACTIONS_KEY_FILE '${KEY_FILE}' is missing or unreadable." >&2
  echo "[key-gate] Generate one with: openssl rand -base64 32 > ${KEY_FILE} && chmod 600 ${KEY_FILE}" >&2
  exit 2
fi

if [ "$(stat -c '%a' "$KEY_FILE")" != "600" ]; then
  echo "[key-gate] ${KEY_FILE} must be mode 600." >&2
  exit 2
fi

case "$(realpath -m "$KEY_FILE")" in
  "$(realpath -m "$ROOT")"/*)
    echo "[key-gate] ${KEY_FILE} is inside the repository; the key must live outside the build context." >&2
    exit 2
    ;;
esac

# The fingerprint of the key is bound into the build cache key (see the Dockerfile
# comment above the secret mount). BuildKit does not hash secret content, so
# without it a rebuild after a rotation would reuse a layer that still holds the
# old key and the gate would reject a build that looks correct. The same value is
# what the gate compares against, so it is computed once.
if ! expected="$(node "$ROOT/scripts/ci/server-action-key-fingerprint.mjs" "$KEY_FILE")"; then
  echo "[key-gate] ${KEY_FILE} does not contain a valid Server Action key" >&2
  exit 2
fi

# Everything private lives in one 0700 directory. The build log is 0600, the
# extracted source context is only readable by this user, and the directory is
# removed on every exit path. BUILD_EVIDENCE_DIR, when set, receives the
# source/identity records before the temporary directory is removed.
BUILD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/beaconhs-build.XXXXXX")"
chmod 700 "$BUILD_DIR"
BUILD_LOG="$BUILD_DIR/build.log"
: >"$BUILD_LOG"
chmod 600 "$BUILD_LOG"
CONTEXT_DIR="$BUILD_DIR/context"
mkdir -p "$CONTEXT_DIR"
chmod 700 "$CONTEXT_DIR"

copy_evidence() {
  [ -n "$BUILD_EVIDENCE_DIR" ] || return 0
  mkdir -p "$BUILD_EVIDENCE_DIR" || return 1
  chmod 700 "$BUILD_EVIDENCE_DIR" 2>/dev/null || true
  for file in build.log source-identity.json source-manifest.json image-inspect.json embedded-identity.json; do
    [ -f "$BUILD_DIR/$file" ] && cp -f "$BUILD_DIR/$file" "$BUILD_EVIDENCE_DIR/$file" 2>/dev/null || true
  done
}

cleanup() {
  copy_evidence || true
  rm -rf "$BUILD_DIR"
}
trap cleanup EXIT

echo "[source-identity] archive=${SOURCE_CONTEXT_ARCHIVE}"
echo "[source-identity] release=${RELEASE_ID}"

# Refuse archives that could write outside the extraction directory or that
# contain material which must never enter an image layer.
if ! tar "${TAR_LIST[@]}" "$SOURCE_CONTEXT_ARCHIVE" >"$BUILD_DIR/archive.list" 2>"$BUILD_DIR/archive.err"; then
  fail "source archive cannot be read: $(tr '\n' ' ' <"$BUILD_DIR/archive.err")"
fi
if grep -Eq '(^/|(^|/)\.\.(/|$))' "$BUILD_DIR/archive.list"; then
  fail 'source archive contains an absolute or traversal path'
fi
if grep -Eq '(^|/)\.(env|env\.orig|env\.prod-verify)$|(^|/)node_modules(/|$)|(^|/)\.git(/|$)' "$BUILD_DIR/archive.list"; then
  fail 'source archive contains a secret, VCS or dependency directory'
fi

if ! tar "${TAR_EXTRACT[@]}" "$SOURCE_CONTEXT_ARCHIVE" -C "$CONTEXT_DIR" 2>"$BUILD_DIR/extract.err"; then
  fail "source archive cannot be extracted: $(tr '\n' ' ' <"$BUILD_DIR/extract.err")"
fi
for required_file in Dockerfile pnpm-lock.yaml .dockerignore; do
  [ -r "$CONTEXT_DIR/$required_file" ] || fail "source archive is missing '$required_file'"
done

archive_files="$(grep -vc '/$' "$BUILD_DIR/archive.list" || true)"
archive_files="${archive_files//[[:space:]]/}"
extracted_files="$(find "$CONTEXT_DIR" -mindepth 1 ! -type d | wc -l | tr -d '[:space:]')"
[ "$archive_files" = "$extracted_files" ] \
  || fail "archive file count (${archive_files}) does not match extracted count (${extracted_files})"

IDENTITY_JSON="$BUILD_DIR/source-identity.json"
if ! node "$ROOT/scripts/ci/source-deployment-id.mjs" \
  --archive "$SOURCE_CONTEXT_ARCHIVE" \
  --release "$RELEASE_ID" \
  --manifest "$BUILD_DIR/source-manifest.json" \
  --json >"$IDENTITY_JSON"; then
  fail 'source deployment identity could not be derived'
fi

DEPLOYMENT_ID="$(jq -er '.deployment_id' "$IDENTITY_JSON")"
ARCHIVE_SHA="$(jq -er '.source_archive.sha256' "$IDENTITY_JSON")"
GIT_HEAD="$(jq -r '.git_head // empty' "$IDENTITY_JSON")"

[[ "$DEPLOYMENT_ID" =~ ^[0-9a-f]{40}$ ]] || fail "derived deployment id '${DEPLOYMENT_ID}' is malformed"
[[ "$ARCHIVE_SHA" =~ ^[0-9a-f]{64}$ ]] || fail "archive SHA-256 '${ARCHIVE_SHA}' is malformed"
[ "$(sha256sum "$SOURCE_CONTEXT_ARCHIVE" | cut -d' ' -f1)" = "$ARCHIVE_SHA" ] \
  || fail 'archive changed after the source identity was derived'

echo "[source-identity] archive_sha256=${ARCHIVE_SHA}"
echo "[source-identity] deployment_id=${DEPLOYMENT_ID}"
echo "[source-identity] git_head=${GIT_HEAD:-unknown}"

if [ "${PREPARE_ONLY:-0}" = "1" ]; then
  echo "[source-identity] PREPARE ONLY — stopping before docker build"
  copy_evidence
  exit 0
fi

label_args=(
  --label "com.beaconhs.deployment-id=${DEPLOYMENT_ID}"
  --label "com.beaconhs.source-archive-sha256=${ARCHIVE_SHA}"
)
if [ -n "$GIT_HEAD" ]; then
  label_args+=(--label "com.beaconhs.git-head=${GIT_HEAD}")
fi

echo "[build] building ${IMAGE} from the verified source archive"
if ! DOCKER_BUILDKIT=1 docker build \
  --secret id=next_server_actions_key,src="$KEY_FILE" \
  --build-arg DEPLOYMENT_VERSION="$DEPLOYMENT_ID" \
  --build-arg NEXT_SERVER_ACTIONS_KEY_FINGERPRINT="$expected" \
  --build-arg NEXT_PUBLIC_SENTRY_DSN="" \
  "${label_args[@]}" \
  --tag "$IMAGE" \
  --file "$CONTEXT_DIR/Dockerfile" \
  "$CONTEXT_DIR" >"$BUILD_LOG" 2>&1; then
  echo "[build] image build FAILED; last 20 lines of the build log:" >&2
  tail -20 "$BUILD_LOG" >&2
  exit 1
fi

# The key must not have leaked into the build log, image config or history. Use
# the key file as a fixed-pattern list so the value is never placed on a command
# line or printed.
if grep -qF -f "$KEY_FILE" "$BUILD_LOG"; then
  echo "[key-gate] the Server Action key appears in the build log" >&2
  exit 1
fi

if ! docker image inspect "$IMAGE" >"$BUILD_DIR/image-inspect.json" 2>/dev/null; then
  echo "[build] could not inspect the built image" >&2
  exit 1
fi
docker history --no-trunc "$IMAGE" >"$BUILD_DIR/history.txt" 2>/dev/null || true
if grep -qF -f "$KEY_FILE" "$BUILD_DIR/image-inspect.json" "$BUILD_DIR/history.txt"; then
  echo "[key-gate] the Server Action key appears in the image config or history" >&2
  exit 1
fi

actual_deployment_id="$(jq -r '.[0].Config.Labels["com.beaconhs.deployment-id"] // ""' "$BUILD_DIR/image-inspect.json")"
actual_archive_sha="$(jq -r '.[0].Config.Labels["com.beaconhs.source-archive-sha256"] // ""' "$BUILD_DIR/image-inspect.json")"
if [ "$actual_deployment_id" != "$DEPLOYMENT_ID" ]; then
  echo "[source-identity] image deployment-id label is '${actual_deployment_id:-<none>}', expected '${DEPLOYMENT_ID}'" >&2
  exit 1
fi
if [ "$actual_archive_sha" != "$ARCHIVE_SHA" ]; then
  echo "[source-identity] image source-archive label is '${actual_archive_sha:-<none>}', expected '${ARCHIVE_SHA}'" >&2
  exit 1
fi

# Read the Next.js deploymentId back out of the image. The value must equal the
# archive-derived id: a label alone is not evidence that the application was
# built with it.
if ! node "$ROOT/scripts/ci/verify-image-identity.mjs" \
  --image "$IMAGE" \
  --expect "$DEPLOYMENT_ID" \
  --json >"$BUILD_DIR/embedded-identity.json"; then
  echo "[source-identity] embedded Next.js deploymentId does not match the source archive" >&2
  cat "$BUILD_DIR/embedded-identity.json" >&2 || true
  exit 1
fi

# Read the embedded key back out of the finished image and compare fingerprints
# through the shared gate (`image` mode). It copies only the server-reference
# manifest out of a non-running container and removes every temporary file; the
# key never leaves the image in clear.
GATE="$ROOT/scripts/ci/verify-server-action-key-gate.sh"
if "$GATE" image "$IMAGE" "$expected"; then
  echo "[key-gate] PASS ${IMAGE} embeds the expected Server Action key"
  echo "[key-gate] fingerprint=${expected}"
  echo "[source-identity] PASS ${IMAGE} matches archive ${ARCHIVE_SHA} and deployment id ${DEPLOYMENT_ID}"
  exit 0
else
  status=$?
  echo "[key-gate] FAIL ${IMAGE} embeds a DIFFERENT Server Action key" >&2
  echo "[key-gate] expected=${expected}" >&2
  exit "$status"
fi
