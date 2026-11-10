# BeaconHS 发布候选审查 — PD-01（21 个领先提交）

**审查基线：** HEAD `62237a25`，分支 `hse-platform`，工作区干净（0 项），领先 `origin/hse-platform` **21** 提交，未 push。
**生产发布基线：** `origin/hse-platform`（镜像 `6ce125a4…`，57 migrations）。
**性质：** 只读审查 + 文档编制。未 Push / Merge / 部署 / 连接生产 / 执行 0058 / 修改 RLS 或业务代码。

## 1. Git 变更审查（逐提交）

| 提交                             | 目的                                                                                          | 变更面                                                                    | RC 评估       |
| -------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------- |
| `ca68101d`                       | 记录 2026-11-10 写路径冒烟测试                                                                | docs                                                                      | ✅            |
| `4ee61c12`                       | PD-01/02/03 设计与分阶段记录                                                                  | docs                                                                      | ✅            |
| `51db8ea9`                       | **PD-01 P1**：`api_keys` 加 `principal_tenant_user_id`/`scopes` 列 + 迁移 0058                | schema + 0058 + 完整性测试更新（api_keys 列变化触发的 snapshot 测试同步） | ✅ 见迁移审查 |
| `30a3f7f4`                       | **PD-01 P2**：凭证绑定授权主体（`principal.ts` 纯决策 + `auth.ts` 解析 + `narrowRoleScopes`） | lib/api + packages/tenant                                                 | ✅            |
| `9b8f8b08`/`03cef82c`/`8fd90152` | PD-01/02/03 阶段报告                                                                          | docs                                                                      | ✅            |
| `ed6b2c23`                       | **PD-01 P3 (1/7)**：corrective_actions 读写记录 scope                                         | lib/api + scope-pg 测试                                                   | ✅            |
| `738c7b7e`                       | **PD-01 P3 (2-3/7)**：documents / training_records 记录 scope                                 | scope.ts + 测试                                                           | ✅            |
| `5e7141d9`/`bf3b0f8d`            | 映射与入口审计报告                                                                            | docs                                                                      | ✅            |
| `8fbb5752`                       | `createdByCol` → `ownerTenantUserCol` 重命名（含 assistant 调用点同步，无行为变化）           | refactor                                                                  | ✅            |
| `faf1fefb`                       | **B-1**：Builder responses 对 scoped key fail-closed（403）                                   | lib/api + 2 路由                                                          | ✅            |
| `027f724d`/`d54a233e`            | B-1/B-2 审计与 HTTP 验收报告                                                                  | docs                                                                      | ✅            |
| `ea7801be`                       | 视图实体 scope 谓词 500 修复（常量列名）                                                      | scope.ts                                                                  | ✅            |
| `ffd526ec`                       | **专项修复**：写路径谓词统一 + 创建时归属校验 + 视图 person 列 + 连接池隔离测试               | scope.ts + 2 测试                                                         | ✅            |
| `23b1d64e`/`684053db`            | 验收与独立审计报告                                                                            | docs                                                                      | ✅            |
| `1ba6cc7c`                       | **M1/L1 关闭**：patch 同事务 Scope 复查 + 通配符死分支删除                                    | scope.ts/write.ts/principal.ts + 2 测试                                   | ✅            |
| `62237a25`                       | M1/L1 修复报告与审查附录                                                                      | docs                                                                      | ✅            |

**横向检查：**

- **临时文件/调试代码：** 全量代码 diff 扫描 `console.log / debugger / TODO / FIXME / XXX / HACK` —— **0 命中**；无临时文件（`next-env.d.ts` 为 `next dev/build` 工具链再生成文件，按 AGENTS.md 约定随工作提交）。
- **未披露变更：** Schema 仅 `api-keys.ts`（+0058）；`rls.ts`、`PERMISSION_CATALOGUE`、`permissions.ts`、`.env.example`、worker、storage **零变更**；非 docs 变更集中在 `apps/web/src/lib/api/**`、`packages/tenant/src/index.ts`（P2 决策层）、assistant 一个调用点（重命名同步）。
- **与独立安全审查一致：** 独立审计（`684053db`）针对 `23b1d64e` 给出 CONDITIONAL PASS；`1ba6cc7c` 关闭 M1/L1 后经第二次独立复核升级为 PASS（`62237a25` 追记）—— 提交序列与审查记录一一对应。

