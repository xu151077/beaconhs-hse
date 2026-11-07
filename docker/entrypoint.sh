#!/usr/bin/env sh
set -e

case "${APP_ROLE:-web}" in
  web)
    exec node apps/web/server.js
    ;;
  worker)
    exec node apps/worker/dist/index.js
    ;;
  scheduler)
    exec node apps/worker/dist/scheduler.js
    ;;
  storage-init)
    exec node apps/worker/dist/storage-init.js
    ;;
  # Apply database migrations. Runs as a one-shot job, never as a long-lived
  # service. It is a SEPARATE deploy target (apps/ops-migrate) with its own
  # node_modules, so the migration driver never enters the worker runtime, and it
  # is the ONLY process that receives MIGRATION_DATABASE_URL. Exits non-zero on
  # failure so the deploy gate can refuse to start web, worker and scheduler
  # against an unmigrated schema. Arguments pass straight through to the CLI with
  # no eval/word-splitting of user input.
  migrate)
    exec node apps/ops-migrate/dist/migrate.js "$@"
    ;;
  # Create the first administrator. Dry-run unless --apply is passed explicitly.
  # Separate deploy target (apps/ops-bootstrap-admin): better-auth/bcryptjs/pg
  # live only here, not in the worker runtime. Supply a password via
  # --password-stdin (stdin), never as an argv value, so it never appears in the
  # process list or in a `docker logs`/compose command echo. Idempotent by design:
  # it never creates a second administrator and never overwrites an existing
  # password. Never runs db:seed.
  bootstrap-admin)
    exec node apps/ops-bootstrap-admin/dist/bootstrap-admin.cli.js "$@"
    ;;
  *)
    echo "Unknown APP_ROLE: ${APP_ROLE}" >&2
    echo "Expected one of: web, worker, scheduler, storage-init, migrate, bootstrap-admin" >&2
    exit 1
    ;;
esac
