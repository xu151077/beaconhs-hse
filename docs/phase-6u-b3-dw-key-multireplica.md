# Phase DW-3 — Server Action Key multi-replica verification

Date: 2026-10-20
Repository: `/home/test/projects/beaconhs-hse`
Branch: `hse-platform`
HEAD: `51a899b7aac0a942da327222a3eed355fca9798a`

## 1. Result

**MULTI-REPLICA NOT RUN.** No isolated multi-container environment was available. The
`replicas` mode requires running containers labelled
`com.docker.swarm.service.name=<stack>_web` that expose `/api/health/ready` and emit the
`[server-action-key]` log line. Creating such a setup requires deploying the app image with
its database, Redis, storage, and auth dependencies, which is outside the safe scope of this
phase and would risk the shared host.

## 2. What was verified instead

- Call chain traced end to end (CI test → pre-deploy image gate → post-rollout replica gate →
  readiness boundary).
- 13/13 harness scenarios pass (consistent, mismatch, missing, invalid, rotation, rollback,
  no-leakage).
- 8/8 deployment-contract tests pass.
- Real image extraction path against `beaconhs:dr-mirror-51a899b7`: correct fingerprint passes,
  wrong fingerprint exits 1.
- The `replicas` parser and comparator were exercised through the `log` mode in the harness.

## 3. Conclusion

Multi-replica runtime check: **NOT RUN**. W2 remains **PARTIAL**. See
`docs/phase-6u-b3-dw-environment.md` for the minimum multi-replica environment request.
