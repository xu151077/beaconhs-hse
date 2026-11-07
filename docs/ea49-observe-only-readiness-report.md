# EA-49：供应链门禁阶段 A（Observe-only）实施准备与授权核验

**状态：** `PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`
**阶段结论：** `NOT READY — 0 of 8 authorizations, 0 of 9 transition criteria`
**日期：** 2026-10-27
**分支 / HEAD：** `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`
**基线：** `docs/ea48-ci-supply-chain-gate-report.md`、`docs/evidence/ea48/`、`docs/ea43-image-reproducibility-risk-acceptance.md`（Rev 5）、`docs/release-approval-checklist.md`、`docs/project-development-state.md`
**新增证据：** `docs/evidence/ea49/`（`sha256sum -c SHA256SUMS` 见 §8）
**执行边界：** 未访问 GHCR / 生产 / ceshi；未使用任何真实 OIDC / Fulcio / Rekor / registry 凭据；未修改 `.github/workflows/*`、`Dockerfile`、`.dockerignore`、业务代码；未提交、未推送、未建 PR；未覆盖或删除任何既有镜像、容器、卷或证据。

---

## 0. 结论速览

| #   | 任务                     | 结论                                                                                                        | 等级                    | 证据                                                              |
| --- | ------------------------ | ----------------------------------------------------------------------------------------------------------- | ----------------------- | ----------------------------------------------------------------- |
| 1   | 执行前工作区状态         | 分支/HEAD 符合预期；165 `M` / 503 `??` / 暂存区空；EA-48 报告与 82 个证据文件俱在                           | ✅ `PASS`               | `environment/workspace.txt`                                       |
| 2   | EA-48 证据复核           | `sha256sum -c` **81/81 通过**；解压载荷 **7/7** 一致；证据未损坏                                            | ✅ `PASS`               | `environment/ea48-recheck.txt`                                    |
| 3   | 八项授权核验（A1–A8）    | **0 APPROVED / 0 PENDING / 0 REJECTED / 8 NOT FOUND**                                                       | ❌ `NOT FOUND`（全部）  | `authorization/authorization-register.md`、`approval-scan.json`   |
| 4   | 授权搜索方法可信度       | 三种独立搜索 + 正向对照；扫描器在合成签署样本上正确标记 `signed=True`                                       | ✅ `PASS`（方法可信）   | `authorization/search-scope.txt`、`scanner-positive-control.json` |
| 5   | Observe-only 方案        | 已制定：含义、窗口、14 项指标、8 项负向测试、退出条件、统一结果词汇                                         | ✅ `PROPOSED`           | `proposal/observe-only-plan.md`                                   |
| 6   | 观察窗口实际状态         | **0 天 / 0 次构建**；开始与结束日期均未设定                                                                 | `NOT RUN`               | `proposal/observe-only-plan.md` §2                                |
| 7   | 无授权下可做的事         | 10 项允许（全离线）；11 项仅可设计、执行需授权；3 项彻底禁止                                                | ✅ `PASS`（已逐项分类） | `proposal/capability-matrix.json`                                 |
| 8   | 实施前置条件（P1–P11）   | `APPROVED` 0 / `PENDING AUTHORIZATION` 6 / `NOT VERIFIED` 2 / `PROPOSED` 2                                  | ❌ `NOT READY`          | `proposal/implementation-readiness.md`                            |
| 9   | 强制门禁进入条件（9 项） | **0 / 9**；其中"负向测试"为 `PARTIAL`（仅离线）                                                             | ❌ `NOT MET`            | `proposal/gate-transition-criteria.md`                            |
| 10  | 授权状态跨文档一致性     | 5 份文档 + 注册表 + 状态文件互相一致（脚本校验 `CONSISTENT`）                                               | ✅ `PASS`               | `authorization/approval-consistency.json`                         |
| 11  | 新增的独立技术发现       | **P3**：`id-token: write` 能否真正取得 GitHub OIDC 身份，取决于仓库/套餐能力，**批准 ≠ 可用**，必须先做预检 | ⚠️ `NOT VERIFIED`       | `proposal/implementation-readiness.md` §2                         |
| 12  | 正式 CI 修改 / 真实观察  | **未实施**（阶段边界禁止）                                                                                  | `NOT RUN`               | 本报告 §9                                                         |

