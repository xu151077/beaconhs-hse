# EA-48：CI 供应链安全门禁审查与隔离验证

**状态：** `PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`
**日期：** 2026-10-26（实验与审查，UTC）/ 2026-10-27（文档定稿，本地时区）
**分支 / HEAD：** `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`
**基线：** `docs/ea47-supply-chain-closure-report.md`、`docs/evidence/ea47/`、`docs/ea46-image-determinism-investigation.md`、`docs/ea43-image-reproducibility-risk-acceptance.md`
**新增证据：** `docs/evidence/ea48/`（82 个文件；`sha256sum -c SHA256SUMS` 81/81 通过，见 §11）
**执行边界：** 未访问 GHCR / 生产 / ceshi；未修改 `.github/workflows/*`、`Dockerfile`、`.dockerignore`、业务代码；未提交、未推送、未建 PR；未覆盖或删除任何既有镜像、容器、卷或证据。

---

## 0. 结论速览

| #   | 任务                         | 结论                                                                                                                                           | 等级                                  | 证据                                                              |
| --- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------- |
| 1   | 执行前工作区状态             | 分支/HEAD 符合预期；165 `M` / 502 `??` / 暂存区空；Docker 29.9.2 / Buildx v0.38.1 / BuildKit v0.34.0                                           | ✅ `PASS`                             | `environment/workspace.txt`                                       |
| 2   | EA-47 证据复核               | 49/49 SHA-256 通过；5/5 解压载荷哈希一致；报告结论与原始输出逐项可对应                                                                         | ✅ `PASS`                             | `environment/ea47-recheck.txt`                                    |
| 3   | CI 只读审查（14 项）         | 2 项 `PASS`、6 项 `PARTIAL`、6 项 `FAIL`（其中 1 项为潜在项，详见 §3）                                                                         | ⚠️ `PARTIAL`                          | `ci-audit/ci-cd-audit.md`                                         |
| 4   | 是否生成 SBOM                | **否**：三个 workflow 中 sbom/sigstore/attest/provenance 关键字命中 0                                                                          | ❌ `FAIL`                             | `ci-audit/ci-cd-audit.md` §2 #4                                   |
| 5   | 是否签名 / 验签              | **否**：无 cosign/notation/`attest-build-provenance`；无 `id-token`；无 `attestations`                                                         | ❌ `FAIL`                             | 同上 #6/#7/#10                                                    |
| 6   | 是否使用 GitHub OIDC         | **否**：`grep -rn 'id-token\|oidc' .github/` → 0 命中                                                                                          | ❌ `FAIL`                             | 同上 #10                                                          |
| 7   | 最小权限                     | ✅ 无 `contents: write`，且由 `workflow-repository-immutability.test.sh` 强制；但 `secrets: inherit` 过宽、`packages: write` 给到了 caller job | ⚠️ `PARTIAL`                          | 同上 #9/#11                                                       |
| 8   | 部署是否用不可变 digest      | ✅ 仅 `IMAGE_NAME@${IMAGE_DIGEST}`，commit tag 永不作为部署身份                                                                                | ✅ `PASS`                             | 同上 #1                                                           |
| 9   | 是否记录平台 manifest digest | **否**：只有 index digest 一个输出，而签名/SBOM/provenance 的 subject 都是 manifest                                                            | ❌ `FAIL`                             | 同上 #3                                                           |
| 10  | SBOM 门禁设计                | 7 阶段门禁（index→manifest→签名→SBOM→覆盖→provenance→SBOM 内容）已实现并在隔离环境验证                                                         | ✅ `PROPOSED`（已本地验证）           | `proposal/ci-supply-chain-design.md`、`gate/supply-chain-gate.sh` |
| 11  | 签名与 OIDC 设计             | keyless + `certificate-identity-regexp` 锁定 repo/workflow/branch；禁止 tag 验签                                                               | ✅ `PROPOSED`                         | `proposal/permissions-matrix.md`                                  |
| 12  | provenance 验收规则          | subject + `vcs.revision` 硬失败；`buildkit_completeness=false` 记录但不自动失败，需例外审批                                                    | ✅ `PROPOSED`                         | `proposal/ci-supply-chain-design.md` §5                           |
| 13  | 隔离测试 T1–T14              | 14/14 全部通过（含 8 个失败/负向场景被正确拒绝）                                                                                               | ✅ `PASS`（`LOCAL VERIFIED`）         | `proposal/verification-matrix.md`                                 |
| 14  | index / manifest digest 策略 | 部署固定 index digest；签名、SBOM、provenance 固定 manifest digest；tag 永不作为身份                                                           | ✅ `PASS`（测量）/ `PROPOSED`（政策） | 本报告 §8                                                         |
| 15  | Chrome Headless Shell 覆盖   | syft 1.55.0 **不识别**为组件（仅 5 个 `files[]` 条目）；已设计"声明式组件"补充机制并验证幂等与拒绝路径                                         | ⚠️ `PARTIAL`（机制已验证，CI 未实施） | `sbom/enrichment-*.json`、本报告 §9                               |
| 16  | CI 修改提案                  | 5 份文档 + 1 个 YAML 片段，全部在 `proposal/`，**未应用**                                                                                      | ✅ `PROPOSED`                         | `proposal/*`                                                      |
| 17  | GitHub OIDC / GHCR 侧验证    | 无 CI 执行权限、无 GHCR 凭据                                                                                                                   | `NOT RUN` / `NOT VERIFIED`            | 本报告 §13                                                        |

