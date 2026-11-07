# Backup and restore runbook (local rehearsal)

Audience: an operator rehearsing or performing a BeaconHS recovery on a
**disposable local stack**. Nothing here authorises a production restore; the
production run must be executed under its own change control with the real
secret manager and the real object store.

Every command below was exercised in Phases EA-9 and EA-10. Where a step is
mandatory because skipping it produces a _healthy-looking but unusable_
database, that is called out.

---

## 1. What the tools are

| Concern                                       | Tool                                                               | Notes                                                                                        |
| --------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Database dump                                 | `scripts/cluster/backup.sh`                                        | Custom-format `pg_dump`, writes `.dump`, `.dump.sha256`, `.dump.manifest.tsv` with mode 0600 |
| Database restore + verification               | `scripts/cluster/restore-verify.sh`                                | Restores with `--role=<owner>`, verifies ownership, manifest metrics and unvalidated FKs     |
| Object store backup / verify / restore / diff | `packages/object-store-backup` (`cli.ts`)                          | Plaintext (format 1) or age-encrypted + HMAC (format 2)                                      |
| Schema compatibility at runtime               | `apps/web/src/lib/schema-compatibility.ts` via `/api/health/ready` | Reuses the migrator's own ledger rules                                                       |
| Migrations and least-privilege grants         | `packages/db/src/migrate.ts` (`pnpm db:migrate`)                   | Forward-only; also the **only** supported way to reapply runtime grants after a restore      |

### Roles

- `beaconhs_owner` — NOLOGIN owner of the schema. Restores must land objects on
  this role (`restore-verify.sh --role`), or the migrator refuses the database.
- `beaconhs_migrator` — login used for DDL; member of `beaconhs_owner`.
- `beaconhs_app` / `beaconhs_super` — runtime roles. They hold `SELECT` on
  `drizzle.*` **only** because the migrator grants it; a restore does not.
- A backup login — `LOGIN`, `NOSUPERUSER`, `BYPASSRLS`,
  `default_transaction_read_only=on`. `backup.sh` refuses anything else, so a
  shared role cannot be reused.

---

## 2. Before you start

1. Confirm you are pointed at the intended stack:
   `docker ps --format '{{.Names}}'` and the `PGHOST`/`PGDATABASE` you are about
   to pass. An object-store or database drill that cannot prove isolation must
   stop here.
2. Confirm free space for the dump plus the restored copy (roughly 2× the
   database size) and for the object backup.
3. Confirm the encryption tools exist **on the machine that will run the tool**:
   `command -v age age-keygen` for format 2. `age` lives on `PATH`; the tool
   refuses to fall back to plaintext when it is missing.
4. Confirm the runtime image you will start afterwards is the build you intend:
   the Server Action key gate is the cheapest proof —
   `scripts/ci/verify-server-action-key-gate.sh image <image> <fingerprint>`.
5. Record the RPO target now. "The backup we have" is not an RPO.

---

## 3. Back up

### 3.1 Database

```sh
PGHOST=… PGPORT=… PGDATABASE=… PGUSER=<backup login> PGPASSWORD=… \
DATABASE_BACKUP_ROLE=<backup login> \
  scripts/cluster/backup.sh /secure/backup/dir
```

- Encrypted output is the default. `BACKUP_AGE_RECIPIENT` selects the public key;
  the command refuses to write plaintext unless
  `BACKUP_ALLOW_PLAINTEXT=true`, which exists for **disposable drills only**.
- Keep the `.sha256` and `.manifest.tsv` next to the dump; the restore verifies
  both.
- Record from the manifest: `migration_rows`, `public_tables`, `forced_rls_tables`,
  `tenant_policies`, `tenants`, `database_size_bytes`, plus the dump size and
  SHA-256. These become the acceptance numbers for the restore.

### 3.2 Object store

```sh
OBJECT_STORE_ENDPOINT=… OBJECT_STORE_BUCKET=… \
OBJECT_STORE_ACCESS_KEY_ID=… OBJECT_STORE_SECRET_ACCESS_KEY=… \
[BACKUP_AGE_RECIPIENT=… BACKUP_HMAC_KEY_FILE=…] \
  pnpm --filter @beaconhs/object-store-backup exec tsx src/cli.ts \
  backup --destination /secure/backup/objects [--encrypt] [--create-bucket]
```