**一句话结论：** EA-49 **没有**发现任何一项授权记录——仓库里不存在 A1–A8 的任何批准，连"提交待批"的正式工单也没有；因此 Observe-only 窗口**不能开始**，全部签名相关指标停在 `NOT RUN`。本阶段交付的是一份**可审阅、可执行、且不会自我批准**的实施包：把"能做什么/不能做什么"变成可运行的分类矩阵（10 允许 / 11 仅设计 / 3 禁止），把 11 项实施前置条件和 9 项升级条件逐条绑定到负责人与证据位置，并新增一条此前未被识别的技术风险 **P3（OIDC 能力预检）**。发布状态保持 `PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`。

---

## 1. 执行前工作区状态

| 项目         | 值                                                                                                        |
| ------------ | --------------------------------------------------------------------------------------------------------- |
| 当前目录     | `/home/test/projects/beaconhs-hse`                                                                        |
| 分支         | `hse-platform`                                                                                            |
| HEAD         | `51a899b7aac0a942da327222a3eed355fca9798a`                                                                |
| 已跟踪修改   | 165 个（`git diff --stat`：5996 insertions / 2053 deletions）                                             |
| 未跟踪条目   | 503 个                                                                                                    |
| 暂存区       | 空                                                                                                        |
| EA-48 报告   | 存在，47,254 B                                                                                            |
| EA-48 证据   | 82 个文件（含 `SHA256SUMS`）                                                                              |
| EA-48 提案   | 6 个文件                                                                                                  |
| 工作流修改态 | `.github/workflows/*`、`Dockerfile`、`.dockerignore` 的 `M` 为执行前既有（mtime 2026-09-27 ~ 2026-10-22） |

**结论：✅ `PASS`。**

---

## 2. EA-48 证据复核

```
cd docs/evidence/ea48 && sha256sum -c SHA256SUMS → 81/81 OK, exit 0
UNCOMPRESSED-SHA256SUMS                          → 7/7 payloads match
```

未发现损坏或缺文件，无需记录差异，未覆盖任何原始证据。
证据：`environment/ea48-recheck.txt`

**同时复核了"工作流确实未被改动"**：三个 workflow 中 `cosign|syft|sbom|attest|id-token` 关键字命中 **0**，与 EA-48 的结论一致。

---

## 3. 八项授权核验结果

### 3.1 方法

三种独立搜索，全部留痕于 `authorization/`：

| 方法         | 脚本                                | 规则                                                                                                                                             | 结果                              |
| ------------ | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| 批准标记扫描 | `approval_scan.py`                  | 行内出现 `APPROVED`/`已批准`/`批准日期`/`signed by`/`signature: <值>`/`签字: <值>`，且**不是** `PENDING`/`required`/`待签`/`待决策` 之类的需求行 | **命中 0**                        |
| 签署表审计   | `signature_audit.py`                | 只认真正的签字列（表头含 `签字`/`签署`/`signature`，**排除** "signature required" 这类是否题）；`✅ Yes` 不算签字                                | 5 张表 / 16 个角色行 / **签署 0** |
| Git 历史     | `git log --grep` / `tag` / `branch` | 提交主题、tag、分支名                                                                                                                            | 无任何 A1–A8 批准记录             |

**扫描器可信度验证**：用一份合成样本（含一行真实签署、一行 `PENDING`、一行空）跑同一脚本，结果 `signed=True / False / False` — 证明"0 签署"不是扫描器失效造成的。证据：`authorization/scanner-positive-control.json`。

### 3.2 结果

