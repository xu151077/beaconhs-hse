#!/usr/bin/env bash
# Promote a verified build to its release tag without changing its digest.
#
# Why this exists as a script: publication must happen only after the built
# artefact's identity has been asserted, and the promoted reference must be
# provably the same bytes that were asserted. `docker buildx imagetools create`
# performs a server-side manifest copy, so the digest is preserved — but that is
# an assumption until it is checked, so this verifies it and fails otherwise.
#
# Usage: promote-verified-image.sh <repository> <index-digest> <release-ref>
#   e.g. promote-verified-image.sh ghcr.io/org/beaconhs sha256:...:  ghcr.io/org/beaconhs:51a899b7
#
# Prints the digest on success. Exits non-zero for any unusable input or any
# digest change; there is no warning path.
set -euo pipefail

repo="${1:-}"
digest="${2:-}"
release_ref="${3:-}"

if [ -z "$repo" ] || [ -z "$digest" ] || [ -z "$release_ref" ]; then
  echo "usage: promote-verified-image.sh <repository> <index-digest> <release-ref>" >&2
  exit 2
fi

if ! [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "::error::refusing to promote: '$digest' is not a canonical sha256 digest" >&2
  exit 1
fi

if ! [[ "$release_ref" =~ ^[^:]+(:[0-9]+)?/[^:@]+:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]]; then
  echo "::error::refusing to promote: '$release_ref' is not a plain tag reference" >&2
  exit 1
fi

docker buildx imagetools create -t "$release_ref" "${repo}@${digest}"

# Read the reference back and prove the promotion did not re-encode anything.
promoted="$(docker buildx imagetools inspect "$release_ref" \
  | awk '/^Digest:/{print $2; exit}')"
if [ "$promoted" != "$digest" ]; then
  echo "::error::promotion changed the digest: built=$digest promoted=${promoted:-<none>}" >&2
  exit 1
fi

echo "$digest"