## 2. 数据库迁移审查

详见 `BEACONHS_DATABASE_MIGRATION_REVIEW.md`。核心结论：

- 0058 纯加列（2 可空列 + 1 复合索引），NULL 兼容，存量 API Key 行为零影响，无 RLS 变更。
- **兼容性矩阵：旧应用+58 ✅ / 新应用+57 ❌（认证全量 500）/ 新应用+58 ✅** → 硬性顺序：先迁移、后部署。
- 迁移器具备 advisory lock、账本双向验证、角色预检、失败非零退出；无 down-migration，回滚依赖"旧应用兼容"与备份/PITR。

## 3. 生产部署兼容性

| 维度                  | 评估                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------- |
| 环境变量              | ✅ 零新增（`.env.example` 无差异）                                                    |
| API Key 鉴权          | ✅ 存量 key 全部未绑定 → legacy 路径逐字节不变；token 解析、速率限制不变              |
| Principal 绑定        | ✅ 新能力，休眠态（0058 后所有生产 key 的 principal 列为 NULL）；绑定需显式配置才激活 |
| 数据库连接/RLS/连接池 | ✅ `rls.ts` 零差异；`withTenant` 事务级上下文经 7/7 真 PG 隔离测试                    |
| API 路由              | ✅ 无新增路由；行为变化仅作用于 scoped key（生产暂无）                                |
| 前端构建              | ✅ 仅 assistant 一个调用点随字段重命名同步；`pnpm build` 0                            |
| 后台任务              | ✅ worker 零变更；worker 中无 api/v1/API-key 引用                                     |
| 文件存储              | ✅ 零变更                                                                             |

## 4. 已知限制

见 `BEACONHS_KNOWN_LIMITATIONS.md`（R1/R2/R3/R4/R6/R7、M1 测试 Docker 依赖、0058 无 FK 设计、documents/training_records Site Scope 限制、未映射实体 fail-closed、四实体产品冻结保持）。除 CI 未运行外，全部为拒绝方向或元数据层面，**不影响当前发布**；产品冻结一律未解除。

## 5. 发布及回滚方案

详见 `BEACONHS_PRODUCTION_DEPLOYMENT_PLAN.md`（10 节预案）。核心：备份 → 迁移 → 健康 → 部署 → 验证 → 观察；回滚触发条件明确；**迁移完成后允许直接回滚旧应用版本，无需回滚数据库**。

## 6. 前置条件（唯一未满足项）

| #   | 前置条件                                               | 状态                                                 |
| --- | ------------------------------------------------------ | ---------------------------------------------------- |
| 1   | 21 个提交 push 后 CI 六门禁全绿（CI #25 之后的新运行） | ⏳ 未 push（本任务禁止）；本地六门禁各自退出码均为 0 |
| 2   | 执行发布时按预案 §2 先完成即时备份                     | 待执行                                               |
| 3   | 严格执行"先迁移、后部署"顺序                           | 待执行（预案已固化）                                 |

## 7. 最终结论：**CONDITIONAL READY**

- 未发现任何阻断问题：代码与独立安全审查（PASS）一致，六门禁本地全绿，迁移兼容性矩阵明确，部署/回滚路径完整，产品冻结未解除。
- 未授予 READY 的唯一原因是**前置条件 #1**：CI 尚未对这 21 个提交运行（本任务禁止 push）。push 并确认 CI 全绿后，本审查即升级为 READY，发布操作仍需用户单独批准。
