# EA-50：审批决策闭环与旧镜像回滚风险处置

**状态：** `PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`
**阶段结论：** `0 APPROVED / 8 NOT FOUND` · `0/9 transition criteria` · `Observe-only NOT STARTED`
**日期：** 2026-10-27
**分支 / HEAD：** `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`
**基线：** `docs/ea49-observe-only-readiness-report.md`、`docs/evidence/ea49/`、`docs/ea48-ci-supply-chain-gate-report.md`、`docs/ea43-image-reproducibility-risk-acceptance.md`（Rev 5）、`docs/release-approval-checklist.md`、`docs/project-development-state.md`
**新增证据：** `docs/evidence/ea50/`（`sha256sum -c SHA256SUMS` 见 §9）
**执行边界：** 未访问生产 / ceshi / 生产数据库 / 对象存储 / GHCR；未使用真实 OIDC / Fulcio / Rekor / registry 凭据；未修改 `.github/workflows/*`、`Dockerfile`、`.dockerignore`、业务代码；未执行部署、回滚、迁移、备份恢复或流水线；未提交、未推送、未建 PR；未覆盖或删除任何既有镜像、容器、卷、备份、快照或证据。

---

## 0. 结论速览

| #   | 任务                      | 结论                                                                                                            | 等级                    | 证据                                       |
| --- | ------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------- | ------------------------------------------ |
| 1   | 执行前工作区状态          | 分支/HEAD 符合预期；165 `M` / 504 `??` / 暂存区空；EA-49 报告与 19 个证据文件俱在                               | ✅ `PASS`               | `environment/workspace.txt`                |
| 2   | EA-49 证据复核            | `sha256sum -c` **18/18 通过**；一致性脚本 `CONSISTENT`                                                          | ✅ `PASS`               | `environment/ea49-recheck.txt`             |
| 3   | 是否出现新审批材料        | **没有**。用比 EA-49 更严格的扫描器（决策行 + 所有权人 + 日期 + 主题 + 排除 fixture/摘要句）复检 → **0 项合格** | ✅ `PASS`（结论：无）   | `decisions/strict-approval-scan.json`      |
| 4   | A1–A8 当前正式状态        | `APPROVED` 0 · `PENDING AUTHORIZATION` 0 · `REJECTED` 0 · **`NOT FOUND` 8**                                     | ❌ `NOT FOUND`（全部）  | `decisions/decision-register.md`           |
| 5   | 正式决策登记表            | 8 项各自建档（背景/选项/后果/证据/缺口/推荐/决定字段/状态），决定字段**全部留空**                               | ✅ `PROPOSED`           | `decisions/decision-register.md`           |
| 6   | 旧未签名镜像回滚风险分析  | 完成。EA-16 身份可复算（index `17126c6e…`、manifest `43a7dc27…`）；**无签名、无 SBOM**、有 provenance           | ✅ `PASS`（分析）       | `rollback/unsigned-image-rollback-risk.md` |
| 7   | 回滚处置四方案比较        | R1/R2/R3/R4 逐项比较；推荐标 `RECOMMENDATION ONLY — NOT APPROVED`                                               | ✅ `PROPOSED`           | 同上 §3–§5                                 |
| 8   | OIDC 能力预检计划         | 六个互不等价的验收项（O1–O6）分列；**未执行**，状态 `NOT VERIFIED — PENDING AUTHORIZATION (A2)`                 | ✅ `PROPOSED`           | `oidc-precheck-plan.md`                    |
| 9   | Observe-only 启动检查表   | 7 项阻断门 + 11 项配置门；**`NOT STARTED — PENDING AUTHORIZATION`**                                             | ❌ `NOT STARTED`        | `observe-only-start-checklist.md`          |
| 10  | 强制门禁转换条件逐项复核  | 以 EA-49 九项为基线，**0 / 9 met**，负向测试仍为 `PARTIAL`（仅离线），未放宽任何标准                            | ❌ `NOT MET`            | `gate-transition-assessment.md`            |
| 11  | 新增独立发现              | **部署与回滚身份只是文档约定**：流水线只记录 index digest，从不记录/交叉校验 manifest digest                    | ⚠️ `FAIL`（此前未单列） | `gate-transition-assessment.md` §2         |
| 12  | 审批状态跨文档一致性      | 注册表 / 启动清单 / 转换评估 / 本报告 / 发布清单 一致（脚本校验 `CONSISTENT`）                                  | ✅ `PASS`               | `decisions/approval-consistency.json`      |
| 13  | 正式 CI / 真实观察 / 部署 | **未实施**（阶段边界禁止）                                                                                      | `NOT RUN`               | 本报告 §10                                 |

