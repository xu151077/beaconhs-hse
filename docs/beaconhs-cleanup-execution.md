# BeaconHS — Cleanup Execution Report

> **Status:** execution complete · **Date:** 2026-09-29 · **Repo:** `/home/test/projects/beaconhs-hse`
> **HEAD:** `70da27c4` (unchanged, 952 commits intact)
> Predecessor: [beaconhs-cleanup-inventory.md](./beaconhs-cleanup-inventory.md)
>
> **Nothing was redeployed.** This phase removed the previous environment only.

## 摘要（中文执行摘要）

清理**完全成功**，且与第一阶段盘点**零偏差**。

**已删除：**

- 5 个容器（postgres / redis / storage / mailpit / collabora）
- 3 个 volume（postgres-data / redis-data / storage-data）
- 1 个 project network（`beaconhs-hse_default`）
- 5 个镜像（seaweedfs / postgres / redis / mailpit / collabora，共约 3.1 GB）

**已保留：**

- `hello-world:latest` —— 非 BeaconHS 资源，未触碰
- Docker 内置网络 `bridge` / `host` / `none` —— 未触碰
- Git 仓库、952 条提交、`.git/` —— 未触碰
- 7 份审计文档 —— 未修改（mtime 保持写入时原值）
- `docker-compose.yml` —— **保持 SeaweedFS 版本未动**（按要求不用 git checkout/restore/reset）

**最终 Docker 状态：0 容器 / 1 镜像（hello-world）/ 0 volume / 3 内置网络。**

**⚠️ 一个需要下一阶段注意的点：**

`docker-compose.yml` 按要求保持 SeaweedFS 配置**未恢复**。下一阶段需要用 BeaconHS 官方
Compose 恢复 MinIO 定义。本阶段已预先创建 `docker-compose.yml.pre-cleanup-backup`
（SeaweedFS 状态备份），另有 `docker-compose.yml.bak`（MinIO 状态，mtime 未变）
作为官方 Compose 的对照参考。

**CLEANUP VERIFIED**

---

# 1. Pre-cleanup resources (re-verified, matched inventory exactly)

Verified immediately before any destructive action. **No discrepancy with the inventory —
execution proceeded.**

| Resource  | Name                         | State                    | Inventory match |
| --------- | ---------------------------- | ------------------------ | --------------- |
| Container | `beaconhs-postgres`          | Up 45 h (healthy)        | ✅              |
| Container | `beaconhs-redis`             | Up 45 h (healthy)        | ✅              |
| Container | `beaconhs-storage`           | Up 45 h                  | ✅              |
| Container | `beaconhs-mailpit`           | Up 45 h (healthy)        | ✅              |
| Container | `beaconhs-collabora`         | Up 45 h (healthy)        | ✅              |
| Volume    | `beaconhs-hse_postgres-data` | 46.2 MB                  | ✅              |
| Volume    | `beaconhs-hse_redis-data`    | 4.0 KB                   | ✅              |
| Volume    | `beaconhs-hse_storage-data`  | 2.5 MB                   | ✅              |
| Network   | `beaconhs-hse_default`       | bridge                   | ✅              |
| Image     | `chrislusf/seaweedfs:latest` | 729 MB (`ce9e796f1fe6`)  | ✅              |
| Image     | `postgres:16-alpine`         | 420 MB (`721873c34ceb`)  | ✅              |
| Image     | `redis:7-alpine`             | 57.8 MB (`858f009f9709`) | ✅              |
| Image     | `axllent/mailpit:latest`     | 50.7 MB (`ed9b00c609e7`) | ✅              |
| Image     | `collabora/code:latest`      | 1.84 GB (`4e983196eb98`) | ✅              |
| Image     | `hello-world:latest`         | 25.9 kB                  | ✅ (preserved)  |

## 1.1 Compose project ownership — confirmed before teardown

```
docker compose ls  ->  Name: beaconhs-hse
                       Status: running(5)
                       Config files: /home/test/projects/beaconhs-hse/docker-compose.yml
```

All 5 containers carried `com.docker.compose.project=beaconhs-hse` and
`com.docker.compose.project.working_dir=/home/test/projects/beaconhs-hse`.

## 1.2 Pre-cleanup git state

