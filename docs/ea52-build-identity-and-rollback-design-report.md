# EA-52：构建身份缺陷修复方案与回滚执行路径设计

**状态：** `PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`
**阶段结论：** D1/D2 **机制已确认但未修复** · D3 设计已定未实施 · 回滚路径 `PROPOSED`（RB-B/C/D 待 A8）
**日期：** 2026-10-27
**分支 / HEAD：** `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`
**基线：** `docs/ea51-deployment-identity-and-rollback-report.md`、`docs/evidence/ea51/`、`docs/evidence/ea50/rollback/unsigned-image-rollback-risk.md`、`docs/evidence/ea48/proposal/workflow-change-plan.md`、`docs/release-approval-checklist.md`、`docs/project-development-state.md`、`turbo.json`
**新增证据：** `docs/evidence/ea52/`（13 个文件；`sha256sum -c SHA256SUMS` **12/12 通过**）
**执行边界：** 未访问生产 / ceshi / GHCR / 生产数据库 / 对象存储；未使用真实 OIDC / Fulcio / Rekor / registry 凭据；**未修改 `.github/workflows/*`、`Dockerfile`、`.dockerignore`、`turbo.json`、业务代码**；未执行部署、回滚、迁移、备份恢复或流水线；未提交、未推送、未建 PR；未覆盖或删除任何既有镜像、容器、卷、备份、快照或证据。全部实验在 `/tmp/opencode/ea52/probe/**` 的独立副本中进行。

---

## 0. 结论速览

| #   | 任务                                      | 结论                                                                                                                      | 等级                            | 证据                                                                   |
| --- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | ---------------------------------------------------------------------- |
| 1   | 执行前工作区状态                          | 分支/HEAD 符合预期；165 `M` / 506 `??` / 暂存区空；EA-51 报告与 13 个证据文件俱在                                         | ✅ `PASS`                       | `environment/workspace.txt`                                            |
| 2   | EA-51 证据复核                            | `sha256sum -c` **12/12 通过**；身份复算脚本可重跑且结果一致                                                               | ✅ `PASS — EVIDENCE REPRODUCED` | `environment/ea51-recheck.txt`、`environment/identity-replay.txt`      |
| 3   | **D1 复核**（镜像不自证源码版本）         | 独立重跑同一判定：EA-16 `deploymentId=undefined`、源码 SHA **0** 命中；EA-45 镜像 295 命中                                | ✅ `PASS — EVIDENCE REPRODUCED` | `tests/build-identity-corrobation.txt`（EA-51，本阶段复跑）            |
| 4   | **D2 复核**（HEAD 未声明该变量）          | `git show HEAD:turbo.json` 中 `globalEnv` **21 项，无 `DEPLOYMENT_VERSION`**；工作区 25 项**有**                          | ✅ `PASS — EVIDENCE REPRODUCED` | `tests/T1-T7-probes.log` §T2b                                          |
| 5   | **D3 复核**（就绪检查读运行时值）         | `ready/route.ts:145` 读 `process.env.APP_VERSION`；`appVersion()` 助手未被该路由使用                                      | ✅ `PASS — EVIDENCE REPRODUCED` | 本报告 §2.3                                                            |
| 6   | **D2 的端到端复现**（新增）               | 用 HEAD 形态的 `turbo.json` 走 Turbo + `next build`：`deploymentId: undefined`，`BUILD_ID` 为随机值，源码 SHA 0 命中      | ✅ `PASS — MECHANISM CONFIRMED` | `tests/T1-T7-probes.log` §T1/T2                                        |
| 7   | **修复形态验证**（新增）                  | 声明到 `globalEnv` 或 task `env` 后：`deploymentId` 正确、22 个产物文件含 SHA                                             | ✅ `PASS — MECHANISM CONFIRMED` | 同上 §T3、§T3b                                                         |
| 8   | **`envMode: loose` 是安全陷阱**（新增）   | loose 会"修复"D2，但把**所有**导出变量送进任务（探针中 `APP_VERSION` 从被严格过滤变为可见）                               | ❌ `FAIL`（记录为禁止方案）     | 同上 §T2b case 3                                                       |
| 9   | **`BUILD_ID` 不是 revision 指纹**（新增） | 两个不同 revision 产生**相同** `BUILD_ID`（`build-TfctsWXpff2fKS`）；Next 在配置 `deploymentId` 时返回常量                | ❌ `FAIL`（记录为陷阱）         | 同上 §T5、§T6；源码 `next/dist/build/index.js` `getBuildId()`          |
| 10  | **缺失身份是静默降级**（新增）            | 完全不传变量时构建 **exit 0**，产出无身份镜像                                                                             | ❌ `FAIL`（非 fail-closed）     | 同上 §T7                                                               |
| 11  | A/B/C 修复方案比较                        | A（提交声明）+ C（独立身份面）为推荐组合；B 不推荐为主方案                                                                | ✅ `PROPOSED`                   | `design/build-identity-remediation.md`                                 |
| 12  | 构建身份契约（10 字段）                   | 区分 `source_revision` / `deployment_version` / digest / `runtime_app_version`；只有 `deployment_version` 能自证 revision | ✅ `PROPOSED`                   | `design/build-identity-contract.md`                                    |
| 13  | 部署身份校验契约（10 步）                 | 仅第 1 步已实现；第 2–8 步 `PROPOSED`；**第 9 步 `FAIL`**（今天不可能通过）                                               | ❌ `FAIL`                       | `design/deployment-identity-validation.md`                             |
| 14  | 回滚执行路径（10 步 + 4 类）              | 全部 `PROPOSED`；RB-B/C/D 为 `PENDING AUTHORIZATION`（A8/A7）                                                             | ⚠️ `PROPOSED`                   | `design/rollback-execution-contract.md`                                |
| 15  | Server Action Key 与 Migration 51 限制    | key 在镜像内烘焙、异 key 404、EA-16→当前 `NOT VERIFIED`；迁移 forward-only、生产预检查 `NOT RUN`                          | ⚠️ `PARTIAL`                    | 回滚契约 §4–§5                                                         |
| 16  | 恢复耗时分析                              | 构建 342 s（六次冷构建均值）；**push/拉取/启动/schema 校验/存储恢复/业务验证全部 `NOT RUN`**                              | ⚠️ `PARTIAL`                    | 本报告 §7                                                              |
| 17  | 测试矩阵                                  | 构建身份 BI-1~~BI-12：6 `PASS`、4 `FAIL`（记录缺陷本身）、2 `NOT RUN`；回滚 RB-1~~RB-13：**全部 `NOT RUN`**               | ⚠️ `PARTIAL`                    | `tests/build-identity-test-matrix.md`、`tests/rollback-test-matrix.md` |
| 18  | 正式 CI / 部署 / 回滚                     | **未实施**（阶段边界禁止）                                                                                                | `NOT RUN`                       | 本报告 §12                                                             |

