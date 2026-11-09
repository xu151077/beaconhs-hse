# BeaconHS 上线后收敛与巡检报告 — 2026-11-10

## 本轮动作（密码保持不变，未轮换）

### 生产只读巡检

| 检查     | 结果                                                                                                                                   |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 备份目录 | 仅 `beaconhs-20261109T223650Z/`（dump + sha256），无镜像 tar 残留                                                                      |
| env 权限 | `local-prod.env` 与 `.bak-20261110` 均 `600`                                                                                           |
| 容器     | 6 服务 healthy；web/worker `RestartCount=0`                                                                                            |
| 日志     | web 无 error；worker 仅调度输出 `0 errors`                                                                                             |
| DB       | 57 迁移、`storage_object_deletion_outbox=0`（无堆积）、`audit_log=285`、RLS 191 表、audit FK `RESTRICT`                                |
| HTTP     | `/login` 200、`/api/health/ready` 200（version `424761d0…`）、`/kiosk` 200、未授权 `/api/v1/incidents` **401**（非 5xx）、公网登录 200 |

### 补充备份与恢复演练

- **MinIO 对象备份**（此前缺口）：`mc` 未安装；以目录快照替代 → `minio-data.tar.gz`（1.6M）+ sha256，置于备份目录。⚠️ 运行中快照非事务一致；建议后续用 runbook 的 `object-store-backup` 做加密/HMAC 备份。
- **完整灾难恢复链**（生产主机本机临时库 `beaconhs_drill2`，生产库未动）：
  1. `pg_restore` 自生产 dump：0 错误、54 迁移、211 表、owner `beaconhs_owner`
  2. 用新镜像 `APP_ROLE=migrate`（三个 URL 均经 pathname 校验指向 `beaconhs_drill2`，防误连生产）：`54 applied, 3 pending → 57 applied`，RLS 191 表
  3. 终态：57 迁移、FK `RESTRICT`、审计触发器在位
  4. drill2 已删除；生产库仍 57

### 工作区收敛

- **删除 2 个临时 worktree**：`beaconhs-merge-check`（干净）、`beaconhs-release-candidate`（先将其 2 份未追踪报告复制到主仓库再删）
- **删除临时分支** `tmp-merge-check`；**保留** `release/beaconhs-candidate-2026-11-09`（已推送、已合并，可追溯）
- **新增** `docs/release-2026-11-09/README.md` 报告索引（24 份报告的用途与归类；不移动任何现有文件）
- 报告总数：24 份未追踪 MD（含本轮复制的 2 份）

### 一处自我纠正

- 此前建议「修正 `deploy-dev.yml` 的 `main` 门禁」**是误判**：`ci.yml:176-188` 注释明确说明本 fork 默认分支 `hse-platform` 只跑 CI 门禁，dev 部署是 upstream `main` 路径，调用 `deploy-dev` 从 `hse-platform` 会故意失败并染红 CI。**不应修改**，本次生产走主机 canonical 脚本正是既定路径。

## 未做（及原因）

| 项                                    | 原因                                                                                                                                                                                                                          |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 本地 `hse-platform` 分支同步          | 本地 `78e48df8` 落后 `origin 424761d0` 7 提交；12 个历史 MD 的工作区内容**已与远端逐字节一致**（远端 `style(docs)` commit 包含），但 `next-env.d.ts` 为产物差异，dirty 工作区下 ff 会被拒。为遵守「不覆盖用户修改」，保留原状 |
| 生产写入冒烟（建记录/上传/PPTX 删除） | 会在生产创建业务数据；仅做了只读端点与 DB 一致性检查                                                                                                                                                                          |
| PD-01/02/03                           | 产品决策，不代用户决定；`BEACONHS_PRODUCT_DECISIONS.md` 保持「待确认」                                                                                                                                                        |
| A3 Apply / 生产回填                   | 目标在库未定位，未授权                                                                                                                                                                                                        |
| SSH 密码轮换                          | 用户明确「密码不变」                                                                                                                                                                                                          |

## 本地分支同步建议（需你在方便时手动执行）

因 12 个 MD 已与远端一致，可安全采用远端版本；`next-env.d.ts` 保留本地产物即可：

```bash
cd /home/test/projects/beaconhs-hse
git fetch origin
git diff > /tmp/beaconhs-local-worktree.patch   # 备份，纯只读导出
git stash push -u -m "pre-sync 2026-11-10"
git merge --ff-only origin/hse-platform
git stash pop                                   # 若有冲突：12 个 MD 直接采用远端版本即可
```

或直接不做：本地 HEAD 落后不影响生产（生产跑的是 `424761d0` 构建的镜像），但要提醒后续开发基于旧 HEAD。

## 剩余待办

1. **P0（用户决定不做）**：SSH 密码轮换 / 改 SSH key
2. **P2**：PD-01 F2 site/self、PD-02 审计回溯、PD-03 A3 回填书面结论
3. **P3**：写路径冒烟（登录→建记录→附件→导出→PPTX 删除），验证 outbox+worker 端到端；用 runbook 工具做加密对象存储备份；上线 24–48h 错误率观测
4. **工作区**：24 份报告按索引归档为单独 `docs:` 提交（需授权）

## 后续补记（同日，用户授权「继续」后）

| 项           | 结果                                                                                                                                                  |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 报告归档     | 25 份证据 + 索引 + 运维手册 + 决策卡全部收进 `docs/release-2026-11-09/`；根目录不再散落报告；`git add --dry-run` 确认无 `.env`/Secret/`next-env` 混入 |
| T+20min 观测 | 0 错误、0 重启、outbox 0、资源平稳；基线与 24–48h 观测清单见 `POST_CUTOVER_RUNBOOK.md`                                                                |
| 完整恢复链   | 生产主机本机临时库：`pg_restore` 0 错误 → `migrate` 54→57 → FK RESTRICT + 触发器在位；已清理，生产库未动                                              |
| 写路径冒烟   | **未执行**（需认证会话且会写生产业务数据）；已在 `POST_CUTOVER_RUNBOOK.md` 给出 8 步可执行清单与断言                                                  |
| 决策卡       | PD-01/02/03 扩充为选项/影响/工程建议/签字栏，**仍待产品负责人签字**，未代决定                                                                         |
| 远端引用     | `git fetch` 后 `origin/hse-platform` 仍 `424761d0`；本地 HEAD `78e48df8` 保持不动                                                                     |
| 提交         | **未执行**：归档与文档仅在文件系统就绪，`git add`/`commit` 待单独授权                                                                                 |

## 状态

- 生产：正常运行，Gate 5 PASS，57 迁移
- 原仓库：`78e48df8 / hse-platform`，HEAD 与分支未变；工作区改动完整保留（仅新增 `docs/release-2026-11-09/` 归档目录）
- 未执行：commit / merge / push / A3 Apply / 生产数据写入 / 部署变更
