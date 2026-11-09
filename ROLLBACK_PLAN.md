# BeaconHS Rollback Plan — A3 Backfill & Release 2026-11-09

Scope: everything that is **not** reversible by git revert:
(1) the DB-side 0055 rollout, (2) the A3 data rewrite, (3) the code deployment.

## 1. Prepare (before any step)

```sh
# Full dump of every column the backfill touches (idempotent, named like this)
pg_dump "$MIGRATION_DATABASE_URL" \
  -t form_responses -t training_lessons -t training_content_items \
  > backup_pre_a3_$(date +%Y%m%d).sql
# A3 audit output (rowsScanned/references/withCap/pending) archived to the runbook
```

## 2. Rollback scenarios

| Scenario | What breaks | Rollback |
|---|---|---|
| Apply fails midway | nothing | **auto-rollback**: one transaction; rerun the audit to see the same plan |
| Apply commits, content surprises | images/signature refs look wrong | *(prefer)* leave it — the rewrite is deterministically re-runnable; the pre-apply dump is the byte-for-byte exit: restore the three tables from the dump **before any new writes land on them** (restore overwrites post-apply writes on touched rows — dangerous afterwards) |
| Code deploy regresses | app error | redeploy previous build; v1 caps still 404 in stored text (backfill idempotency note below) |
| 0055 migration needs reverting | (already safe) | 0055 is a data-truth alignment; **never re-add the 9 dropped duplicates or remove the installed FK as a "revert"** — the snapshots and the audit allowlist pin them. Reverting the *release* is the code rollback above, not a constraint rollback. |

**Idempotency note:** after a completed apply, re-running the script's audit
still shows `pending = 0` (caps are deterministic v2). Re-running `--apply`
is a no-op — so the "forward fix" for a surprise is another apply of the same
rewrite against newer rows, not the dump.

## 3. Rollback ledger-side

- Migrations: journal + snapshot chain step forward only (0044/0045..0055).
  Rollback is a **new** compensating migration, not a rewrite. Not needed
  here: 0055 aligns with live DB evidence (591 FKs, allowlist residue 74 when
  reconciled with DB).
- API keys created for audit probes were deleted; no residual test accounts
  or tenant config changes remain (kiosk_pin reset to unset, cert rows 0).

## 4. Blast-radius guardrails during apply

- Writers drained flag enforced; advisory lock (`beaconhs:attachment-capability-v2:v1`)
  serializes concurrent apply runs (a second runner aborts with a lock error).
- Audit-mode runs are read-only regardless of lock state; any service can run
  them any time for a fresh sizing snapshot.

## 5. Restore verification

After any restore:
1. `pnpm db:migrate` → `Migration ledger valid: N applied, 0 pending`.
2. Re-run A3 audit → `pending = 0`, `changedRows = 0`.
3. DB orphan scan: no `/api/attachments/` strings in the persisted cells that
   the audit's `withCap` counter says should be none.
4. Attachment bytes smoke (v2 URL → 200; v1 → 404).