**一句话结论：** 本阶段在**独立临时目录**里完整复现了 D2 并验证了它的修复形态，同时发现三个此前未记录的陷阱：**`envMode: loose` 能"修复"D2 但会把全部导出变量灌进任务**（安全倒退）；**`BUILD_ID` 不是 revision 指纹**（配置 `deploymentId` 后是常量，两个不同 commit 会得到同一个 `BUILD_ID`）；**缺失身份是静默成功而非失败**（构建 exit 0，产出无身份镜像）。D1/D2 的**根因与修复形态都已确认，但仓库未改动**，因此按本阶段自己的判据，D1–D3 仍**不具备宣布关闭的条件**——缺的是"CI 从干净 HEAD 构建并断言 `deploymentId == $GITHUB_SHA`"这一条真实测试。回滚方面，10 步路径与 4 类对象已定义，但**没有任何一行回滚代码**，RB-1~RB-13 **全部 `NOT RUN`**。

---

## 1. 执行前工作区状态

| 项目         | 值                                                            |
| ------------ | ------------------------------------------------------------- |
| 当前目录     | `/home/test/projects/beaconhs-hse`                            |
| 分支         | `hse-platform`                                                |
| HEAD         | `51a899b7aac0a942da327222a3eed355fca9798a`                    |
| 已跟踪修改   | 165 个（`git diff --stat`：6044 insertions / 2053 deletions） |
| 未跟踪条目   | 506 个                                                        |
| 暂存区       | 空                                                            |
| `turbo.json` | **未提交修改**（`M`），mtime 2026-10-23T11:04                 |
| EA-51 报告   | 存在，49,265 B                                                |
| EA-51 证据   | 13 个文件                                                     |

**结论：✅ `PASS`。**

---

## 2. D1–D3 复核

### 2.1 复核结论分级

| 项                | 本阶段做法                                                 | 分级                            |
| ----------------- | ---------------------------------------------------------- | ------------------------------- |
| EA-51 证据完整性  | `sha256sum -c SHA256SUMS`                                  | ✅ `PASS — EVIDENCE REPRODUCED` |
| 身份复算可重跑    | 重跑 `extract_identities.py`，8 对象结论一致               | ✅ `PASS — EVIDENCE REPRODUCED` |
| D1 镜像自证       | 重新对两个既有本地镜像读取 `deploymentId` 与 `/app` 内 SHA | ✅ `PASS — EVIDENCE REPRODUCED` |
| D2 HEAD 声明状态  | `git show HEAD:turbo.json` 与工作区逐项比对                | ✅ `PASS — EVIDENCE REPRODUCED` |
| D3 就绪读取路径   | 读取 `ready/route.ts` 与 `app-version.ts`，核对 importer   | ✅ `PASS — EVIDENCE REPRODUCED` |
| D2 的端到端行为   | **新做**：隔离 Turbo + Next 完整构建                       | ✅ `PASS — MECHANISM CONFIRMED` |
| 修复形态是否生效  | **新做**：两种声明方式各构建一次                           | ✅ `PASS — MECHANISM CONFIRMED` |
| CI 视角的最终验证 | 不能执行（禁止触发流水线）                                 | `NOT RUN`                       |

