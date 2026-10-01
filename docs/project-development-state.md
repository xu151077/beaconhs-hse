# BeaconHS HSE — Project Development State

> **This file is the single durable record of where the project is.**
> Update it at the end of every sizeable development task, in the same change.

---

## 中文摘要

**当前阶段：基础设施就绪（Phase 0）。尚未开始任何 HSE 功能开发。**

BeaconHS 官方部署基线已完整恢复并通过运行时验证（PostgreSQL / Redis /
Mailpit / Collabora / MinIO、migration、seed、Web、登录、Storage E2E、
Presigned PUT/GET、Attachment）。HSE 二次开发的**分析基线已完成**，但**开发
尚未开始**。

**三份关键文档已就绪：**

| 文档                               | 内容                                                    |
| ---------------------------------- | ------------------------------------------------------- |
| `docs/hse-development-baseline.md` | HSE 能力基线、17 项能力矩阵、三个数据模型深挖、开发顺序 |
| `docs/opencode-*.md`               | OpenCode V2 基础设施基线（9 份）                        |
| 本文件                             | 项目状态、缺陷登记、下一步                              |

**最重要的结论（已实测）：** BeaconHS 记录 HSE 事件的能力很强，但**不管理
它们的闭环**——不存在 `findings` 表、不存在 `hazards` 表、不存在 `risks`
表，存在 8 条互相独立的残缺生命周期，只有 `corrective_actions` 一条同时具备
责任人 + 截止日期 + 验证 + 通知。

**下一任务：等待用户批准后，按 `docs/hse-development-baseline.md` §17 从
Phase 1（数据模型统一）开始。在此之前不做任何 HSE 功能开发。**

---

## 1. Current baseline

| Item                             | State                                                    |
| -------------------------------- | -------------------------------------------------------- |
| Git HEAD                         | `70da27c4`                                               |
| Node / pnpm / Git                | `v24.21.0` / `10.30.3` / `2.53.0`                        |
| OpenCode                         | **v2.0.18**                                              |
| TypeScript                       | `^6.0.3`                                                 |
| Compose baseline                 | `docker-compose.yml` byte-identical to `HEAD`            |
| Containers                       | postgres, redis, mailpit, minio, collabora — all healthy |
| Migrations applied               | 41                                                       |
| Public tables                    | 202                                                      |
| `FORCE ROW LEVEL SECURITY`       | 187                                                      |
| `TENANT_SCOPED_TABLES`           | 187                                                      |
| `PERMISSION_CATALOGUE`           | 89 unique keys                                           |
| Report entities / seeded reports | 16 / 32                                                  |
| Form field types                 | 46                                                       |
| Flow triggers / actions          | 6 / 13                                                   |

Storage baseline: **MinIO**, built from pinned archived source commit
`9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a` (tag `RELEASE.2025-10-15T17-29-55Z`).
25/25 acceptance conditions passed. **No SeaweedFS. `packages/storage/**`
unmodified.**

Tenant isolation proven live:

```
beaconhs_app, no app.tenant_id  -> people = 0
beaconhs_app, app.tenant_id set -> people = 10
beaconhs_super (BYPASSRLS)      -> people = 10
```

## 2. Current phase

**Phase 0 — Infrastructure and baseline. Complete.**

Specifically: storage audit and MinIO restoration, SeaweedFS incompatibility
investigation, HSE development baseline analysis, and OpenCode V2 project
infrastructure.

**Not started: any HSE feature development.** This is deliberate and was
explicitly requested.

## 3. Completed

| Work                                                                                          | Evidence                                                                       |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Official compose baseline restored                                                            | `docs/beaconhs-official-deployment-baseline.md`                                |
| Storage subsystem audit                                                                       | `docs/beaconhs-storage-audit.md`                                               |
| SeaweedFS impact analysis + runtime verification                                              | `docs/beaconhs-seaweedfs-impact.md`, `docs/beaconhs-seaweedfs-verification.md` |
| MinIO rebuilt from pinned archived source                                                     | `docs/beaconhs-minio-build.md`                                                 |
| Storage E2E verification (25/25)                                                              | `docs/beaconhs-storage-minio-verification.md`                                  |
| Cleanup inventory and execution                                                               | `docs/beaconhs-cleanup-inventory.md`, `docs/beaconhs-cleanup-execution.md`     |
| Architecture and capability audit                                                             | `docs/beaconhs-architecture.md`, `docs/beaconhs-capability-matrix.md`          |
| Extension points                                                                              | `docs/beaconhs-extension-points.md`                                            |
| HSE gap analysis                                                                              | `docs/hse-gap-analysis.md`                                                     |
| **HSE development baseline** (17-capability matrix, 3 data-model deep dives, phase plan)      | `docs/hse-development-baseline.md`                                             |
| **OpenCode V2 infrastructure** (config, permissions, 3 MCP, 12 skills, 9 agents, 9 baselines) | `docs/opencode-*.md`                                                           |

