# AQ — Isolated AJ Deployment Access Recovery

Date: 2026-10-16.
Branch: hse-platform (no commit, no push).

## Findings

- No SSH configuration exists for the AJ isolated host. `~/.ssh/config` exposes only
  `beaconhs-drill` (10.10.31.30 / ceshi), which is explicitly **not** the AJ test target.
- No Phase AP report records an AJ SSH alias, host override, port, or valid key path.
- The local web endpoint remains `https://beaconhs-test.xuhaoqing.top`, and its ready endpoint
  still reports version `51a899b7`.
- Search across docs and repository did not reveal the correct isolated AJ SSH host or credentials.

## Action taken

- `beaconhs-drill` was inspected only through the documented alias and only for inventory; it was not
  treated as a deployment target.
- No keystores were copied or guessed.
- No production DNS, tunnel, drill, or object storage resources were modified.

## Blocked items

- Remote image/rebuild/deploy operations: BLOCKED (no connection).
- Remote version verification: only stale `51a899b7` is visible.
- Runtime `R2_ENDPOINT`, `R2_INTERNAL_ENDPOINT`, and CSP inspection: only public passive HTTP,
  showing the unchanged pre-AN state.
- Real browser single-file and multipart upload E2E: NOT RUN.
- Collabora editing verification: NOT RUN.

## Required from environments owner

Provide a valid SSH alias or explicit user/host/port/key for the isolated AJ host, scoped to AJ only.
No guessing of credentials was attempted.

## Remaining local/clean result

- repository local gates remain green (from prior phases): typecheck, lint, format, deadcode;
  `pnpm test` passed after storage and web guidance changes.
- No changes introduced during this attempt except this report.