> **不把 EA-51 的历史结果当作本阶段重新验证成功**：D1/D2/D3 的每一条都在本阶段重新读了一遍原始文件；
> 其中 D2 的"行为后果"是**本阶段新做实验**才确认的（EA-51 只观察到未提交状态，未做端到端构建）。

### 2.2 D1 — 镜像不自证源码版本

| 镜像                                | `deploymentId`  | `/app` 内含源码 SHA 的文件数 |
| ----------------------------------- | --------------- | ---------------------------- |
| `beaconhs:phase-ea16-…`（生产候选） | **`undefined`** | **0**                        |
| `beaconhs:ea45-repro-1`             | `"51a899b7…"`   | 295                          |

只读检查既有本地镜像，未构建新镜像。证据：`tests/build-identity-corrobation.txt`。

### 2.3 D2 — `DEPLOYMENT_VERSION` 不在 HEAD

| 位置                          | `globalEnv` 条目       | 含 `DEPLOYMENT_VERSION` |
| ----------------------------- | ---------------------- | ----------------------- |
| `git show HEAD:turbo.json`    | 21                     | **否**                  |
| 工作区 `turbo.json`（未提交） | 25                     | 是                      |
| 工作区 `tasks.*.env`          | 无任何 task 声明 `env` | —                       |

### 2.4 D3 — 就绪检查读运行时值

| 事实                                                             | 证据                                                                             |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 就绪端点返回 `process.env.APP_VERSION`                           | `apps/web/src/app/api/health/ready/route.ts:145`                                 |
| `appVersion()` 助手优先 `DEPLOYMENT_VERSION`，但**该路由未使用** | `apps/web/src/lib/app-version.ts:12`；唯一 importer 是 `app/(app)/layout.tsx:24` |
| `APP_VERSION` 不在镜像 config，由部署注入                        | `deploy-dev.yml:374,455`                                                         |
| 部署侧比较 `.version == $GITHUB_SHA`                             | `deploy-dev.yml:471-478`                                                         |

⇒ 比较的是"编排器告诉容器的 SHA"与"编排器认为的 SHA"，**不涉及镜像内容**。

---

## 3. A/B/C 身份修复方案比较

完整评估：`design/build-identity-remediation.md`。所有实验在 `/tmp/opencode/ea52/probe/**`，仓库未改动。

### 3.1 实测事实（本节全部为本阶段新证据）

| #   | 实验                                                     | 结果                                                                      |
| --- | -------------------------------------------------------- | ------------------------------------------------------------------------- |
| E1  | HEAD 形态 `turbo.json` + 导出变量 → Turbo + `next build` | `deploymentId: undefined`，SHA 0 命中，`BUILD_ID` 随机                    |
| E2  | 声明到 `globalEnv`                                       | `deploymentId: "51a899b7…"`，SHA 22 命中，`BUILD_ID=build-TfctsWXpff2fKS` |
| E3  | 声明到 task `env`                                        | 与 E2 相同                                                                |
| E4  | `envMode: "loose"`                                       | 变量送达，**同时把 `APP_VERSION` 也送进任务**（严格模式下它是被过滤的）   |
| E5  | `BUILD_ID` 的语义                                        | 配置 `deploymentId` 后是**常量**（源码确认）                              |
| E6  | 完全不传变量                                             | 构建 **exit 0**，`deploymentId: undefined`                                |
| E7  | 同 revision 两次构建                                     | 身份一致                                                                  |
| E8  | 不同 revision                                            | `deploymentId` 不同，**`BUILD_ID` 相同**                                  |
| E9  | `Dockerfile:28` 守卫                                     | 拒绝 `""`/短 SHA/大写/`undefined`，只接受 40 位小写 hex                   |

证据：`tests/T1-T7-probes.log`（单一份完整记录）、`tests/run-identity-probes.sh`（可重跑）、`tests/probe-fixtures.md`（fixture 结构）

### 3.2 方案对比

| 维度       | A 提交声明到 Turbo 配置 | B 显式注入 revision 到文件 | C 构建身份与运行时身份分离        |
| ---------- | ----------------------- | -------------------------- | --------------------------------- |
| 修复 D1    | ✅                      | ✅                         | ✅                                |
| 修复 D2    | ✅ **直接**             | ⚠️ 绕过而非修复            | ❌ 正交                           |
| 修复 D3    | ❌                      | ❌                         | ✅ **结构性**                     |
| 缓存正确性 | ✅ 参与任务哈希         | ⚠️ 需注意层序              | ✅                                |
| 改动范围   | **1 行**                | Dockerfile 一层            | Dockerfile + 新路由 + 测试 + 文档 |
| 安全风险   | 低                      | 中（可被伪造的 SHA 输入）  | 中（新增公开面）                  |
| 需要审批   | Release Engineer        | + Technical Approver       | + Technical Approver（新面）      |

