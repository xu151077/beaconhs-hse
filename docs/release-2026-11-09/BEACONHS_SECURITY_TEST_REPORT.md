# BeaconHS 安全测试报告 — 2026-11-09

## 环境

- 主机：`test-Virtual-Machine` / Ubuntu 24.04.5，`test`/`/home/test`
- 基线：`hse-platform` `20d0c78f+`（含本轮修复）
- 测试 DB：**未启用真实 DB 集成**（`docker compose` 未跑本地 PG/Redis/MinIO；`vitest` 均为 SQLite Mock / 源码合同）。未连接生产库，未跑迁移，未跑 A3。

## 命令与结果

| 门禁          | 命令                                                              | 结果     | 数量/说明                                                            |
| ------------- | ----------------------------------------------------------------- | -------- | -------------------------------------------------------------------- |
| Format        | `pnpm format:check`                                               | **0**    | 本轮改动文件全过；13 报告 md 已补 Prettier                           |
| Lint          | `pnpm lint`                                                       | **0**    | turbo lint 通过                                                      |
| Typecheck     | `pnpm --filter @beaconhs/web --filter @beaconhs/tenant typecheck` | **0**    | `tenant`/`web` Done（`db` 单独亦在全量中）                           |
| Unit API      | `vitest run src/lib/api/security.test.ts permissions.test.ts`     | **通过** | 2 文件 14/14（含新增 1 合同）                                        |
| Unit tenant   | `vitest run`（`packages/tenant`）                                 | **通过** | 14/14                                                                |
| Unit web 全量 | `vitest run`（`@beaconhs/web`）                                   | **通过** | 2213/2226，13 跳                                                     |
| Unit db       | `vitest run`（`@beaconhs/db`）                                    | **通过** | 513/554，41 跳；含 `production-cutover 19` 与 `fk-snapshot-coverage` |
| Deadcode      | `pnpm deadcode:check`                                             | **0**    | knip                                                                 |
| Build         | `pnpm build --force`                                              | **0**    | 4 任务，约 9 分钟（低内存长耗时）                                    |

## 真实 DB 验证范围

- **已覆盖（静态/模拟）：** 租户 GUC `set_config(is_local)`、pool 复用、`FORCE RLS` 注册等价（`rls.test.ts`）、CAS/锁/CAS 见 A3 脚本、`fk-snapshot`/`production-cutover` 快照链。
- **未覆盖（需活库）：** 活库 RLS 零行/有行、并发写竞态实跑、审计不可篡改触发器落库后 `UPDATE/DELETE` 抛错验证、迁移在新库/已有库/重放/中断恢复实测、端到端 HTTP+DB 全链（创建/改/批/上传/下载/删/审计生成/跨租户拒）。此类均列【待验证】，未以 Mock 冒充真实 DB。
- **A3 脚本：** 仅静态复核与测试断言，未执行 audit/apply（任务禁令）。

## 未通过及未执行

- 未通过：**0**。
- 未执行：Integration（HTTP 真实）、RLS（活库）、E2E、Database Migration（落库/升级/重放）——原因：无可安全隔离的测试 DB 与对象存储，且任务禁连生产库/跑迁移。后续独立 DB 授权后再补。

## 0056 专项补充（真实 PG）

- `audit-immutability.test.ts`：ephemeral `postgres:16-alpine` + 最小 schema，覆盖 16 项（INSERT 准、UPDATE/DELETE/TRUNCATE/级联/禁用触发器/改函数/BYPASS 拒、owner 例外准、FK 缺席/重放/未验证/异定义）3 例全过；journal/快照链静态断言通过。
- 全链 0000→0056 活库迁移未在本轮执行（需独立 DB 授权），列为未验证。

## 0056 专项补充

- `audit-immutability.test.ts` 补专用角色（有 UPDATE/DELETE 仍被触发器拒）分离权限层/触发器层。
- 门禁终检：format 0 / lint 0 / typecheck 0 / test 26/26 / deadcode 0 / build 0（build 1m43s）。