| ID     | 授权事项                                                  | 负责人                   | 裁决            | 不存在的证据                         |
| ------ | --------------------------------------------------------- | ------------------------ | --------------- | ------------------------------------ |
| **A1** | 公共 Rekor 或私有 Sigstore                                | Technical Approver       | **`NOT FOUND`** | 扫描 0 命中；签署表 0/16             |
| **A2** | `id-token: write` + `attestations: write`（仅 build job） | Release Engineer         | **`NOT FOUND`** | 同上；`deploy-dev.yml` 无 `id-token` |
| **A3** | 移除 caller `packages: write`、取消 `secrets: inherit`    | Release Engineer         | **`NOT FOUND`** | 同上；`ci.yml:177-183` 仍保留        |
| **A4** | `environment: dev` 人工审批门                             | Ops + Release Engineer   | **`NOT FOUND`** | 同上；workflow 中无 `environment:`   |
| **A5** | Observe-only 阶段（2 周 + 起止日期）                      | Release Engineer         | **`NOT FOUND`** | 同上；仓库无任何观察记录             |
| **A6** | GHCR 只读凭据                                             | Ops                      | **`NOT FOUND`** | 同上                                 |
| **A7** | `buildkit_completeness=false` 例外流程                    | Technical Approver       | **`NOT FOUND`** | 同上                                 |
| **A8** | 旧未签名镜像回滚例外                                      | Release Engineer + Audit | **`NOT FOUND`** | 同上                                 |

**统计：`APPROVED` 0 · `PENDING AUTHORIZATION` 0 · `REJECTED` 0 · `NOT FOUND` 8。**

### 3.3 为什么是 `NOT FOUND` 而不是 `PENDING AUTHORIZATION`

`PENDING AUTHORIZATION` 用于"尝试执行、因缺授权而停止"的能力（见 §7 的可执行矩阵）；
这里**没有任何动作被尝试**，是"去找授权、没找到"。两者都意味着"不得继续"，但事实不同，
因此分开记录。仓库中既没有批准，也没有正式的待批工单。

### 3.4 既有审批材料不能当作授权

| 文档                                                    | 实际状态                                                           |
| ------------------------------------------------------- | ------------------------------------------------------------------ |
| `docs/ea39-release-decision-closure.md:505-520`         | 第 7–11 项全部 `PENDING` / `NOT DECIDED`                           |
| `docs/ea40-approval-execution-record.md:89-140`         | 原文：**"No valid written approval obtained"**                     |
| `docs/ea41-final-approval-package.md`                   | 同一张 PENDING 状态表                                              |
| `docs/ea43-image-reproducibility-risk-acceptance.md` §8 | 签字表**整表为空**                                                 |
| `docs/release-approval-checklist.md:299-304,350-355`    | 表头是"审批签字**是否必需**"，值 `✅ Yes` 是**需要签字**，不是已签 |

最后一条是本阶段刻意排除的陷阱：把 `✅ Yes`（是否题答案）当成签名，会得出"四名审批人已签"的错误结论。扫描器已按列语义处理，并在 `search-scope.txt` 中写明规则。

---

## 4. Observe-only 计划

完整方案：`proposal/observe-only-plan.md`。要点：

| 规则           | 含义                                              |
| -------------- | ------------------------------------------------- |
| 只收集         | SBOM / 签名 / provenance / digest / 验签结果      |
| 无决策权       | 不改变任何发布或部署决定                          |
| 不自动阻断     | 观察失败不阻止现有流水线                          |
| 不追溯签名     | 历史未签名镜像**永不**被标记为已签名              |
| 不绕过既有门禁 | 现有 6 项 CI 门禁与迁移/DB 套件照常执行、照常失败 |
| 不收集秘密     | 只记录 digest、布尔值、计数                       |
| 不改动环境     | 实验不得写入生产或 ceshi                          |

**两条必须写在最前面的澄清（否则容易误读）：**

1. **"部署没有被阻断"不等于"安全门禁通过"。** Observe-only 本身就是关掉阻断，因此本阶段的绿色部署**证明不了**门禁有效性；能得出的唯一结论是"控制执行了并产出预期工件"。
2. **既有强制检查失败时仍按原规则失败**，不得以 Observe-only 为由忽略。

---

## 5. 观察指标与周期

### 5.1 周期（全部为方案值，未执行）