## 4. In progress

**Nothing.** The project is at a clean stopping point awaiting a decision on
which phase to start.

## 5. Blocked

| Blocker                          | Detail                                                                                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase start not authorised       | HSE feature development has not been authorised to begin. All plans are ready; nothing is in flight.                                              |
| LSP unavailable (platform)       | OpenCode V2 does not run language servers or expose LSP tools. Substitute is `pnpm typecheck` + `lint` + `test`. Not fixable in this environment. |
| GitHub MCP awaiting OAuth        | Configured; sign in via `/mcps` in the TUI. No `github_*` tool is available until then.                                                           |
| Host memory                      | ~3.4 GB RAM. Next.js page compiles have OOM-killed the dev server under parallel load. Compile one route at a time.                               |
| No E2E suite                     | No Playwright dependency, config or checked-in tests. Browser verification is via the playwright MCP and the built-in `browser` tool.             |
| Pre-existing API defect          | `POST /api/v1` returns 500: no read permission mapped for the `compliance` category. Unmodified upstream file.                                    |
| Tag-filtered lifecycle execution | Rules store and read back correctly; expiry worker did not fire in-window. Runtime behaviour of that path is UNVERIFIED.                          |

## 6. Known defects

Record only. **Do not fix as a side effect of unrelated work, and do not silently
work around them.**

| ID     | Defect                                                                                                                                                                                                         | Location                                                                                                                     |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **D1** | Nav and module-admin reference `equipment.read.self`, which is **not** in `PERMISSION_CATALOGUE` (only `equipment.read.all` / `equipment.read.site`). Passes today only because `readTierCovers` tier-maps it. | `apps/web/src/lib/nav/registry.ts:185`, `apps/web/src/lib/module-admin/registry.ts`, `packages/db/src/schema/iam.ts:208-209` |
| **D2** | The `people` nav entry has **no `requiredPermission`**, so every authenticated user sees workforce master data (emergency contacts, DOB, termination dates). Only mutations are gated (`admin.org.manage`).    | `apps/web/src/lib/nav/registry.ts:172`                                                                                       |
| **D3** | Dead columns, zero read/write usages: `training_enrollments.expires_on`, `training_enrollments.due_on`, `equipment_inspection_records.certificate`.                                                            | `packages/db/src/schema/training-lms.ts:216-217`, `packages/db/src/schema/equipment-inspection-records.ts:111`               |
| **D4** | PPE failed-inspection → corrective-action spawn omits `recordDomainEvent`, so those CAs are never notified — unlike the identical inspections path.                                                            | `apps/web/src/app/(app)/ppe/_lib.ts` vs `apps/web/src/app/(app)/inspections/_lib.ts:370`                                     |
| **D5** | Flow profile `equipment` `statusValues` omits `'repaired'` and `'verified'`, both of which exist in the DB enum and the UI filter. The flow engine cannot condition on two real states.                        | `apps/web/src/lib/flows/module-profiles.ts:577`; enum `packages/db/src/schema/equipment.ts:290-299`                          |
| **D6** | Stale comment claiming "four canonical form templates" where `CANONICAL_TEMPLATES` holds exactly one.                                                                                                          | `packages/db/src/seed.ts:1569-1570` vs `packages/db/src/canonical-templates.ts:179-189`                                      |

### Tooling and environment defects

| ID     | Issue                                                                                                                                                                                         |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **T1** | `turbo.json` `globalEnv` omits `R2_ENDPOINT` and `ATTACHMENT_CAPABILITY_SECRET`. Turbo strips unlisted vars, so `pnpm dev` needs `--env-mode=loose` for `R2_ENDPOINT` to reach `next-server`. |
| **T2** | `packages/storage/src/index.ts:39-40` uses `??`, which does **not** fall back on an empty string, while `.env.example` ships empty R2 credentials.                                            |
| **T3** | Node is under nvm and not on the default PATH: `export PATH="/home/test/.nvm/versions/node/v24.21.0/bin:$PATH"`.                                                                              |
| **T4** | `docker-compose.yml` ships empty R2 credentials that must be filled to match compose `MINIO_ROOT_*`.                                                                                          |
| **T5** | Only `apps/web` has an eslint script, so `pnpm lint` (turbo) covers one package.                                                                                                              |

### Audit corrections (self-corrections vs the earlier audit)

| Prior claim                                   | Actual at HEAD                            |
| --------------------------------------------- | ----------------------------------------- |
| 92 permission keys                            | **89**                                    |
| 12 report entities                            | **16**                                    |
| 39 form field types                           | **46**                                    |
| "equipment inspections lack inspector fields" | They have **3**; the real gap is narrower |

## 7. Architecture decisions