```
 M docker-compose.yml
?? docker-compose.yml.bak
?? docs/beaconhs-*.md  (7 audit docs)
?? docs/hse-gap-analysis.md
```

All 7 protected audit documents confirmed present with expected byte sizes before any action.

---

# 2. Resources actually deleted

## 2.1 Container teardown

Command (the profile flag is mandatory — see §2.4):

```bash
docker compose --profile local-db down -v --remove-orphans
```

Observed output, in order:

```
Container beaconhs-collabora  Stopping / Stopped / Removing / Removed
Container beaconhs-storage    Stopping / Stopped / Removing / Removed
Container beaconhs-postgres   Stopping / Stopped / Removing / Removed
Container beaconhs-redis      Stopping / Stopped / Removing / Removed
Container beaconhs-mailpit    Stopping / Stopped / Removing / Removed
Volume beaconhs-hse_postgres-data  Removing -> Removed
Volume beaconhs-hse_storage-data   Removing -> Removed
Volume beaconhs-hse_redis-data     Removing -> Removed
Network beaconhs-hse_default       Removing -> Removed
EXIT=0
```

## 2.2 Image removal

```bash
docker rmi chrislusf/seaweedfs:latest
  Untagged: chrislusf/seaweedfs:latest
  Deleted:  sha256:ce9e796f1fe6f06968f4c04bdaf8f678dad9c8acdfef3d244133d71bfa6bf882

docker rmi postgres:16-alpine
  Untagged: postgres:16-alpine
  Deleted:  sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea

docker rmi redis:7-alpine
  Untagged: redis:7-alpine
  Deleted:  sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499

docker rmi axllent/mailpit:latest
  Untagged: axllent/mailpit:latest
  Deleted:  sha256:ed9b00c609e77e99c79b93f1178255ebc271868920f2c69a8d166bd5634ed10d

docker rmi collabora/code:latest
  Untagged: collabora/code:latest
  Deleted:  sha256:4e983196eb9878f339cc506c38c21f1cc3473bca3d6de883c5de08f9c0cc3a6c
```

Images were removed **individually by name**, never via `docker image prune` or
`docker system prune`. Before removal, each was confirmed to have
`referenced_by_containers=0`.

## 2.3 Deleted resource summary

| Type       | Count | Names                                                 | Reclaimed |
| ---------- | ----- | ----------------------------------------------------- | --------- |
| Containers | 5     | `beaconhs-{postgres,redis,storage,mailpit,collabora}` | —         |
| Volumes    | 3     | `beaconhs-hse_{postgres,redis,storage}-data`          | 50.35 MB  |
| Networks   | 1     | `beaconhs-hse_default`                                | —         |
| Images     | 5     | seaweedfs, postgres, redis, mailpit, collabora        | ~3.10 GB  |

## 2.4 Why `--profile local-db` was mandatory

The inventory (and a live check) established this trap:

```
$ docker compose config --services
mailpit / redis / storage / collabora        <-- postgres absent

$ docker compose --profile local-db config --services
postgres / redis / storage / collabora / mailpit
```

`postgres` is declared under `profiles: [local-db]` (`docker-compose.yml:5-9`). A plain
`docker compose down` would have **left `beaconhs-postgres` and
`beaconhs-hse_postgres-data` behind**, and the surviving container would have kept host port
**5433** bound, colliding with the upcoming deployment. The profile flag removed it correctly —
confirmed by the `beaconhs-postgres Removed` line in the teardown output.

---

# 3. Docker state after cleanup

## 3.1 Containers

```
$ docker ps -a
CONTAINER ID   IMAGE   COMMAND   CREATED   STATUS   PORTS   NAMES

container count: 0
```

## 3.2 Images

```
$ docker images -a
IMAGE                ID             DISK USAGE   CONTENT SIZE   EXTRA
hello-world:latest   5e2309035332   25.9kB         9.49kB

image count: 1
```

## 3.3 Volumes

```
$ docker volume ls
DRIVER    VOLUME NAME

volume count: 0
```

## 3.4 Networks

```
$ docker network ls
NETWORK ID     NAME      DRIVER    SCOPE
0d32b2067f36   bridge    bridge    local
603eea017e64   host      host      local
a779ae2481e4   none      null      local
```