**一句话结论：** EA-50 用更严格的判定（决策行 + 所有权人 + 日期 + 主题，并显式排除 fixture 与状态摘要句）复核后确认 **A1–A8 仍全部 `NOT FOUND`**——本阶段**没有**把任何一项"因为写了决策请求"而升级为 `PENDING AUTHORIZATION`。交付物是三件可独立审阅的东西：①一份**每项都留空决定字段**的决策登记表与决策请求包；②一份把"旧镜像回滚"从一句话风险变成**可复算 digest、可分方案比较**的分析，并指出**该风险今天就存在**，与门禁是否上线无关；③一份把"OIDC 能用"拆成六个互不等价验收项的预检方案，避免"批准了就等于能用"的误判。同时新指出一个此前未单列的缺陷：**部署按 index digest、签名按 manifest digest，而流水线从不记录后者**，使"发布与回滚身份一致"目前只是文档约定。

---

## 1. 执行前工作区状态

| 项目       | 值                                                                |
| ---------- | ----------------------------------------------------------------- |
| 当前目录   | `/home/test/projects/beaconhs-hse`                                |
| 分支       | `hse-platform`                                                    |
| HEAD       | `51a899b7aac0a942da327222a3eed355fca9798a`                        |
| 已跟踪修改 | 165 个（`git diff --stat`：6012 insertions / 2053 deletions）     |
| 未跟踪条目 | 504 个                                                            |
| 暂存区     | 空                                                                |
| EA-49 报告 | 存在，33,524 B                                                    |
| EA-49 证据 | 19 个文件                                                         |
| 审批登记表 | `docs/evidence/ea49/authorization/authorization-register.md` 存在 |
| 校验脚本   | `check_consistency.py` 存在并可运行（`CONSISTENT`）               |

**结论：✅ `PASS`。**

---

## 2. EA-49 证据复核

```
cd docs/evidence/ea49 && sha256sum -c SHA256SUMS → 18/18 OK, exit 0
python3 authorization/check_consistency.py       → CONSISTENT (0 problems)
```

未发现损坏，未覆盖任何原始证据。

### 2.1 新审批材料复核（关键动作）

EA-49 的扫描器在 EA-50 复跑时报告了 **6 条命中**。逐条打开后确认**全部是规则描述或状态摘要句**，不是批准：

| 命中位置                                       | 实际内容                                                                            | 判定   |
| ---------------------------------------------- | ----------------------------------------------------------------------------------- | ------ |
| `ea49/proposal/gate-transition-criteria.md:16` | 表格行"Observe-only plan **formally approved**"（是*条件*描述）                     | 非批准 |
| `...:21`                                       | 表格行"A8 **signed** by Release Engineer and Audit"（是*条件*描述）                 | 非批准 |
| `ea49/proposal/implementation-readiness.md:19` | 表格行"scope **approved** and the GitHub plan supports it"（是*前置条件*描述）      | 非批准 |
| `release-approval-checklist.md:1302`           | 句子"the authorization register records 0 of 8 approvals (A1–A8 all **NOT FOUND**)" | 非批准 |

**结论：EA-49 → EA-50 之间没有任何新的正式审批材料。** 为避免同类误判，EA-50 另写了更严格的扫描器（见 §3.1）。

---

## 3. A1–A8 的当前正式状态

### 3.1 判定方法的升级

EA-49 的扫描器问的是"文档里有没有 APPROVED 字样"。这在出现规则描述与状态摘要后会产生假阳性。EA-50 的问法是：

> 是否存在一个**决策块**，同时包含 ① 所有权角色 ② 该事项主题 ③ 日期，且不是 fixture/示例？

`docs/evidence/ea50/decisions/strict_approval_scan.py` 的实现与验证：

| 检查             | 结果                                                             |
| ---------------- | ---------------------------------------------------------------- |
| 全仓扫描         | **0 项合格**（`strict-approval-scan.json`）                      |
| 正向对照         | 合成签署块被检出 → fixture 内 1 项（`fixture-scan.json`）        |
| 反向对照（三例） | 无日期 / 无具体所有权人（"the team"）/ 主题不匹配 → **均不检出** |