### 3.3 推荐（`PROPOSED`）

**A 先行，C 随后。**

- **A 先行**：一行改动，从根上关闭 D1 与 D2，且它正是工作区里**已有但从未提交**的那处改动。没有 A，C 没有可信的东西可发布。
- **C 随后**：D3 是语义问题，A 修不了——只要就绪端点还读 `APP_VERSION`，运维就会继续把"readiness 绿"当成"镜像身份正确"。
- **B 不作为主方案**：它修症状、留下 D2 这个对下一个人复现的陷阱。

**无论选哪个，都必须把"缺失身份"变成构建失败**（E6 证明今天是静默成功）。`Dockerfile:28` 只守住了输入，没有任何东西守住了效果。

**A/B/C 都做不到的事**：让镜像字节可复现、让 provenance 完整、提供签名——分别仍属 A7、A1、A2。

---

## 4. 隔离实验结果

| 测试 | 目的                                              | 结果                                                                                     | 等级                  |
| ---- | ------------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------- |
| T1   | 当前 HEAD 的构建输入是否包含 `DEPLOYMENT_VERSION` | **不包含**（HEAD `globalEnv` 21 项无此项）                                               | ✅ `PASS`（确认缺陷） |
| T2   | 严格环境过滤是否导致变量丢失                      | **是**；四种配置对照：undeclared→丢失、globalEnv→送达、loose→送达(且泄漏)、task env→送达 | ✅ `PASS`（机制确认） |
| T3   | 显式注入后产物是否包含正确 revision               | **是**：`deploymentId` 正确、22 文件含 SHA                                               | ✅ `PASS`             |
| T4   | 修改运行时 `APP_VERSION` 是否影响构建身份         | **不影响**：身份仍为 `deploymentId` 值                                                   | ✅ `PASS`             |
| T5   | 同一源码重复构建，版本标识是否稳定                | **稳定**：两次同 `deploymentId`、同 `BUILD_ID`                                           | ✅ `PASS`             |
| T6   | 不同 revision 是否产生可区分身份                  | **可区分**（`deploymentId` 不同），但 **`BUILD_ID` 相同**                                | ✅ `PASS`（附陷阱）   |
| T7   | 缺少身份文件/字段时是否明确失败                   | **不失败**：exit 0，静默产出无身份镜像                                                   | ❌ `FAIL`             |
| T8   | 身份与源码 revision 不匹配时是否被拒绝            | `NOT RUN`——需要部署侧校验（第 9 步），今天不存在                                         | `NOT RUN`             |

**T8 无法在隔离环境完成**：它需要"部署点读取镜像内身份并比对"，而该步骤尚未实现。不通过篡改正式镜像或工作区来"模拟"它。

---

## 5. 部署身份校验契约

完整设计：`design/deployment-identity-validation.md`（10 步）。

| 步  | 内容                                  | 今天                              |
| --- | ------------------------------------- | --------------------------------- |
| 1   | 取得完整 index digest 并精确比对      | ✅ 已实现                         |
| 2   | 确认目标平台唯一                      | ❌ 缺失（无 manifest 解析）       |
| 3   | 唯一解析 manifest digest              | ❌ 缺失                           |
| 4   | 记录 image config digest              | ❌ 缺失                           |
| 5   | 验签覆盖对象 == 预期对象              | ❌ 缺失（无签名）                 |
| 6   | 验签身份符合批准约束                  | ❌ 缺失                           |
| 7   | provenance subject 与 revision        | ❌ 缺失                           |
| 8   | SBOM subject                          | ❌ 缺失                           |
| 9   | **镜像内嵌身份 == `source_revision`** | ❌ **缺失且今天不可能通过**（D1） |
| 10  | 写入部署记录                          | ❌ 缺失                           |

**第 9 步是整个契约的支点**：第 1–8 步都是"别的系统对镜像的断言"，只有第 9 步的证据来自镜像内部。

### 5.1 每步能证明什么（防止过度解读）

| 步  | 证明                               | **不**证明                               |
| --- | ---------------------------------- | ---------------------------------------- |
| 5   | 签名指向这个 manifest              | 签名者构建了它                           |
| 6   | **谁**签的（按 OIDC claims）       | 签名者的 runner 未被入侵                 |
| 7   | builder 断言了 subject 与 revision | 构建可复现或密闭（`completeness=false`） |
| 9   | **产物自己记录了该 revision**      | 构建时工作区干净                         |
| 10  | 记录存在且完整                     | 会有人读                                 |

---

## 6. 回滚执行路径设计