**一句话结论：** 当前 CI **不具备**任何供应链安全门禁——不生成 SBOM、不签名、不验签、不使用 OIDC、也不记录平台 manifest digest，尽管它已经把"按 index digest 部署"这件事做对了。本阶段交付了一个**可执行的 7 阶段门禁参考实现**和一套**完整提案**，并在隔离 registry 上用 T1–T14 证明了它能拒绝未签名、被篡改、签名被移植、身份不符、provenance revision 不符、平台选择歧义、tag 被改指、组件缺失这八类攻击/故障，同时**不误杀**正确镜像。提案未写入 `.github/workflows/`；GHCR 与真实 OIDC 路径仍 `NOT VERIFIED`。

---

## 1. 执行前工作区状态

| 项目          | 值                                                                      |
| ------------- | ----------------------------------------------------------------------- |
| 当前目录      | `/home/test/projects/beaconhs-hse`                                      |
| 分支          | `hse-platform`                                                          |
| HEAD          | `51a899b7aac0a942da327222a3eed355fca9798a`                              |
| 已跟踪修改    | 165 个（`git diff --stat`：5981 insertions / 2053 deletions）           |
| 未跟踪条目    | 502 个（`docs/evidence/` 整体折叠为一条）                               |
| 暂存区        | 空（`git diff --cached --stat` 无输出）                                 |
| Docker        | 29.9.2（API 1.56，overlayfs）                                           |
| Buildx        | v0.38.1                                                                 |
| BuildKit      | v0.34.0                                                                 |
| workflow 文件 | `ci.yml`（183 行）、`deploy-dev.yml`（505 行）、`security.yml`（64 行） |

**结论：✅ `PASS`。** 与 EA-47 记录一致（未跟踪数 502 含 EA-47 报告与证据目录）。

---

## 2. EA-47 证据复核

### 2.1 完整性

```
cd docs/evidence/ea47 && sha256sum -c SHA256SUMS   → 49/49 OK, exit 0
UNCOMPRESSED-SHA256SUMS                            → 5/5 载荷哈希一致
```

证据：`environment/ea47-recheck.txt`。

### 2.2 结论溯源（哪些是实测，哪些是建议）

| EA-47 结论                                            | 性质       | 原始输出                                 |
| ----------------------------------------------------- | ---------- | ---------------------------------------- |
| SBOM 可生成、可校验、`source.id` 绑定 manifest digest | **实测**   | `ea47/sbom/*`、`validation.json`         |
| 签名/验签/SBOM attestation 可用                       | **实测**   | `ea47/signing/verify-*`                  |
| 三类篡改被拒（未签名、追加层、签名移植）              | **实测**   | `ea47/signing/tamper-*`                  |
| provenance 与 index 内 attestation 逐字节一致         | **实测**   | `ea47/registry/*`                        |
| index digest 因 attestation descriptor 而变           | **实测**   | `ea47/registry/digest-relationships.txt` |
| 按 tag 验签必然失败                                   | **实测**   | `ea47/signing/verify-by-tag.txt`         |
| "CI 应增加 `sbom:` 并验签"                            | **建议**   | EA-47 §14 第 2 条                        |
| "部署前校验顺序"                                      | **建议**   | EA-47 §6.4                               |
| GHCR 侧签名存在性                                     | **未验证** | —                                        |

> 本阶段只把**实测**部分作为设计输入；建议部分作为提案的依据而非既成事实。

---

## 3. CI/CD 现状（含文件与行号）

完整审查表见 `docs/evidence/ea48/ci-audit/ci-cd-audit.md`。摘要：