| 属性                | 方案值                                                | 状态                    |
| ------------------- | ----------------------------------------------------- | ----------------------- |
| 时长                | **14 个日历日** 或 **10 次合格构建**，取较晚者        | `PROPOSED`（需 A5）     |
| 开始条件            | A1 + A2 + A5 已签，且首次可观察运行开始               | `PENDING AUTHORIZATION` |
| 开始 / 结束日期     | 未设定                                                | `PENDING AUTHORIZATION` |
| 已观察天数 / 构建数 | **0 / 0**                                             | `NOT RUN`               |
| 采样对象            | 窗口内全部 `deploy-dev` 构建，`linux/amd64`，不下采样 | `PROPOSED`              |

### 5.2 14 项指标（当前全部 `NOT RUN`）

| #   | 指标                       | 定义                                                           | 当前                                           |
| --- | -------------------------- | -------------------------------------------------------------- | ---------------------------------------------- |
| M1  | 构建成功率                 | 成功构建 ÷ 尝试构建                                            | `NOT RUN`                                      |
| M2  | SBOM 生成率                | 有可解析 SPDX **且** CycloneDX 的构建 ÷ 构建                   | `NOT RUN`                                      |
| M3  | SBOM 校验率                | 通过结构+绑定校验的 SBOM ÷ 已生成                              | `NOT RUN`                                      |
| M4  | 规范摘要稳定性             | 同一 manifest digest 重复扫描得到同一规范摘要                  | `NOT RUN`（离线测得 2/2，仅 `LOCAL VERIFIED`） |
| M5  | Chrome 覆盖                | 富化后出现 `chrome-headless-shell` 组件的构建 ÷ 构建           | `NOT RUN`（机制仅离线验证）                    |
| M6  | provenance subject 匹配率  | `subject.digest == manifest digest` ÷ 构建                     | `NOT RUN`                                      |
| M7  | provenance revision 匹配率 | `vcs.revision == github.sha` ÷ 构建                            | `NOT RUN`                                      |
| M8  | digest 解析率              | 能解析出**恰好一个** `linux/amd64` manifest ÷ 构建             | `NOT RUN`                                      |
| M9  | 签名生成率                 | 存在该 manifest digest 签名的构建 ÷ 构建                       | `NOT RUN`（需 A1/A2）                          |
| M10 | 验签成功率                 | 验签通过 ÷ 已签名构建                                          | `NOT RUN`（需 A1/A2）                          |
| M11 | 身份匹配率                 | Fulcio 身份匹配 `deploy-dev.yml@refs/heads/main` 的验签 ÷ 验签 | `NOT RUN`（需 A1/A2）                          |
| M12 | 门禁模拟失败分类           | 失败阶段按 `ENV/TOOL/ARTIFACT/POLICY/UNKNOWN` 分类             | `NOT RUN`                                      |
| M13 | 耗时与资源                 | 每构建新增墙钟秒数与产物字节                                   | `NOT RUN`（EA-48 估算 30–55 s）                |
| M14 | 未知组件与告警             | 校验告警数、无 purl 组件数                                     | `NOT RUN`                                      |

**失败分类中 `UNKNOWN` 会阻断阶段结束**，防止"无法解释的失败"被时间冲淡。

**明确无法观察的项目**：M9–M11 因 A1/A2 未批；任何需要真实 GHCR 读取的指标因 A6 未批；任何"让失败阻断部署"的能力因本阶段设计上不阻断。这些全部标 `NOT RUN`，不写 0 %，也不写"未知"。

---

## 6. 强制门禁阶段的进入条件

完整标准：`proposal/gate-transition-criteria.md`。九项条件当前 **0 / 9**：

| #   | 条件                                                            | 当前      | 说明                       |
| --- | --------------------------------------------------------------- | --------- | -------------------------- |
| 1   | Observe-only 方案正式批准                                       | `NOT MET` | A5 未签                    |
| 2   | 观察窗口实际完成并有完整证据                                    | `NOT MET` | 0 天 / 0 构建              |
| 3   | SBOM / 签名 / provenance 身份与 digest 关系**在真实流水线**验证 | `NOT MET` | 仅离线 `LOCAL VERIFIED`    |
| 4   | 关键组件覆盖缺口有可审计处理方式                                | `NOT MET` | 机制已验证，政策未批       |
| 5   | OIDC 身份与最小权限方案批准                                     | `NOT MET` | A1–A4 未签                 |
| 6   | 旧镜像回滚例外正式决定                                          | `NOT MET` | A8 未签                    |
| 7   | 负向测试通过（验签失败、身份错误、digest 不匹配）               | `PARTIAL` | 八类全部被拒，但**仅离线** |
| 8   | 工作流修改方案、回滚方案、验收标准通过审查                      | `NOT MET` | 无审查记录                 |
| 9   | Release Engineer 明确授权进入实施阶段                           | `NOT MET` | —                          |