- `--encrypt` writes `manifest.json.enc`, `backup.hmac`, `objects/<sha256>.age`,
  `checkpoint.json.enc`. There is **no** plaintext manifest in that mode; if you
  see one, the backup is not what it claims to be.
- The HMAC key is not written into the backup directory. Store it separately and
  with mode 0600 — the tool refuses a key file that group or others can read.
- Credentials come from the environment, never from flags.

### 3.3 Verify before you trust it

```sh
pnpm --filter @beaconhs/object-store-backup exec tsx src/cli.ts \
  verify --backup-dir /secure/backup/objects --strict
```

`verify` must print `backup is intact`. A non-zero exit is a stop condition —
do not restore from a backup that failed verification.

---

## 4. Restore

### 4.1 Order

1. **Stop writers.** Take the web/worker/scheduler containers out of service and
   put the tenant into the storage freeze state if the tooling cannot otherwise
   prevent writes. A restore performed under live writes produces a database
   that is neither the backup nor the present.
2. **Restore the database** (§4.2). It defines which attachment rows and object
   keys must exist.
3. **Reapply runtime grants** (§4.3). Skipping this yields a database where the
   application cannot read a single table.
4. **Restore the object store** (§4.4), then compare it against the database's
   attachment rows (§4.5).
5. **Start one instance and check readiness** (§4.6) before returning traffic.
6. **Unfreeze and smoke-test** the workflows that read attachments.

### 4.2 Database

```sh
PGHOST=… PGPORT=… PGDATABASE=postgres \
PGUSER=<postgres administrator> PGPASSWORD=… \
DATABASE_OWNER_ROLE=beaconhs_owner KEEP_RESTORE_DB=true \
  scripts/cluster/restore-verify.sh /secure/backup/dir/beaconhs-<ts>.dump
```

- `PGUSER` must be an **administrator on the restore cluster** (the script's own
  contract). `beaconhs_migrator` is not one: it cannot create databases, and its
  verification query cannot read `drizzle.*` after the restore reassigns
  ownership.
- The script restores into a **new** database named
  `beaconhs_restore_<timestamp>_<pid>` and never touches an existing one.
  `KEEP_RESTORE_DB=true` keeps it for the next steps; without it the script drops
  it.
- It fails on: checksum mismatch, wrong object owner, any manifest metric
  mismatch, or unvalidated foreign keys. Treat any of those as a stop condition.
- `--no-privileges` is deliberate: privileges are rebuilt by the migrator, not
  copied from an old cluster.

### 4.3 Reapply grants (mandatory)

```sh
MIGRATION_DATABASE_URL=…/<restored-db> \
DATABASE_URL=…/<restored-db> \
SUPERADMIN_DATABASE_URL=…/<restored-db> \
  pnpm db:migrate
```

Expected output: `0 pending` (the restored ledger is already current),
`RLS applied`, and `Least-privilege grants applied`. Without this step:

- `beaconhs_app` has no `SELECT` on application tables, and
- `/api/health/ready` returns **503** because it cannot read the migration ledger.

Phase EA-10 reproduced exactly that: the same dump that reports `ready` 200 after
the grant step reports 503 before it, with
`permission denied for schema drizzle` in the log.

### 4.4 Object store

```sh
OBJECT_STORE_ENDPOINT=… OBJECT_STORE_ACCESS_KEY_ID=… OBJECT_STORE_SECRET_ACCESS_KEY=… \
BACKUP_AGE_IDENTITY=… BACKUP_HMAC_KEY_FILE=… \
  pnpm --filter @beaconhs/object-store-backup exec tsx src/cli.ts \
  restore --backup-dir /secure/backup/objects \
  --bucket <target> [--create-target-bucket] [--overwrite] \
  --public-endpoint <browser-reachable endpoint>
```

- Restore into a **new** bucket wherever the deployment allows it; the tool
  refuses to overwrite existing keys unless `--overwrite` is explicit.
- `restore` never deletes objects that the backup does not contain. It is not a
  mirror, and it will not remove objects written after the backup — reconcile
  those separately.
