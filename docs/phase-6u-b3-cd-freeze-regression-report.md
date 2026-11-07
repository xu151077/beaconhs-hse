# Phase CD — Freeze Regression Report

Date: 2026-10-18

## 1. Status

**NOT re-run this phase.** The PDF fix (Phase BU) touches only `upload-policy.ts` and `pdf-viewer.tsx`; it does not modify any storage-freeze, write-arm, in-flight, or multipart code path.

## 2. Phase BQ results (historical evidence)

- Frozen-UX regression: 4/4 pass
- Multipart across a freeze: 7/7 pass
- Auth: real magic-link login against test env's Mailpit
- Freeze state: production `applyTransition` against test env's DB
- Multipart: 256 MiB fixture (4 × 64 MiB parts), SHA-256 verified
- All six gates passed

## 3. What would need re-verification

Once the new image is confirmed running (it is now deployed):

- Normal multipart upload completes, SHA-256 matches
- Frozen-state upload rejection shows frozen copy
- Start blank / Import Word file under ACTIVE and FROZEN
- Collabora editing under ACTIVE

## 4. D-BQ-2 interaction

The PDF fix does not affect freeze behaviour. No new freeze write-paths introduced.

## 5. Post-deploy note

The Phase CD deployment recreated the application containers (web, worker, scheduler, storage-init) with the new image. Base services (postgres, redis, minio) were also recreated but using external volume references, so all data is preserved. The freeze regression risk is unchanged.