完整设计：`design/rollback-execution-contract.md`（10 步 + 4 类）。**未编写任何回滚代码。**

### 6.1 十步

| #   | 步骤                                   | 失败时                                      |
| --- | -------------------------------------- | ------------------------------------------- |
| 1   | 声明原因与审批引用                     | **中止**——无名回滚是事故不是操作            |
| 2   | 读取上一部署记录与目标完整 digest      | 中止；无记录即 RB-D                         |
| 3   | 重新解析平台 manifest                  | 中止                                        |
| 4   | 重跑适用的签名与 provenance 校验       | 中止或转 §6.2 分支                          |
| 5   | 验证 Server Action Key 兼容性证据      | 中止（混 key 回滚会在请求期 404）           |
| 6   | 验证数据库 schema / 迁移兼容性         | 中止（forward-only 迁移无法被镜像回滚撤销） |
| 7   | 验证对象存储恢复需求                   | 中止或记录明确降级                          |
| 8   | 检查目标是否符合**其构建时**适用的政策 | 转 §6.2                                     |
| 9   | 记录前后身份集                         | 中止                                        |
| 10  | 执行后验证健康与业务关键路径           | **宣告回滚失败**，不得宣告成功              |

### 6.2 四类对象与权限

| 类       | 定义                                                    | 可自动？ | 需要的授权         | 无法通过的步 |
| -------- | ------------------------------------------------------- | -------- | ------------------ | ------------ |
| **RB-A** | 签名 + SBOM + provenance 全部对得上                     | 是       | 无额外             | 无           |
| **RB-B** | 未签名历史镜像（EA-16：有 provenance、无签名、无 SBOM） | **否**   | A8 逐次例外 + 记录 | 4、8         |
| **RB-C** | provenance 不完整或缺失                                 | **否**   | A7 **和** A8       | 4 部分、8    |
| **RB-D** | 来源不可确认（EA-13 及更早）                            | **否**   | 逐次单独批准并留痕 | 2、4、8      |

**A8 未批准前，RB-B/C/D 没有可执行路径**——这不是本文档的缺口，而是当前状态，写下来是为了避免在事故中被发现。

### 6.3 第 10 步是最容易被跳过的一步

就绪 200 只证明进程起来了，不证明应用能用。EA-33 在 staging 用**真实 Server Action 往返**做标准；RB-13 要求的是那个标准，不是一个 200。

---

## 7. Server Action Key 及 Migration 51 限制

| 约束                                | 事实                                          | 对回滚的影响                                                |
| ----------------------------------- | --------------------------------------------- | ----------------------------------------------------------- |
| Key 在镜像内烘焙                    | `Dockerfile:47-52`（BuildKit secret，非 ENV） | 回滚目标带着它构建时的 key                                  |
| 异 key → 404                        | EA-33 staging                                 | 回滚到异 key 镜像 = **部分**故障：页面能渲染，action 全失败 |
| 前向闸门已实现                      | `deploy-dev.yml:286-296`                      | **回滚路径没有对应检查**——这是缺口                          |
| `EA-16 → 当前` 是否同 key           | **`NOT VERIFIED`**                            | 无法预先判断 RB-B 会不会 404                                |
| 迁移 forward-only                   | `backup-restore-runbook.md` §7                | 镜像回滚**不撤销**迁移                                      |
| 旧镜像遇新 schema                   | `ready/route.ts:76` 拒绝服务                  | 回滚会以"就绪失败"告终——更安全，但仍是**失败的回滚**        |
| Migration 51 内容                   | `0051_ea12_drop_dead_columns.sql` 删 3 个死列 | 已应用且数据已变时旧镜像不兼容                              |
| 生产预检查 / DB 恢复 / 对象存储恢复 | **`NOT RUN`**                                 | 运维今天**无法判断**自己处在三种情形中的哪一种              |

---

## 8. 恢复耗时分析

沿用 EA-51 的六次冷构建基线（**未新增构建**）：

| 阶段             | 数值                                                | 等级                                  |
| ---------------- | --------------------------------------------------- | ------------------------------------- |
| 构建             | **342 s 均值**（323–363 s，n=6，全部 `--no-cache`） | `PARTIAL`（本地、cache mount、非 CI） |
| 镜像发布与拉取   | 无数据                                              | `NOT RUN`                             |
| 应用启动         | 无数据                                              | `NOT RUN`                             |
| 数据库兼容性验证 | 无数据                                              | `NOT RUN`                             |
| 对象存储恢复     | 无数据                                              | `NOT RUN`                             |
| 业务关键路径验证 | 无数据                                              | `NOT RUN`                             |

**不得把 342 秒当作恢复时间承诺。** 它是"构建这一段"的实测值，且不含 push、拉取、启动、迁移、收敛与就绪（部署 job 单独给就绪 600 s 预算，`deploy-dev.yml:468`）。

---

## 9. 测试矩阵

### 9.1 构建身份（`tests/build-identity-test-matrix.md`）

