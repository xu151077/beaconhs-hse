# Phase DZ — Final report

Date: 2026-10-20
Repository: `/home/test/projects/beaconhs-hse`
Branch: `hse-platform`
HEAD: `51a899b7aac0a942da327222a3eed355fca9798a`

## 1. Status summary

| Work item                                | Status   | One-line                                             |
| ---------------------------------------- | -------- | ---------------------------------------------------- |
| DZ-1 — W1 CI acceptance checklist        | Complete | Checklist written; CI NOT RUN                        |
| DZ-2 — W2 multi-replica steps            | Complete | Steps written; multi-replica NOT RUN                 |
| DZ-3 — W3 browser E2E steps              | Complete | Matrix written; browser E2E NOT RUN                  |
| DZ-4 — Remote recovery/cleanup checklist | Complete | Checklist written; host unreachable, no action taken |
| DZ-5 — Unified acceptance runbook        | Complete | Runbook written (sections A–G)                       |

No code changes in DZ.

## 2. What was produced

- `docs/phase-6u-b3-dz-acceptance-runbook.md` — ordered acceptance procedure (A–G) with
  preconditions, commands, expected output, failure handling, stop conditions, and cleanup.
- `docs/phase-6u-b3-dz-remote-recovery-checklist.md` — read-only recovery and safe-cleanup
  steps for the unreachable host.
- `docs/phase-6u-b3-dz-final-report.md` — this report.
- `docs/phase-6u-b3-cv-release-readiness.md` — DZ addendum (§15).

## 3. Current state of each work item

| Item    | Status                                                                                                      |
| ------- | ----------------------------------------------------------------------------------------------------------- |
| W1      | local PASS, **CI NOT RUN**                                                                                  |
| W2      | **PARTIAL** (gate wired and locally proven; live workflow and multi-replica NOT RUN)                        |
| W3      | **PARTIAL** (500-as-refusal closed incl. badge routes; browser matrix, release image, WOPI, freeze NOT RUN) |
| WOPI    | `KNOWN / UNRESOLVED — LOW PRIORITY — INVESTIGATION PAUSED`                                                  |
| Overall | **not release-ready**                                                                                       |

## 4. Git state

HEAD: `51a899b7aac0a942da327222a3eed355fca9798a`
Branch: `hse-platform`
154 tracked files modified, 440 untracked. No commit, push, reset, clean, restore, or
checkout.

## 5. Temporary resources

None created in DZ. DX leftovers may remain on the unreachable host.

## 6. Next shortest execution path

1. Recover SSH to `10.10.31.30` (section A of the runbook).
2. Clean DX leftovers (section B).
3. Build the test image on the host (section C).
4. Run the W3 browser matrix (section D).
5. Run the W2 multi-replica gate (section E).
6. Trigger real CI with owner authorisation (section F).
7. Summarise and clean up (section G).
