# BeaconHS API Security Remediation — Phase 5

**Audit conclusion: no permission code needs modification.** Every probe
(E1–E14) matched the permission design; no vulnerability was found, so this
file lists (a) what was fixed this release already, (b) the two informational
notes that stay as-is, and (c) the operational follow-ups that are not code
changes.

## Already fixed (prior commits in this release)

| Item                                                                                          | Where                     |
| --------------------------------------------------------------------------------------------- | ------------------------- |
| Directory pickers required purpose + `people.pick` (18 lookups)                               | `534faf0c` — route + test |
| Account-identity pickers (7, emails included) folded in                                       | same                      |
| Attachment capabilities `attachment:v1:` → v2 (historical links 404)                          | `b3e65ef6`                |
| Kiosk PIN public minimum 6 digits, legacy 4–5 dead (normalize choke)                          | `2d3355bf` + `03900b36`   |
| D8 82 FKs: 9 redundant singles dropped, missing PPE FK installed, residue pinned by allowlist | `6feca20e`                |
| ILIKE wildcards across every list search + contract test                                      | `58d5bb5f` + `7df32ab6`   |
| FormData raw ids into uuid/enum/date predicates (11 sites)                                    | `dea0d9aa` + `ef41c6ff`   |

## Held as informational (no change recommended)

1. **Anonymous OpenAPI.** `/api/v1/docs` + `/api/v1/openapi.json` expose
   endpoint shapes and permission keys without auth; keys grant nothing by
   being documented. Decision: keep public (consistent with SCпубликации
   SRI-pinned reference), revisit only if the product wants spec-keyed
   exports hidden.
2. **Outbox replay GETs 405.** GET on `/api/internal/domain-events/:id` is
   405 (POST-only) — pre-existing, harmless.

## Remaining operational work (not code; deployment time)

| #   | Step                                                                                                              | Why / ordering                                                                                    |
| --- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 1   | Apply migrations on the target DB (`pnpm db:migrate`)                                                             | brings 0055 + converges `people.pick` into built-ins; ledger hash/created_at recorded at fs level |
| 2   | Deploy the code                                                                                                   | v2 caps, PIN 6–12, picker gates all live together                                                 |
| 3   | Run the capability backfill audit; if refs exist in persisted values, `--apply` with writers drained              | the last production step that still matters (see §A3 of the execution handoff)                    |
| 4   | Provision production secrets (`ATTACHMENT_CAPABILITY_SECRET` ≥32, `R2_*`, `DATABASE_URL*` for the target cluster) | fail-closed at boot otherwise                                                                     |
| 5   | Announce the PIN policy change to users                                                                           | 4–5-digit PINs die with this release; no migration                                                |

## Suggested (optional) regression hardening for the next audit round

- Keep the FormData/ILIKE contract tests; re-run them after every large
  module-add. Optional: extend the picker route tests to a deny-per-lookup
  matrix so purpose+pick coherence is re-verified with zero review effort.