同时列出**反条件**（任一出现即停止，无论九项多绿）：窗口存在未分类 `UNKNOWN`；构建数不足 10 却外推；分母为 0 却报 `PASS`；靠放宽检查变绿（关 `sbom:`、去掉 identity 约束、真实调用加 `--insecure-ignore-tlog`、删必需组件）；签名跨 digest 复用；未取得 A8 就执行回滚。

---

## 7. 无授权状态下可做 / 不可做（可执行分类）

`proposal/capability_matrix.py` 把边界写成可运行判定，脚本在"需要授权却被标为 ALLOWED"时报错退出。当前结果：**允许 10 / 仅设计 11 / 禁止 3**。

| 允许（全离线，隔离 registry）                | 仅设计、执行需授权       | 彻底禁止                  |
| -------------------------------------------- | ------------------------ | ------------------------- |
| 对本地镜像跑门禁                             | GitHub 步骤摘要（A5）    | 修改 `.github/workflows/` |
| syft 生成 SBOM                               | 真实 observe 运行（A5）  | 触发生产/dev 部署         |
| SBOM 结构/绑定/覆盖校验                      | 请求 OIDC token（A2）    | 访问生产/ceshi/GHCR 凭据  |
| 规范摘要两次对比                             | Fulcio 证书（A1/A2）     |                           |
| 离线核对 provenance subject/revision         | Rekor 写入（A1）         |                           |
| index→manifest 解析                          | GitHub attestation（A2） |                           |
| 一次性密钥签名/验签                          | 读取 GHCR（A6）          |                           |
| 负向测试（篡改/移植/错误身份/错误 revision） | 改权限（A3）             |                           |
| 记录指标到本地证据包                         | environment 门（A4）     |                           |
| —                                            | provenance 例外（A7）    |                           |
| —                                            | 未签名回滚（A8）         |                           |

---

## 8. 新增及修改文件

### 8.1 新增

| 文件                                         | 说明                                    |
| -------------------------------------------- | --------------------------------------- |
| `docs/ea49-observe-only-readiness-report.md` | 本报告                                  |
| `docs/evidence/ea49/`                        | 证据包（`SHA256SUMS` + 4 个可复跑脚本） |

### 8.2 修改

| 文件                                 | 变更                                                                               |
| ------------------------------------ | ---------------------------------------------------------------------------------- |
| `docs/project-development-state.md`  | 仅新增 `## EA-49 addendum`（EA-49A~J）                                             |
| `docs/release-approval-checklist.md` | 仅新增 §10.21，并在 §11 追加 EA-49 相关的 2 条状态行；**未改动任何既有生产阻断项** |

### 8.3 刻意未修改

`.github/workflows/*`、`Dockerfile`、`.dockerignore`、业务代码、schema、权限、RLS；
风险接受材料（EA-43）的历史签字栏与风险等级栏保持为空，未填入任何内容。

---

## 9. 质量检查结果

### 9.1 六项标准门禁

**仅运行 `pnpm format:check`（exit 0）**；typecheck / lint / deadcode / test / build 标 **`NOT RUN`**，原因：未修改任何应用代码、依赖、schema 或构建输入。EA-47 在相同 HEAD、相同依赖下已用 `--force` 跑通全部六项（`docs/evidence/ea47/gates/`）。

### 9.2 本阶段实际执行的检查