| #   | 检查项                        | 现状                                                                                                                                     | 位置                                            | 等级              |
| --- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ----------------- |
| 1   | 不可变 digest 部署            | `IMAGE_NAME@${IMAGE_DIGEST}`，commit tag 永不作部署身份                                                                                  | `deploy-dev.yml:262,366,450`；`RUNBOOK:525-532` | ✅ `PASS`         |
| 2   | 构建输出含完整 index digest   | `build-push-action` 的 `outputs.digest` → job output                                                                                     | `deploy-dev.yml:39,82-99`                       | ✅ `PASS`         |
| 3   | 记录平台 manifest digest      | **无**，只有 index digest                                                                                                                | `deploy-dev.yml:39`                             | ❌ `FAIL`         |
| 4   | 生成 SBOM                     | **无**（无 `sbom:`、无 syft/trivy）                                                                                                      | `deploy-dev.yml:82-99`                          | ❌ `FAIL`         |
| 5   | 生成并验证 provenance         | BuildKit 默认产出 SLSA v1，但**无任何验证步骤**；`buildkit_completeness=false`                                                           | `deploy-dev.yml:82-99`                          | ⚠️ `PARTIAL`      |
| 6   | 镜像签名                      | **无**（cosign/sigstore/attest 关键字 0 命中）                                                                                           | 全部 workflow                                   | ❌ `FAIL`         |
| 7   | 部署前验签并比对 digest       | **无**                                                                                                                                   | `deploy-dev.yml`（缺失）                        | ❌ `FAIL`         |
| 8   | tag 改指可绕过验证            | 部署按 digest 固定 ⇒ 改指无法改变部署对象；但**没有签名门禁可绕过**（因为还没有门禁）⇒ 该项目前空转，一旦引入签名门禁必须按 digest 解析  | `deploy-dev.yml:88`                             | ❌ `FAIL`（潜在） |
| 9   | 最小权限                      | 无 `contents: write`，有脚本强制；但 `packages: write` 给了 caller，`secrets: inherit` 过宽                                              | `ci.yml:177-183`；`deploy-dev.yml:23-25,33-35`  | ⚠️ `PARTIAL`      |
| 10  | 使用 GitHub OIDC              | **无**（`id-token`/`oidc` 0 命中）                                                                                                       | 全部 workflow                                   | ❌ `FAIL`         |
| 11  | 密钥/token 不暴露给不可信步骤 | 今天无签名密钥；但 38 处 `secrets.` + `inherit` 使全部秘密进入 reusable workflow 上下文                                                  | `ci.yml:183`                                    | ⚠️ `PARTIAL`      |
| 12  | PR / 分支 / tag / 手动边界    | `ci.yml:175` 限定 push/dispatch；`deploy-dev.yml:41-52` 再校验 `refs/heads/main`；无 `pull_request_target`；**但无 `environment:` 保护** | `ci.yml:6-11,175`；`deploy-dev.yml:41-52`       | ⚠️ `PARTIAL`      |
| 13  | 构建完成后才执行发布门禁      | `push: true` 与 build 同一步，**镜像在任何门禁之前就已推入 GHCR**                                                                        | `deploy-dev.yml:82-99`                          | ⚠️ `PARTIAL`      |
| 14  | 门禁失败阻断发布/部署         | 现有门禁（stale-main、key gate、readiness）确实 fail-closed；但**不存在供应链门禁**                                                      | `deploy-dev.yml:46-52,132-139,286-296,461-487`  | ⚠️ `PARTIAL`      |

**统计（14 项）：** `PASS` 2 项（#1 不可变 digest 部署、#2 构建输出含 index digest）、`PARTIAL` 6 项（#5、#9、#11–#14）、`FAIL` 6 项（#3 manifest digest 未记录、#4 无 SBOM、#6 无签名、#7 无验签、#8 潜在绕过、#10 无 OIDC）。

### 3.1 关键发现：镜像先发布、后门禁

`deploy-dev.yml:82-99` 的 `push: true` 与构建在同一步完成。任何在 build job 之后添加的供应链门禁，**只能阻止部署，不能阻止发布**。提案因此把 SBOM/签名放进 build job（`sbom:`/`provenance:` 输入 + 同 job 内签名步骤），使失败也能阻断 tag 被视为"可发布"。

### 3.2 关键发现：签名对象与部署对象不是同一个 digest

部署用 index digest（`deploy-dev.yml:39`），而 EA-47 实测证明签名、SBOM、provenance 的 subject 全是**平台 manifest digest**。当前流水线**没有**任何地方记录或解析 manifest digest，这意味着即使将来只加"签名 + 验签"两步，也会因为"验签对象找不到"而失败，或被迫按 tag 验签——而 EA-47 已证明按 tag 验签必然报 `no signatures found`。

---

## 4. SBOM 门禁设计

完整设计见 `docs/evidence/ea48/proposal/ci-supply-chain-design.md` §4。要点：

| 阶段 | 动作                                                                                  | 断言           |
| ---- | ------------------------------------------------------------------------------------- | -------------- |
| 生成 | 对**已推送**镜像按 manifest digest 扫描（syft 1.55.0），输出 SPDX 2.3 + CycloneDX 1.7 | 两种格式都产出 |
| 结构 | 解析、必填字段、关系端点可解析                                                        | 0 error        |
| 绑定 | **根包 checksum == 平台 manifest digest**                                             | 是             |
| 覆盖 | 必需组件断言（next/react/node/libreoffice-core/poppler-utils/chrome-headless-shell）  | 全部存在       |
| 内容 | 记录**规范组件摘要**（canonical digest），同时记录原始文件哈希                        | 两者都入库     |

### 4.1 关键发现：SBOM 原始字节不可复现（新增证据）

对**同一个不可变 digest** 连续扫描两次：

| 运行             | SPDX 文件 SHA-256   | CycloneDX 文件 SHA-256 |
| ---------------- | ------------------- | ---------------------- |
| 1                | `0e91a7f8478e46dd…` | `782b10541a2704f4…`    |
| 2                | `0f91b0d6c6dce8bd…` | `42c414ef1c6399b6…`    |
| **规范组件摘要** | `0064dce94573f233…` | 组件集合完全一致       |

差异来源：SPDX `documentNamespace` 与 CycloneDX `serialNumber` 各含一个随机 UUID，另有创建时间戳。因此：