这证明"0 项"是判定严格的结果，不是扫描器失效。

### 3.2 登记表结果

| ID     | 主题                                                      | 所有权角色               | 状态            |
| ------ | --------------------------------------------------------- | ------------------------ | --------------- |
| **A1** | 公共 Rekor vs 私有 Sigstore                               | Technical Approver       | **`NOT FOUND`** |
| **A2** | `id-token: write` + `attestations: write`（仅 build job） | Release Engineer         | **`NOT FOUND`** |
| **A3** | 移除 caller `packages: write` / 取消 `secrets: inherit`   | Release Engineer         | **`NOT FOUND`** |
| **A4** | `environment: dev` 审批门                                 | Ops + Release Engineer   | **`NOT FOUND`** |
| **A5** | Observe-only 窗口（含起止日期）                           | Release Engineer         | **`NOT FOUND`** |
| **A6** | GHCR 只读凭据                                             | Ops                      | **`NOT FOUND`** |
| **A7** | `buildkit_completeness=false` 例外                        | Technical Approver       | **`NOT FOUND`** |
| **A8** | 旧未签名镜像回滚例外                                      | Release Engineer + Audit | **`NOT FOUND`** |

**统计：`APPROVED` 0 · `PENDING AUTHORIZATION` 0 · `REJECTED` 0 · `NOT FOUND` 8 · `NOT APPLICABLE` 0。**

每一项的**决定人 / 决定日期 / 审批记录位置**字段均为空——本阶段不代签、不预填。

### 3.3 为什么不改成 `PENDING AUTHORIZATION`

`PENDING AUTHORIZATION` 意味着"有正式请求在等批复"。仓库里既没有批准，也没有走正式渠道的待批工单。EA-50 交付的 `decision-request-package.md` **本身**是请求，但在它被组织认可的渠道（工单/邮件归档/决策记录文档）正式登记之前，登记表仍为 `NOT FOUND`。把"我写了一份请求"当成"请求已提交"，就是本阶段明令禁止的自我授权。

---

## 4. 旧未签名镜像回滚风险及方案比较

完整分析：`docs/evidence/ea50/rollback/unsigned-image-rollback-risk.md`。

### 4.1 问题定义

签名门禁生效后，**回滚到此前任何未签名镜像都会落在"未经验证"的状态**。两类后果：要么恢复通道被堵死（业务连续性风险），要么被绕过后无人留痕（审计风险）。**该风险独立于门禁是否上线**——EA-49 §11 第 8 项已记录"当前没有任何例外程序"。

### 4.2 只读核对到的既有证据

| 项目                                        | 结论                                                                  | 证据                                               |
| ------------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------- |
| EA-16 index digest                          | `17126c6e…`（**本地复算一致**）                                       | `docs/evidence/ea44/ea16/ea16-index.json`          |
| EA-16 manifest digest                       | `43a7dc27…`（**本地复算一致**）                                       | `ea16-manifest.json`                               |
| EA-16 attestation manifest                  | `0f7e823e…`                                                           | `ea16-att.json`                                    |
| EA-16 provenance                            | `15358431…`，`subject.digest = 43a7dc27…`，`vcs.revision = 51a899b7…` | `ea16-prov.json`                                   |
| EA-16 `buildkit_completeness`               | `{request:false, resolvedDependencies:false}`                         | 同上                                               |
| EA-16 **签名**                              | **无**                                                                | 所有证据包中无签名产物                             |
| EA-16 **SBOM**                              | **无**                                                                | EA-46 §7.1                                         |
| EA-13 及更早镜像                            | tag/digest/来源 **`NOT VERIFIED`**（无证据包）                        | —                                                  |
| 本地 35 个 `beaconhs:*` 标签                | 实验产物，**不是**合规回滚目标                                        | `docker images`（只读）                            |
| Server Action Key 跨版本                    | 同 key 可回滚，异 key 404，已在 staging 验证（EA-25~30/33）           | `docs/ea36-release-readiness-review.md:45,364,510` |
| EA-16 → 当前 是否同 key                     | **`NOT VERIFIED`**（依赖已部署密钥，本阶段不读取秘密）                | —                                                  |
| 迁移 forward-only、旧镜像遇新 schema 会 503 | 已确认                                                                | `docs/backup-restore-runbook.md` §7                |
| Migration 51 + 数据丢失 ⇒ 旧镜像不兼容      | 已确认                                                                | `docs/ea38-release-decision-record.md:86-90`       |
| 生产 DB / 对象存储备份恢复                  | **`NOT RUN`**                                                         | 独立阻断项                                         |