| 结果                         | 条目                                                                                         |
| ---------------------------- | -------------------------------------------------------------------------------------------- |
| ✅ `PASS`（6）               | BI-2、BI-3、BI-5、BI-6、BI-7、BI-9                                                           |
| ❌ `FAIL`（4，均为缺陷本身） | BI-1（缺失身份静默成功）、BI-4（loose 泄漏）、BI-8（`BUILD_ID` 陷阱）、BI-10（EA-16 无身份） |
| `NOT RUN`（2）               | BI-11、BI-12（部署侧检测与 provenance 比对）                                                 |

合计 12 条。**其中 4 条 `FAIL` 记录的是仓库当前行为，不是测试失败**——它们证明缺陷存在，正是本阶段要交付的结论。

### 9.2 回滚（`tests/rollback-test-matrix.md`）

**RB-1 ~ RB-13：全部 `NOT RUN`。** 因为没有回滚代码就没有可断言的测试。这不是遗漏，是本阶段最重要的结论之一。

必须存在才能让 D1–D3 关闭的四项测试：

1. CI 从干净 HEAD 构建并断言 `deploymentId == $GITHUB_SHA`；
2. 部署侧断言"缺身份即失败"；
3. 独立于运行时 env 的身份查询面（C 方案）；
4. 负向测试：用错误 SHA 构建，确认闸门拒绝。

**一项都不存在。** 所以 D1/D2 的状态是 `PARTIAL — MECHANISM CONFIRMED`，不是"已修复"。

---

## 10. 文件新增及修改清单

### 10.1 新增

| 文件                                                          | 说明                                             |
| ------------------------------------------------------------- | ------------------------------------------------ |
| `docs/ea52-build-identity-and-rollback-design-report.md`      | 本报告                                           |
| `docs/evidence/ea52/design/build-identity-contract.md`        | 10 字段契约（生产者/不可变性/能否证明 revision） |
| `docs/evidence/ea52/design/build-identity-remediation.md`     | A/B/C 方案与实测 E1–E9                           |
| `docs/evidence/ea52/design/deployment-identity-validation.md` | 10 步校验契约 + 能证明/不证明                    |
| `docs/evidence/ea52/design/rollback-execution-contract.md`    | 10 步回滚 + RB-A~D                               |
| `docs/evidence/ea52/tests/build-identity-test-matrix.md`      | BI-1~BI-12                                       |
| `docs/evidence/ea52/tests/rollback-test-matrix.md`            | RB-1~RB-13（全 `NOT RUN`）                       |
| `docs/evidence/ea52/tests/T1-T7-probes.log`                   | 探针完整记录                                     |
| `docs/evidence/ea52/tests/run-identity-probes.sh`             | 可重跑探针脚本                                   |
| `docs/evidence/ea52/tests/probe-fixtures.md`                  | fixture 结构与为什么用 `--webpack`               |
| `docs/evidence/ea52/environment/*`                            | 工作区快照、EA-51 复核、身份复算重跑             |

### 10.2 修改

| 文件                                 | 变更                                                      |
| ------------------------------------ | --------------------------------------------------------- |
| `docs/project-development-state.md`  | 仅新增 `## EA-52 addendum`                                |
| `docs/release-approval-checklist.md` | 仅新增 §10.24 与 §12 状态句；**未改动任何既有生产阻断项** |

### 10.3 刻意未修改

`.github/workflows/*`、`Dockerfile`、`.dockerignore`、**`turbo.json`（保持未提交原样，未提交也未回退）**、业务代码、schema/权限/RLS；EA-43 签字栏与风险等级栏保持为空。

---

## 11. 质量检查

### 11.1 六项标准门禁

| 门禁                  | 状态            | 原因                                                             |
| --------------------- | --------------- | ---------------------------------------------------------------- |
| `pnpm format:check`   | **RUN, exit 0** | Markdown 必须检查                                                |
| `pnpm typecheck`      | `NOT RUN`       | 无 TS/TSX 改动                                                   |
| `pnpm lint`           | `NOT RUN`       | 无源码改动                                                       |
| `pnpm deadcode:check` | `NOT RUN`       | 无导入/导出改动                                                  |
| `pnpm test`           | `NOT RUN`       | 无行为改动                                                       |
| `pnpm build`          | `NOT RUN`       | 无构建输入改动（探针在 `/tmp` 用独立 workspace，不产生仓库构建） |

### 11.2 本阶段实际执行的检查

| 检查               | 结果                                        |
| ------------------ | ------------------------------------------- |
| EA-51 证据 SHA-256 | **12/12 通过**                              |
| EA-52 证据 SHA-256 | 见 `docs/evidence/ea52/SHA256SUMS`          |
| 身份复算重跑       | 8 对象结论与 EA-51 一致                     |
| 探针可重跑性       | `run-identity-probes.sh` 单脚本产出完整日志 |
| Markdown 格式      | `format:check` exit 0                       |
| 内部链接           | 见 §11.3                                    |
| 秘密扫描           | 0 命中（见 §11.4）                          |
| Git diff / 暂存区  | 见 §12                                      |

