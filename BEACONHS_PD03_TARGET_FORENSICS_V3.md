# PD-03 目标指纹取证 V3（P3-1，只读）

**授权：** 仅只读取证。未连接目标库、未执行盘点/Apply、未改数据、未删对象、未输出 Secret。

## 1. 本轮新增证据：本机 `SUPERADMIN_DATABASE_URL` 指纹已计算

用 `apps/web/scripts/cutover-target.ts` 的算法（`sha256('beaconhs-cutover-db-v1|hostname|port|pathname')`）对本机 `.env` 的 `SUPERADMIN_DATABASE_URL` 计算（**只输出主机/端口/库名与哈希，不输出凭据**）：

| 项                      | 值                                                                 |
| ----------------------- | ------------------------------------------------------------------ |
| host                    | `localhost:5433`                                                   |
| database                | `/beaconhs`                                                        |
| fingerprint             | `ae0ab37a6858b2b82f0714ac3859cfba0799667a5153945aa420886cffa57945` |
| 匹配 pool `a19382e0…`   | ❌                                                                 |
| 匹配 direct `0ae09059…` | ❌                                                                 |

**结论：本机配置对应的数据库不是 A3 审计目标。** 与 `A3_EXECUTION_CARD.md`、`TEST_HOST_A3_FORENSIC_AUDIT.md` 一致。

## 2. 已排查实例（累计）

| 主机          | 实例                                      | 库               | 指纹                         | 结论           |
| ------------- | ----------------------------------------- | ---------------- | ---------------------------- | -------------- |
| `10.10.31.13` | `beaconhs-local-prod-postgres-1`          | `beaconhs`(32MB) | 未计算（生产，不做指纹探测） | 生产库，非目标 |
| `10.10.31.13` | `risk-postgres`（pg13）                   | —                | —                            | 非 BeaconHS    |
| `10.10.31.26` | `beaconhs-postgres`（已停）               | `beaconhs`       | `ae0ab37a…`                  | 非目标         |
| `10.10.31.26` | `beaconhs-prod-verify-postgres-1`（已停） | `beaconhs`       | 未计算（已停）               | 非目标         |
| `10.10.31.26` | `beaconhs-fixture-postgres-1`（Exited 1） | 未声明           | —                            | 非目标         |

**未找到 `a19382e0…` / `0ae09059…` 的实例。**

## 3. 目标标记与定位依据（复核）

`apps/web/scripts/cutover-target.ts:44-58`：

- `BEACONHS_CUTOVER_TARGET` 必须等于常量 `CUTOVER_TARGET`（`beaconhs-dev`）——**环境标记**，不是库名；
- 真正判定：`SUPERADMIN_DATABASE_URL` 的指纹必须命中 `DEV_DATABASE_POOL_FINGERPRINT`（`a19382e0…`）或 `DEV_DATABASE_DIRECT_FINGERPRINT`（`0ae09059…`）。

因此"目标库未定位"的准确表述是：**没有任何已排查实例的指纹命中期望值**，而非缺少名为 `beaconhs-dev` 的数据库。

## 4. 历史 A3 执行记录（复核）

| 文档                                                     | 结论                                                              |
| -------------------------------------------------------- | ----------------------------------------------------------------- |
| `A3_BACKFILL_PREFLIGHT.md`                               | 前置条件与顺序                                                    |
| `A3_EXECUTION_CARD.md`                                   | guardrails 与期望指纹                                             |
| `docs/release-2026-11-09/TEST_HOST_A3_FORENSIC_AUDIT.md` | 三指纹引入提交 `a1e55581`；本机不匹配；env unset；**A3 从未执行** |
| `docs/project-development-state.md:1743`                 | cutover 环境说明                                                  |

## 5. 六类盘点 SQL

已在 `BEACONHS_PD03_TARGET_FORENSICS_V2.md` §6 给出（孤儿附件、悬空引用、删除标记不一致、outbox 残留、对象缺失、对象多余），本轮**未执行**（指纹未匹配前禁止）。

## 6. 结论

- **P3-1 未完成**：指纹未命中。
- **P3-2 及之后不得开始**（备份/盘点/回填/验证）。
- 未修改任何数据，未删除任何对象，未读取或输出 Secret。

## 7. 所需输入（缺一不可）

1. 指纹为 `a19382e0…`（pool）或 `0ae09059…`（direct）的实例地址与库名；
2. 该实例 `SUPERADMIN_DATABASE_URL` 的注入方式（Vault / 秘密文件，**不经聊天**）；
3. 目标租户范围（单租户 / 全部）；
4. 对象存储实例与 bucket。

拿到 1 后，本方可计算指纹并确认；确认后按 §5 执行只读盘点（仍不 Apply）。
