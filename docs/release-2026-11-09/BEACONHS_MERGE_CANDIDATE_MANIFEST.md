# BeaconHS 合并候选清单

| 文件                                                                                 | 状态                                                                                            | 是否进入整改合并  | 说明                   |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | ----------------- | ---------------------- |
| `0056_audit_log_and_fk_replay_safety.sql`                                            | 新建                                                                                            | ✅ 是             | Migration 必并         |
| `0056_snapshot.json`                                                                 | 新建                                                                                            | ✅ 是             | Snapshot 必并          |
| `_journal.json`（56）                                                                | 修改                                                                                            | ✅ 是             | 含 0056                |
| `audit.ts`、`ppe.ts`                                                                 | 修改                                                                                            | ✅ 是             | RESTRICT/复合 FK       |
| `training/pptx/_lib.ts`、`pptx/_actions.ts`                                          | 修改                                                                                            | ✅ 是             | purge 锁 Tx            |
| `training/library/_actions.ts`、`studio/_actions.ts`                                 | 修改                                                                                            | ✅ 是             | importLessonPptx 锁    |
| `write.ts`（19 谓词）、`builder-apps.ts`                                             | 修改                                                                                            | ✅ 是             | F1/F2                  |
| `documents/_master-actions`、`people/files                                           | titles`、`insights/_actions`、`reports/export`、`training/evaluations`、`backfill-attachment-*` | 修改              | ✅ 是                  | A3/孤儿/门禁 |
| `*-*.test.ts` 6 个 + `security.test.ts`                                              | 修改/新建                                                                                       | ✅ 是             | 真 PG/合同测试必并     |
| `next-env.d.ts`                                                                      | 修改（构建产物）                                                                                | ❌ 否             | 保持文件、提交时勿 add |
| `BEACONHS_*.md` 13 + `TEST_HOST_*.md` 1                                              | 新建                                                                                            | ⚠️ 可并（仅历史） | 非运行时依赖；只归档   |
| `A3_*.md`/`API_*.md`/`CONNECTION_*`/`DEEP_*`/`PERMISSION_*`/`RELEASE_*`/`ROLLBACK_*` | 修改                                                                                            | ⚠️ 可并（仅历史） | 非运行时依赖；只归档   |
| `.env`/`.env.orig`/`.env.prod-verify`                                                | 未修改                                                                                          | ❌ 否             | 未改动，不应入本次提交 |
| 临时 runner/容器（已删）                                                             | —                                                                                               | ❌ 否             | 已清理                 |

原则：源码 + Migration + 测试进入；报告类仅作证据归档，不参与运行时。
