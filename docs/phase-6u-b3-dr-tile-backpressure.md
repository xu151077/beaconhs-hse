# Phase DR-C — tile backpressure experiments (dn-mirror)

Status: **executed in the isolated mirror only.** No phase-aj, development-stack or
production resource was read, written, restarted or frozen during these runs.
Environment provenance is in `docs/phase-6u-b3-dr-local-mirror.md`.

## 1. Predicate, fixed before the first run

A run counts as backpressure **only** when one 5 s window satisfies all three legs:

1. `TaskDuration` grows by **≥ 1.5 s** in that window,
2. Collabora logs a native **`client not consuming tiles`** event in that window,
3. an editor **`/cool/ws`** WebSocket is open for that window.

Plus the target anomaly (frozen re-open `load` never fires) for `REPRODUCED`.
The predicate was not changed after any result was seen.

Classification is the one required by the phase brief: `REPRODUCED`,
`BACKPRESSURE_ONLY`, `NOT_REPRODUCED`, `INVALID`, `BLOCKED`.

## 2. Run shape

Each run reproduces the Phase DK shape, one run per freeze window:

1. open the document editor while `ACTIVE`, wait for the editor frame and `/cool/ws`;
2. freeze through the production state machine (`bt-freeze-driver` → `applyTransition`);
3. apply the lever;
4. the **same tab** navigates to the same frozen document with `waitUntil: 'load'`;
5. sample `TaskDuration` every 5 s from CDP `Performance.getMetrics`, track
   `/cool/ws` open/closed per window, then join Collabora's own log lines by
   timestamp into the same windows;
6. release through `RECONCILING → ACTIVE`.

A window whose `TaskDuration` counter _decreases_ is a renderer swap (the
navigation committed); it is recorded as **unmeasurable**, never scored as 0 busy.

Raw evidence was written to `/tmp/opencode/phase-dr/evidence/<run>/result.json` (mode
0700, outside the repository). Each file contained the per-window series, socket
state, Collabora event counts and the freeze-state row; none contained tokens,
cookies or presigned URLs (checked, see §7). The files were removed at the end of the
phase, after this document and the final report were written.

## 3. Results

| Run          | Lever                                              | Freeze state | Nav (ms) | `load` fired | Windows (measurable) | Busy ≥1.5 s | Max `TaskDuration`/5 s | Collabora `client not consuming tiles` | `/cool/ws` open in window | Predicate       | Classification   |
| ------------ | -------------------------------------------------- | ------------ | -------- | ------------ | -------------------- | ----------- | ---------------------- | -------------------------------------- | ------------------------- | --------------- | ---------------- |
| A2 `dr-c-A2` | none (control, instrumentation v1)                 | `DRAINING`   | 5 055    | yes          | 1 (0)                | 0           | 0 (swap)               | 0                                      | no                        | not met         | `NOT_REPRODUCED` |
| B1 `dr-c-B1` | 20× client CPU + 500-page doc                      | `DRAINING`   | 12 157   | yes          | 2 (1)                | **1**       | **5.07 s**             | **0**                                  | **yes**                   | not met (leg 2) | `NOT_REPRODUCED` |
| C1 `dr-c-C1` | Collabora capped at 0.5 CPU                        | `DRAINING`   | 5 060    | yes          | 1 (0)                | 0           | 0 (swap)               | 0                                      | no                        | not met         | `NOT_REPRODUCED` |
| D1 `dr-c-D1` | `per_document.max_concurrency=1` + 2 live sessions | `DRAINING`   | 5 050    | yes          | 1 (0)                | 0           | 0 (swap)               | 0                                      | no                        | not met         | `NOT_REPRODUCED` |
| B2 `dr-c-B2` | repeat of B1                                       | `DRAINING`   | 17 019   | yes          | 3 (2)                | **2**       | **5.14 s**, 2.77 s     | **0**                                  | **yes**                   | not met (leg 2) | `NOT_REPRODUCED` |
| A3 `dr-c-A3` | none (control, final instrumentation)              | `DRAINING`   | 5 058    | yes          | 1 (0)                | 0           | 0 (swap)               | 0                                      | no                        | not met         | `NOT_REPRODUCED` |

### 3.1 Lever A — control

The frozen re-open behaved exactly as the certified DR-B control: frozen panel
visible, **0 iframes**, no WOPI call, `load` fired in 5.06 s, no stalls. A3 is the
same run under the final instrumentation (the only difference from A2 is the
renderer-swap guard, which marks the single post-commit window unmeasurable instead
of scoring it), so both control runs agree. This is the baseline the other runs are
compared against, and the precondition check that the mirror is not spontaneously
slow.

### 3.2 Lever B — 20× client CPU throttling + 500-page document

The heavy document is real: 6 000 paragraphs, **500 pages, 174 000 words**, loaded
through the normal WOPI path (fixture provenance in
`docs/phase-6u-b3-dr-local-mirror.md` §5). CDP CPU throttling was applied **after**
the editor finished loading, so only the frozen re-open ran under starvation.

- Leg 1 was met decisively: **5.07 s of `TaskDuration` inside a 5.4 s window** — the
  renderer's main thread was saturated for essentially the whole window.
