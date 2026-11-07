# Phase 6U-B3-DL — Scenario 4 evidence

Date: 2026-10-19  
Repository: `/home/test/projects/beaconhs-hse`  
Branch/HEAD: `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`  
Target: `beaconhs-phase-aj`, web `sha256:60dc4841…`, Collabora `sha256:4e983196…`, tenant `ea5a149b-ea76-48e0-abbe-fa360f520d8e`

## 1. Runs performed this phase

Three runs, each: create a document in ACTIVE → start the editor (iframe present) → drive the freeze state machine to **FROZEN** → re-open the same document → restore **ACTIVE**.

| Run  | Purpose                                          | Result   | Frozen state reached | `load`      | Panel | iframes | Duration |
| ---- | ------------------------------------------------ | -------- | -------------------- | ----------- | ----- | ------- | -------- |
| DL-1 | frame/WS recorder, `waitUntil: 'commit'` + poll  | **PASS** | FROZEN               | yes         | 1     | 0       | 6.4 min  |
| DL-2 | original `waitUntil: 'load'`, bounded            | **PASS** | FROZEN               | yes (7.8 s) | 1     | 0       | 6.5 min  |
| DL-3 | freeze 25 s after editor attach (DK-like timing) | **PASS** | FROZEN               | yes (2.0 s) | 1     | 0       | 6.3 min  |

Scenario 4 was therefore **not reproduced** in this phase. This is a real negative result, not a skipped test: every run asserted the rendered state (`frozenPanel > 0`, `iframes == 0`) after the navigation, and all three held.

## 2. Freeze handling

- FROZEN was reached through `helpers/freeze-control.ts` → the production state machine (`request` → `drain` → `freeze`). No drain was forced, no write-arm was cleared, no database row was edited.
- After every run the tenant was returned to **ACTIVE** through the legal transition path; the last verified state is `state=ACTIVE version=221`.
- One test document per run, in the isolated test tenant only.

## 3. What the three runs establish

- The frozen re-open is **not deterministically broken**: three consecutive attempts under the documented conditions completed in 2–8 s with the correct panel and no editor.
- The product requirement holds when it does complete: **no WOPI call is made**, no iframe remains, and the refusal panel renders.
- The DK failure therefore depends on a condition that did not recur. The only structural difference found between DK and these runs is the **lingering `cool.html` child frame** in DK (see the frame-lifecycle report).

## 4. Sensitive-data handling

| Run  | Trace size | SHA-256                                                            | `cookie` headers present (count) |
| ---- | ---------- | ------------------------------------------------------------------ | -------------------------------- |
| DL-1 | 8,446,041  | `aacaf6e576b7e9c5a5ddfb9cc1739ba287079fbbf4422bf28b2e2a5d55ca23d3` | 427                              |
| DL-2 | 9,315,629  | `49fc16e5b9ad35aa1761cf1b900e965b4216759c232950d9837c7bd3b203d9d0` | 448                              |
| DL-3 | 10,613,188 | `0141f0c0c8a975fc635d95f29ecd9541f74ae3d685fa7eb965a4f0b380b62dad` | 415                              |

All three ZIPs pass `unzip -t`. They live under `/tmp/opencode/phase-dl/evidence/{run,run2,run3}/`, mode `0700`, outside the repository. `apps/web/test-results/` still contains only `.last-run.json`. No cookie, token, or signed URL value is reproduced in any report.

## 5. Historical vs new

- **New**: all three DL runs, their frame/WebSocket timelines, and the comparison with the DK failure's lingering frame.
- **Historical**: the DK failure itself, the CT timeout, the Phase DH stall counts, and the local DRAINING run.

## 6. Status

**FAIL/BLOCKED** for the root cause (not reproduced; mechanism unknown). **PASS** for the frozen-state functional assertions in three runs and for evidence retention.