## 3.5 Disk usage

```
$ docker system df
TYPE            TOTAL     ACTIVE     SIZE     RECLAIMABLE
Images          1         0          36.94kB  25.87kB (70%)
Containers      0         0          0B       0B
Local Volumes   0         0          0B       0B
Build Cache     0         0          0B       0B
```

## 3.6 Compose configuration still resolves

The compose files were left intact (as required), so configuration parsing still works — proof
that nothing in the project's deployment definition was damaged:

```
$ docker compose config --services
mailpit / redis / storage / collabora

$ docker compose --profile local-db config --services
postgres / redis / storage / collabora / mailpit

$ docker compose --profile local-db config --volumes
postgres-data / redis-data / storage-data
```

**BeaconHS was not started.** Confirmed: `docker ps -a` shows zero containers.

---

# 4. Preserved resources

| Resource             | Name                   | Verification                      |
| -------------------- | ---------------------- | --------------------------------- |
| Image (non-BeaconHS) | `hello-world:latest`   | present, `5e2309035332`           |
| Network (built-in)   | `bridge`               | present, `0d32b2067f36`           |
| Network (built-in)   | `host`                 | present, `603eea017e64`           |
| Network (built-in)   | `none`                 | present, `a779ae2481e4`           |
| Git repository       | `.git/`                | present                           |
| Git history          | 952 commits            | `git rev-list --count HEAD` = 952 |
| OpenCode config      | `/home/test/.opencode` | untouched                         |
| Project source       | entire worktree        | untouched                         |

## 4.1 Commands deliberately NOT used

| Forbidden                        | Used?  |
| -------------------------------- | ------ |
| `git reset --hard`               | **No** |
| `git reset`                      | **No** |
| `git clean` (any form)           | **No** |
| `git restore`                    | **No** |
| `git checkout -- <file>`         | **No** |
| `docker system prune` (any form) | **No** |
| `docker image prune`             | **No** |
| `docker volume prune`            | **No** |
| `docker container prune`         | **No** |
| Deleting `.git`                  | **No** |
| Modifying `packages/storage`     | **No** |
| Modifying DB schema              | **No** |

The only write operations performed against the project directory were: creating
`docker-compose.yml.pre-cleanup-backup`, and creating this report.

---

# 5. Git working-tree state

```
$ git status --short
 M docker-compose.yml
?? docker-compose.yml.bak
?? docker-compose.yml.pre-cleanup-backup
?? docs/beaconhs-architecture.md
?? docs/beaconhs-capability-matrix.md
?? docs/beaconhs-cleanup-inventory.md
?? docs/beaconhs-extension-points.md
?? docs/beaconhs-seaweedfs-impact.md
?? docs/beaconhs-seaweedfs-verification.md
?? docs/beaconhs-storage-audit.md
?? docs/hse-gap-analysis.md
```

| Check          | Value                                            |
| -------------- | ------------------------------------------------ |
| HEAD           | `70da27c4` — **unchanged**                       |
| Branch         | `main`                                           |
| Commit count   | 952 — **unchanged**                              |
| Upstream       | `## main...origin/main` — in sync, no divergence |
| Stash          | 0 entries                                        |
| `git fsck`     | no errors                                        |
| `.git/`        | present                                          |
| Staged changes | none                                             |
| Deleted files  | none                                             |

## 5.1 `docker-compose.yml` intentionally left as-is

Per §8 of the task, the file was **not** restored. It still carries the SeaweedFS definition:

```
size:    2811 B
mtime:   2026-09-27 17:58:06      (unchanged since before cleanup)
markers: minio=0  seaweedfs=1
```

## 5.2 Compose file trio

| File                                    | Size   | mtime            | Content   | Role                           |
| --------------------------------------- | ------ | ---------------- | --------- | ------------------------------ |
| `docker-compose.yml`                    | 2811 B | 2026-09-27 17:58 | SeaweedFS | active file, untouched         |
| `docker-compose.yml.bak`                | 2913 B | 2026-09-27 17:42 | **MinIO** | original backup, **untouched** |
| `docker-compose.yml.pre-cleanup-backup` | 2811 B | 2026-09-27 17:58 | SeaweedFS | **newly created** this phase   |

