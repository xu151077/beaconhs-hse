# BeaconHS 2026-11 发布证据索引

25 份发布证据已全部收进本目录（原仓库根目录不再散落报告）。本目录为纯文档归档，不参与运行时；未提交，待单独授权。

**发布基线：** `origin/hse-platform@424761d0`（PR #9 合并）
**生产镜像：** `beaconhs@sha256:a3061df9…`
**结论：** 生产上线完成，Gate 5 PASS，见 `BEACONHS_PRODUCTION_CUTOVER_REPORT.md`。

## 安全整改与审计

| 报告                                                                                             | 用途                                        |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| `BEACONHS_FULL_SECURITY_AUDIT_REPORT.md`                                                         | 全项目安全审计                              |
| `BEACONHS_SECURITY_ARCHITECTURE_REVIEW.md`                                                       | 架构级安全评审                              |
| `BEACONHS_SECURITY_REAUDIT_REPORT.md`                                                            | 复审                                        |
| `BEACONHS_SECURITY_REMEDIATION_REPORT.md`                                                        | 整改记录                                    |
| `BEACONHS_SECURITY_TEST_REPORT.md`                                                               | 安全测试证据                                |
| `API_SECURITY_*` / `API_ROUTE_INVENTORY.md` / `API_WRITE_SECURITY_AUDIT.md`                      | 通用 API 面清单与写面审计（历史已跟踪文件） |
| `PERMISSION_TEST_MATRIX.md` / `DEEP_SECURITY_EVIDENCE.md` / `CONNECTION_POOL_ISOLATION_AUDIT.md` | 权限/连接池证据（历史已跟踪）               |

## PPTX 与并发一致性

| 报告                                          | 用途                             |
| --------------------------------------------- | -------------------------------- |
| `BEACONHS_PPTX_F2_CLOSURE.md`                 | 事务边界 + F2 契约闭合           |
| `BEACONHS_READONLY_AUDIT_REPORT.md`           | 只读独立审查（发现 P1 并发误删） |
| `BEACONHS_PPTX_CONCURRENCY_FIX_REPORT.md`     | 四入口统一锁协议                 |
| `BEACONHS_PPTX_REAL_PG_CONCURRENCY_REPORT.md` | 真 PG A–F 六场景                 |
| `BEACONHS_PPTX_IMPORT_LOCK_FIX_REPORT.md`     | `importLessonPptx` 补锁 + G/H/I  |

## 迁移与真库验证

| 报告                                                                                   | 用途                                             |
| -------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `BEACONHS_ISOLATED_PG_FULL_MIGRATION_REPORT.md`                                        | 0000→0056 / 0055→0056 / 重放 / 恢复 / RLS / 备份 |
| `BEACONHS_ORIGIN_MAIN_INTEGRATION_REVIEW.md`                                           | 远程分支差异与整合方案                           |
| `A3_BACKFILL_PREFLIGHT.md` / `A3_EXECUTION_CARD.md` / `TEST_HOST_A3_FORENSIC_AUDIT.md` | A3 回填前置与目标取证（**Apply 未执行**）        |
| `ROLLBACK_PLAN.md` / `RELEASE_READINESS_CHECKLIST.md`                                  | 回滚与发布清单（历史已跟踪）                     |

## Git 流程与审查

| 报告                                          | 用途                             |
| --------------------------------------------- | -------------------------------- |
| `BEACONHS_PRE_MERGE_FINAL_AUDIT_REPORT.md`    | 合并前独立审查                   |
| `BEACONHS_PRE_MERGE_CLEANUP_REPORT.md`        | 变更整理与 P2 复核               |
| `BEACONHS_MERGE_CANDIDATE_MANIFEST.md`        | 合并候选清单                     |
| `BEACONHS_GIT_STAGING_REPORT.md`              | 选择性暂存证据                   |
| `BEACONHS_GIT_PRE_COMMIT_FINAL_REVIEW.md`     | 暂存区最终复核                   |
| `BEACONHS_GIT_COMMIT_REPORT.md`               | `78e48df8` 提交记录              |
| `BEACONHS_RELEASE_READINESS_ASSESSMENT.md`    | 只读发布评估                     |
| `BEACONHS_FINAL_RELEASE_REVIEW_REPORT.md`     | 远程候选最终发布审查             |
| `BEACONHS_RELEASE_CANDIDATE_BUILD_REPORT.md`  | 候选构建与验证                   |
| `BEACONHS_PRODUCT_DECISIONS.md`               | **PD-01/02/03 待产品负责人确认** |
| `BEACONHS_PRODUCTION_CUTOVER_REPORT.md`       | **生产上线最终报告**             |
| `BEACONHS_POST_CUTOVER_CONVERGENCE_REPORT.md` | 上线后巡检、恢复演练、工作区收敛 |

## 上线后运维

| 文档                            | 用途                                               |
| ------------------------------- | -------------------------------------------------- |
| `POST_CUTOVER_RUNBOOK.md`       | 观测基线、冒烟清单、回滚触点                       |
| `BEACONHS_PRODUCT_DECISIONS.md` | 三项待决策的决策卡（选项/影响/建议默认值，待签字） |

## 归类建议

- **可单独 `docs:` 提交**：上表全部（纯文档，不参与运行时）
- **不应进入代码提交**：`apps/web/next-env.d.ts`（build 产物）、任何 `.env*` / Secret
- **已入库**：`0056` / `0057` migration + snapshot + journal、全部源码与测试（见 `78e48df8` / `424761d0`）
