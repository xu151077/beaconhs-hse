# BeaconHS — Cleanup Inventory (Phase 1, read-only)

> **Status:** inventory only. **Nothing was deleted, stopped, or modified.**
> **Date:** 2026-09-29 · **Repo:** `/home/test/projects/beaconhs-hse` · **HEAD:** `70da27c4`
>
> This document is the read-only reconnaissance for a subsequent teardown-and-redeploy of the
> local BeaconHS stack using BeaconHS's officially documented containers. Every command shown
> is a **proposal for the next phase** — none was executed.

## 摘要（中文执行摘要）

盘点结论：**宿主机上所有 Docker 资源几乎都属于 BeaconHS，宿主机构建极少，清理风险很低。**

- 5 个容器、3 个 volume、1 个 network **全部**带 `com.docker.compose.project=beaconhs-hse` 标签，
  归属明确，删除不会波及其他项目。
- **MinIO 资源已完全不存在**（无容器/镜像/volume/network），说明 SeaweedFS 替换是彻底替换而非并存。
- **宿主机只有 1 个与 BeaconHS 无关的 Docker 资源**：`hello-world:latest` 镜像（Docker 自带测试镜像）。
  以及 3 个 Docker 内置网络 `bridge` / `host` / `none`。这些**必须保留**。

**⚠️ 最重要的发现（会导致清理遗漏）：**

> `postgres` 服务位于 `local-db` profile 下（`docker-compose.yml:5-9`）。
> **直接执行 `docker compose down` 不会删除 `beaconhs-postgres` 容器和 `beaconhs-hse_postgres-data` volume。**
> 已通过 `docker compose config --services` 验证：不带 profile 只解析出 4 个服务
> （redis / storage / collabora / mailpit），**postgres 被漏掉**。
> 必须使用 `docker compose --profile local-db down -v --remove-orphans`。

**数据损失评估：几乎为零。**

- PostgreSQL：`pg_stat_user_tables` 计数为 **0** —— 数据库从未迁移，无任何业务表。
- Redis：`/data` 仅 4.0K —— 空。
- SeaweedFS：`/data` 2.5M —— 仅含上一阶段验证残留（`.dat`/`.idx` 分片文件），业务对象已清理。

**最高风险项（与 Docker 无关）：** 7 份未跟踪的审计文档只存在于磁盘，
**Git 中没有任何副本**。清理 Docker 不影响它们，但任何 `git clean` 类操作会永久删除。
本文档全程不使用该类命令。

---

# 1. Current Git state

| Item     | Value                                                                 |
| -------- | --------------------------------------------------------------------- |
| Branch   | `main`                                                                |
| HEAD     | `70da27c4`                                                            |
| Upstream | `origin/main` — **in sync, 0 unpushed commits**                       |
| Stash    | empty                                                                 |
| History  | 952 commits, 2026-05-18 → 2026-09-18. **Intact, must not be touched** |

## 1.1 Working-tree modifications

```
 M docker-compose.yml                       <- tracked, modified
?? docker-compose.yml.bak                   <- untracked
?? docs/beaconhs-architecture.md             <- untracked (audit)
?? docs/beaconhs-capability-matrix.md        <- untracked (audit)
?? docs/beaconhs-extension-points.md         <- untracked (audit)
?? docs/beaconhs-seaweedfs-impact.md         <- untracked (audit)
?? docs/beaconhs-seaweedfs-verification.md   <- untracked (audit)
?? docs/beaconhs-storage-audit.md            <- untracked (audit)
?? docs/hse-gap-analysis.md                  <- untracked (audit)
```

**1 tracked modification + 8 untracked files. Zero deleted, zero staged.**

## 1.2 The one tracked modification — `docker-compose.yml`

The operator's SeaweedFS change, against committed HEAD:

