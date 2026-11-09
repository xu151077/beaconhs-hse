# BeaconHS Release Readiness Checklist — 2026-11-09

Baseline `d06924d0` (all gates equal 0 at their commits: format, typecheck,
lint, test, deadcode, build — each verified after every code change this
session; the audit docs added after land no runtime code).

## Deployment order

| # | Step | Code/DB | Compatibility |
|---|---|---|---|
| 1 | `db:migrate` on target (applies **0055** + RLS + converge `people.pick` into built-ins) | DB | 0055's 9 drops / 1 add are safe either way: the app never references those constraints by name. |
| 2 | Deploy the code (v2 caps, PIN 6–12, picker gates all ship together) | app | v1 caps 404 the instant this lands — expected and intended. |
| 3 | **A3 apply** on the audited environment (writers drained, advisory lock) | data | Idempotent no-op in dev (0 refs); reviews the target's actual persisted refs. |
| 4 | **Verify** | — | rerun A3 audit → `pending = 0`; re-run `db:check:migration-drift`?; `docker` health + `/login`; RLS direct checks; kiosk PIN smoke. |
| 5 | **Announce** the PIN policy; archive/finalize fingerprints | comm | 4–5-digit PINs die with this release; all historical attachment URLs are dead. |

**Adjustment to the original order:** step 2 and 3 must be in the **same
maintenance window** (not days apart): the moment new code lands, stored v1
caps are already 404 — deferring the backfill only extends that breakage to
every rich-text embed that had persisted a URL.

## Compatibility of DB × code mid-flight

| state | app behaviour |
|---|---|
| post-0055 DB + pre-code app (brief) | unchanged (0055 touches security-unlabelled constraints only) |
| pre-0055 DB + post-code app (migration skipped) | redundant constraints ride along; nothing reads them; same valid states once 0055 lands |
| service crash mid-apply | full transaction rollback; audit shows the same plan again |

## Sign-off checklist

- [ ] Machine gates at current commit: format/typecheck/lint/test/deadcode/build (all 0 here).
- [ ] `check:migration-drift` PASS post-journal change.
- [ ] Ledger holds a row for every journal entry (`validateMigrationState` closed:
      55 applied, 0 pending on dev).
- [ ] `people.pick` present on all built-ins (migrate converge verified in dev).
- [ ] A3 audit sizing recorded; apply run inside a maintenance window (writers drained, lock).
- [ ] Announcement of PIN policy change.
- [ ] Archive fingerprint values (DB URL + secret) for the audited environment,
      recorded **outside** the repo (never committed).

## What is NOT needed with this release

- No schema changes beyond 0055 already committed.
- No RBAC/RLS rebuild (tenant isolation + lock-step roles verified this audit).
- No WOPI change (owner-paused).