**准确表述：** EA-16 是"**未签名但有 attestation、无 SBOM**"，不是"无 provenance"。这一点很重要——它意味着 R2 在技术上可行（provenance blob 仍在），但也正因如此**更容易被误读成"当年就验证过"**。

### 4.3 方案比较

| 维度         | R1 回滚前强制验签 | R2 事后补来源证明                        | R3 限定范围临时例外           | R4 禁止回滚旧镜像 |
| ------------ | ----------------- | ---------------------------------------- | ----------------------------- | ----------------- |
| 安全强度     | 高                | **低**（签名暗示的信任超过它实际提供的） | 中（受范围+期限约束）         | 高                |
| 恢复可用性   | **低**            | 中                                       | **高**                        | 低                |
| 可审计性     | 高                | 中，**标注不当即误导**                   | 高（逐次留痕）                | 高                |
| 实施成本     | 无                | 中                                       | 中                            | 无                |
| 静默滥用风险 | 低                | **高**                                   | 中                            | 低                |
| 状态         | `PROPOSED`        | `PROPOSED`                               | `PROPOSED — PENDING APPROVAL` | `PROPOSED`        |

### 4.4 建议（不构成政策）

`RECOMMENDATION ONLY — NOT APPROVED`

建议 **R3 + 明确到期日**，并用 **R2 仅作"保管性再声明"**（明确标注：只证明"今天有人确认这份 provenance 属于该 digest"，不证明当年构建可信），用于让例外对象身份无歧义。理由是：R1/R4 会关掉 EA-16 的唯一已知良好回退路径，而**重建耗时从未在生产测量过**（`NOT RUN`）——把"随时能重建"当既成事实，正是凌晨三点故障的成因。

**在 A8 决定之前，实际生效的是最严格的读法（R1）**，§4.1 的缺口保持打开。

---

## 5. OIDC 预检计划

完整方案：`docs/evidence/ea50/oidc-precheck-plan.md`。

### 5.1 六个互不等价的验收项

| #   | 问题                             | 当前                                  |
| --- | -------------------------------- | ------------------------------------- |
| O1  | 权限是否**已批准**               | `NOT FOUND`                           |
| O2  | 权限是否**已配置**在 workflow 中 | `NOT RUN`（`id-token` 关键字 0 命中） |
| O3  | 本仓库能否**取得** workflow 身份 | `NOT VERIFIED`                        |
| O4  | Fulcio 能否**实际签发**证书      | `NOT VERIFIED`                        |
| O5  | 证书**身份**是否符合校验约束     | `NOT VERIFIED`                        |
| O6  | 用该身份做的签名能否**通过验签** | `NOT VERIFIED`                        |

**O1→O2→O3→O4→O5→O6 任一级不能由上一级推出。** "批准了就说明能用"、"拿到证书就说明签名可信"都是错误推断；EA-49 已把 O3 记为技术阻断 P3，本阶段把它形式化。

### 5.2 为什么本阶段不执行

A2 未批（请求 token 正是 A2 授权对象）、需要真实 workflow 运行（边界禁止）、需要新增 workflow 文件（边界禁止）；且只做一半会被误报为"OIDC 可用"，正是本文要防的混同。

### 5.3 执行设计要点

| 要素     | 要求                                                                                                                     |
| -------- | ------------------------------------------------------------------------------------------------------------------------ |
| 权限     | 仅 `id-token: write` + `contents: read`，**不需要** `packages`/`attestations`                                            |
| 触发     | 仅 `workflow_dispatch`，scratch 分支，**不设** `environment:`（避免与 A4 混淆）                                          |
| 运行位置 | `ubuntu-latest`，**绝不**用自托管 dokploy runner                                                                         |
| 记录     | 只记 `iss`/`aud`/`sub`/`ref`/`sha`/`event_name`/`exp` 与证书 SAN、链校验结果、验签退出码                                 |
| 禁止     | 不打印/上传原始 token；不落地临时私钥；不签release 镜像；除非 A1 选公共 Rekor，否则不写 tlog                             |
| 停止条件 | 403/401 ⇒ O3 失败；`sub` 不符 ⇒ O5 必失败；Fulcio 4xx ⇒ O4 失败；P5 成功但 P6 失败 ⇒ O6 失败（是校验参数错，不是签名错） |
| 证据位置 | `docs/evidence/ea50/oidc/`（一旦产出），并在 A2 记录中引用                                                               |