| #      | Decision                                                                                                                                                                                     | Rationale                                                                                         |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| ADR-1  | **Builder-first.** Native modules only for a complex state machine, dedicated API, dedicated permission, transactional cross-model logic, performance, or an authoritative queryable record. | The form engine already has 46 field types, 6 triggers, 13 actions and a gate store.              |
| ADR-2  | **Only two NEW native modules** are justified: `findings` and `risks`. Plus one new table, `machinery_certificates`.                                                                         | Every other HSE capability reuses an existing module. See `docs/hse-development-baseline.md` §15. |
| ADR-3  | **No second lifecycle.** Modules that can link to `corrective_actions` must, rather than re-inventing owner/due/verification.                                                                | Eight partial lifecycles exist today; that is the failure mode to avoid repeating.                |
| ADR-4  | **Never persist a computed risk score.** Persist likelihood/severity inputs; derive the score at render.                                                                                     | Matches the existing design at `apps/web/src/components/risk-matrix.tsx:120-123`.                 |
| ADR-5  | **Project scoping is additive, not a new subsystem.** Reuse `people_assignments` + validity window (the precedent at `packages/compliance/src/audience.ts:89-104`).                          | Avoids re-creating User/Organization/Permission concepts.                                         |
| ADR-6  | **Storage stays abstract.** MinIO is the local baseline, Cloudflare R2 the production target. No module may couple to a vendor.                                                              | `docs/beaconhs-seaweedfs-verification.md` proved vendor coupling is a real correctness risk.      |
| ADR-7  | **MinIO image built from pinned archived source**, not a floating tag or unknown prebuilt binary.                                                                                            | The official `minio/minio` Docker Hub image was deleted 2026-09-11.                               |
| ADR-8  | **Gate suppression is denied in configuration, not merely discouraged.** `--no-verify`, `eslint-disable`, `ts-ignore` are `deny` in `.opencode/opencode.jsonc`.                              | `AGENTS.md` rule 8 is enforced mechanically rather than by trust.                                 |
| ADR-9  | **Destructive git is `deny` at the permission layer**, with judgement guidance in the `git-safety` skill.                                                                                    | Mechanical blocks belong in permissions, not in a plugin hook that can fail open.                 |
| ADR-10 | **No custom tools yet.** MCP + skills + agents are sufficient.                                                                                                                               | See `docs/opencode-tools-evaluation.md`.                                                          |
| ADR-11 | **No plugins.** Built-ins plus skills and agents cover every need.                                                                                                                           | See `docs/opencode-plugin-baseline.md`.                                                           |

## 8. Next task

**Awaiting authorisation to begin Phase 1.**

When authorised, the sequence from `docs/hse-development-baseline.md` §17:

| Phase | Scope                                                                                                                                        | Exit criterion                                                                        |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| **1** | Data model unification — remove dead columns, unify expiry-status and expiry-derivation helpers, fix the `equipment` flow `statusValues` gap | Dead columns gone; one expiry-status function; `pnpm test` and `pnpm typecheck` green |
| **2** | Certificate ADAPT — add `machinery_certificates`, native expiry notifier, missing report columns/entities                                    | Certificate table migrated; notification path proven                                  |
| **3** | Finding NEW — the canonical ancestor table + typed links from all 8 lifecycles                                                               | `findings` exists; every lifecycle links; manual articles updated                     |
| **4** | Risk Register NEW — `risks` seeded from hazard rows; risk report entity/view                                                                 | Risk queryable across projects                                                        |
| 5     | _Machinery certificate — folded into Phase 2_                                                                                                | —                                                                                     |
| 6     | Action/Verification convergence — wire `flow_gates` as the generic verifier                                                                  | Work orders have due + verifier                                                       |
| 7     | Incident/Investigation completion                                                                                                            | Due date, reviewer, CA link                                                           |
| 8     | HSE Dashboard / Reports                                                                                                                      | Risk/finding datasets visible                                                         |
| 9     | Notifications completion                                                                                                                     | All module paths notified                                                             |
| 10    | ~~Permission / Project Scope~~ — **withdrawn**; removed as a permanent decision                                                              | Authorization is Permission → Role Scope → Visibility Tier only                       |

**Two independent items can proceed first, without waiting for phase approval:**

- **D2** (ungated `people` nav) is a live privacy exposure and could be fixed in
  isolation as a security improvement.
- **GitHub MCP OAuth sign-in** via `/mcps`, which unblocks repository and issue
  work.

## 9. Update protocol

On completing a sizeable task, update in the same change:

1. **§2 Current phase** — where the project now is.
2. **§3 Completed** — what shipped, with evidence.
3. **§4 In progress** — what is in flight.
4. **§5 Blocked** — anything newly blocked.
5. **§6 Known defects** — new defects, and any that were fixed (move them out).
6. **§7 Architecture decisions** — any new ADR, with rationale.
7. **§8 Next task** — the updated immediate next step.

Keep the format. A future agent reads this file first.
