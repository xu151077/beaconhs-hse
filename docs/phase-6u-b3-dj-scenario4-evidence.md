# Phase 6U-B3-DJ — Scenario 4 evidence

Date: 2026-10-19  
Repository: `/home/test/projects/beaconhs-hse`  
Branch/HEAD: `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`

## Status

Status: **FAIL / BLOCKED** for the phase-aj root cause. This phase produced a **complete, retained, request-level trace of the local equivalent**, which is new evidence: it shows the blocking state's navigation completing in ~1.1 s with **zero WOPI calls**. The phase-aj hang still cannot be reproduced locally.

## 1. What was captured (new this phase)

A temporary spec (`apps/web/e2e/phase-dj-scenario4-local.spec.ts`, deleted after the run) drove the same document through ACTIVE → blocking → ACTIVE on the local isolated stack, with `trace: 'on'`.

- Document: `5beae69a-39f1-426f-9eff-693c640ec874` (tenant `8b62c4c2-8ac9-40f5-8918-224036c4fbfd`), an in-app DOCX master.
- Freeze transitions went through the production state machine via `bt-freeze-driver.ts`.
- Trace: `/tmp/opencode/phase-dj/evidence/scenario4-local-trace.zip`, 3,263,652 bytes, SHA-256 `e4ecb5e311689938c84813be9f3b24158a45d67521772f80b3a7790ddd1f87f9`.
- Result: **1 passed**, exit 0, 4.4 min.

### Timeline (from the trace's own attachment)

| Time (UTC)   | Step                         |
| ------------ | ---------------------------- |
| 14:26:00.386 | `active:open`                |
| 14:26:01.645 | `active:opened`              |
| 14:28:09.651 | `blocking-state:DRAINING`    |
| 14:28:09.651 | `blocked:open`               |
| 14:28:12.155 | `blocked:refused-with-panel` |
| 14:29:46.866 | `released:ACTIVE`            |
| 14:29:46.866 | `recovered:open`             |
| 14:29:48.358 | `recovered:opened`           |

### Request-level evidence (from the trace's network log)

| Time         | Method | Path                   | Status |     Duration |
| ------------ | ------ | ---------------------- | -----: | -----------: |
| 14:26:00.391 | GET    | `/documents/5beae69a…` |    200 |       603 ms |
| 14:26:01.880 | POST   | `/documents/5beae69a…` |    200 |        84 ms |
| 14:28:09.665 | GET    | `/documents/5beae69a…` |    200 | **1,090 ms** |
| 14:28:11.495 | POST   | `/documents/5beae69a…` |    200 |       479 ms |
| 14:28:11.626 | POST   | `/documents/5beae69a…` |    200 |       220 ms |
| 14:29:46.873 | GET    | `/documents/5beae69a…` |    200 |       662 ms |
| 14:29:48.220 | POST   | `/documents/5beae69a…` |    200 |        82 ms |

**WOPI calls in the whole run: 0.** In the blocking state the page returned in 1.09 s, rendered the frozen panel, and never requested a writer session — which is the designed behaviour.

## 2. The blocking state reached

The driver refused `FROZEN` with:

```
ERROR: cannot enter FROZEN: drain verification is missing or incomplete; requesting a freeze is not the same as being frozen
```

so the run settled at **DRAINING**, which already refuses new writes. That is the honest state: the local demo tenant has 15 unresolved `storage_write_arms` rows (all `armed`, all expired 2026-10-15), so a database-verified drain cannot be claimed. The evidence is therefore for DRAINING, not FROZEN, and the report says so.

## 3. What this rules in and out

| Hypothesis                                       | State             | Evidence                               |
| ------------------------------------------------ | ----------------- | -------------------------------------- |
| The frozen/blocking page navigation itself hangs | RULED OUT locally | 1.09 s GET, 200, frozen panel rendered |
| A WOPI request is issued and blocks              | RULED OUT locally | 0 WOPI calls in the entire trace       |
| The blocking state is honoured                   | CONFIRMED         | panel shown, no iframe                 |
| Recovery to ACTIVE works                         | CONFIRMED         | 662 ms GET, Write pane visible         |
| phase-aj's hang has the same shape               | **NOT PROVEN**    | the local run never stalls             |

## 4. The remaining gap

The phase-aj environment differs in exactly the way the Phase DH/DJ logs show: its Collabora session stalls (`client not consuming tiles`, 111 lines in 24h) and its kit is killed in the failure window, while the local Collabora logged zero stalls. Reproducing the hang therefore needs the Collabora side to stall first — which requires either a phase-aj trace captured with the new retention policy, or the temporary diagnostic Collabora container described in `phase-6u-b3-dj-docbroker-observability.md`.

## 5. Change decision

No business code and no WOPI configuration was changed. The local evidence again shows the freeze gate and the document page behaving correctly.