### 11.3 内部链接

所有内部链接以脚本核验（非人工目测）：抽取反引号内的仓库相对路径与证据包相对路径，剥离 `:行号` 后逐条检查存在性。

| 范围                                                  | 结果                                                                                    |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 仓库相对路径（以 `docs` 开头）                        | 全部存在，0 缺失                                                                        |
| 证据包相对路径（`design/`、`tests/`、`environment/`） | 全部存在，0 缺失                                                                        |
| 跨迭代证据引用                                        | EA-48/49/50/51 的文件统一写成完整路径，避免与 EA-52 自己的 `tests/`、`design/` 同名混淆 |
| 尚未创建的路径                                        | 无（所有引用指向已存在文件）                                                            |

> `docs/evidence/ea52/SHA256SUMS` 在报告初稿时尚不存在；生成后已重新校验。

### 11.4 秘密扫描

扫描范围：`docs/ea52-build-identity-and-rollback-design-report.md`、`docs/evidence/ea52/**`。

| 检查                                          | 结果                                                       |
| --------------------------------------------- | ---------------------------------------------------------- |
| 私钥头（`BEGIN … PRIVATE KEY`）               | 0 命中                                                     |
| 私钥/口令文件（`*.key` / `*.pem` / `*.pw`）   | 证据包内**不存在**                                         |
| `ghp_` / `github_pat_` / `xox*` / `AKIA` 令牌 | 0 命中                                                     |
| 含口令的数据库连接串                          | 0 命中                                                     |
| Server Action Key 赋值形态                    | 0 命中（本阶段未读取、未派生任何 key 材料）                |
| 探针使用的值                                  | `deadbeef…`、`1111111…` 为合成占位串，非真实 commit 或密钥 |

本阶段全程未读取、未生成、未存储任何凭据。探针运行在 `/tmp/opencode/ea52/probe/**`，
使用仓库 `apps/web/node_modules` 的只读符号链接，不复制依赖、不改动仓库。

---

## 12. Git 状态

| 项目             | 值                                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 分支             | `hse-platform`                                                                                                            |
| HEAD             | `51a899b7aac0a942da327222a3eed355fca9798a`（**未变**，本阶段无提交）                                                      |
| 已跟踪修改       | 165 个（与执行前一致）                                                                                                    |
| 未跟踪条目       | 507 个（执行前 506，**+1** = `docs/ea52-build-identity-and-rollback-design-report.md`；`docs/evidence/` 折叠为一条 `??`） |
| 暂存区           | **空**（未执行任何 `git add`）                                                                                            |
| 提交 / 推送 / PR | **无**                                                                                                                    |
| 破坏性 Git 操作  | **无**（未执行 `reset --hard` / `clean` / `restore` / `checkout --`）                                                     |

### 12.1 `turbo.json` 保持原样（本阶段的关键约束）

| 检查                            | 值                                   |
| ------------------------------- | ------------------------------------ |
| `git status --short turbo.json` | ` M`（仍为未提交修改，与执行前一致） |
| mtime                           | `2026-10-23T11:04`（未变化）         |
| HEAD `globalEnv` 条目           | 21（无 `DEPLOYMENT_VERSION`）        |
| 工作区 `globalEnv` 条目         | 25（有 `DEPLOYMENT_VERSION`）        |

**本阶段未提交、也未回退这处改动。** 所有探针改写的是 `/tmp/opencode/ea52/probe/**/turbo.json`，
不是仓库中的这一份。

### 12.2 正式 CI / 构建文件确认未被修改

`.github/workflows/*`、`Dockerfile`、`.dockerignore` 显示 `M`，均为**执行前既有**改动：

| 文件                               | mtime（本机）    | 判定                            |
| ---------------------------------- | ---------------- | ------------------------------- |
| `Dockerfile`                       | 2026-10-21T09:54 | 早于 EA-47…52                   |
| `.dockerignore`                    | 2026-10-14T07:43 | 早于 EA-47…52                   |
| `.github/workflows/ci.yml`         | 2026-10-22T08:53 | 早于 EA-47…52                   |
| `.github/workflows/deploy-dev.yml` | 2026-10-21T23:53 | 早于 EA-47…52                   |
| `.github/workflows/security.yml`   | 2026-09-27T17:18 | 未修改（未出现在 `git status`） |

补充校验：三个 workflow 中 `cosign|syft|sbom|attest|id-token` 命中仍为 **0**。

### 12.3 本阶段触碰的文件

