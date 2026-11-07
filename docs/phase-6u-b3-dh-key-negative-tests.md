# Phase 6U-B3-DH — Server Action key negative tests

Date: 2026-10-19  
Repository: `/home/test/projects/beaconhs-hse`  
Branch/HEAD: `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`

## Environment

The tests ran against the **real production standalone build** produced by this phase's `pnpm build`, started on the host with `apps/web/scripts/start-standalone.mjs` and the repository `.env` (local Postgres/Redis/MinIO). Two instances were started for the mismatch scenario. Only dedicated disposable test keys were used; no production key was read, and no key material appears in any log or report.

## Results (executed this phase)

| #   | Scenario                                | Instance                                    | Request                         | HTTP status                        | Evidence                                                                                                                                                                                                                                          |
| --- | --------------------------------------- | ------------------------------------------- | ------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Missing runtime key                     | standalone :3100                            | `GET /api/health/ready`         | **200** `{"status":"ready"}`       | build-time key applies (framework default)                                                                                                                                                                                                        |
| 2   | Invalid runtime key                     | standalone :3100                            | `GET /api/health/ready`         | **503** `{"status":"unavailable"}` | log: `[readiness] server action key rejected: [server-action-key] NEXT_SERVER_ACTIONS_ENCRYPTION_KEY is not a valid base64-encoded AES key (16, 24, or 32 bytes). The instance is not ready for traffic.` — 0 occurrences of the value in the log |
| 3   | Valid runtime key                       | standalone :3100                            | `GET /api/health/ready`         | **200** `{"status":"ready"}`       | no rejection logged                                                                                                                                                                                                                               |
| 4   | Two instances, different runtime keys   | :3100 and :3101                             | `GET /api/health/ready` on each | **200** and **200**                | neither instance detects the mismatch                                                                                                                                                                                                             |
| 5   | Recovery after fixing the configuration | standalone :3100 restarted with a valid key | `GET /api/health/ready`         | **200**                            | the instance returns to rotation without a rebuild                                                                                                                                                                                                |

Unit level: 13 tests passed (8 key-contract tests, 5 readiness tests), exit 0.

## Layer separation

- **Configuration layer** — now fail-closed for an invalid override (scenario 2) and explicitly permissive for an absent override (scenario 1).
- **Server Action request layer** — the rejected formats cannot be imported as an AES-GCM key; the unit test reproduces Next.js's own `atob` + `importKey` call and shows the rejection is real, not cosmetic.
- **Cross-instance layer** — not detected. Next.js exposes no mechanism, and its documentation only states the requirement ("all instances must use the same encryption key"). A shared non-secret configuration version would be the only safe way to compare instances; that is a deployment-side change and was not implemented here.

## Status

Status: **PASS** for missing / invalid / valid configuration handling and recovery. **NOT RUN** for a bound-argument Server Action executed end-to-end against two instances with different keys (the containerized test instance could not complete an authenticated session with a bound action in this environment). Cross-instance mismatch detection remains **NOT RUN**.