| 检查               | 结果                                                                     |
| ------------------ | ------------------------------------------------------------------------ |
| EA-48 证据 SHA-256 | 81/81 通过                                                               |
| EA-49 证据 SHA-256 | 见 `docs/evidence/ea49/SHA256SUMS`                                       |
| EA-49 解压载荷     | 本阶段无压缩证据（全部为 `.md`/`.json`/`.txt`/`.py` 原文）               |
| Markdown 格式      | `pnpm format:check` exit 0                                               |
| 内部链接           | 见 §9.3                                                                  |
| **审批状态一致性** | 脚本校验 **`CONSISTENT`**：注册表 8 项与实施清单、升级条件、状态文件一致 |
| 扫描器正向对照     | 合成签署样本被正确判定（`scanner-positive-control.json`）                |
| 秘密扫描           | 0 命中（见 §9.4）                                                        |
| Git diff / 暂存区  | 见 §10                                                                   |

### 9.3 内部链接

所有内部链接以脚本核验（非人工目测），规则：抽取反引号内的 `docs/...` 与证据包相对路径，逐条检查文件是否存在。

| 范围                                                            | 结果                                                                                        |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 仓库相对路径（`docs/...`，含 `:行号` 形式，已剥离行号后比对）   | 18 条全部存在，0 缺失                                                                       |
| 证据包相对路径（`proposal/`、`authorization/`、`environment/`） | 全部存在，0 缺失                                                                            |
| 未创建路径的处理                                                | `observation/` 目录在窗口开始后才创建，因此不写成路径引用，而写成"窗口开始后在证据包内创建" |
| EA-48 提案文件引用                                              | 统一写成完整路径 `docs/evidence/ea48/proposal/...`，避免同名文件歧义                        |

> `docs/evidence/ea49/SHA256SUMS` 在报告初稿写作时尚不存在，生成后已重新校验（18/18 通过）。

### 9.4 秘密扫描

扫描范围：`docs/ea49-observe-only-readiness-report.md`、`docs/evidence/ea49/**`。

| 检查                                               | 结果               |
| -------------------------------------------------- | ------------------ |
| 私钥头（`BEGIN … PRIVATE KEY`）                    | 0 命中             |
| 私钥/口令文件（`*.key` / `*.pem` / `*.pw`）        | 证据包内**不存在** |
| `ghp_` / `github_pat_` / `xox*` / `AKIA` 令牌      | 0 命中             |
| 含口令的数据库连接串                               | 0 命中             |
| 长度 ≥40 的可疑 token 串（排除 digest 与版本标识） | 0 命中             |

本阶段全程未读取、未生成、未存储任何凭据；`approval_scan.py` / `signature_audit.py` /
`capability_matrix.py` / `check_consistency.py` 只读 Markdown 与自身生成的 JSON，不接触环境变量。

---

## 10. Git 状态

| 项目             | 值                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------- |
| 分支             | `hse-platform`                                                                                                |
| HEAD             | `51a899b7aac0a942da327222a3eed355fca9798a`（**未变**，本阶段无提交）                                          |
| 已跟踪修改       | 165 个（与执行前一致）                                                                                        |
| 未跟踪条目       | 504 个（执行前 503，**+1** = `docs/ea49-observe-only-readiness-report.md`；`docs/evidence/` 折叠为一条 `??`） |
| 暂存区           | **空**（未执行任何 `git add`）                                                                                |
| 提交 / 推送 / PR | **无**                                                                                                        |
| 破坏性 Git 操作  | **无**（未执行 `reset --hard` / `clean` / `restore` / `checkout --`）                                         |

### 10.1 正式 CI 工作流确认未被修改

`.github/workflows/*`、`Dockerfile`、`.dockerignore` 在 `git status` 中显示 `M`，但均为**执行前既有**改动：

| 文件                               | mtime（本机）    | 判定                              |
| ---------------------------------- | ---------------- | --------------------------------- |
| `Dockerfile`                       | 2026-10-21T09:54 | 早于 EA-47/48/49                  |
| `.dockerignore`                    | 2026-10-14T07:43 | 早于 EA-47/48/49                  |
| `.github/workflows/ci.yml`         | 2026-10-22T08:53 | 早于 EA-47/48/49                  |
| `.github/workflows/deploy-dev.yml` | 2026-10-21T23:53 | 早于 EA-47/48/49                  |
| `.github/workflows/security.yml`   | 2026-09-27T17:18 | 未被修改（未出现在 `git status`） |

