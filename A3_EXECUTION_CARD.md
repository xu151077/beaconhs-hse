# A3 Backfill Execution Card — audit → apply (A3 + Phase 5, 2026-11-09)

A3 capability-v2 backfill (`apps/web/scripts/backfill-attachment-capability-v2.ts`).
Audit-only is authorised this turn; apply needs the follow-up authorisation.
This card states the exact commands and every expected gate/verification.

## Why this output is environment-gated (and cannot be improvised here)

The script refuses to run anywhere except the **audited** environment:

| Guard                         | Constant                                                                                             | Actual here                                                                                        |
| ----------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| target marker                 | `BEACONHS_CUTOVER_TARGET=beaconhs-dev`                                                               | unset (export at run time)                                                                         |
| DB pool fingerprint           | expected `a19382e0…`                                                                                 | computed from this host's config: **`ae0ab37a…`** ≠ constant → this dev DB is _not_ the audited DB |
| DB direct fingerprint         | expected `0ae09059…`                                                                                 | same computation above; not present                                                                |
| capability secret fingerprint | `1c79927d…`                                                                                          | `ATTACHMENT_CAPABILITY_SECRET` is **unset** here (dev fallback only)                               |
| apply gate                    | `BEACONHS_CUTOVER_WRITERS_DRAINED=true`                                                              | env at run time                                                                                    |
| session shape                 | BYPASSRLS login role `beaconhs_super`, non-superuser, database `beaconhs`, writable, not in recovery | `assertCutoverDatabaseSession` requirements                                                        |

Provision the two values (DB direct URL for the audited environment and its
33+ char capability secret **from their vault** — never through chat/logs/git),
export them plus `BEACONHS_CUTOVER_TARGET=beaconhs-dev` and
`NODE_ENV=production`, and the command below is the entire execution. This is
the only legitimate way to reach a matching fingerpr
...[truncated]