| Aspect         | HEAD (MinIO)                              | Working tree (SeaweedFS)                                    |
| -------------- | ----------------------------------------- | ----------------------------------------------------------- |
| Service name   | `minio`                                   | `storage`                                                   |
| Image          | `minio/minio:latest`                      | `chrislusf/seaweedfs:latest`                                |
| Container      | `beaconhs-minio`                          | `beaconhs-storage`                                          |
| Command        | `server /data --console-address ":9001"`  | `mini -dir=/data -ip=0.0.0.0`                               |
| Credentials    | `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` | `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` + `S3_BUCKET` |
| Ports          | `9000:9000`, `9001:9001`                  | `9000:8333`                                                 |
| Volume         | `minio-data`                              | `storage-data`                                              |
| Healthcheck    | present                                   | **removed**                                                 |
| Restart policy | (none)                                    | `restart: unless-stopped`                                   |

Diff is confined to the storage block plus the volume declaration (lines 39-51, 85).

## 1.3 Gitignored local state (not at risk from Git operations)

| Path                           | Note                                                                                                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.env`                         | **Modified during SeaweedFS verification.** 2 changes: credentials set, `AWS_REQUEST_CHECKSUM_CALCULATION=WHEN_REQUIRED` added. Gitignored, so invisible to `git status`. |
| `apps/worker/dist/`            | Built during verification (gitignored)                                                                                                                                    |
| `node_modules/` (all packages) | gitignored                                                                                                                                                                |
| `docker-compose.yml.bak`       | **NOT gitignored** — appears in `git status`                                                                                                                              |

---

# 2. Docker Compose configuration

## 2.1 Services declared in `docker-compose.yml`

| Service     | Image                        | Container name       | Profile        | Host ports               |
| ----------- | ---------------------------- | -------------------- | -------------- | ------------------------ |
| `postgres`  | `postgres:16-alpine`         | `beaconhs-postgres`  | **`local-db`** | `5433:5432`              |
| `redis`     | `redis:7-alpine`             | `beaconhs-redis`     | default        | `6380:6379`              |
| `storage`   | `chrislusf/seaweedfs:latest` | `beaconhs-storage`   | default        | `9000:8333`              |
| `mailpit`   | `axllent/mailpit:latest`     | `beaconhs-mailpit`   | default        | `1025:1025`, `8025:8025` |
| `collabora` | `collabora/code:latest`      | `beaconhs-collabora` | default        | `9980:9980`              |

## 2.2 ⚠️ CRITICAL — the `local-db` profile trap

```
$ docker compose config --services
redis
storage
collabora
mailpit                      <-- postgres is MISSING