- Leg 3 was met: the `/cool/ws` socket of the old editor session was still open
  (`socketsStillOpen: ["ws://localhost/cool/ws"]`), and in fact it was still open
  after `load` completed.
- Leg 2 was **never** met: **0** `client not consuming tiles` lines, **0** tile-drop
  lines, in the entire run window.
- The navigation did complete, 12.2 s after it started (2.4× the unthrottled 5.0 s),
  and rendered the frozen panel.

The repeat (B2) reproduced the same shape: **two** busy windows (5.14 s and 2.77 s
of `TaskDuration` in 5 s windows), the `/cool/ws` socket open in every window, and
still **0** `client not consuming tiles` events. The navigation again completed,
this time in 17.0 s (3.4× the unthrottled baseline).

So the client was starving (leg 1) while its socket stayed open (leg 3), and the
server still never reported a slow consumer (leg 2) — in two independent runs.

**Why that matters:** the WebSocket reader lives in the browser process, not in the
throttled renderer main thread. Throttling the renderer therefore cannot make the
socket stop draining, which is precisely the condition Collabora reports as
`client not consuming tiles`. Client CPU starvation alone is not a mechanism for
the phase-aj tile stall. (Stated as an inference from this experiment, not as
proof about phase-aj.)

### 3.3 Lever C — Collabora kit CPU cap (independent mechanism)

`docker update --cpus=0.5 dn-mirror-collabora` (verified: `NanoCpus=500000000`;
kits are children of that cgroup), 500-page document, no client throttle. Result:
nav 5.06 s, no busy window, no stalls, no failure. Reverted to `NanoCpus=0`
before the next run.

Analytically this lever **cannot** reach the frozen navigation: the frozen page mints
no WOPI token and never contacts Collabora (`socketsCreatedDuringNav=0`,
`iframesAfterNav=0`), so starving the document server changes nothing about a page
load that never asks the document server for anything. That is consistent with the
DK trace (0 WOPI calls in the failing run) and is the reason lever C is reported
separately and not merged into any conclusion.

### 3.4 Lever D — `per_document.max_concurrency=1` (independent mechanism)

Collabora was recreated with `--o:per_document.max_concurrency=1`; its own log
confirms `MAX_CONCURRENCY set to 1` and a second client session
(`current number of connections: 2`) on the same document. Two live editor tabs
held the same document, then the freeze and the frozen re-open ran in the first tab.
Result: nav 5.05 s, no busy window, no stalls, no failure. Reverted before B2.

As with C, the frozen re-open never contacts Collabora, so a per-document
concurrency limit has no path to the frozen page load. Recorded as an independent
negative result, not as evidence about the phase-aj mechanism.

## 4. What the experiments establish

1. The mirror can freeze and frozen-re-open in ~5 s with no WOPI call and no iframe —
   the product path is healthy here (DR-B control, A2).
2. A 500-page document plus 20× CPU starvation produces **100 % main-thread busy
   time** (5.07 s and 5.14 s per 5 s window, twice) and still **no** server-side tile
   stall. Leg 1 alone is not sufficient, and did not produce leg 2 in either run.
3. Neither a CPU-starved document server (C) nor a per-document concurrency cap (D)
   can influence the frozen page load, because that load never talks to Collabora.
4. The three-leg predicate was **not satisfied in any run**, so no run may be called
   backpressure, and none reproduced the navigation hang.

## 5. What is still missing

The only phase-aj failure had `client not consuming tiles` from the **previous**
editor session while the frozen navigation hung. In the mirror, that leg never
appeared even at 100 % client CPU saturation, so the missing ingredient is not CPU:
it is whatever makes the browser stop reading the socket (a blocked/stalled socket
reader, a suspended renderer process, or a network stall on the socket path). The
cheapest next step is `Page.setWebLifecycleState('frozen')` or a real backgrounded
window, which suspends the whole page (socket reader included) rather than just the
main thread. That is recorded as a proposal, not executed in DR.

## 6. Honest limitations

- **Freeze state was `DRAINING`, not `FROZEN`**, in every experiment, because the
  editor session stays open and the drain never verifies. The gate refuses writes in
  both states and the frozen panel rendered identically, but this is a
  non-equivalence with DK (which reached `FROZEN`) and is stated wherever it matters.
- The freeze/release cycle costs ~5.5 min per run (production drain + reconciliation),
  which caps how many repetitions were practical: one run per lever, plus one repeat
  of B (B1, B2).
- The mirror has no TLS, no Cloudflare Tunnel and no Traefik; see the mirror report
  §3.3 for the full list.
- `client not consuming tiles` is a log line, not a counter. Collabora exposes no
  dropped-tile counter (the `INFO` log has no such metric), so dropped tiles are
  reported as **not observable**, never inferred.

## 7. Evidence hygiene

- Searched every `result.json` under `/tmp/opencode/phase-dr/evidence/` for
  `access_token` and cookie material: **0 matches**.
- Collabora log lines are parsed for counts and timestamps only; the raw lines (which
  can contain a WOPI URL with an access token) are never written to evidence or docs.
- Evidence directories are mode `0700` and live outside the repository.
