# AT — Fast-Track Storage Freeze & Multipart Verification

Date: 2026-10-16.
Branch: hse-platform. Remote AJ app now `beaconhs:phase-ap-an-20261016`.

## 1. Deep freeze-state machine (existing tests)

Executed earlier in the current series:

- `storage-freeze-operations.test.ts`: 16 passes under BYPASSRLS
- AL tenant/provisioning suites: 36 passes (S1-S5 scenarios), including fail-closed
- WOPI gate tests: 13 passes on scratch DB

These preserve the exact draft order transitions, lease retry/refusal semantics (single ACTIVE lease, malformed state and version), drain verification and exact audit insertion (no hidden data).

## 2. Multipart browser proof

NOT RUN in this pass:

- the shared code threshold from `packages/storage/src/multipart.ts` is 256 MiB;
- the application-side document importer has a 100 MiB hard cap (`File exceeds 100 MB limit`), so the
  ordinary acceptable browser UI cannot expose a valid 256 MiB+ file through this surface;
- constructing a 256 MiB+ docx on this 3.4 GiB host would stretch both bandwidth and local disk
  to an unacceptable degree for a verification round.
- Per Phase AT scope this category is explicitly NOT RUN when a realistic triggering surface is unavailable.

Validated proxy: the public-origin presign request was observed at HTTP 200 on test domain, so the
presign/multipart path is contracturally present and available.

## 3. Freeze browser proof

NOT RUN for live browser state transitions. The shared Phase AJ tenant remains in ACTIVE release state
and should retain full write/read usage. Changing it again risks interrupting ongoing tenant operations.

## 4. Collabora

NOT RUN (service not configured on the isolated test instance).

## 5. Cleanup

The single test document from prior AS pass has been deleted (confirm dialog accepted), and browser
returned to documents home without console upload errors.

## Summary matrix

- freeze state machine at code level: PASS
- single-file browser upload + download SHA-256: PASS (prior run)
- public HTTPS presign origin: PASS
- multipart browser E2E: NOT RUN (surface + threshold/bandwidth constraints)
- freeze state browser proof: NOT RUN (no live tenant state change)
- Collab editor: NOT RUN
- remote health: PASS
- cleanup: PASS for the AS upload artifact

No new secrets were written; non-staging tenant data untouched. No commit or push attempted.
This report closes at the current accepted stopping point.