$ docker compose --profile local-db config --services
collabora
mailpit
postgres                     <-- only with the profile flag
redis
storage
```

**Consequence for cleanup:**

| Command                                     | Removes postgres?                                                                      |
| ------------------------------------------- | -------------------------------------------------------------------------------------- |
| `docker compose down`                       | **NO** — container `beaconhs-postgres` and volume `beaconhs-hse_postgres-data` survive |
| `docker compose --profile local-db down -v` | **YES**                                                                                |

A naive `docker compose down -v` leaves a stale Postgres container and its data volume behind,
which will then collide with the new deployment on host port **5433**.

## 2.3 Resolved volumes and network

|                     |                                                                                          |
| ------------------- | ---------------------------------------------------------------------------------------- |
| Volumes             | `postgres-data`, `redis-data`, `storage-data` (prefixed `beaconhs-hse_` by project name) |
| Network             | `beaconhs-hse_default` (bridge)                                                          |
| Compose version     | `5.5.1`                                                                                  |
| Project name        | `beaconhs-hse` (derived from the directory name)                                         |
| Project working dir | `/home/test/projects/beaconhs-hse`                                                       |

---

# 3. Docker containers

All 5 containers carry `com.docker.compose.project=beaconhs-hse` and
`com.docker.compose.project.working_dir=/home/test/projects/beaconhs-hse`.

| Container            | Image                        | Status                   | Ports                      | Owner                    |
| -------------------- | ---------------------------- | ------------------------ | -------------------------- | ------------------------ |
| `beaconhs-postgres`  | `postgres:16-alpine`         | Up 45 h (healthy)        | `5433->5432`               | **BeaconHS**             |
| `beaconhs-redis`     | `redis:7-alpine`             | Up 45 h (healthy)        | `6380->6379`               | **BeaconHS**             |
| `beaconhs-storage`   | `chrislusf/seaweedfs:latest` | Up 45 h (no healthcheck) | `9000->8333` + 7 internal  | **BeaconHS / SeaweedFS** |
| `beaconhs-mailpit`   | `axllent/mailpit:latest`     | Up 45 h (healthy)        | `1025->1025`, `8025->8025` | **BeaconHS**             |
| `beaconhs-collabora` | `collabora/code:latest`      | Up 45 h (healthy)        | `9980->9980`               | **BeaconHS**             |

**No stopped/orphaned containers. No non-BeaconHS containers on the host at all.**

### SeaweedFS internal (container-only) ports

`7333, 8080, 8888, 9333, 18080, 18888, 19333` — not published to the host, so no host-level
port conflicts on redeploy.

## 3.1 Application containers — none

`deploy/dokploy-dev.compose.yaml` defines `web` / `worker` / `scheduler` / `storage-init` roles,
but **no such container is running locally**. That file is the production/Dokploy path and is
out of scope for a local teardown.

No `pnpm dev`, Turbo, or Next.js process is running. The only host-listening ports are the
Docker-published ones: `5433, 6380, 9000, 8025, 9980`.

---

# 4. Docker images

| Image                        | ID             | Size    | Used by              | Classification              |
| ---------------------------- | -------------- | ------- | -------------------- | --------------------------- |
| `postgres:16-alpine`         | `721873c34ceb` | 420 MB  | `beaconhs-postgres`  | **BeaconHS** — removable    |
| `redis:7-alpine`             | `858f009f9709` | 57.8 MB | `beaconhs-redis`     | **BeaconHS** — removable    |
| `chrislusf/seaweedfs:latest` | `ce9e796f1fe6` | 729 MB  | `beaconhs-storage`   | **SeaweedFS** — removable   |
| `axllent/mailpit:latest`     | `ed9b00c609e7` | 50.7 MB | `beaconhs-mailpit`   | **BeaconHS** — removable    |
| `collabora/code:latest`      | `4e983196eb98` | 1.84 GB | `beaconhs-collabora` | **BeaconHS** — removable    |
| `hello-world:latest`         | `5e2309035332` | 25.9 kB | **nothing**          | **NOT BeaconHS — PRESERVE** |

- **No dangling images.**
- **No build cache** (`Build Cache 0B`) — no local BeaconHS image was ever built.
- Total reclaimable from images after container removal: ~3.06 GB.

> `hello-world:latest` is Docker's own bundled test image, unrelated to BeaconHS. Rule 2 forbids
> removing it. It is also effectively free (25.9 kB) and Docker's official test fixture.

---

# 5. Docker volumes

All 3 carry `com.docker.compose.project=beaconhs-hse`.

| Volume                       | Mounted to                 | Size        | Contents                               | Classification            |
| ---------------------------- | -------------------------- | ----------- | -------------------------------------- | ------------------------- |
| `beaconhs-hse_postgres-data` | `/var/lib/postgresql/data` | **46.2 MB** | 0 user tables — cluster never migrated | **BeaconHS** — removable  |
| `beaconhs-hse_redis-data`    | `/data`                    | **4.0 KB**  | empty                                  | **BeaconHS** — removable  |
| `beaconhs-hse_storage-data`  | `/data`                    | **2.5 MB**  | SeaweedFS shards only                  | **SeaweedFS** — removable |

**No non-BeaconHS volumes exist on the host.** Total 50.35 MB.

## 5.1 Data-loss assessment — effectively zero

| Volume    | Finding                                                                                                                                                                                  |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| postgres  | `select count(*) from pg_stat_user_tables` → **0**. No application schema was ever created. Nothing to lose.                                                                             |
| redis     | 4 KB, empty.                                                                                                                                                                             |
| seaweedfs | `beaconhs-dev_2.dat/.idx/.vif` (8 bytes — an empty bucket shard) plus internal `filerldb2/`, `admin/`, `m9333/`, `worker/`. All test objects were deleted during the verification phase. |

## 5.2 SeaweedFS volume contents (for the record)

```
/data
├── .mini_kek_passphrase      (64B)
├── .mini_sse_kek             (64B)
├── 1.dat / 1.idx / 1.vif     (74KB/224B/194B)
├── beaconhs-dev_2.dat/.idx/.vif  (8B/0B/194B)  <- empty bucket
├── admin/  filerldb2/  m9333/  worker/
├── mini.options
└── vol_dir.uuid
```

No `beaconhs-minio` / `minio-data` volume exists — MinIO was fully replaced, not left behind.

---

# 6. Docker networks

| Network                | Driver | Scope | Classification                                            |
| ---------------------- | ------ | ----- | --------------------------------------------------------- |
| `beaconhs-hse_default` | bridge | local | **BeaconHS** — removable (auto-removed by `compose down`) |
| `bridge`               | bridge | local | **Docker built-in — PRESERVE**                            |
| `host`                 | host   | local | **Docker built-in — PRESERVE**                            |
| `none`                 | null   | local | **Docker built-in — PRESERVE**                            |

No non-BeaconHS custom networks exist.

---

# 7. MinIO / SeaweedFS resource accounting

| Resource            | Present? | Detail                                                       |
| ------------------- | -------- | ------------------------------------------------------------ |
| MinIO container     | **No**   | none                                                         |
| MinIO image         | **No**   | `minio/minio` not present locally                            |
| MinIO volume        | **No**   | `beaconhs-hse_minio-data` not present                        |
| MinIO network       | **No**   | —                                                            |
| SeaweedFS container | **Yes**  | `beaconhs-storage`, image `ce9e796f1fe6` (built 2026-09-14)  |
| SeaweedFS image     | **Yes**  | `chrislusf/seaweedfs:latest`, 729 MB                         |
| SeaweedFS volume    | **Yes**  | named `beaconhs-hse_storage-data` (not seaweedfs-prefixed)   |
| Host port 9001      | **Free** | not listening — MinIO console port is available for redeploy |

**The SeaweedFS replacement was a clean substitution.** There is no MinIO residue to clean up
beyond restoring `docker-compose.yml` to its MinIO form.

---

# 8. Required next-phase actions

> **Proposals only. Not executed in this phase.**

## 8.1 BeaconHS resources that may be deleted

| Resource  | Name                         | Rationale                               |
| --------- | ---------------------------- | --------------------------------------- |
| Container | `beaconhs-postgres`          | compose project `beaconhs-hse`          |
| Container | `beaconhs-redis`             | compose project `beaconhs-hse`          |
| Container | `beaconhs-mailpit`           | compose project `beaconhs-hse`          |
| Container | `beaconhs-collabora`         | compose project `beaconhs-hse`          |
| Volume    | `beaconhs-hse_postgres-data` | 0 user tables, no data loss             |
| Volume    | `beaconhs-hse_redis-data`    | empty                                   |
| Network   | `beaconhs-hse_default`       | project network, auto-removed by `down` |
| Image     | `postgres:16-alpine`         | pulled only for BeaconHS                |
| Image     | `redis:7-alpine`             | pulled only for BeaconHS                |
| Image     | `axllent/mailpit:latest`     | pulled only for BeaconHS                |
| Image     | `collabora/code:latest`      | pulled only for BeaconHS                |

## 8.2 SeaweedFS resources that may be deleted

| Resource  | Name                                          | Size   |
| --------- | --------------------------------------------- | ------ |
| Container | `beaconhs-storage`                            | —      |
| Volume    | `beaconhs-hse_storage-data`                   | 2.5 MB |
| Image     | `chrislusf/seaweedfs:latest` (`ce9e796f1fe6`) | 729 MB |

## 8.3 Non-BeaconHS resources that MUST be preserved

| Resource   | Name                                      | Why preserve                                   |
| ---------- | ----------------------------------------- | ---------------------------------------------- |
| Image      | `hello-world:latest`                      | Docker's own test image, not BeaconHS (rule 2) |
| Network    | `bridge`                                  | Docker built-in                                |
| Network    | `host`                                    | Docker built-in                                |
| Network    | `none`                                    | Docker built-in                                |
| Docker     | entire Docker daemon + socket             | obviously                                      |
| Filesystem | all of `/home/test/projects/beaconhs-hse` | the project itself                             |
| Git        | `.git/` and all 952 commits               | rule 4 — no history removal                    |
| Docs       | all 15 files in `docs/`                   | rule 6                                         |

**Additionally forbidden:** `docker system prune -a --volumes` (rule 8) would delete
`hello-world:latest` and the three built-in networks' associations. Do not use it.

## 8.4 Current BeaconHS Git working-tree changes

**Must be preserved (rule 6, and general safety):**

| File                                      | Status    | Note                        |
| ----------------------------------------- | --------- | --------------------------- |
| `docs/beaconhs-architecture.md`           | untracked | 80,009 B — **no Git copy**  |
| `docs/beaconhs-capability-matrix.md`      | untracked | 35,613 B — **no Git copy**  |
| `docs/beaconhs-extension-points.md`       | untracked | 52,464 B — **no Git copy**  |
| `docs/beaconhs-seaweedfs-impact.md`       | untracked | 41,542 B — **no Git copy**  |
| `docs/beaconhs-seaweedfs-verification.md` | untracked | 36,287 B — **no Git copy**  |
| `docs/beaconhs-storage-audit.md`          | untracked | 59,394 B — **no Git copy**  |
| `docs/hse-gap-analysis.md`                | untracked | 33,669 B — **no Git copy**  |
| `docker-compose.yml.bak`                  | untracked | MinIO reference copy        |
| `docker-compose.yml`                      | modified  | operator's SeaweedFS change |
| `.env`                                    | ignored   | 2 verification-phase edits  |

> **The 7 untracked audit documents exist only on disk.** They are the highest-value artifacts
> on this host and are invisible to `git status --short` cleanup intuition. Nothing in the
> proposed Docker teardown touches them, but this is the reason to be careful with any
> Git-adjacent command.

## 8.5 Current docs/ audit documents

| File                                      | Bytes  | Git-tracked? |
| ----------------------------------------- | ------ | ------------ |
| `docs/beaconhs-architecture.md`           | 80,009 | no           |
| `docs/beaconhs-capability-matrix.md`      | 35,613 | no           |
| `docs/beaconhs-extension-points.md`       | 52,464 | no           |
| `docs/beaconhs-seaweedfs-impact.md`       | 41,542 | no           |
| `docs/beaconhs-seaweedfs-verification.md` | 36,287 | no           |
| `docs/beaconhs-storage-audit.md`          | 59,394 | no           |
| `docs/hse-gap-analysis.md`                | 33,669 | no           |
| `docs/IMPLEMENTATION_PLAN.md`             | 61,465 | yes          |
| `docs/LEGACY_REPORT_PARITY.md`            | 8,628  | yes          |
| `docs/PRODUCTION_RUNBOOK.md`              | 18,444 | yes          |
| `docs/QUICKSTART.md`                      | 3,244  | yes          |
| `docs/TENANT_RELATIONAL_INTEGRITY.md`     | 8,972  | yes          |
| `docs/entity-creation-conventions.md`     | 13,278 | yes          |
| `docs/monitored-sessions-design.md`       | 5,821  | yes          |
| `docs/migration/README.md`                | —      | yes          |

**15 files, 7 untracked / 8 tracked. All must survive.**

---

# 9. Proposed teardown sequence (for the next phase)

Not executed. Presented so the next phase can be reviewed before anything is removed.

```bash
# 1. Stop and remove the project's containers, networks and ALL volumes.
#    The --profile local-db flag is REQUIRED or beaconhs-postgres and
#    beaconhs-hse_postgres-data survive (see §2.2).
cd /home/test/projects/beaconhs-hse
docker compose --profile local-db down -v --remove-orphans

