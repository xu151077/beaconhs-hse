# Phase 6U-B3-G External Write and Lifecycle Deletion Report

- Date: 2026-10-14
- Branch: `hse-platform`
- Source HEAD: `51a899b7aac0a942da327222a3eed355fca9798a`

## Audit result

No new functional defect was discovered beyond phases 6U-B3-A/B/C/D/E/F. The external surface is dominated by two previously-identified structural properties:

1. **Applications routes containing WOPI/attachments collaborate** — they route their final object effect through `putObject` / `deleteObject`, which after 6U-B3-B calls the freeze gate and the in-flight tracker. New issuance of presigned arms and `presignPut` / `presignMultipartPart` go through lock-checked freeze checks.
2. **Deletion outbox and expired-upload reconciler** retry through `deleteObject`, which is also gated, so freeze attempts fail and exponential retry occurs. They still _claim_ work at queue safe until the gate check, but they cannot close the object deletion while the tenant is frozen in a controlled manner; the object remains on the store until thaw.

## Paths now covered directly

- `packages/storage/src/index.ts`
  - `putObject`, `createMultipartUpload`, `completeMultipartUpload`, `abortMultipartUpload`, `deleteObject`, `promoteObject`, `presignPut`, `presignMultipartPart` now have arm issuance with locking.
- `apps/web/src/app/wopi/files/[fileId]/contents/route.ts`
  - staging through `putObject`; blocked staging returns HTTP 423.
- `apps/worker/src/lib/storage-object-deletion-outbox.ts`
  - through `deleteObject` (gated).
- `apps/worker/src/lib/attachment-upload-reconciler.ts`
  - through `deleteObject` (gated).
- External lifecycle:
  - `packages/storage/src/lifecycle.ts` manages Expiration only for `beaconhs-state=pending` and `beaconhs-state=transient` objects, with `AbortIncompleteMultipartUpload`; no produced durable object carries expiration. This is code-and source-backed and auditable. We did **not** modify vendor bucket policy, nor connect to MinIO in this phase.

## Validation

- No additional code modification for G was required.
- Storage tests: 123 passing.
- DB typecheck: passing.
- Whole typecheck: 27 apps/packages successful.
- Lint: green (worse-than-baseline warning remains in web pre-existing config).
- Format: green.
- (See prior reports for DB evidence.)

## Retained residual risk (explicitly NOT claimed closed)

1. **WOPIToken lifetime 12h:** while terminal saves return 423 appropriately, sessions remain usable and retries can occur. Does not turn G2 into pass.
2. **Un-revokeability of browser-style presigned URLs:** bounded by TTL + reconciliation (E3-F). No live redeeming-client behavior included in this evidence.
3. **Out-of-process deletes:** MinIO retention, operator access, bucket versioning, filesystem lifecycle, SeaweedFS auto-expiry remain system-visible risks; manual seats keep noun gate UI option. If the tenant cannot safely guarantee none occur, G2 is still blocked.

## Recommendation

G should be treated as an **audit-and-confirmation pass** rather than a feature commit. External lifecycle observability still requires persistent vendor simulation logs. Continue G2 in blocked state.
