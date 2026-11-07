# Phase 6U-B3-CW — Drill status

Date: 2026-10-19  
Repository: `/home/test/projects/beaconhs-hse`  
Branch/HEAD: `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`

## 1. Read-only status

| Field                 | Value                                                              |
| --------------------- | ------------------------------------------------------------------ |
| Compose project       | `beaconhs-drill-20261009`                                          |
| Worker container      | `beaconhs-drill-20261009-worker-1`                                 |
| Container ID          | `bc5fef35aab9c6b9741e82c9a2adfd24a14108813b9606c3499f0b235ddc5bae` |
| Worker state          | `running`                                                          |
| Failed scheduled jobs | `1958`                                                             |

## 2. Containment options

1. Stop only the worker: pauses all background processing; web, database, Redis, MinIO, and phase-aj remain running.
2. Stop the entire drill stack: full isolation but removes all drill services.
3. Back up, repair schema, then restart: required if drill remains in use.

## 3. Schema drift

The drill ledger stops at `0045`; physical schema contains 0046/0047 objects but lacks the 0048 unique index and 0049/0050 `multipart_upload_id` column. Direct `pnpm db:migrate` is unsafe.

## 4. Status

Status: **BLOCKED**. No container, database, schema, ledger, or endpoint was changed. Owner approval is required before containment or repair.