整体状态：**`NOT VERIFIED — PENDING AUTHORIZATION`**。

---

## 6. Observe-only 启动条件

完整清单：`docs/evidence/ea50/observe-only-start-checklist.md`。**启动状态：`NOT STARTED — PENDING AUTHORIZATION`**，观察记录 **0 天 / 0 构建**。

| 门  | 内容                             | 状态           |
| --- | -------------------------------- | -------------- |
| G1  | A1 已决定                        | `NOT FOUND`    |
| G2  | A2 已批准                        | `NOT FOUND`    |
| G3  | A5 已批准（**含起止日期**）      | `NOT FOUND`    |
| G4  | OIDC 预检已执行                  | `NOT VERIFIED` |
| G5  | 指定观察责任人（有权暂停/中止）  | `NOT MET`      |
| G6  | 声明工作流范围（文件与触发条件） | `NOT MET`      |
| G7  | 证据落地位置存在可写             | `NOT MET`      |

配置门 C1–C11（窗口长度、采样、指标、**SBOM 规范化比较法**、Chrome 覆盖策略、provenance 规则、失败分类、证据格式、留存、退出条件、退出审批）全部为 `PROPOSED`，需在 A5 决定时固定。

两条硬约束写在清单里：

1. 观察步骤必须 `continue-on-error: true` 或位于不阻断部署的 job，否则本阶段会**变成未经批准的阻断阶段**；
2. 首次观察构建前后，被部署的 digest 不得因观察步骤而改变，否则立即中止。

---

## 7. 强制门禁转换条件逐项状态

完整评估：`docs/evidence/ea50/gate-transition-assessment.md`。**0 / 9 met**（未修改任何原有标准）。

| #   | 条件                                              | 当前      | 缺口                    |
| --- | ------------------------------------------------- | --------- | ----------------------- |
| 1   | Observe-only 方案正式批准                         | `NOT MET` | A5 无记录               |
| 2   | 观察窗口完成且有完整证据                          | `NOT MET` | 0 天 / 0 构建           |
| 3   | SBOM/签名/provenance 身份关系**在真实流水线**验证 | `NOT MET` | 仅离线 `LOCAL VERIFIED` |
| 4   | 组件覆盖缺口有可审计处理                          | `NOT MET` | 机制已验证，政策未批    |
| 5   | OIDC 身份与最小权限批准                           | `NOT MET` | A1–A4 + 预检            |
| 6   | 旧镜像回滚例外已决定                              | `NOT MET` | A8；**风险今天已存在**  |
| 7   | 负向测试通过                                      | `PARTIAL` | 八类全拒，**仅离线**    |
| 8   | 工作流/回滚/验收方案通过审查                      | `NOT MET` | 无审查记录              |
| 9   | Release Engineer 明确授权进入实施                 | `NOT MET` | —                       |

### 7.1 逐项重点核对（题目要求）

| 核对项                             | 结论                                                             |
| ---------------------------------- | ---------------------------------------------------------------- |
| 负向测试是否仍只有离线证据         | **是**，全部来自隔离 registry                                    |
| 真实 OIDC 与 GHCR 验证是否完成     | **未完成**（`NOT VERIFIED`）                                     |
| Observe-only 是否实际运行          | **未运行**（0 天 / 0 构建）                                      |
| SBOM 组件覆盖是否有正式策略        | **无**（机制已验证）                                             |
| 旧镜像回滚例外是否已批准           | **未批准**（`NOT FOUND`）                                        |
| 强制门禁是否有可审计的失败阻断机制 | **仅在设计/模拟层证明**（`tests/T12-blocked.log`），真实流水线无 |
| **发布与回滚身份是否一致**         | **不一致且未强制**——见 §7.2                                      |