The new backup was verified byte-identical to its source (`cmp` → identical). The existing
`.bak` retains its original mtime, confirming it was neither rewritten nor deleted.

> **For the next phase:** `docker-compose.yml.bak` already contains BeaconHS's committed
> MinIO-based definition and is a byte-for-byte equivalent of the file at `HEAD`. It is the
> natural reference for restoring the official container stack, and doing so can be recorded as
> an explicit, auditable file operation rather than a Git mutation.

---

# 6. Audit document protection verification

`ls -lh docs/` — 16 markdown files (15 in `docs/`, 1 in `docs/migration/`).

## 6.1 The 7 protected documents

| File                                      | Size     | mtime               | Status                  |
| ----------------------------------------- | -------- | ------------------- | ----------------------- |
| `docs/beaconhs-architecture.md`           | 80,009 B | 2026-09-29 11:40:54 | **PRESENT, unmodified** |
| `docs/beaconhs-capability-matrix.md`      | 35,613 B | 2026-09-29 11:40:20 | **PRESENT, unmodified** |
| `docs/beaconhs-extension-points.md`       | 52,464 B | 2026-09-29 11:40:21 | **PRESENT, unmodified** |
| `docs/beaconhs-seaweedfs-impact.md`       | 41,542 B | 2026-09-29 11:40:21 | **PRESENT, unmodified** |
| `docs/beaconhs-seaweedfs-verification.md` | 36,287 B | 2026-09-29 12:10:21 | **PRESENT, unmodified** |
| `docs/beaconhs-storage-audit.md`          | 59,394 B | 2026-09-29 11:40:21 | **PRESENT, unmodified** |
| `docs/hse-gap-analysis.md`                | 33,669 B | 2026-09-29 11:40:21 | **PRESENT, unmodified** |

**Result: 7 present, 0 missing, 0 modified.** Every mtime predates this cleanup phase, proving
none was rewritten.

## 6.2 All other documentation

| File                                  | Size      | Tracked             |
| ------------------------------------- | --------- | ------------------- |
| `docs/IMPLEMENTATION_PLAN.md`         | 61 K      | yes                 |
| `docs/LEGACY_REPORT_PARITY.md`        | 8.5 K     | yes                 |
| `docs/PRODUCTION_RUNBOOK.md`          | 19 K      | yes                 |
| `docs/QUICKSTART.md`                  | 3.2 K     | yes                 |
| `docs/TENANT_RELATIONAL_INTEGRITY.md` | 8.8 K     | yes                 |
| `docs/entity-creation-conventions.md` | 13 K      | yes                 |
| `docs/monitored-sessions-design.md`   | 5.7 K     | yes                 |
| `docs/migration/README.md`            | —         | yes                 |
| `docs/beaconhs-cleanup-inventory.md`  | 28 K      | no (phase 1 output) |
| `docs/beaconhs-cleanup-execution.md`  | this file | no                  |

**No documentation was deleted or altered.**

---

# 7. Residual resource check

Direct answers to the four required questions:

| #   | Question                       | Answer   | Evidence                                           |
| --- | ------------------------------ | -------- | -------------------------------------------------- |
| 7   | Residual BeaconHS containers?  | **NONE** | `docker ps -a` → 0 containers                      |
| 8   | Residual SeaweedFS containers? | **NONE** | `beaconhs-storage` removed; total count 0          |
| 9   | Residual BeaconHS volumes?     | **NONE** | `docker volume ls` → 0 volumes                     |
| 10  | Residual SeaweedFS volumes?    | **NONE** | `beaconhs-hse_storage-data` removed; total count 0 |
| 11  | Residual SeaweedFS images?     | **NONE** | `docker images` → only `hello-world:latest`        |

## 7.1 Label-scoped sweep (independent confirmation)

```bash
docker ps -a      --filter 'label=com.docker.compose.project=beaconhs-hse'   -> empty
docker volume ls  --filter 'label=com.docker.compose.project=beaconhs-hse'   -> empty
docker network ls --filter 'label=com.docker.compose.project=beaconhs-hse'   -> empty
```

## 7.2 Name-scoped sweep