- **禁止**跨运行比较 SBOM 原始哈希（每次都会"失败"）；
- 比较**规范摘要**（`gate/sbom_canonical.py`：对 `(name, version, purl, sourceInfo)` 排序后取 SHA-256）；
- 原始哈希仍要记录，用于证明"签的是哪一份文件"；
- 负向对照（`gate/t13_negative_control.py`）修改一个包版本后规范摘要**必须变化**，证明规范化没有把真实差异抹平。

证据：`sbom/det-{1,2}.{spdx,cdx}.json.xz`、`tests/T13-canonical-*.json`。

---

## 5. 签名与 OIDC 设计

完整设计见 `proposal/permissions-matrix.md`。要点：

| 项目     | 方案                                                                                                                                                                                              |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 身份     | GitHub Actions OIDC → Fulcio 短期证书（**无长期私钥**）                                                                                                                                           |
| 信任约束 | `--certificate-identity-regexp '^https://github\.com/<org>/<repo>/\.github/workflows/deploy-dev\.yml@refs/heads/main$'` + `--certificate-oidc-issuer https://token.actions.githubusercontent.com` |
| 签名对象 | **平台 manifest digest**（不是 index，不是 tag）                                                                                                                                                  |
| 存储     | registry 内 cosign artifact（本 registry 回退到 `sha256-<digest>` 标签；GHCR 支持 OCI referrers）                                                                                                 |
| 验签位置 | deploy job，**migrations 之前**                                                                                                                                                                   |
| 失败行为 | 非零退出 ⇒ 部署终止                                                                                                                                                                               |
| 权限     | `id-token: write` 与 `attestations: write` **仅给 build job**；deploy job 保持只读                                                                                                                |
| 透明日志 | 二选一：公共 Rekor（可审计但 digest 公开）/ 私有 Sigstore + 不可变部署日志（不泄露但无第三方证明）——**需审批人决定**                                                                              |

### 5.1 权限矩阵（现状 → 提案）

| Job                             | contents | packages         | id-token      | attestations  |
| ------------------------------- | -------- | ---------------- | ------------- | ------------- |
| `ci.yml / deploy-dev`（caller） | read     | **write → read** | –             | –             |
| `deploy-dev.yml / build`        | read     | write            | **– → write** | **– → write** |
| `deploy-dev.yml / deploy`       | read     | read             | –             | –             |

`contents: write` 在所有 job 中始终缺席，且由 `scripts/ci/workflow-repository-immutability.test.sh`（`ci.yml:114` 执行）强制——提案保留该约束。

### 5.2 验签必须同时满足的 5 个条件

1. 签名对象是预期 **manifest digest**（不是 index、不是 tag）；
2. 签名身份符合预期 workflow + 分支（identity regexp + issuer）；
3. provenance 的 `vcs.revision` == 待发布 commit；
4. SBOM 关联的镜像对象 == 待发布对象（根包 checksum 比对）；
5. **篡改后的 digest 无法复用原签名通过验证**（T3/T6 已实测拒绝）。

---

## 6. Provenance 验收规则

| 条件                                                | 要求   | 当前实测值                           |
| --------------------------------------------------- | ------ | ------------------------------------ |
| index 内含 attestation manifest                     | 是     | 是（`530bbc28…`，`unknown/unknown`） |
| `subject[0].digest` == manifest digest              | 是     | 是（`be54cfce…`）                    |
| `vcs.revision` == `github.sha`                      | 是     | 是（`51a899b7…`）                    |
| `predicateType` == `https://slsa.dev/provenance/v1` | 是     | 是                                   |
| `buildkit_completeness.request == true`             | **否** | `false`                              |
| `resolvedDependencies` 完整                         | **否** | `false`                              |
| provenance 有组织签名                               | **否** | BuildKit attestation 本身未签名      |

**规则：** subject 或 revision 不符 ⇒ **硬失败，阻断部署**；completeness 不足 ⇒ **记录 + 需例外审批**，不自动失败（因为它反映的是 builder 能力，不是本次构建的错误）。

例外审批流程（`PROPOSED`）：由 Technical Approver 书面确认"本次发布不使用 SLSA L2+ 声明"，并把 `buildkit_completeness` 值写入发布记录；若政策要求 L2+，必须先更换受控 builder，不能靠关闭 provenance 绕过。

---

## 7. 隔离测试 T1–T14

完整矩阵见 `proposal/verification-matrix.md`。全部在 `127.0.0.1:5055` 的**新仓库** `beaconhs-ea48` 上执行，EA-47 仓库 `beaconhs-ea47` 只读未写。

