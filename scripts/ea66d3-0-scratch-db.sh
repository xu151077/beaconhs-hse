#!/usr/bin/env bash
# Prepare an ISOLATED scratch database for the first-run setup integration test.
#
# It never touches a deployment's own database: the container is started with its
# own anonymous volume on a dedicated port, the five BeaconHS roles are created
# from the REAL scripts/cluster/provision.sql, and the real migration runner
# applies the real journal. The suite then observes the real guards.
#
# Usage: scripts/ea66d3-0-scratch-db.sh up|down|env
set -euo pipefail

CONTAINER="ea66d3-0-scratch-pg"
PORT="55433"
DB="beaconhs"
PASSWORD="scratch_only_not_a_real_credential"

case "${1:-up}" in
  up)
    echo "starting the isolated scratch postgres on 127.0.0.1:${PORT}"
    docker run -d --name "$CONTAINER" \
      -e POSTGRES_PASSWORD="$PASSWORD" \
      -p "127.0.0.1:${PORT}:5432" \
      postgres:16-alpine >/dev/null
    for _ in $(seq 1 30); do
      if docker exec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1; then break; fi
      sleep 1
    done
    docker exec "$CONTAINER" createdb -U postgres "$DB"
    echo "✓ scratch database '${DB}' created"

    # The five roles come from the REAL provisioning script, so the test runs
    # against the same role attributes production has.
    docker exec -i "$CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
      -v app_password="$PASSWORD" \
      -v super_password="$PASSWORD" \
      -v migrator_password="$PASSWORD" \
      -v backup_password="$PASSWORD" \
      -f - < "$(dirname "$0")/../scripts/cluster/provision.sql" >/dev/null
    echo "✓ roles provisioned"

    # The real migration runner, with the owner-capable login.
    MIGRATION_DATABASE_URL="postgresql://beaconhs_migrator:${PASSWORD}@127.0.0.1:${PORT}/${DB}" \
    DATABASE_URL="postgresql://beaconhs_app:${PASSWORD}@127.0.0.1:${PORT}/${DB}" \
    SUPERADMIN_DATABASE_URL="postgresql://beaconhs_super:${PASSWORD}@127.0.0.1:${PORT}/${DB}" \
    DATABASE_OWNER_ROLE="beaconhs_owner" \
    DATABASE_BACKUP_ROLE="beaconhs_backup" \
      # `tsx` is a dependency of packages/db, not of the repo root, so it is
      # resolved through the workspace package that owns it.
      pnpm --filter @beaconhs/db exec tsx src/migrate.ts >/dev/null
    echo "✓ migrations applied"
    ;;
  down)
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
    echo "✓ scratch postgres removed"
    ;;
  env)
    echo "SEED_TEST_SCRATCH_DATABASE_URL=postgresql://beaconhs_app:${PASSWORD}@127.0.0.1:${PORT}/${DB}"
    echo "SEED_TEST_SCRATCH_SUPERADMIN_URL=postgresql://beaconhs_super:${PASSWORD}@127.0.0.1:${PORT}/${DB}"
    ;;
  *)
    echo "usage: $0 up|down|env" >&2
    exit 2
    ;;
esac
