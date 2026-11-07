#!/usr/bin/env bash
# Phase EA-4 / EA-5 — isolated acceptance tests for the local key-gate build entry point.
#
# These cover the failure paths without building an image, and the success path
# against an image this test builds itself. No key material is printed: the only
# value that reaches the terminal is the 128-bit fingerprint the gate emits.
#
# Phase EA-5: check 7 no longer rebuilds the image with a second key. That relied
# on BuildKit serving a cached layer built with the first key, which made the
# result depend on cache state (it inverted on a cold runner). The image is now
# built once and the SHARED gate is asked to certify it against a different key,
# which is the real deployment check and is cache-independent.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BUILD="$ROOT/scripts/build-local-image-with-key-gate.sh"
GATE="$ROOT/scripts/ci/verify-server-action-key-gate.sh"
FINGERPRINT="$ROOT/scripts/ci/server-action-key-fingerprint.mjs"
WORK="$(mktemp -d)"
IMAGE="beaconhs:ea4-gate-selftest"
trap 'rm -rf "$WORK"' EXIT

# EA-66B.1: the build entry point now takes a source archive and preserves the
# source manifest/build log in BUILD_EVIDENCE_DIR. This test creates a plain-tar
# context with the same production exclusions as `.dockerignore` plus the
# operator/evidence directories, so it does not depend on an untracked EA-66B
# evidence archive being present in CI.
SOURCE_CONTEXT_ARCHIVE="$WORK/source-context.tar"
BUILD_EVIDENCE_DIR="$WORK/evidence"
export SOURCE_CONTEXT_ARCHIVE BUILD_EVIDENCE_DIR
tar \
  --exclude='./.git' --exclude='./.github' \
  --exclude='**/node_modules' --exclude='**/.next' --exclude='**/.turbo' \
  --exclude='**/dist' --exclude='**/.vercel' \
  --exclude='./.env' --exclude='./.env.orig' --exclude='./.env.prod-verify' \
  --exclude='**/*.log' --exclude='./.claude' --exclude='./.vscode' \
  --exclude='./.idea' --exclude='./.DS_Store' \
  --exclude='./docs/evidence' --exclude='./.playwright-mcp' \
  --exclude='./.tmp-*' --exclude='./.scratchpad' \
  --exclude='./docs/migration/*.json' --exclude='./packages/etl' \
  --exclude='./.local' --exclude='./private' \
  --exclude='./packages/db/src/scripts/dokploy-*' --exclude='./.docker' \
  --exclude='*.bak' --exclude='*.backup' --exclude='*.before-pat-test' \
  --exclude='**/coverage' --exclude='**/playwright-report' --exclude='**/test-results' \
  -cf "$SOURCE_CONTEXT_ARCHIVE" -C "$ROOT" .

pass=0
fail=0
ok() { pass=$((pass + 1)); echo "ok $((pass + fail)) - $1"; }
not_ok() { fail=$((fail + 1)); echo "not ok $((pass + fail)) - $1" >&2; }

# A 44-byte base64 key (32 raw bytes), created with mode 600 outside the repo.
KEY="$WORK/valid.key"
(umask 077; openssl rand -base64 32 > "$KEY")
chmod 600 "$KEY"

# 1. Missing key file must fail closed, not fall back to a dev default.
set +e
NEXT_SERVER_ACTIONS_KEY_FILE="$WORK/absent.key" "$BUILD" >"$WORK/out1" 2>&1
code=$?
set -e
if [ "$code" -eq 2 ] && grep -q "missing or unreadable" "$WORK/out1"; then
  ok "a missing key file fails closed"
else
  not_ok "a missing key file must exit 2 with a clear reason (got $code)"
fi

# 2. Wrong permissions must fail closed.
cp "$KEY" "$WORK/loose.key"
chmod 644 "$WORK/loose.key"
set +e
NEXT_SERVER_ACTIONS_KEY_FILE="$WORK/loose.key" "$BUILD" >"$WORK/out2" 2>&1
code=$?
set -e
if [ "$code" -eq 2 ] && grep -q "must be mode 600" "$WORK/out2"; then
  ok "a world-readable key file fails closed"
else
  not_ok "a non-0600 key file must exit 2 (got $code)"
fi

# 3. An INVALID key must fail closed BEFORE any build starts. The fingerprint is
# now computed before the build (it is bound into the build cache key), so this
# costs nothing and must not reach Docker at all.
printf 'not-a-valid-key' > "$WORK/invalid.key"
chmod 600 "$WORK/invalid.key"
set +e
NEXT_SERVER_ACTIONS_KEY_FILE="$WORK/invalid.key" "$BUILD" "$IMAGE" >"$WORK/out3" 2>&1
code=$?
set -e
if [ "$code" -eq 2 ] && grep -q "does not contain a valid Server Action key" "$WORK/out3"; then
  ok "an invalid key fails closed before the build"
else
  not_ok "an invalid key must exit 2 before building (got $code)"
fi

# 4. The failure-path outputs must never contain the key material.
leak=0
for f in "$WORK/out1" "$WORK/out2" "$WORK/out3"; do
  if grep -Fq -- "$(cat "$KEY")" "$f" 2>/dev/null; then leak=1; fi
done
if [ "$leak" -eq 0 ]; then
  ok "no key material appears in the failure-path output"
else
  not_ok "the script printed key material"
fi

# 5. Success path: build a real image with a key WE hold, then certify it.
# This is the only honest "PASS" case — an image whose key we do not hold must
# never be certified, and check 7 covers that.
docker image rm -f "$IMAGE" >/dev/null 2>&1 || true
set +e
NEXT_SERVER_ACTIONS_KEY_FILE="$KEY" "$BUILD" "$IMAGE" >"$WORK/out5" 2>&1
code=$?
set -e
if [ "$code" -eq 0 ] && grep -q "PASS" "$WORK/out5"; then
  ok "an image built with this key passes the gate"
else
  not_ok "a self-built image must pass the gate (exit $code)"
  tail -5 "$WORK/out5" >&2
fi

# 6. The success path must never print the key either.
if grep -Fq -- "$(cat "$KEY")" "$WORK/out5" 2>/dev/null; then
  not_ok "the success path printed key material"
else
  ok "no key material appears in the success-path output"
fi

# 7. A DIFFERENT key must refuse the same image — the gate cannot be talked into
# certifying an image that holds another key. This is the check a deployment runs
# against an image pulled from a registry.
OTHER="$WORK/other.key"
(umask 077; openssl rand -base64 32 > "$OTHER")
chmod 600 "$OTHER"
other_fingerprint="$(node "$FINGERPRINT" "$OTHER")"
set +e
"$GATE" image "$IMAGE" "$other_fingerprint" >"$WORK/out7" 2>&1
code=$?
set -e
if [ "$code" -eq 1 ] && grep -q "fingerprint mismatch" "$WORK/out7"; then
  ok "an image built with a different key is refused"
else
  not_ok "a different key must refuse the image (exit $code)"
fi
if grep -Fq -- "$(cat "$OTHER")" "$WORK/out7" 2>/dev/null; then
  not_ok "the failure path printed key material"
else
  ok "no key material appears in the refusal-path output"
fi

docker image rm -f "$IMAGE" >/dev/null 2>&1 || true

echo "1..$((pass + fail))"
if [ "$fail" -ne 0 ]; then
  echo "$fail of $((pass + fail)) checks failed" >&2
  exit 1
fi
echo "all $pass checks passed"