| ID  | 场景                       | 结果                                                                                                                        | 退出码  | 等级      |
| --- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------- | --------- |
| T1  | 为实验镜像生成 SBOM        | 15.1 s，`source.id = be54cfce…`，1,520 artifacts                                                                            | 0       | ✅ `PASS` |
| T2  | 验证 SBOM 格式             | SPDX-2.3 1,521 包 / 9,042 文件，0 error 0 warning                                                                           | 0       | ✅ `PASS` |
| T3  | SBOM 关联到错误 digest     | 移植正确 bundle 到篡改 digest → `provided artifact digest does not match any digest in statement`                           | 1       | ✅ `PASS` |
| T4  | 对正确 digest 签名并验签   | 7 阶段门禁全 PASS                                                                                                           | 0       | ✅ `PASS` |
| T5  | 对未签名镜像验签           | `no signatures found`                                                                                                       | 10      | ✅ `PASS` |
| T6  | 篡改后复用原签名           | 追加层 → `d74dec8c…`；移植签名 → 拒绝；门禁阻断                                                                             | 1       | ✅ `PASS` |
| T7  | 身份不符的签名             | 新密钥从未签过该镜像 → `accepted signatures do not match threshold, Found: 0`                                               | 1       | ✅ `PASS` |
| T8  | provenance revision 不符   | `vcs.revision = 0000…` → 拒绝；另测门禁钉 `1111…` → 拒绝                                                                    | 1       | ✅ `PASS` |
| T9  | tag 改指、digest 未变      | tag 从 `9b2156ac…` 改到 `d74dec8c…`；固定 digest 仍解析原对象；门禁拒绝 tag、通过 digest                                    | 1 / 0   | ✅ `PASS` |
| T10 | index 与 manifest 不一致   | (a) 两个 amd64 → `platform selection is ambiguous`；(b) 仅 attestation → `the index contains no linux/amd64 image manifest` | 1       | ✅ `PASS` |
| T11 | 缺少 Chrome Headless Shell | 门禁 `--require-component` 失败；补充机制生效且幂等；文件不存在时拒绝                                                       | 1/0/0/1 | ✅ `PASS` |
| T12 | 门禁失败阻断发布           | 失败 → `PUBLISH/ROLLOUT BLOCKED`，标记文件不存在；通过 → 标记文件创建                                                       | 1 / 0   | ✅ `PASS` |
| T13 | （新增）SBOM 确定性陷阱    | 原始哈希不同、规范摘要相同；改一个版本后规范摘要变化                                                                        | 0 / 1   | ✅ `PASS` |
| T14 | （新增）YAML 语法校验      | 3 个真实 workflow + 1 个提案片段全部解析成功；job 级权限从解析结果读取（非字符串搜索）                                      | 0       | ✅ `PASS` |

### 7.1 门禁自身发现并修复的 3 个缺陷

| #   | 缺陷                                          | 症状                                  | 修复                                                      |
| --- | --------------------------------------------- | ------------------------------------- | --------------------------------------------------------- |
| G1  | digest 比较混用 `sha256:` 前缀与裸十六进制    | 正确镜像被判 `subject_matches: False` | 比较前统一规范化                                          |
| G2  | `--repo repo@sha256:…` 被拼成 `repo@sha@sha`  | `could not parse reference`           | 拆 `REF_NAME` / `RESOLVE_REF`，后续阶段一律按 digest 寻址 |
| G3  | 零个 amd64 descriptor 报"ambiguous (found 0)" | 运维看到误导性信息                    | 单独区分"缺失"与"歧义"                                    |

这三个缺陷都由**负向测试**暴露，说明"只跑 happy path"不足以验证门禁。

### 7.2 未执行项（需要 GitHub / GHCR / 真实身份）

| ID  | 场景                                   | 原因                           | 等级           |
| --- | -------------------------------------- | ------------------------------ | -------------- |
| N1  | 真实 OIDC token → Fulcio 证书          | 禁止触发正式 CI，无 GHCR 访问  | `NOT RUN`      |
| N2  | 用 identity regexp 验证 keyless 签名   | 需要真实 Fulcio 证书           | `NOT RUN`      |
| N3  | 把 SBOM 发布为 workflow artifact       | 无工作流执行                   | `NOT RUN`      |
| N4  | GitHub 原生 artifact attestation       | 需要真实 `attestations: write` | `NOT RUN`      |
| N5  | Rekor 透明日志条目                     | 刻意避免向公共日志写入         | `NOT RUN`      |
| N6  | 插入门禁后的真实 `deploy-dev.yml` 运行 | 不得修改或触发正式工作流       | `NOT RUN`      |
| N7  | GHCR 侧验签                            | 无凭据                         | `NOT VERIFIED` |

---

## 8. index 与 manifest digest 策略

| 对象                            | 用途                                    | 是否可复现                      | 本阶段验证                      |
| ------------------------------- | --------------------------------------- | ------------------------------- | ------------------------------- |
| OCI index digest                | **部署引用**（`IMAGE_NAME@sha256:…`）   | 否（含 attestation descriptor） | ✅ 拉取、不可变、tag 改指不影响 |
| 平台 manifest digest            | **签名 / SBOM / provenance 的 subject** | 否（preview 密钥）              | ✅ 解析、验签、绑定             |
| image config digest             | 内容标识（`rootfs`）                    | 否                              | 记录                            |
| layer digest                    | 逐层内容                                | 17/18（EA-46）                  | 引用 EA-46                      |
| SBOM 原始文件 digest            | 证明"签的是哪份文件"                    | **否**（随机 UUID）             | ✅ 实测两次不同                 |
| SBOM 规范组件摘要               | 跨运行比较组件集合                      | **是**                          | ✅ 实测两次相同                 |
| provenance / attestation digest | provenance 对象身份                     | 否（`invocationId`/时间戳）     | ✅ 实测                         |
| 签名 artifact                   | 签名对象                                | 随签名时间变化                  | ✅ 实测                         |