- The tool verifies what it wrote and runs anonymous/wrong-credential/presigned
  access checks before printing `RESTORE VERIFIED`.

### 4.5 Compare

- Re-run `backup` against the restored bucket into a scratch directory, then
  compare the two manifests by key, size, SHA-256 and `contentType`.
- `inventory --diff` refuses to compare **different buckets** on purpose (a
  cross-bucket diff has no meaning and would delete the wrong objects). Compare
  the two manifests directly instead.
- Confirm every `t/<tenant-uuid>/…` key still carries its tenant prefix, and that
  the attachment rows in the restored database resolve to keys that exist.

### 4.6 Readiness and version compatibility

```sh
curl -sS -w '\n%{http_code}\n' http://<instance>/api/health/ready
```

| Database vs running build          | Expected                                                             |
| ---------------------------------- | -------------------------------------------------------------------- |
| Matches the journal in the image   | `200` `{"status":"ready","version":"<commit>"}` and `[schema] match` |
| Behind (pending migrations)        | `200`, logged once as `[schema] pending`                             |
| Ahead of the build                 | **`503`**, `[schema] ahead …`                                        |
| Ledger unreadable / journal absent | **`503`** in production                                              |
| Database unreachable               | `503`                                                                |

The `version` field must equal the commit you intended to deploy. A 200 from a
different commit means the wrong image is running.

---

## 5. Stop conditions

Stop and do not declare recovery if any of these is true:

1. `verify` on the backup fails, or the dump checksum does not match.
2. `restore-verify.sh` reports a metric mismatch, wrong ownership, or
   unvalidated foreign keys.
3. The restored ledger count differs from the manifest's `migration_rows`.
4. Any object is missing, extra, or has a different SHA-256 than the manifest.
5. Readiness is 503 after the grant step, or reports a different `version`.
6. The object diff cannot be produced for a reason other than "different
   buckets" (which is refused by design).
7. You cannot prove the target is isolated from production.

Do not "fix" these by editing the migration ledger, disabling the freeze check,
or granting broader privileges than `migrate.ts` grants.

---

## 6. RPO / RTO record

For every rehearsal or recovery, record:

| Field                                       | How to obtain                                                                                                             |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Backup started / finished (UTC)             | `created_at_utc` in the dump manifest                                                                                     |
| RPO achieved                                | failure time − backup `created_at_utc`                                                                                    |
| Dump size and SHA-256                       | `.dump` file and `.sha256`                                                                                                |
| Restore start / end, duration               | wall clock around `restore-verify.sh` (EA-10 measured 4 s for a 1.1 MB drill dump on this host — not a production figure) |
| Grant step duration                         | wall clock around `pnpm db:migrate`                                                                                       |
| Readiness first 200                         | instance start time → first `200`                                                                                         |
| Object backup/restore size, count, duration | tool output                                                                                                               |
| Verification results                        | verify, manifest comparison, access checks                                                                                |

The RTO is the sum of the stages actually measured. Do not quote a figure from a
small drill as a production RTO.

---

## 7. Never roll the database backwards

- Migrations are **forward-only**. `packages/db/src/migrate.ts` refuses a
  database whose ledger is ahead of its checkout, and
  `/api/health/ready` refuses to report ready in the same situation.
- There is no down-migration path. Rolling a database back to an older schema
  means restoring an older dump — which loses everything written since that
  dump — and then running the **current** migrator forward again.
- Re-pinning an older image against a newer database is exactly the failure
  EA-8 found and EA-9 fixed: the image must be refused, not silently served.
- After any restore, run the current migrator. A restore is not complete until
  the ledger, the grants and readiness all agree.

---

## 8. Environment notes

- `restore-verify.sh` calls `sha256sum --check`. BusyBox `sha256sum` (Alpine)
  rejects the long option; run the script on a host with GNU coreutils, or use
  the `shasum`/`sha256sum` shims described in the EA-10 report. This is a
  portability wrinkle of the script, not a data problem.
- `age` is not bundled: it must be installed on the machine running the
  object-store tool. Debian/Ubuntu package it as `age`; the distro binary is
  sufficient (1.1.1 was used for the EA-10 drill).
- Object-store credentials are environment variables only; flags would put the
  secret in argv and shell history.
