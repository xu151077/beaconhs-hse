# BeaconHS 隔离 PostgreSQL 全链迁移验证报告

**基线：** `hse-platform / 20d0c78f`，工作区 33M+14?? 保留。未连生产（`10.10.31.13`）、未动 0055、未改 Secret/.env、未 A3 Apply、未部署、未提交。

## 1. 执行环境

- PostgreSQL 16.15（`postgres:16-alpine` 容器 `beaconhs-migration-test-pg`，`127.0.0.1:15432`），隔离网络 `beaconhs-migration-test-net`，命名 `beaconhs_migration_test_*`（fresh/upgrade/interrupt/restore 四库独立）。
- 角色 5 个：`beaconhs_owner`（NOLOGIN）、`beaconhs_migrator`（LOGIN→owner）、`beaconhs_app`（runtime）、`beaconhs_super`（maintenance BYPASSRLS）、`beaconhs_backup`（BYPASSRLS+read-only）。
- 连接全部走 `127.0.0.1:15432`（env 显式注入，不读生产 `.env` 内容；`migrate.ts` 的 dotenv 不覆盖已注入的 DATABASE_URL）。

## 2. Git 基线

HEAD `20d0c78f` / `hse-platform`，33 修改 + 14 未追踪（与首轮一致）。

## 3. Migration 清单

| 项目                | 实际                                                                    |
| ------------------- | ----------------------------------------------------------------------- |
| 最早                | `0000_init.sql`（idx 0）                                                |
| 最后                | `0056_audit_log_and_fk_replay_safety.sql`（idx 56）                     |
| migration 数量      | 56 个 SQL                                                               |
| journal 条目        | 56（idx 0–41,43–56；**idx42 缺号**，无 `0033_*.sql`，历史遗留，未补造） |
| Snapshot 数量       | 与 journal 同批                                                         |
| 0055 哈希（SHA256） | `b63fd97de984c84cfb7ac08f0cce67e74ab98a432d1081720d8d936874beae00`      |
| 0056 哈希           | `d2d8b4f3644bb86fe6f5b29615d98b8ab5fcf0f4caec79ca7acea540390030df`      |

迁移器：`packages/db/src/migrate.ts` → `drizzle-orm/postgres-js/migrator`，`__drizzle_migrations(hash,created_at)` 跟踪；`migration-state.ts` 以 `created_at:hash` 键判定已执行/pending/不一致（缺号亦可识别）。

## 4. 全新 0000→0056（真 PG）✅

`tsx src/migrate.ts` exit 0：`Fresh database / 56 applied, 0 pending`，RLS 191 表，grants/stats(32)/views(15) 全过。对象：56 tracker、197 public 表、111 枚举。

## 5. 已有 0055→0056（真 PG）✅

升级库以临时 journal 副本（`/tmp/beaconhs-mig-0055`，源码未动）跑 0000→0055（55 tracker；audit FK=CASCADE、无 trigger），插入 1 租户 + 1 审计行后执行 `migrate.ts`：`55 applied, 1 pending → 56 applied`。结果：audit FK=RESTRICT、trigger 到位、PPE 复合 FK=`c`、审计历史 1 行保留。

## 6. 0056 重放与幂等（真 PG）✅

- runner 重放：`56 applied, 0 pending` exit 0（no-op）。
- 直接 SQL 重放（0055 基线库）：两次均成功。
- 语义重复 FK（`zz_dup_fk` 同列异名）→ 0056 拒绝 `conflicting foreign key…`。
- 定义错误 FK（现 FK 改 RESTRICT）→ 拒绝 `has wrong referential actions`。
- 覆盖 contype/connamespace/表归属、columns、actions、MATCH、DEFERRABLE（见 `0056` `DO` 块）。

> 已硬化库（grants 后）直接重放 0056 在 `CREATE FUNCTION` 处 `permission denied for schema public` —— 这是跑批顺序的属性（0056 须在 grants 硬化前执行，runner 内部顺序即如此），非缺陷。

## 7. 中断恢复（真 PG）✅