**策略（`PROPOSED`，需书面批准）：**

1. 部署继续固定 **index digest**，不改为 tag。
2. 供应链验收对象固定 **平台 manifest digest**；三者（签名、SBOM、provenance）必须指向同一个值。
3. **禁止**按 tag 验签（EA-47 实测必然失败）。
4. 多平台部署必须显式声明平台；本仓库当前 `platforms: linux/amd64`（`deploy-dev.yml:86`），门禁按 `linux/amd64` 解析，出现零个或多个 amd64 descriptor 都拒绝。
5. 不得因 manifest digest 在某次实验中稳定，就假定所有构建/平台稳定（EA-46 已证伪）。
6. index 与 manifest 的可复现性**分别评估**，不互相替代。
7. 不得通过关闭 provenance/SBOM/签名来消除 digest 差异。

---

## 9. Chrome Headless Shell 覆盖方案

### 9.1 现状（实测）

- `Dockerfile:95-101`：`ARG HEADLESS_SHELL_VERSION=140.0.7339.207`，通过 `@puppeteer/browsers@3.0.6` 安装到 `/opt/chrome`。
- syft 1.55.0 对该镜像：`packages` 中**无任何** `chrome*` 条目；`files[]` 中有 5 条：
  - `/opt/chrome/chrome-headless-shell/linux-140.0.7339.207/chrome-headless-shell-linux64/chrome-headless-shell`
  - 以及 `libEGL.so`、`libGLESv2.so`、`libvk_swiftshader.so`、`libvulkan.so.1`
- 二进制分类器只识别出 `node`（以及 2 个 `fastlist` PE 文件）。

### 9.2 为什么不能只靠"格式有效"

SBOM 通过 SPDX 校验不代表组件完整。若用 SBOM 做浏览器漏洞比对，`chrome-headless-shell` 缺失会导致**漏报**。因此门禁必须有**必需组件断言**，且断言失败必须阻断。

### 9.3 方案比较

| 方案                             | 优点                   | 缺点                            | 结论             |
| -------------------------------- | ---------------------- | ------------------------------- | ---------------- |
| 换扫描器（trivy / cdxgen）       | 可能识别更多二进制     | 未验证；增加工具链依赖          | 备选，需单独评估 |
| 自定义 syft cataloger            | 根本解决               | 维护成本高，需 Go 开发          | 长期方案         |
| **声明式组件补充**（本阶段验证） | 零新依赖、可审计、幂等 | 需要维护声明文件                | ✅ `PROPOSED`    |
| 用 `files[]` 代替组件            | 无需额外工作           | 无法做版本/漏洞匹配，等于没覆盖 | ❌ 拒绝          |

### 9.4 已验证的补充机制（`gate/enrich_sbom.py`）

规则：

1. 组件版本**必须**来自固定构建输入（Dockerfile ARG），不得猜测；
2. 声明中列出的证据路径**必须**真实存在于镜像 `files[]`，否则 `rejected-missing-files` 并退出 1；
3. 扫描器**已识别**的组件报 `duplicate-not-added`，**不重复添加**（防止 purl 膨胀）；
4. 新增条目带 `sourceInfo = "ea48:declared:<origin>"`，消费方可区分"检测到"与"声明"。

实测：

| 用例                       | 结果                             | 证据                                      |
| -------------------------- | -------------------------------- | ----------------------------------------- |
| 补充 chrome-headless-shell | `added`，1,521 → 1,522 包        | `sbom/enrichment-report.json`             |
| 重复运行                   | `duplicate-not-added`，包数不变  | `sbom/enrichment-idempotency-report.json` |
| 证据路径不存在             | `rejected-missing-files`，退出 1 | `sbom/enrichment-rejection-report.json`   |

---

## 10. CI 修改提案文件清单

全部位于 `docs/evidence/ea48/proposal/`，**未写入 `.github/workflows/`**：

| 文件                               | 内容                                                                                                 |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `ci-supply-chain-design.md`        | 设计原则、目标步骤顺序、keyless 理由、SBOM 门禁、provenance 规则、失败语义、证据留存、成本、回滚     |
| `workflow-change-plan.md`          | 11 项变更（C1–C11）、精确插入点、顺序不变式、明确不做的事、预计耗时                                  |
| `permissions-matrix.md`            | 现状 vs 提案权限矩阵、secret 暴露面、OIDC trust policy、Rekor 二选一、触发器边界、自托管 runner 约束 |
| `verification-matrix.md`           | T1–T14 + N1–N7、门禁阶段覆盖表、3 个门禁缺陷                                                         |
| `rollback-plan.md`                 | R1–R4 回滚层级、不可回滚项（已发布签名）、与既有部署回滚的交互、分阶段采纳                           |
| `example-deploy-steps.yml.snippet` | 6 个步骤的 YAML 片段，带 `PROPOSAL — NOT FOR PRODUCTION — NOT APPLIED` 横幅                          |

---

## 11. 质量门禁结果