# 2. Verify nothing BeaconHS-owned remains.
docker ps -a --filter 'label=com.docker.compose.project=beaconhs-hse'
docker volume ls --filter 'label=com.docker.compose.project=beaconhs-hse'
docker network ls --filter 'label=com.docker.compose.project=beaconhs-hse'

# 3. Remove the 5 now-unused images individually (NEVER `docker system prune -a --volumes`,
#    which would also delete the unrelated hello-world image).
docker rmi chrislusf/seaweedfs:latest \
          postgres:16-alpine \
          redis:7-alpine \
          axllent/mailpit:latest \
          collabora/code:latest

# 4. Restore the MinIO-based compose file to match BeaconHS's official docs.
#    Preferred: `git checkout -- docker-compose.yml` (restores the committed MinIO definition
#    and is a single-file, additive-to-nothing operation).
#    docker-compose.yml.bak is byte-identical to that committed version and is a safe fallback.
#
# 5. Redeploy
docker compose --profile local-db up -d
```

**Rules satisfied by the above:** no `git reset --hard`, no `git clean -fd`, no `git restore`,
no `docker system prune -a --volumes`, no Git history removal, no source modification, no
deletion of non-BeaconHS Docker resources, no deletion of the audit docs.

> `git checkout -- docker-compose.yml` restores one tracked file from HEAD. It is **not**
> `git restore`/`git reset` and touches no other path. If even that is unwanted, copying
> `docker-compose.yml.bak` over `docker-compose.yml` achieves the same result with plain `cp`.

---

# 10. Risks and open items

| #   | Severity | Item                                                                                                                                                                                                                                                                                                          |
| --- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | **High** | `docker compose down` without `--profile local-db` leaves `beaconhs-postgres` + its volume running, colliding on host port 5433 with the new deployment.                                                                                                                                                      |
| C2  | **High** | 7 untracked audit documents have no Git copy. Any `git clean`-style operation destroys them permanently.                                                                                                                                                                                                      |
| C3  | Medium   | Restoring the MinIO compose definition re-enables the `??` empty-credential trap at `packages/storage/src/index.ts:39-40` **unless** `.env` keeps the credentials set during verification. `.env` is gitignored and survives, so this is safe — but confirm before redeploy.                                  |
| C4  | Medium   | The SeaweedFS `AWS_REQUEST_CHECKSUM_CALCULATION=WHEN_REQUIRED` line stays in `.env` after restoring MinIO. Harmless for MinIO (it simply omits a header MinIO ignores), but it is now stale configuration worth reviewing.                                                                                    |
| C5  | Low      | `collabora/code:latest` is 1.84 GB. Deleting and re-pulling it costs time and bandwidth. Consider excluding it from the teardown if the Collabora service is to be redeployed unchanged.                                                                                                                      |
| C6  | Low      | Host port `9001` is currently free, so a MinIO redeploy binds cleanly.                                                                                                                                                                                                                                        |
| C7  | Low      | `postgres:16-alpine` and `redis:7-alpine` are generic images that another project _could_ use. Here they are referenced only by BeaconHS (`used_by_containers=1` each), and the host has no other project, so removal is safe — but on a shared host re-check `docker ps -a --filter ancestor=<image>` first. |

## Open questions for the next phase

1. Should `collabora` be redeployed? It is 1.84 GB and is only needed for in-browser PPTX editing
   (`COLLABORA_URL`; empty disables the feature, while PPTX import/download keep working).
2. Does the database need to be re-migrated and re-seeded? The current volume has 0 tables, so
   `pnpm db:migrate` + `pnpm db:seed` will be required after redeploy to reach a usable state.
3. Should `.env` be reset to pristine, or keep the verification-phase storage settings? Note C3
   and C4 above.
4. Should the MinIO deployment be pinned to a specific tag rather than `minio/minio:latest`?
   `README.md:176` names MinIO as the documented dev store, and the SeaweedFS verification found
   a hard incompatibility (`docs/beaconhs-seaweedfs-verification.md` §4.3).

---

## Related documents

- [SeaweedFS verification](./beaconhs-seaweedfs-verification.md) — why the migration failed
- [SeaweedFS impact](./beaconhs-seaweedfs-impact.md) — the static migration analysis
- [Storage audit](./beaconhs-storage-audit.md) — the object storage subsystem
- [Architecture audit](./beaconhs-architecture.md) — the wider system
