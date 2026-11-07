#!/usr/bin/env bash
# cleanup-local-junk.sh — reclaim disk on the BeaconHS dev host WITHOUT touching
# anything that can lose data.
#
# What it never does (hard limits, by design):
#   - no `docker compose down -v`, no `docker volume rm`, no `docker volume prune`
#     (volumes may hold Postgres/MinIO data; they are never in scope)
#   - no `docker system prune` (that sweeps volumes too)
#   - no `git reset --hard/clean/restore/checkout` (never discards your work)
#   - no untracked-file deletion: personal/secret-adjacent files (`cosign.*`,
#     `.env*`, file `20`, compose backups) are listed for review, never removed
#   - no images referenced by any container (running OR stopped) are removed
#
# Default mode is DRY-RUN: it prints what would be removed and how much space
# each category would free, and deletes nothing. To actually delete:
#
#   scripts/cleanup-local-junk.sh --execute --categories cache,docker-cache
#
# Add `--yes` to skip the interactive confirmation. Category `evidence` and
# `node-modules` are opt-in (they are not part of `all` by default thinking;
# request them explicitly by name).
#
# Categories:
#   cache         Turbo cache + Next.js build output + untracked dist/build
#                 dirs + coverage/tsbuildinfo + .tmp-* scratch + MCP logs.
#                 Regenerates fully with `pnpm build`. Low risk.
#   docker-cache  Docker builder cache only (`docker builder prune -f`).
#                 Images and volumes untouched. Low risk.
#   docker-images Old `beaconhs:*` image tags (keeps the newest 3 and anything
#                 referenced by containers). Interactive per-image list.
#   evidence      docs/evidence/**/*.tar.zst source archives (rebuildable
#                 from git with scripts/ci/build-source-context-archive.mjs)
#                 and per-phase build output dirs. Opt-in; review the list.
#   node-modules  Root + workspace node_modules. Reinstall with `pnpm install`.
#                 Opt-in.
#
# The script is idempotent: run it twice, the second run finds nothing.

set -uo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || { echo "cannot cd to $REPO_ROOT" >&2; exit 1; }

EXECUTE=0
YES=0
CATEGORIES="cache,docker-cache"

usage() {
  sed -n '2,40p' "$0"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --execute) EXECUTE=1 ;;
    --yes) YES=1 ;;
    --categories) CATEGORIES="${2:?--categories needs a value}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage; exit 2 ;;
  esac
  shift
done

has_category() {
  case ",$CATEGORIES," in
    *",$1,"*) return 0 ;;
    *) return 1 ;;
  esac
}

confirm() {
  # $1 = human label. Without --yes, require typing "yes".
  if [ "$YES" = 1 ]; then return 0; fi
  printf 'Proceed with: %s [type "yes"]: ' "$1"
  read -r answer
  [ "$answer" = "yes" ]
}

human_size() {
  # du-style human size for a path; 0 when missing (single command, no pipe
  # into $?, per shell hygiene rules).
  if [ -e "$1" ] || [ -L "$1" ]; then du -sh "$1" 2>/dev/null | cut -f1; else echo "0"; fi
}

EARLY_TOTAL=$(du -sh . 2>/dev/null | cut -f1)

echo "================================================================"
echo " BeaconHS local cleanup  (repo: $REPO_ROOT)"
if [ "$EXECUTE" = 0 ]; then
  echo " MODE: DRY-RUN — nothing will be deleted. Add --execute to delete."
else
  echo " MODE: EXECUTE — deletions WILL happen (see categories)."
fi
echo " Categories: $CATEGORIES"
df -h "$REPO_ROOT" | tail -1
echo "================================================================"

# --------------------------------------------------------------------------
# Category: cache (regenerable build artifacts + scratch)
# --------------------------------------------------------------------------
if has_category cache; then
  echo
  echo "--- cache ---"
  TOTAL=0
  for dir in .turbo apps/web/.next apps/worker/.next; do
    if [ -d "$dir" ]; then
      echo "  would remove: $dir ($(human_size "$dir"))"
      if [ "$EXECUTE" = 1 ]; then rm -rf -- "$dir" && echo "    removed"; fi
    fi
  done
  # Untracked dist/build dirs only: a dir is deleted only when git does not
  # track any file under it (git ls-files <dir> empty).
  while IFS= read -r dir; do
    if [ -z "$(git ls-files "$dir" 2>/dev/null)" ]; then
      echo "  would remove: $dir ($(human_size "$dir")) [untracked build output]"
      if [ "$EXECUTE" = 1 ]; then rm -rf -- "$dir" && echo "    removed"; fi
    fi
  done < <(find . -type d \( -name dist -o -name build \) \
    -not -path "*/node_modules/*" -not -path "./docs/evidence/*" 2>/dev/null)
  for dir in coverage .nyc_output; do
    if [ -d "$dir" ]; then
      echo "  would remove: $dir ($(human_size "$dir"))"
      if [ "$EXECUTE" = 1 ]; then rm -rf -- "$dir" && echo "    removed"; fi
    fi
  done
  find . -maxdepth 4 -name "*.tsbuildinfo" -not -path "*/node_modules/*" 2>/dev/null | while read -r f; do
    echo "  would remove: $f"
    if [ "$EXECUTE" = 1 ]; then rm -f -- "$f" && echo "    removed"; fi
  done
  for dir in .tmp-cf .tmp-cj .tmp-ck .tmp-e2e .playwright-mcp; do
    if [ -d "$dir" ]; then
      echo "  would remove: $dir ($(human_size "$dir")) [operator scratch]"
      if [ "$EXECUTE" = 1 ]; then rm -rf -- "$dir" && echo "    removed"; fi
    fi
  done
  echo "  after: repo size now $(du -sh . 2>/dev/null | cut -f1) (was $EARLY_TOTAL)"