### 11.1 六项标准门禁

**未运行**（`NOT RUN`），原因：本阶段只新增文档与隔离实验产物，**未修改任何应用代码、schema、依赖、构建配置或正式工作流**。EA-47 在相同 HEAD、相同依赖、相同构建配置下已用 `--force` 跑通全部六项（`docs/evidence/ea47/gates/`）；本次改动不触碰任何被这些门禁覆盖的输入。

| 门禁                  | 状态      | 理由                              |
| --------------------- | --------- | --------------------------------- |
| `pnpm format:check`   | **RUN**   | 见 §11.2（Markdown 格式必须检查） |
| `pnpm typecheck`      | `NOT RUN` | 无 TS/TSX 改动                    |
| `pnpm lint`           | `NOT RUN` | 无源码改动                        |
| `pnpm deadcode:check` | `NOT RUN` | 无导入/导出改动                   |
| `pnpm test`           | `NOT RUN` | 无源码或行为改动                  |
| `pnpm build`          | `NOT RUN` | 无构建输入改动                    |

### 11.2 本阶段实际执行的检查

| 检查                              | 结果                                                    | 证据                             |
| --------------------------------- | ------------------------------------------------------- | -------------------------------- |
| Markdown 格式                     | `pnpm format:check` → **exit 0**，全部文件通过 Prettier | 本阶段日志                       |
| EA-47 证据 SHA-256                | 49/49 通过                                              | `environment/ea47-recheck.txt`   |
| EA-48 证据 SHA-256                | 81/81 通过（退出码 0）                                  | `docs/evidence/ea48/SHA256SUMS`  |
| 证据解压载荷一致性                | 7/7 一致（4 份扫描对 + 3 份补充 SBOM）                  | `UNCOMPRESSED-SHA256SUMS`        |
| SBOM 格式解析                     | SPDX 2.3 / CycloneDX 1.7，0 error                       | `sbom/validation.json`           |
| YAML 语法（真实 workflow + 片段） | 4/4 解析成功，0 error                                   | `tests/T14-yaml-validation.json` |
| 门禁脚本语法                      | `bash -n` 通过                                          | `gate/supply-chain-gate.sh`      |
| 秘密扫描                          | 0 命中                                                  | 见 §11.3                         |
| Git diff / 暂存区                 | 165 `M` / 503 `??` / 暂存区空                           | 见 §12                           |

### 11.3 内部链接

**内部链接**（脚本校验，非人工目测）：

| 范围                                                                                               | 结果                                   |
| -------------------------------------------------------------------------------------------------- | -------------------------------------- |
| 仓库相对路径（`docs/...`）                                                                         | 16 条全部存在，0 缺失                  |
| 证据包相对路径（`gate/`、`proposal/`、`tests/`、`sbom/`、`signing/`、`ci-audit/`、`environment/`） | 全部存在，0 缺失                       |
| 通配引用（`*.json.xz`、`tamper-*.txt` 等）                                                         | 按 §7 的逐项证据路径核对，均有对应文件 |

`docs/PRODUCTION_RUNBOOK.md` 的引用已改为章节引用（原为行号），避免行号漂移导致链接失效。

### 11.4 秘密扫描

扫描范围：`docs/ea48-ci-supply-chain-gate-report.md`、`docs/evidence/ea48/**`。规则：私钥头、`ghp_`/`github_pat_`/`xox`/`AKIA` 令牌、数据库连接串、`COSIGN_PASSWORD=` 赋值、长随机串。

结果：**0 命中**。

| 检查                                          | 结果                                           |
| --------------------------------------------- | ---------------------------------------------- |
| 私钥头（`BEGIN … PRIVATE KEY`）               | 0 命中；证据包内**无任何** `.key` / `.pw` 文件 |
| `ghp_` / `github_pat_` / `xox*` / `AKIA` 令牌 | 0 命中                                         |
| 数据库连接串（含口令）                        | 0 命中                                         |
| `COSIGN_PASSWORD=` 实值赋值                   | 0 命中（报告中仅出现占位说明）                 |
| 用 EA-47 口令文件逐行反查                     | 0 匹配                                         |
| 用 EA-47 私钥文件逐行反查                     | 0 匹配                                         |
| 用 EA-48 临时口令文件逐行反查                 | 0 匹配                                         |

说明：EA-47 与 EA-48 的私钥、口令均只存在于 `/tmp/opencode/**`，从未复制进仓库或证据包；
证据包内只有公钥 `signing/verification-key.pub`（`BEGIN PUBLIC KEY`）。

---

## 12. Git 状态

| 项目             | 值                                                                                                          |
| ---------------- | ----------------------------------------------------------------------------------------------------------- |
| 分支             | `hse-platform`                                                                                              |
| HEAD             | `51a899b7aac0a942da327222a3eed355fca9798a`（**未变**，本阶段无提交）                                        |
| 已跟踪修改       | 165 个（与执行前一致）                                                                                      |
| 未跟踪条目       | 503 个（执行前 502，**+1** = `docs/ea48-ci-supply-chain-gate-report.md`；`docs/evidence/` 折叠为一条 `??`） |
| 暂存区           | **空**（未执行任何 `git add`）                                                                              |
| 提交 / 推送 / PR | **无**                                                                                                      |
| 破坏性 Git 操作  | **无**（未执行 `reset --hard` / `clean` / `restore` / `checkout --`）                                       |

