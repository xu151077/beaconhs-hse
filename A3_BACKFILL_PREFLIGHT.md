# A3 Backfill Pre-Launch Review — Capability v2

Baseline `d06924d0`; script: `apps/web/scripts/backfill-attachment-capability-v2.ts`;
guardrails: `apps/web/scripts/cutover-target.ts`. **This review executes nothing;
it records whether A3 is executable, and what must happen around it.**

## Execution conditions audit

| #   | Check                                                                                                                                    | Status                                                                                                                                                                                                                                                | Evidence                                                                                                                                                    |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Script logic: full re-mint via `attachmentUrl()` (deterministic v2), route-refs only (`public-object` → hard error), invalid refs → fail | ✓ reviewed                                                                                                                                                                                                                                            | `backfill-attachment-capability-v2.ts`                                                                                                                      |
| 2   | Audit vs apply semantics                                                                                                                 | ✓                                                                                                                                                                                                                                                     | audit prints stats; apply re-preflights **under the advisory lock**, CAS-rewrites, then re-runs to prove idempotency (`changedRows === 0`, `pending === 0`) |
| 3   | Environment identity                                                                                                                     | guarded by `BEACONHS_CUTOVER_TARGET=beaconhs-dev` + **SHA-256-fingerprinted DB URL** (pool **and** direct port) + `NODE_ENV=production` + capability-secret fingerprint                                                                               | `apps/web/scripts/cutover-target.ts` (3 refs)                                                                                                               |
| 4   | Secret/fingerprint enforcement                                                                                                           | `requireCutoverCapabilitySecret()` refuses fallback/local secrets (so persisted v2 caps are never minted with a dev secret)                                                                                                                           | same file; app-level secret readable at boot                                                                                                                |
| 5   | Writers-drained gate for apply                                                                                                           | `BEACONHS_CUTOVER_WRITERS_DRAINED=true` required in apply; audit mode is read-only                                                                                                                                                                    | same file                                                                                                                                                   |
| 6   | **Idempotency**                                                                                                                          | yes by construction: v2 is deterministic per attachment; second pass plans 0 rows; with different secret it would re-mint differently (hence the fingerprint)                                                                                         | code + E-gate assertion                                                                                                                                     |
| 7   | Transaction scope                                                                                                                        | **single transaction over all planned rows** — failure mid-apply rolls back **everything**; on success the whole set is atomically rewritten; per-row CAS (`is not distinct from` before-values) rejects racing writers the moment a conflict is seen | `applyPlans`                                                                                                                                                |
| 8   | Cross-tenant safety                                                                                                                      | every CAS binds `tenant_id = plan.tenantId` in the **predicate** (not just RLS); preflight asserts `attachments.tenant_id == row.tenantId` (attaches and rejects cross-tenant refs loudly)                                                            | lines 302/369/395/414/435/443                                                                                                                               |
| 9   | Row re-read under lock                                                                                                                   | lock → fresh full preflight → apply (`id` + before PK check)                                                                                                                                                                                          | main flow                                                                                                                                                   |
| 10  | Historical links affected                                                                                                                | every embedded route-ref in `form_responses.(data,draft_data,workflow_state)` and in `training_{lessons,content_items}.content_html` where the raw != fresh v2                                                                                        | surfaces in the script                                                                                                                                      |

**Verdict on (8)/(9):** For dev data the expected change-set is _already zero_ —
an SQL-only scan found **0** cells with attachment-route strings in either
tenant's persisted JSON/HTML. On the audited target, run the audit first and
size it from its output; the script rewrites nothing if pending = 0.

## Irreversibility / recovery

- The apply is _transactionally_ safe: no row is partially rewritten.
  Interruption mid-apply = full rollback by Postgres.
- **Semantically irreversible** in one respect: old v1 URLs embedded anywhere
  (inside the app they are now deterministically 404 for anyone without a new
  render) cannot be brought back without reversing the rewrite. The pre-apply
  table dump (see `ROLLBACK_PLAN.md`) preserves everything needed to reverse
  byte-for-byte, including the audit narrative.
- The ledger question: apply is **not** a migration (no journal entry); a
  failed apply is retried from audit with the same idempotency assertions.

## Production data footprint (read-only estimate)

Dev: `form_responses` / `training_lessons` / `training_content_items` contain
**0** attachment-route refs in both tenants (verified with tenant-GUC scans and
earlier E2E round, all five cells = 0). So dev needs nothing. On the target,
the script's first audit mode prints exact `rowsScanned/references/withCap/pending/changedRows`:
sizes apart from the identity shapes above, the apply is a no-op if `pending = 0`.