fi

# --------------------------------------------------------------------------
# Category: docker-cache (builder cache only)
# --------------------------------------------------------------------------
if has_category docker-cache; then
  echo
  echo "--- docker-cache ---"
  docker system df --format '  {{.Type}}: {{.Size}} (reclaimable {{.Reclaimable}})' 2>/dev/null \
    | grep -E "Build Cache|Images" || echo "  (docker unavailable)"
  if [ "$EXECUTE" = 1 ]; then
    if confirm "docker builder prune -f (build cache only; images/volumes untouched)"; then
      docker builder prune -f 2>&1 | tail -3
    else
      echo "  skipped"
    fi
  fi
fi

# --------------------------------------------------------------------------
# Category: docker-images (old beaconhs tags; keep newest 3 + in-use)
# --------------------------------------------------------------------------
if has_category docker-images; then
  echo
  echo "--- docker-images ---"
  IN_USE=$(docker ps -a --format '{{.Image}}' 2>/dev/null | sort -u)
  # Newest 3 beaconhs:* tags by creation are always kept.
  CANDIDATES=$(docker images beaconhs --format '{{.Repository}}:{{.Tag}} {{.CreatedAt}}' 2>/dev/null \
    | sort -k2 -r | awk 'NR>3 {print $1}')
  if [ -z "$CANDIDATES" ]; then
    echo "  no removable beaconhs images (newest 3 kept)"
  fi
  while IFS= read -r ref; do
    [ -n "$ref" ] || continue
    case "$IN_USE" in
      *"$ref"*) echo "  KEEP (referenced by a container): $ref"; continue ;;
    esac
    SIZE=$(docker image inspect "$ref" --format '{{.Size}}' 2>/dev/null || echo "")
    echo "  candidate: $ref size=$SIZE"
    if [ "$EXECUTE" = 1 ]; then
      confirm "remove image $ref" || { echo "    kept"; continue; }
      docker rmi "$ref" 2>&1 | tail -1 || echo "    rmi failed (in use? kept)"
    fi
  done <<EOF
$CANDIDATES
EOF
fi

# --------------------------------------------------------------------------
# Category: evidence (source archives + phase build dirs; opt-in)
# --------------------------------------------------------------------------
if has_category evidence; then
  echo
  echo "--- evidence (opt-in; source archives are rebuildable from git) ---"
  find docs/evidence -type f -name "*.tar.zst" 2>/dev/null | while read -r f; do
    echo "  would remove: $f ($(human_size "$f"))"
    if [ "$EXECUTE" = 1 ]; then rm -f -- "$f" && echo "    removed"; fi
  done
  while IFS= read -r dir; do
    echo "  would remove: $dir ($(human_size "$dir"))"
    if [ "$EXECUTE" = 1 ]; then rm -rf -- "$dir" && echo "    removed"; fi
  done < <(find docs/evidence -type d -name build 2>/dev/null)
fi

# --------------------------------------------------------------------------
# Category: node-modules (opt-in)
# --------------------------------------------------------------------------
if has_category node-modules; then
  echo
  echo "--- node-modules (opt-in; reinstall: pnpm install) ---"
  for dir in node_modules apps/worker/node_modules apps/web/node_modules packages/db/node_modules; do
    if [ -d "$dir" ]; then
      echo "  would remove: $dir ($(human_size "$dir"))"
      if [ "$EXECUTE" = 1 ]; then rm -rf -- "$dir" && echo "    removed"; fi
    fi
  done
fi

# --------------------------------------------------------------------------
# Review list: untracked personal/local files (never deleted by this script)
# --------------------------------------------------------------------------
echo
echo "--- untracked local files — REVIEW ONLY, never deleted here ---"
git status --porcelain=v1 -uall 2>/dev/null | grep '^??' | grep -vE "docs/evidence/|^.. \.tmp-" || true
echo
echo "Volumes are never touched by this script (no volume commands run)."
echo "================================================================"
df -h "$REPO_ROOT" | tail -1
echo "Done."