删除 `__drizzle_migrations` 最新行（模拟单步未落账）→ ledger `55 applied, 1 pending` → 重跑 `migrate.ts` 仅补 0056（幂等）→ 56 回收。Drizzle 每文件独立事务，单文件中断即整体回滚，不会半成品标成功（由设计 + 上述实测支撑）。

## 8. RLS 与租户隔离（真 PG）✅

附件（`t/<tenant>/` 命名空间 + `kind` 约束）下以 `beaconhs_app`：租户 A 上下文可见 1，租户 B 上下文可见 0；B 对 A 行 `UPDATE` = `UPDATE 0`，数据未改。

## 9. 审计权限（真 PG）✅

| 操作                          | 结果                                     | 机制            |
| ----------------------------- | ---------------------------------------- | --------------- |
| app INSERT                    | ✅ OK                                    | —               |
| app UPDATE/DELETE             | ❌ `audit_log is append-only`            | trigger         |
| super UPDATE (BYPASSRLS)      | ❌ 同上                                  | trigger，非 RLS |
| backup UPDATE/DELETE/TRUNCATE | ❌ 拒绝（read-only + 无 TRUNCATE）       | 权限            |
| owner UPDATE                  | ✅ 允许（见 `audit-immutability` 真 PG） | 例外            |
| 删租户（FK RESTRICT）         | ❌ `still referenced`                    | FK `r`          |

> Runner `applyRuntimeGrants` 会对 audit_log 重新给 app/super UPDATE/DELETE（全表授权晚于 0056 REVOKE）；**触发器是真正的 enforcement**，REVOKE 为纵深。backup 保持仅 SELECT。

## 10. PPTX/Outbox（真 PG）✅

`pptx-concurrency-pg` 10/10（A–I 单连接并发/回滚/幂等）；`web security` 4/4；`db audit+fk+coverage` 11/11。MinIO 未接（本轮仅对象校验逻辑，未做真实存储端到端）。

## 11. 备份恢复（真 PG）✅

`pg_dump` fresh（25,718 行）→ 空库 restore：56 tracker、RESTRICT、trigger、租户行齐备。角色/权限随逻辑 dump 恢复（常规 dump）；数据库级对象（角色本体）不在此列（需 `pg_dump --globals-only` 另议）。

## 12. 失败/跳过项

- 无失败。仅一项“直接 SQL 在硬化后重放”被顺序拒绝（预期内，与 runner 路径无关，已注明）。

## 13. 对象差异（fresh vs upgrade）

FK/trigger/审计一致；唯一差异为预置种子行（upgrade 侧 1 租户+1 审计）。

## 14. 0055 哈希对比

前后一致 `b63fd97d…`（未改）。

## 15. 清理说明（待执行）

```bash
docker exec beaconhs-migration-test-pg psql -U postgres -c "DROP DATABASE IF EXISTS beaconhs_migration_test_fresh;" -c "DROP DATABASE IF EXISTS beaconhs_migration_test_upgrade;" -c "DROP DATABASE IF EXISTS beaconhs_migration_test_interrupt;" -c "DROP DATABASE IF EXISTS beaconhs_migration_test_restore;" -c "DROP DATABASE IF EXISTS beaconhs_migration_test_scratch;" -c "DROP DATABASE IF EXISTS beaconhs_migration_test_stage2;"
docker rm -f beaconhs-migration-test-pg
docker network rm beaconhs-migration-test-net
rm -rf /tmp/beaconhs-mig-0055 /tmp/beaconhs-backup-in-container.sql
```

（禁止宽泛 `docker system prune`/`docker volume prune`。）

## 16. 最终判定

**通过**：0000→0056、0055→0056、重放、恢复、RLS、审计、PPTX 回归、备份恢复全过。此前报告/P1 修复/PPTX 并发结论均有真 PG 支撑，可进入合并前最终审查（仓库既有门禁全绿：format/lint/typecheck/deadcode/build）。

> 测试类型：全部为**真实 PostgreSQL**（隔离实例）；无 Mock/源码合同冒充；MinIO 端到端存储写、生产数据回填**未执行**（不在本轮范围）。
