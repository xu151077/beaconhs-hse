# Phase 6U-B3-DJ — Collabora docbroker observability

Date: 2026-10-19  
Repository: `/home/test/projects/beaconhs-hse`  
Branch/HEAD: `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`

## 1. What the image actually contains (read-only, local image copy)

The local and phase-aj Collabora containers run the **same image digest** `sha256:4e983196eb9878f339cc506c38c21f1cc3473bca3d6de883c5de08f9c0cc3a6c` (`collabora/code`, `26.04.4.2` per the log paths).

Inspecting an unused local copy of that image (`docker create` + `docker export`, then removed):

- `etc/coolwsd/coolwsd.xml` exists.
- `usr/bin/coolwsd`, `usr/bin/coolmount`, `usr/bin/coolforkit-caps`, `usr/bin/coolforkit-ns` exist.
- **No shell** (`/bin/sh` absent — `docker exec … sh` fails with `executable file not found`).
- **No docbroker database file** is shipped, and the running containers mount **no volumes** (`docker inspect` → `Mounts: []`), so there is no persisted per-document session store to read after the fact.

## 2. What the shipped configuration says

From `etc/coolwsd/coolwsd.xml` in that image:

| Setting                        | Value                                               | Consequence                                                                                                |
| ------------------------------ | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `logging.level`                | `warning`                                           | normal operation logs warnings and above only                                                              |
| `logging.level_startup`        | `trace`                                             | verbose only during startup                                                                                |
| `logging.disabled_areas`       | `Socket,WebSocket,Admin,Pixel`                      | WebSocket-area detail is suppressed even at higher levels                                                  |
| `logging.file`                 | `enable="false"`                                    | **nothing is written to disk**; the only sink is the container's stdout, which Docker's log driver retains |
| `trace_event`                  | `enable="false"`                                    | no Chrome trace event file                                                                                 |
| `trace` (command replay)       | `enable="false"`, empty path                        | no replay capture                                                                                          |
| `per_document.cleanup`         | enabled; idle 300 s, dirty-memory 3072 MB, CPU 85 % | this is the documented mechanism that **kills a kit** for a resource-consuming document                    |
| `per_document.limit_load_secs` | 100 s                                               | a load that exceeds it is abandoned                                                                        |

The `client not consuming tiles` warning observed on phase-aj comes from `ClientSession.cpp` at the `warning` level, so it appears with the shipped configuration. Nothing more detailed (socket/WebSocket area) is emitted.

## 3. Why the docbroker record cannot be recovered now

- The image has no shell, so no in-container inspection is possible without changing the container.
- There is no volume and no database file, so the session state lived only in the process and in stdout.
- `docker cp` of `/opt/coolwsd`, `/opt/coolwsd/data` and `/opt/coolwsd/data/docbroker.db` all fail: those paths do not exist in this image.

## 4. What would have to change (approval required — NOT executed)

To capture a docbroker session record for a future reproduction, one of these is needed. All of them are **changes to a running remote resource** and were not performed:

1. **Raise the log level for a bounded window** — start a _separate, temporary_ Collabora container with `extra_params=… --o:logging.level=information` (or `debug`) and the same image digest, attached only to the test stack. Risk: larger logs; no security change. Rollback: remove the container.
2. **Enable command trace** — `--o:trace.enable=true --o:trace.path=/tmp/cooltrace-%.gz` on that temporary container. Risk: captures document content, so it must be treated as sensitive and deleted after analysis. Rollback: remove the container.
3. **Persist logs to a volume** — enable `logging.file` on the temporary container and mount a throwaway volume. Risk: disk growth; the volume is test-only.

Doing any of this on `beaconhs-phase-aj-collabora-1` itself would require a container restart, which is out of bounds for this phase.

## 5. Status

Status: **BLOCKED** for docbroker evidence. The supported diagnostic interfaces (`/hosting/discovery` → 200) exist, but no per-session record is retained by the deployed configuration, and enabling one needs approval for a temporary container.