### 7.2 新发现的缺陷（EA-50 单列）

部署引用是 **index digest**（`deploy-dev.yml:262,366,450`，来自 `:39` 的 `builds.outputs.digest`），
而签名、SBOM、provenance 的 subject 全是 **平台 manifest digest**。流水线**从不记录、也从不交叉校验** manifest digest。

后果：在真实部署点，没有任何机制证明"被部署的这个 index 里的 amd64 manifest 就是被签名、被出 SBOM 的那个"。当前它只是文档约定（EA-47/48/49 反复写过，但没有一处把它列为独立缺陷）。

> 这条不改变任何已有判定，也不要求本阶段修复（修改流水线被边界禁止）。它应在 A2/A3 落地时与"记录 manifest digest"一并处理。

---

## 8. 正式决策请求包

`docs/evidence/ea50/decisions/decision-request-package.md`：每项含 待决问题 / 选项 / 后果 / 现有证据 / 缺失证据 / 推荐（标 `RECOMMENDATION ONLY — NOT APPROVED`）/ 审批角色 / 决定字段 / 日期 / 后续执行条件，并附**决策记录模板**（缺少任一必填字段即视为无效）。

路由摘要：

| 事项           | 所有权                   | 阻塞什么                           |
| -------------- | ------------------------ | ---------------------------------- |
| A1             | Technical Approver       | 任何 keyless 签名；M9–M11          |
| A2 (+A2b 预检) | Release Engineer / Ops   | 任何 OIDC token；门禁的签名阶段    |
| A3             | Release Engineer         | 提案中的权限编辑                   |
| A4             | Ops + Release Engineer   | 自托管部署前的人工环节             |
| A5             | Release Engineer         | 整个观察窗口                       |
| A6             | Ops                      | GHCR 侧验证                        |
| A7             | Technical Approver       | "已知限制"表述；否则每次构建都失败 |
| A8             | Release Engineer + Audit | 回滚路径——**今天就有实际暴露**     |

---

## 9. 新增及修改文件

### 9.1 新增

| 文件                                                          | 说明                                     |
| ------------------------------------------------------------- | ---------------------------------------- |
| `docs/ea50-approval-and-rollback-readiness-report.md`         | 本报告                                   |
| `docs/evidence/ea50/decisions/decision-register.md`           | A1–A8 正式决策登记表                     |
| `docs/evidence/ea50/decisions/decision-request-package.md`    | 决策请求包 + 记录模板                    |
| `docs/evidence/ea50/decisions/strict_approval_scan.py`        | 严格审批扫描器（含正/反对照）            |
| `docs/evidence/ea50/decisions/check_consistency.py`           | 跨文档审批状态一致性校验                 |
| `docs/evidence/ea50/rollback/unsigned-image-rollback-risk.md` | 回滚风险分析与 R1–R4 比较                |
| `docs/evidence/ea50/oidc-precheck-plan.md`                    | OIDC 六项验收与预检设计                  |
| `docs/evidence/ea50/observe-only-start-checklist.md`          | 观察启动检查表                           |
| `docs/evidence/ea50/gate-transition-assessment.md`            | 九项转换条件逐项复核                     |
| `docs/evidence/ea50/environment/*`                            | 工作区快照、EA-49 复核输出、审批扫描输出 |

### 9.2 修改

| 文件                                 | 变更                                                                          |
| ------------------------------------ | ----------------------------------------------------------------------------- |
| `docs/project-development-state.md`  | 仅新增 `## EA-50 addendum`                                                    |
| `docs/release-approval-checklist.md` | 仅新增 §10.22 与 §12 状态句；**未改动任何既有生产阻断项**，未新增/删除 §11 行 |

### 9.3 刻意未修改

`.github/workflows/*`、`Dockerfile`、`.dockerignore`、业务代码、schema/权限/RLS；
**EA-43 风险接受草案的签字栏与风险等级栏保持为空**（未填任何内容）。

---

## 10. 质量检查结果

### 10.1 六项标准门禁

| 门禁                  | 状态            | 原因              |
| --------------------- | --------------- | ----------------- |
| `pnpm format:check`   | **RUN, exit 0** | Markdown 必须检查 |
| `pnpm typecheck`      | `NOT RUN`       | 无 TS/TSX 改动    |
| `pnpm lint`           | `NOT RUN`       | 无源码改动        |
| `pnpm deadcode:check` | `NOT RUN`       | 无导入/导出改动   |
| `pnpm test`           | `NOT RUN`       | 无行为改动        |
| `pnpm build`          | `NOT RUN`       | 无构建输入改动    |