| Pattern searched                      | Matches                                |
| ------------------------------------- | -------------------------------------- |
| `beaconhs-*` containers               | 0                                      |
| `beaconhs-hse_*` volumes              | 0                                      |
| `beaconhs-hse_*` networks             | 0                                      |
| `chrislusf/seaweedfs` images          | 0                                      |
| `minio` containers / images / volumes | 0 (none existed before cleanup either) |

---

# 8. Environment readiness for the next phase

The host is now clean and ready for a fresh BeaconHS deployment.

| Requirement                                          | Status                                                                                           |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Host ports `5433, 6380, 9000, 9001, 8025, 9980` free | ✅ all released (no containers)                                                                  |
| Project network name free                            | ✅ `beaconhs-hse_default` gone                                                                   |
| Volume names free                                    | ✅ all 3 gone                                                                                    |
| No conflicting images                                | ✅ only `hello-world` remains                                                                    |
| Compose definition parseable                         | ✅ verified                                                                                      |
| Database state                                       | Fresh — no volume, so a redeploy starts with an empty cluster requiring `db:migrate` + `db:seed` |
| Redis state                                          | Fresh — empty                                                                                    |
| Object storage state                                 | Fresh — no volume                                                                                |

## 8.1 Carried forward to the next phase

1. **`docker-compose.yml` still holds the SeaweedFS definition.** The deployment task must
   restore BeaconHS's official (MinIO) container definition, with a recorded, auditable file
   operation. `docker-compose.yml.bak` (MinIO, mtime untouched) is the reference copy.
2. **`.env` still holds the SeaweedFS-era storage settings**, including
   `AWS_REQUEST_CHECKSUM_CALCULATION=WHEN_REQUIRED` and the credentials set during verification.
   The credentials must remain set — `packages/storage/src/index.ts:39-40` uses `??`, which does
   not fall back on an empty string, so an empty `R2_ACCESS_KEY_ID` breaks every upload. The
   checksum variable becomes redundant under MinIO.
3. **The database has never been migrated.** After redeploy, `pnpm db:migrate` and
   `pnpm db:seed` are required before the application is usable.
4. **Collabora is 1.84 GB and was removed.** Decide whether to redeploy it; it is only required
   for in-browser PPTX editing (`COLLABORA_URL` empty disables that feature while PPTX
   import/download keep working).
5. **Images will be re-pulled on `up`** — roughly 3.1 GB of downloads.

---

# 9. Verdict

## CLEANUP VERIFIED

All required verifications passed:

- ✅ Pre-execution state matched the inventory exactly — no discrepancy, no guessing
- ✅ All BeaconHS containers removed, **including the profile-gated `beaconhs-postgres`**
- ✅ All BeaconHS volumes removed
- ✅ BeaconHS project network removed
- ✅ All 5 BeaconHS/SeaweedFS images removed by name
- ✅ `hello-world:latest` preserved
- ✅ Docker built-in networks `bridge` / `host` / `none` preserved
- ✅ Git repository, HEAD `70da27c4`, and 952 commits intact; `git fsck` clean
- ✅ No forbidden command used (`git reset*`, `git clean`, `git restore`, `git checkout --`,
  `docker system prune*`, `docker image/volume/container prune`)
- ✅ All 7 protected audit documents present and unmodified
- ✅ `docker-compose.yml` left untouched as SeaweedFS version (per §8)
- ✅ BeaconHS not started
- ✅ No source, `packages/storage`, or database schema modified

**No residual BeaconHS or SeaweedFS resource of any kind remains on the host.**

## 9.1 Stop condition

Per §11, execution stops here. Not done in this phase, by design:

- MinIO not restored
- BeaconHS not started
- `docker-compose.yml` not modified
- `.env` not modified
- No database migration or seed executed
- No source code modified
- No HSE development started

---

## Related documents

- [Cleanup inventory](./beaconhs-cleanup-inventory.md) — the read-only reconnaissance
- [SeaweedFS verification](./beaconhs-seaweedfs-verification.md) — why the migration was reverted
- [SeaweedFS impact](./beaconhs-seaweedfs-impact.md) — the static migration analysis
- [Storage audit](./beaconhs-storage-audit.md) — the object storage subsystem
- [Architecture audit](./beaconhs-architecture.md) — the wider system
- [HSE gap analysis](./hse-gap-analysis.md) — product capability