补充校验：三个 workflow 中 `cosign|syft|sbom|attest|id-token` 关键字命中 **0**，说明本阶段及此前各阶段都未把供应链接入正式流水线。

### 10.2 本阶段触碰的文件

| 文件                                         | 状态                    | 说明                                   |
| -------------------------------------------- | ----------------------- | -------------------------------------- |
| `docs/ea49-observe-only-readiness-report.md` | `??` 新增               | 本报告                                 |
| `docs/evidence/ea49/**`                      | `??` 新增               | 19 个文件（含 `SHA256SUMS`）           |
| `docs/project-development-state.md`          | `M`（**执行前已是 M**） | 仅新增 `## EA-49 addendum`             |
| `docs/release-approval-checklist.md`         | `??`（原有未跟踪）      | 仅新增 §10.21 与 §11 两条 EA-49 状态行 |

---

## 11. 未解决问题

| #   | 问题                                           | 等级                    | 说明                               |
| --- | ---------------------------------------------- | ----------------------- | ---------------------------------- |
| 1   | A1–A8 全部无授权记录                           | `NOT FOUND`             | 见 §3；无批准亦无正式待批工单      |
| 2   | P3：`id-token` 能力未预检                      | `NOT VERIFIED`          | 批准 ≠ 可用；需一次只读的能力探测  |
| 3   | Observe-only 未启动                            | `NOT RUN`               | 0 天 / 0 构建                      |
| 4   | 签名类指标完全无法观察                         | `NOT RUN`               | 依赖 A1/A2                         |
| 5   | GHCR 侧验证                                    | `NOT VERIFIED`          | 依赖 A6                            |
| 6   | Chrome 覆盖政策未批准                          | `PROPOSED`              | 机制已验证                         |
| 7   | provenance 完整性例外未决定                    | `PENDING AUTHORIZATION` | A7                                 |
| 8   | 未签名回滚路径未决定                           | `PENDING AUTHORIZATION` | A8；**当前若发生回滚，无合规路径** |
| 9   | 生产 Migration 51 预检查 / 备份恢复 / 回滚演练 | `NOT RUN`               | 独立阻断项，本阶段不涉及           |
| 10  | 镜像可复现性策略书面决策                       | 待决策                  | EA-43 Rev 5 仍为草案               |
| 11  | EA-38/EA-40 遗留的审批缺口                     | `PENDING`               | 与 A1–A8 独立，但同属"签字未取得"  |

**新增的一条实质发现：第 8 项意味着，在 A8 决定之前，一旦需要回滚到策略生效前的镜像，当前既没有例外程序、也没有审计路径——这是比"门禁未上线"更紧迫的运营风险。**

---

## 12. 下一阶段所需的正式授权

| 顺序 | 授权                           | 负责人                                    | 解锁什么                   |
| ---- | ------------------------------ | ----------------------------------------- | -------------------------- |
| 1    | **A1** Rekor 策略              | Technical Approver                        | 决定 keyless 方案是否可行  |
| 2    | **A2** OIDC + attestation 权限 | Release Engineer                          | 解锁 M9–M11 的观察能力     |
| 3    | **P3 预检**                    | Release Engineer（执行）+ Ops（套餐确认） | 确认 OIDC 真的能签发       |
| 4    | **A5** Observe-only 窗口       | Release Engineer                          | 解锁整个观察阶段           |
| 5    | A3 / A4                        | Release Engineer / Ops                    | 解锁权限收窄与环境门       |
| 6    | A6                             | Ops                                       | 解锁 GHCR 侧验证           |
| 7    | A7                             | Technical Approver                        | 解锁 provenance 例外的表述 |
| 8    | A8                             | Release Engineer + Audit                  | 解锁旧镜像回滚路径         |

决策请求包：`proposal/decision-request-package.md`（逐项列出选项、后果、可依赖的证据）。

**最终发布状态保持：`PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`。**

EA-49 只完成**审查、授权核验与实施准备**。生产 Migration 51 预检查、生产数据库与对象存储备份恢复、
完整生产部署与回滚演练、Technical Approver / Release Engineer / DBA / Ops 的正式签字，以及镜像可复现性
策略的书面决策，均仍未完成，且不因本阶段而改变。