EA-47 在相同 HEAD、相同依赖、相同构建配置下已用 `--force` 跑通全部六项（`docs/evidence/ea47/gates/`）。

### 10.2 本阶段实际执行的检查

| 检查               | 结果                                   |
| ------------------ | -------------------------------------- |
| EA-49 证据 SHA-256 | **18/18 通过**                         |
| EA-50 证据 SHA-256 | 见 `docs/evidence/ea50/SHA256SUMS`     |
| 严格审批扫描       | 0 项合格；正/反对照通过                |
| Markdown 格式      | `format:check` exit 0                  |
| 内部链接           | 见 §10.3                               |
| 审批状态一致性     | **`CONSISTENT`**（注册表为唯一真相源） |
| 秘密扫描           | 0 命中（见 §10.4）                     |
| Git diff / 暂存区  | 见 §11                                 |

### 10.3 内部链接

所有内部链接以脚本核验（非人工目测）：抽取反引号内的仓库相对路径（以 docs 开头）与证据包相对路径，剥离 `:行号` 后逐条检查存在性。

| 范围                                                        | 结果                                                                                       |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 仓库相对路径（以 `docs` 开头）                              | 全部存在，0 缺失                                                                           |
| 证据包相对路径（`decisions/`、`rollback/`、`environment/`） | 全部存在，0 缺失                                                                           |
| 尚未创建的目录                                              | `docs/evidence/ea50/observation/` 在观察窗口启动后才创建，因此只以文字说明引用，不写成路径 |
| 跨迭代引用                                                  | EA-48 / EA-49 的提案文件统一写成完整路径，避免同名文件歧义                                 |

> `docs/evidence/ea50/SHA256SUMS` 在报告初稿时尚不存在；生成后已重新校验（13/13 通过）。

### 10.4 秘密扫描

扫描范围：`docs/ea50-approval-and-rollback-readiness-report.md`、`docs/evidence/ea50/**`。

| 检查                                               | 结果               |
| -------------------------------------------------- | ------------------ |
| 私钥头（`BEGIN … PRIVATE KEY`）                    | 0 命中             |
| 私钥/口令文件（`*.key` / `*.pem` / `*.pw`）        | 证据包内**不存在** |
| `ghp_` / `github_pat_` / `xox*` / `AKIA` 令牌      | 0 命中             |
| 含口令的数据库连接串                               | 0 命中             |
| Server Action Key / 环境变量值                     | 未读取、未引用     |
| 长度 ≥40 的可疑 token 串（排除 digest 与版本标识） | 0 命中             |

本阶段全程未读取、未生成、未存储任何凭据；`strict_approval_scan.py` 与 `check_consistency.py` 只读 Markdown 与自身生成的 JSON。

---

## 11. Git 状态

| 项目             | 值                                                                                                                     |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 分支             | `hse-platform`                                                                                                         |
| HEAD             | `51a899b7aac0a942da327222a3eed355fca9798a`（**未变**，本阶段无提交）                                                   |
| 已跟踪修改       | 165 个（与执行前一致）                                                                                                 |
| 未跟踪条目       | 505 个（执行前 504，**+1** = `docs/ea50-approval-and-rollback-readiness-report.md`；`docs/evidence/` 折叠为一条 `??`） |
| 暂存区           | **空**（未执行任何 `git add`）                                                                                         |
| 提交 / 推送 / PR | **无**                                                                                                                 |
| 破坏性 Git 操作  | **无**（未执行 `reset --hard` / `clean` / `restore` / `checkout --`）                                                  |

### 11.1 正式 CI 工作流确认未被修改

`.github/workflows/*`、`Dockerfile`、`.dockerignore` 均显示 `M`，但属**执行前既有**改动：

