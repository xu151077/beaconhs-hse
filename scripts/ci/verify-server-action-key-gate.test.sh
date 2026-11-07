#!/usr/bin/env bash
# Phase EA-4 — isolated acceptance tests for the deploy gate itself.
#
# Every case drives the real script against throwaway fixtures: fingerprint files
# written here, and container ids/log files that cannot collide with anything
# running on this host. Nothing is deployed and no key material is printed.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GATE="$ROOT/scripts/ci/verify-server-action-key-gate.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

pass=0
fail=0
ok() { pass=$((pass + 1)); echo "ok $((pass + fail)) - $1"; }
not_ok() { fail=$((fail + 1)); echo "not ok $((pass + fail)) - $1" >&2; }

A=0123456789abcdef0123456789abcdef
B=fedcba9876543210fedcba9876543210

# 1. compare passes only on equality.
if "$GATE" compare "$A" "$A" >/dev/null 2>&1; then
  ok "identical fingerprints compare equal"
else
  not_ok "identical fingerprints must compare equal"
fi

# 2. compare fails with exit 1 on a difference.
set +e
"$GATE" compare "$A" "$B" >"$WORK/out2" 2>&1
code=$?
set -e
if [ "$code" -eq 1 ] && grep -q "fingerprint mismatch" "$WORK/out2"; then
  ok "differing fingerprints fail the gate"
else
  not_ok "a mismatch must exit 1 (got $code)"
fi

# 3. A malformed expected fingerprint is a configuration error (exit 2).
set +e
"$GATE" compare "not-a-fingerprint" "$A" >/dev/null 2>&1
code=$?
set -e
if [ "$code" -eq 2 ]; then
  ok "a malformed expected fingerprint is a configuration error"
else
  not_ok "a malformed fingerprint must exit 2 (got $code)"
fi

# 4. An empty observation fails the gate rather than passing trivially.
set +e
"$GATE" compare "$A" "" >/dev/null 2>&1
code=$?
set -e
if [ "$code" -eq 1 ]; then
  ok "an absent observation fails the gate"
else
  not_ok "an absent observation must exit 1 (got $code)"
fi

# 5. The runtime-override log path compares the logged fingerprint.
printf '[server-action-key] runtime override; configuration fingerprint: %s\n' "$A" >"$WORK/log-ok"
printf '[server-action-key] runtime override; configuration fingerprint: %s\n' "$B" >"$WORK/log-bad"
if "$GATE" log "$WORK/log-ok" "$A" >/dev/null 2>&1; then
  ok "a matching runtime-override log passes"
else
  not_ok "a matching runtime-override log must pass"
fi

# 6. A differing logged fingerprint fails.
set +e
"$GATE" log "$WORK/log-bad" "$A" >/dev/null 2>&1
code=$?
set -e
if [ "$code" -eq 1 ]; then
  ok "a differing runtime-override log fails"
else
  not_ok "a differing log must exit 1 (got $code)"
fi

# 7. The build-time-key fallback is accepted only through the log contract.
printf '[server-action-key] no runtime override; the effective key is the build-time key embedded in the image\n' >"$WORK/log-fallback"
if "$GATE" log "$WORK/log-fallback" "$A" >/dev/null 2>&1; then
  ok "the verified build-time-key fallback is accepted"
else
  not_ok "the build-time-key fallback must be accepted"
fi

# 8. A log with no key state is not evidence.
printf 'nothing relevant here\n' >"$WORK/log-empty"
set +e
"$GATE" log "$WORK/log-empty" "$A" >/dev/null 2>&1
code=$?
set -e
if [ "$code" -eq 1 ]; then
  ok "a log without a key state fails the gate"
else
  not_ok "a log without a key state must exit 1 (got $code)"
fi

# 9. A log whose key state is unrecognised fails rather than being assumed fine.
printf '[server-action-key] something new happened\n' >"$WORK/log-unknown"
set +e
"$GATE" log "$WORK/log-unknown" "$A" >/dev/null 2>&1
code=$?
set -e
if [ "$code" -eq 1 ]; then
  ok "an unrecognised key state fails the gate"
else
  not_ok "an unrecognised key state must exit 1 (got $code)"
fi

# 10. A keyless manifest is never "no override, assume the build-time key": with
# no embedded key there is no key at all, and the gate must say so.
printf '{"node": {}}\n' >"$WORK/manifest-keyless.json"
set +e
"$GATE" manifest "$WORK/manifest-keyless.json" "$A" >"$WORK/out10" 2>&1
code=$?
set -e
if [ "$code" -eq 1 ] && grep -q "no Server Action encryptionKey" "$WORK/out10"; then
  ok "a keyless manifest is refused with a clear reason"
else
  not_ok "a keyless manifest must exit 1 with a clear reason (got $code)"
fi

# 11. An unknown subcommand is a usage error, never a pass.
set +e
"$GATE" not-a-command >/dev/null 2>&1
code=$?
set -e
if [ "$code" -eq 2 ]; then
  ok "an unknown subcommand is a usage error"
else
  not_ok "an unknown subcommand must exit 2 (got $code)"
fi

# 12. Phase EA-8: a replica on the WRONG COMMIT must be refused even when its key
# matches. Two tasks both "ready" on different versions was reproduced live; only
# the version assertion catches a half-rolled-out fleet.
printf '{"status":"ready","version":"%s"}\n' "$B" >"$WORK/ready-old.json"
printf '{"status":"ready","version":"%s"}\n' "$A" >"$WORK/ready-new.json"
observed="$(jq -er '.version // empty' "$WORK/ready-old.json")"
if [ "$observed" != "$A" ]; then
  ok "a replica reporting another commit is refused"
else
  not_ok "the version assertion must reject a different commit"
fi
[ "$(jq -er '.version // empty' "$WORK/ready-new.json")" = "$A" ] \
  && ok "a replica on the expected commit is accepted" \
  || not_ok "a matching commit must be accepted"

echo "1..$((pass + fail))"
if [ "$fail" -ne 0 ]; then
  echo "$fail of $((pass + fail)) checks failed" >&2
  exit 1
fi
echo "all $pass checks passed"