| 文件                                                     | 状态                    | 说明                                                   |
| -------------------------------------------------------- | ----------------------- | ------------------------------------------------------ |
| `docs/ea52-build-identity-and-rollback-design-report.md` | `??` 新增               | 本报告                                                 |
| `docs/evidence/ea52/**`                                  | `??` 新增               | 13 个文件（含 `SHA256SUMS`）                           |
| `docs/project-development-state.md`                      | `M`（**执行前已是 M**） | 仅新增 `## EA-52 addendum`                             |
| `docs/release-approval-checklist.md`                     | `??`（原有未跟踪）      | 仅新增 §10.24 与 §12 状态句；**未改动 §11 任何既有行** |

---

## 13. 未解决问题与授权依赖

| #   | 问题                                    | 等级                                   | 说明                                     |
| --- | --------------------------------------- | -------------------------------------- | ---------------------------------------- |
| 1   | D1 镜像不自证源码版本                   | `PARTIAL — MECHANISM CONFIRMED`        | 根因已定位，修复形态已验证，**仓库未改** |
| 2   | D2 HEAD 未声明 `DEPLOYMENT_VERSION`     | `PARTIAL — MECHANISM CONFIRMED`        | 同上；修复为 1 行但未提交                |
| 3   | D3 就绪读运行时值                       | `PROPOSED`                             | 需 C 方案；涉及业务代码，本阶段禁止      |
| 4   | 缺失身份是静默成功                      | ❌ `FAIL`                              | 需构建期断言，未实施                     |
| 5   | `envMode: loose` 陷阱                   | ❌ `FAIL`（记录）                      | 不得作为修复方案                         |
| 6   | `BUILD_ID` 被误用为身份                 | ❌ `FAIL`（记录）                      | 需在文档/脚本中明确禁止                  |
| 7   | 校验第 9 步缺失                         | ❌ `FAIL`                              | 今天不可能通过                           |
| 8   | 回滚代码不存在                          | ❌ `FAIL`                              | RB-1~RB-13 全 `NOT RUN`                  |
| 9   | A1–A8 无授权                            | `NOT FOUND`                            | 未变化                                   |
| 10  | A8 / A7 未决                            | `PENDING AUTHORIZATION`                | 阻塞 RB-B/C/D                            |
| 11  | EA-16 → 当前 同 key                     | `NOT VERIFIED`                         | —                                        |
| 12  | Migration 51 生产预检查 / DB / 存储恢复 | `NOT RUN`                              | 阻塞 RB-9/RB-12                          |
| 13  | 恢复时间（除构建段）                    | `NOT RUN`                              | 不得用 342 s 承诺                        |
| 14  | OIDC 预检 / Observe-only / 转换条件     | `NOT VERIFIED` / `NOT STARTED` / `0/9` | 未变化                                   |
| 15  | 镜像可复现性书面决策                    | 待决策                                 | EA-43 Rev 5 仍为草案                     |

### 所需授权（按解锁顺序）

| 顺序 | 授权 / 动作                                   | 负责人                                        | 解锁                        |
| ---- | --------------------------------------------- | --------------------------------------------- | --------------------------- |
| 1    | **提交 `turbo.json` 声明**（方案 A）          | Release Engineer                              | 关闭 D2；让 D1 在 CI 中生效 |
| 2    | **构建期断言"缺身份即失败"**                  | Release Engineer                              | 关闭静默降级                |
| 3    | **C 方案**（身份查询面）                      | Technical Approver + Release Engineer         | 关闭 D3                     |
| 4    | **DI-7 回滚代码路径**                         | Release Engineer                              | 让 RB 测试可执行            |
| 5    | **A8**（回滚例外）+ **A7**（provenance 例外） | Release Engineer + Audit / Technical Approver | 解锁 RB-B/C/D               |
| 6    | A1 / A2                                       | Technical Approver / Release Engineer         | 签名与身份绑定              |
| 7    | 生产 Migration 51 预检查 + DB/存储备份恢复    | DBA / Ops                                     | 解锁 RB-9 / RB-12           |

**D1–D3 是否具备进入正式修复阶段的条件：**

| 缺陷 | 条件                                  | 判断                                                                              |
| ---- | ------------------------------------- | --------------------------------------------------------------------------------- |
| D2   | 根因明确、修复形态已验证、改动为 1 行 | ✅ **具备**                                                                       |
| D1   | 依赖 D2 的提交 + 构建期断言           | ✅ **具备**（与 D2 同批）                                                         |
| D3   | 需改业务代码（新查询面）              | ⚠️ **部分具备**——设计已完成，需 UI/文档联动评估与 Technical Approver 批准新公开面 |
| 回滚 | 需 DI-7 代码路径与 A8 政策            | ❌ **不具备**                                                                     |

**最终发布状态保持：`PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`。**

EA-52 只完成**证据复核、隔离实验、契约设计与回滚方案**。生产 Migration 51 预检查、生产数据库与对象存储
备份恢复、完整生产部署与回滚演练、正式审批签字，以及镜像可复现性书面决策，均仍未完成，且不因本阶段改变。
