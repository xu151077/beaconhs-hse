# Phase 6U-B3-DM — Reproduction results

Date: 2026-10-20  
Repository: `/home/test/projects/beaconhs-hse`  
Branch/HEAD: `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`  
Target: `beaconhs-phase-aj`, web `sha256:60dc4841…`, Collabora `sha256:4e983196…`, tenant `ea5a149b-ea76-48e0-abbe-fa360f520d8e`

## 1. Attempts

Bounded to five attempts, stopping on the first failure.

| Attempt | Started (local) | Result                                                       | Exit | Frozen state    | Nav      | Panel | iframes |
| ------- | --------------- | ------------------------------------------------------------ | ---- | --------------- | -------- | ----- | ------- |
| 1       | 00:08           | PASS                                                         | 0    | FROZEN          | 1,734 ms | yes   | 0       |
| 2       | 00:09           | PASS                                                         | 0    | FROZEN          | 1,649 ms | yes   | 0       |
| 3       | 00:15           | **aborted by operator shell timeout** (not a product result) | —    | FROZEN at abort | —        | —     | —       |
| 3b      | 00:22           | PASS                                                         | 0    | FROZEN          | 940 ms   | yes   | 0       |
| 4       | 00:29           | PASS                                                         | 0    | FROZEN          | 1,372 ms | yes   | 0       |
| 5       | 00:36           | PASS                                                         | 0    | FROZEN          | 878 ms   | yes   | 0       |

Five valid passes, zero reproductions.

## 2. The aborted attempt (disclosed for completeness)

Attempt 3 was running when the operator's shell command hit its own 590 s timeout and was killed. Because the kill happened mid-test, the spec's `ensureActive()` never ran and the tenant was left **FROZEN** (version 244).

This was detected immediately and repaired through the legal path — `reconcile` → `release` → **ACTIVE** (version 246) — before any further test. It is an operator/tooling incident, not a product signal, and is excluded from the evidence matrix. It is recorded here because the report must not hide an unexpected state.

The subsequent attempts used a longer shell timeout, and every run ended with the tenant verified back at ACTIVE (final state after attempt 5: `ACTIVE`, version 261).

## 3. What the five passes establish

- The frozen re-open is **not reliably broken**. Under the documented conditions, five consecutive instrumented runs completed in 0.88–1.73 s with the refusal panel and no editor.
- The **freeze gate is correct**: no WOPI call in any run, no editor frame left behind, and the panel renders every time.
- **Sockets do not leak**: every run ended with an empty `openSocketsAtEnd`, and `Network.webSocketFrameError` never fired.
- **Playwright is not inventing the wait**: the CDP `load` lifecycle event and `page.on('load')` agreed in all five.

## 4. What it cannot establish

The DK failure has no CDP capture and no post-navigation snapshot, so its cause remains untested. Five passes demonstrate the failure is conditional, but they do not identify the condition. Specifically still unknown:

- whether DK's navigation was blocked by a child frame, by the main document, or by the network layer;
- whether the second `wss` in DK was related to the stall or incidental (in the five passes, sockets were opened and closed cleanly within the same second as the navigation);
- the state of the browser process itself (a renderer stall would also freeze `load` and leave no CDP events).

## 5. Bounded next step (not executed)

If a reproducer is required, the highest-yield change is to record **the failing run's CDP stream**, which requires catching the failure itself. Options, all requiring approval because they touch the test environment or the remote stack:

1. Repeat the DM spec in a longer batch (for example 20 attempts) overnight with CDP and trace retention, stopping on first failure. Cost: ~2 hours of test time; no remote change.
2. Mirror the phase-aj conditions locally: the same Collabora image digest, the same `aliasgroup1`/`extra_params`, and a host with similar CPU contention, then attempt the same sequence locally where CDP and container access are unrestricted.
3. Observe browser-process health during a batch (`page.on('crash')`, `Performance.getMetrics`, renderer RSS) to test the "renderer stall" hypothesis.

## 6. Status

**FAIL/BLOCKED** for root cause — no reproduction in 5 attempts, and the failing run lacks CDP data. **PASS** for the five functional frozen-state checks.