### 12.1 正式 CI 工作流确认未被修改

`.github/workflows/*`、`Dockerfile`、`.dockerignore` 在 `git status` 中显示为 `M`，但这是**执行前既有的**
未提交改动，本阶段未触碰：

| 文件                               | mtime（本机）    | 说明                            |
| ---------------------------------- | ---------------- | ------------------------------- |
| `Dockerfile`                       | 2026-10-21T09:54 | 早于 EA-47/EA-48                |
| `.dockerignore`                    | 2026-10-14T07:43 | 早于 EA-47/EA-48                |
| `.github/workflows/ci.yml`         | 2026-10-22T08:53 | 早于 EA-47/EA-48                |
| `.github/workflows/deploy-dev.yml` | 2026-10-21T23:53 | 早于 EA-47/EA-48                |
| `.github/workflows/security.yml`   | 2026-09-27T17:18 | 未修改（`git status` 中未列出） |

本阶段新增/修改的**仅**为文档与 `docs/evidence/ea48/`。

### 12.2 本阶段触碰的文件

| 文件                                                 | 状态                    | 说明                                       |
| ---------------------------------------------------- | ----------------------- | ------------------------------------------ |
| `docs/ea48-ci-supply-chain-gate-report.md`           | `??` 新增               | 本报告                                     |
| `docs/evidence/ea48/**`                              | `??` 新增               | 82 个文件（含 `SHA256SUMS`）               |
| `docs/ea43-image-reproducibility-risk-acceptance.md` | `??`（原有未跟踪）      | Revision 4 → 5，新增 §1.4 与控制措施 19–24 |
| `docs/release-approval-checklist.md`                 | `??`（原有未跟踪）      | 新增 §10.20 + §11 新增 4 条阻断项          |
| `docs/project-development-state.md`                  | `M`（**执行前已是 M**） | 仅新增 `## EA-48 addendum`                 |

---

## 13. 未验证项目及阻断项

| #   | 项目                                              | 等级           | 说明                                |
| --- | ------------------------------------------------- | -------------- | ----------------------------------- |
| 1   | GitHub Actions OIDC → Fulcio 真实签发             | `NOT RUN`      | 禁止触发正式 CI；本地无 OIDC 提供方 |
| 2   | keyless 签名的 identity 约束在真实运行中生效      | `NOT RUN`      | 依赖 #1                             |
| 3   | GHCR 侧签名/attestation 是否存在且可验证          | `NOT VERIFIED` | 无凭据，且属生产相邻环境            |
| 4   | 提案在真实流水线中的耗时与稳定性                  | `NOT RUN`      | 需真实运行 ≥10 次（提案阶段 A）     |
| 5   | Rekor 公共日志的合规性                            | **待决策**     | 需审批人决定"digest 公开"是否可接受 |
| 6   | `chrome-headless-shell` 在 CI 中的声明式补充      | `PROPOSED`     | 机制已本地验证，未接入流水线        |
| 7   | 生产部署与回滚演练                                | `NOT RUN`      | 独立任务                            |
| 8   | Migration 51 生产预检查、生产 DB/对象存储备份恢复 | `NOT RUN`      | 独立任务                            |
| 9   | 镜像可复现性策略书面决策                          | **待决策**     | EA-43 Revision 5 仍为草案           |
| 10  | 真实环境中的 rollback 演练（R1–R4）               | `NOT RUN`      | 需在 dev 流水线执行                 |

---

## 14. 下一步所需授权

| #   | 动作                                                              | 需要的授权               | 备注                     |
| --- | ----------------------------------------------------------------- | ------------------------ | ------------------------ |
| 1   | 决定 Rekor：公共透明日志 vs 私有 Sigstore                         | Technical Approver       | 影响 §5 与 §6 的实现细节 |
| 2   | 批准 `id-token: write` + `attestations: write` 仅授予 build job   | Release Engineer         | 提案 C11                 |
| 3   | 批准移除 caller job 的 `packages: write`、取消 `secrets: inherit` | Release Engineer         | 提案 C10                 |
| 4   | 批准 `environment: dev` 人工审批门                                | Ops + Release Engineer   | 提案 C9                  |
| 5   | 批准阶段 A（observe-only，2 周）                                  | Release Engineer         | 不改变发布行为           |
| 6   | 提供 GHCR 只读凭据以完成 N7                                       | Ops                      | 本阶段禁止自行获取       |
| 7   | 批准例外流程（`buildkit_completeness=false`）                     | Technical Approver       | 提案 §5                  |
| 8   | 批准回滚例外（旧镜像未签名）                                      | Release Engineer + Audit | 提案 rollback-plan §3    |

**最终发布状态保持：`PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`。**

EA-48 只证明**审查与隔离验证**结果，不能替代生产 Migration 51 预检查、生产数据库备份与恢复、生产对象存储备份与恢复、完整生产部署与回滚演练，以及 Technical Approver / Release Engineer / DBA / Ops 的正式签字。