| 文件                               | mtime（本机）    | 判定                            |
| ---------------------------------- | ---------------- | ------------------------------- |
| `Dockerfile`                       | 2026-10-21T09:54 | 早于 EA-47/48/49/50             |
| `.dockerignore`                    | 2026-10-14T07:43 | 早于 EA-47/48/49/50             |
| `.github/workflows/ci.yml`         | 2026-10-22T08:53 | 早于 EA-47/48/49/50             |
| `.github/workflows/deploy-dev.yml` | 2026-10-21T23:53 | 早于 EA-47/48/49/50             |
| `.github/workflows/security.yml`   | 2026-09-27T17:18 | 未修改（未出现在 `git status`） |

补充校验：三个 workflow 中 `cosign|syft|sbom|attest|id-token` 命中 **0**——供应链仍未接入正式流水线。

### 11.2 本阶段触碰的文件

| 文件                                                  | 状态                    | 说明                                                   |
| ----------------------------------------------------- | ----------------------- | ------------------------------------------------------ |
| `docs/ea50-approval-and-rollback-readiness-report.md` | `??` 新增               | 本报告                                                 |
| `docs/evidence/ea50/**`                               | `??` 新增               | 14 个文件（含 `SHA256SUMS`）                           |
| `docs/project-development-state.md`                   | `M`（**执行前已是 M**） | 仅新增 `## EA-50 addendum`                             |
| `docs/release-approval-checklist.md`                  | `??`（原有未跟踪）      | 仅新增 §10.22 与 §12 状态句；**未改动 §11 任何既有行** |

---

## 12. 未解决问题

| #   | 问题                                           | 等级                    | 说明                         |
| --- | ---------------------------------------------- | ----------------------- | ---------------------------- |
| 1   | A1–A8 全部无授权记录                           | `NOT FOUND`             | 无批准，也无正式待批工单     |
| 2   | 旧镜像回滚路径未决定                           | `PENDING AUTHORIZATION` | A8；**该暴露今天已存在**     |
| 3   | OIDC 能力未验证                                | `NOT VERIFIED`          | O3–O6                        |
| 4   | Observe-only 未启动                            | `NOT STARTED`           | 0 天 / 0 构建                |
| 5   | 强制门禁转换条件                               | `NOT MET`               | 0/9                          |
| 6   | 签名类指标不可观察                             | `NOT RUN`               | 依赖 A1/A2                   |
| 7   | GHCR 侧验证                                    | `NOT VERIFIED`          | 依赖 A6                      |
| 8   | SBOM 覆盖政策未批                              | `PROPOSED`              | A7 范畴                      |
| 9   | **部署/回滚身份未强制一致**                    | `FAIL`（新增）          | 流水线不记录 manifest digest |
| 10  | 生产 Migration 51 预检查 / 备份恢复 / 回滚演练 | `NOT RUN`               | 独立阻断项                   |
| 11  | 镜像可复现性策略书面决策                       | 待决策                  | EA-43 Rev 5 仍为草案         |
| 12  | 重建耗时（冷构建→可服务）未测量                | `NOT RUN`               | 影响 A8 的 R1/R4 可行性判断  |

---

## 13. 下一步所需的正式授权

| 顺序 | 授权 / 动作                    | 负责人                                    | 解锁                     |
| ---- | ------------------------------ | ----------------------------------------- | ------------------------ |
| 1    | **A1** Rekor 策略              | Technical Approver                        | keyless 方案可行性       |
| 2    | **A2** OIDC + attestation 权限 | Release Engineer                          | 签名与 M9–M11            |
| 3    | **OIDC 预检**（O3–O6）         | Release Engineer（执行）+ Ops（能力确认） | 证明"批准≠可用"是否成立  |
| 4    | **A5**（含起止日期与责任人）   | Release Engineer                          | 整个观察窗口             |
| 5    | **A8**                         | Release Engineer + Audit                  | 回滚路径（含现有暴露）   |
| 6    | A3 / A4                        | Release Engineer / Ops                    | 权限收窄与环境门         |
| 7    | A6                             | Ops                                       | GHCR 侧验证              |
| 8    | A7                             | Technical Approver                        | provenance 例外表述      |
| 9    | 转换条件第 8 项：**方案审查**  | Release Engineer + Technical Approver     | 进入实施阶段的最后一道关 |

**最终发布状态保持：`PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`。**

EA-50 只完成**审批闭环准备、回滚风险分析与文档交付**。生产 Migration 51 预检查、生产数据库与对象存储备份恢复、
完整生产部署与回滚演练、正式审批签字，以及镜像可复现性书面决策，均仍未完成，且不因本阶段改变。
