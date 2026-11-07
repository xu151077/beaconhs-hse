# EA-47：候选镜像发布策略与供应链安全闭环验证

**状态：** `PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`
**日期：** 2026-10-26（实验与门禁执行，UTC）/ 2026-10-27（文档定稿，本地时区）
**分支 / HEAD：** `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`
**基线：** `docs/ea46-image-determinism-investigation.md`、`docs/ea45-candidate-reproducibility-report.md`、`docs/ea43-image-reproducibility-risk-acceptance.md`
**新增证据：** `docs/evidence/ea47/`（51 个文件；`sha256sum -c SHA256SUMS` 49/49 通过）
**执行边界：** 未访问生产 / 未改动 ceshi / 未覆盖或删除任何既有镜像 / 未修改业务代码、schema、权限、Role Scope、RLS / 未提交、未推送、未部署。

---

## 0. 结论速览

| #   | 任务                                | 结论                                                                                                                                                    | 等级                                                     | 证据                                                             |
| --- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------- |
| 1   | 执行前工作区状态                    | 分支/HEAD 符合预期；165 个已跟踪修改、501 个未跟踪、暂存区为空                                                                                          | ✅ `PASS`                                                | `environment/workspace.txt`                                      |
| 2   | EA-46 证据复核                      | 25/25 SHA-256 通过；17/18 层、preview 密钥、digest 关系等报告结论均有对应原始证据                                                                       | ✅ `PASS`                                                | `environment/ea46-recheck.txt`                                   |
| 3   | EA-46 是否含签名/SBOM/registry 证据 | **不含**（EA-46 本身即记录"不存在"）→ 本次补齐本地实验                                                                                                  | ✅ `PASS`（记录属实）                                    | EA-46 §7、本报告 §3–§5                                           |
| 4   | CI 是否生成 SBOM                    | **否**：三个 workflow 中 sbom/sigstore/attest/provenance 关键字命中 0                                                                                   | ❌ `FAIL`                                                | 本报告 §3.1                                                      |
| 5   | SBOM 生成（隔离）                   | syft 1.55.0 对 registry 对象与 EA-46 OCI 归档各生成 SPDX 2.3 + CycloneDX 1.7，`source.id` 精确绑定 manifest digest                                      | ✅ `PASS — SBOM GENERATED`                               | `sbom/*.json.xz`、`sbom/source-binding.json`                     |
| 6   | SBOM 结构与一致性校验               | 4 份文档 0 错误；SPDX 关系端点全部可解析；CycloneDX 仅"重复 purl"告警                                                                                   | ✅ `PASS — SBOM VALIDATED`                               | `sbom/validation.json`                                           |
| 7   | SBOM 组件完整性                     | Debian 12（267 deb）、Node 依赖（1250 npm，含 38 个 `@beaconhs/*`）、node 24.18.0 二进制均覆盖；**chrome-headless-shell 140.0.7339.207 未被识别为组件** | ⚠️ `PARTIAL`                                             | 本报告 §3.3                                                      |
| 8   | SBOM 与 digest 的关联               | `source.id` = 平台 manifest digest；cosign attest 后 DSSE `subject.digest` 相同                                                                         | ✅ `PASS`（本地 registry）                               | `sbom/source-binding.json`、`signing/attestation-envelope.json`  |
| 9   | 镜像签名（隔离）                    | 临时密钥 + 无 tlog 签名配置；签名 manifest digest 与 index digest 均验证通过                                                                            | ✅ `PASS`（本地 registry）                               | `signing/verify-manifest.txt`、`signing/verify-index.txt`        |
| 10  | 篡改测试                            | 未签名 digest→`no signatures found`；追加空层后→失败；**签名移植到新 digest→`provided artifact digest does not match`**                                 | ✅ `PASS`                                                | `signing/tamper-*.txt`                                           |
| 11  | Provenance 关联                     | registry 内 attestation manifest 与 provenance blob 与 EA-45 证据**逐字节相同**；`subject.digest` = 同一 index 内的 amd64 manifest                      | ✅ `PASS`（本地 registry）                               | `registry/attestation-manifest.json`、`registry/provenance.json` |
| 12  | index vs manifest digest 策略       | 同一 manifest，仅去掉 attestation descriptor 即令 index 从 `9b2156ac…` 变为 `e3e7d6f8…`；manifest 完全不变 → 两者用途必须分离                           | ✅ `PASS`（测量）                                        | `registry/digest-relationships.txt`                              |
| 13  | 按 digest 拉取                      | index digest 与 manifest digest 均可拉取，拉取结果 digest == 请求 digest；tag 可被改写但 digest 不变                                                    | ✅ `PASS`（本地 registry）                               | `deploy/pull-*.txt`、`deploy/tag-mutation.txt`                   |
| 14  | 回滚方案                            | 文档口径正确（digest-only、迁移 forward-only）；**真实回滚未执行**                                                                                      | `NOT RUN`                                                | 本报告 §7                                                        |
| 15  | preview 密钥验收                    | 无官方确定性方案、无安全替代方案 → 维持 `PARTIAL`                                                                                                       | ⚠️ `PARTIAL — PREVIEW SECRET NON-DETERMINISM UNRESOLVED` | 本报告 §8                                                        |
| 16  | 风险接受草案                        | 修订至 Revision 4，控制措施逐项标注；签字栏保持为空                                                                                                     | ⚠️ `DRAFT — PENDING SIGNATURE`                           | `docs/ea43-image-reproducibility-risk-acceptance.md`             |
| 17  | GHCR / 真实 CI 侧验证               | 无凭据、且属生产相邻环境 → 未执行                                                                                                                       | `NOT VERIFIED` / `NOT RUN`                               | 本报告 §14                                                       |

**一句话结论：** 在**隔离的本地 registry** 上，SBOM 生成与结构校验、签名与验签、SBOM attestation、provenance 与 digest 的关联、三类篡改测试、按 digest 拉取，全部**实测通过**（`LOCAL VERIFIED`）；同时用实验证明 **index digest 会因 attestation descriptor 的存在而变化，而平台 manifest digest 不变**，因此"部署按 index digest 固定、可复现性与签名按平台 manifest digest 判定"必须作为成对策略写死。**GHCR、真实 CI 流水线、生产部署与回滚仍未验证**，preview 密钥仍是非确定性残留，最终状态保持 `PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`。

---

## 1. 执行前工作区状态

| 项目       | 值                                                                                                                                                                         |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 当前目录   | `/home/test/projects/beaconhs-hse`                                                                                                                                         |
| 分支       | `hse-platform`                                                                                                                                                             |
| HEAD       | `51a899b7aac0a942da327222a3eed355fca9798a`                                                                                                                                 |
| 已跟踪修改 | 165 个（`git diff --stat`：5967 insertions / 2053 deletions）                                                                                                              |
| 未跟踪条目 | 501 个（`docs/evidence/**` 与历史报告均未提交，与 EA-46 的 500 个相差 1，为 EA-46 报告本身）                                                                               |
| 暂存区     | 空（`git diff --cached --stat` 无输出）                                                                                                                                    |
| Docker     | 29.9.2（API 1.56，storage=`overlayfs` + containerd snapshotter）                                                                                                           |
| Buildx     | v0.38.1                                                                                                                                                                    |
| BuildKit   | v0.34.0                                                                                                                                                                    |
| 候选镜像   | EA-16 `beaconhs:phase-ea16-…` index `17126c6e…`；EA-45 `beaconhs:ea45-repro-1` index `9b2156ac…`、`repro-2` index `d76edbad…`；EA-46 `beaconhs:ea46-tsprobe-1` `8cc349ea…` |

**结论：✅ `PASS`。** 历史文件数量与报告记录一致，无新增未提交流失。

---

## 2. EA-46 验收结果复核

### 2.1 证据完整性

`cd docs/evidence/ea46 && sha256sum -c SHA256SUMS` → 25/25 通过（`environment/ea46-recheck.txt`）。

### 2.2 逐项复核

| #   | EA-46 结论                                         | 本次复核                                                                                                                        | 等级                  |
| --- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| 1   | 18 层中 17 层字节一致                              | `ea46/comparison/d1-vs-d2-matrix.txt` + `d1-vs-d2-residual.txt` 存在且哈希通过；残留仅 `prerender-manifest.json`                | ✅ `PASS`（证据在）   |
| 2   | 剩余差异唯一内容为 preview 密钥                    | `ea46/comparison/layer-diff-by-class.csv` 与 `preview/preview-key-blast-radius.txt` 一致                                        | ✅ `PASS`             |
| 3   | index / manifest / config / attestation 的摘要关系 | 本地 registry 重新取回后逐字节一致：index `9b2156ac…` → manifest `be54cfce…` + attestation `530bbc28…` → provenance `c990513f…` | ✅ `PASS`（新增证据） |
| 4   | `.playwright-mcp/` 是否进入最终镜像                | `ea46/comparison/final-image-scan.txt`：18 层 0 命中                                                                            | ✅ `PASS`             |
| 5   | EA-46 证据是否包含签名 / SBOM / registry 验证结果  | **不包含**——EA-46 §7 明确记录"不存在 / NOT VERIFIED"，与证据一致；本次补齐                                                      | ✅ `PASS`（记录属实） |

### 2.3 本次需要更正或细化的表述

| 位置                                      | 原表述                                                          | 更正后                                                                                                                                                                      | 依据                                                                            |
| ----------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| EA-46 §8.2 / EA-43 事实 18                | "manifest digest 本地不可寻址（containerd store 只解析 index）" | **本地构建的镜像**确实只能用 index digest 寻址；但**从 registry 按 manifest digest 拉取是可行的**，拉取后 daemon 以该 manifest digest 作为镜像 `Id`。两者是不同场景         | `deploy/pull-manifest-digest.txt`                                               |
| EA-46 §7.2                                | registry 侧签名 `NOT VERIFIED`                                  | 在**隔离本地 registry** 上已验证（签名/attestation/篡改测试）；**GHCR 侧仍 `NOT VERIFIED`**                                                                                 | `signing/*`                                                                     |
| EA-46 §7.1                                | SBOM `NOT PRESENT`                                              | 结论仍成立（镜像内与 CI 均无 SBOM）；本次证明"可生成、可校验、可关联"，但**未在 CI 实施**                                                                                   | 本报告 §3                                                                       |
| EA-46 §6.4 隐含"OCI 导出不含 attestation" | 未明确区分导出方式                                              | `--output type=oci` 导出的 `d1.tar` 确实只有单 manifest；而 **`docker save`（containerd store）导出的 `a1.tar` 保留完整 index + attestation**。审计取证应优先 `docker save` | `/tmp/opencode/ea45/a1.tar` 与 `/tmp/opencode/ea46/d1.tar` 的 `index.json` 对比 |

> 上述更正只改文档表述，不改变 EA-46 的任何判定等级。

---

## 3. SBOM 生成与验证

### 3.1 当前 CI 现状（只读检查）

| 检查项                                                                       | 结果                                                                                 |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| workflow 文件                                                                | `ci.yml`、`deploy-dev.yml`、`security.yml`                                           |
| `sbom` / `cosign` / `sigstore` / `attest` / `provenance` / `notation` 关键字 | **0 命中**                                                                           |
| `build-push-action` 是否设置 `sbom:`                                         | 否                                                                                   |
| SBOM 生成位置（源码 / 构建阶段 / 最终镜像）                                  | 三处均无                                                                             |
| SBOM 是否绑定最终镜像 digest                                                 | 否（不存在）                                                                         |
| 依赖锁文件存在是否可替代镜像 SBOM                                            | 不能：本镜像含 267 个 Debian 包、1250 个 npm 包和 node 二进制，锁文件只覆盖 npm 部分 |

**结论：❌ `FAIL`（CI 无 SBOM）。**

### 3.2 工具选择与来源

本地无任何 SBOM / 签名工具（`syft`/`trivy`/`cosign`/`notation`/`oras`/`skopeo`/`crane` 全部不存在），
因此下载固定版本到隔离目录 `/tmp/opencode/ea47/bin`，并用上游发布的 checksums 文件校验 SHA-256（3/3 `OK`）：

| 工具   | 版本   | 用途                          | 校验                                        |
| ------ | ------ | ----------------------------- | ------------------------------------------- |
| syft   | 1.55.0 | SPDX 2.3 / CycloneDX 1.7 SBOM | `syft_1.55.0_checksums.txt` → 匹配          |
| cosign | 3.1.4  | 签名、attestation、验签       | `cosign_checksums.txt` → 匹配               |
| crane  | 0.22.1 | registry 取回、append、copy   | go-containerregistry `checksums.txt` → 匹配 |

详见 `environment/tools.txt`。

### 3.3 生成结果

扫描对象与绑定关系：

| 目标                                 | 扫描方式                                      | SBOM 记录的 `source.id`             | 说明                                         |
| ------------------------------------ | --------------------------------------------- | ----------------------------------- | -------------------------------------------- |
| `127.0.0.1:5055/beaconhs-ea47:a1`    | `syft scan registry:… --platform linux/amd64` | `be54cfce…`（平台 manifest digest） | 绑定到实际扫描的 manifest，不是 index        |
| `/tmp/opencode/ea46/d1.tar`（EA-46） | `syft scan oci-archive:…`                     | `41a45fae…`（EA-46 平台 manifest）  | 与 EA-46 证据 `builds/d1-manifest.json` 一致 |

| 指标                   | a1（registry）                                                            | d1（EA-46 镜像） |
| ---------------------- | ------------------------------------------------------------------------- | ---------------- |
| 生成耗时               | 14.6 s                                                                    | 12.0 s           |
| SPDX 版本 / 包数       | SPDX-2.3 / 1,521                                                          | SPDX-2.3 / 1,504 |
| SPDX 关系 / 文件条目   | 12,043 / 9,042                                                            | 12,009 / 9,025   |
| SPDX 文件 SHA-256      | `cfcafd26…`                                                               | `e9bb3f7f…`      |
| CycloneDX 版本 / 组件  | 1.7 / 10,538                                                              | 1.7 / 10,504     |
| CycloneDX 文件 SHA-256 | `092e2f4f…`                                                               | `9461de4a…`      |
| OS 发行版              | Debian 12 (bookworm), 267 deb                                             | 同左             |
| Node 依赖              | 1,250 npm（38 个 `@beaconhs/*`、next 16.3.5、react 19.2.7、sharp 0.35.4） | 同左             |
| 二进制                 | node 24.18.0、fastlist x64/x86                                            | 同左             |

**校验结果（`sbom/validation.json`）：**

- SPDX：`spdxVersion=SPDX-2.3`、`dataLicense=CC0-1.0`、SPDXID 唯一、12,043 条关系端点全部可解析、1,519/1,521 个包带 purl externalRef → **0 error / 0 warning**。
- CycloneDX：`bomFormat=CycloneDX`、`specVersion=1.7`、1,518 个 purl、组件必填字段齐全 → **0 error**；仅 249 / 244 条"重复 purl"告警（镜像内存在多个 `pnpm deploy` 目录，同一包出现在多个路径，属真实布局，非缺陷）。

> 证据包中的 SBOM 以 `xz` 容器存放（`sbom/*.json.xz`），压缩前后字节不变。
> 上表列出的 SHA-256 是**解压后 JSON 原文**的哈希，可在 `UNCOMPRESSED-SHA256SUMS` 中核对；
> `.xz` 容器自身的哈希在 `SHA256SUMS` 中。

### 3.4 覆盖缺口（必须显式记录）

- **`chrome-headless-shell` 未被识别为组件**：镜像内 `/opt/chrome/chrome-headless-shell/linux-140.0.7339.207/…` 的 5 个文件只出现在 SBOM 的 `files[]` 清单中，没有对应的 package/component 条目。syft 的 binary classifier 只识别出 `node`。
- LibreOffice、poppler 等通过 Debian 包覆盖（`libreoffice-core`、`poppler-utils` 等）；`soffice` 可执行文件本身未单列（同属 Debian 包覆盖）。
- 结论：**"生成成功"不等于"组件完整"**。若要用 SBOM 做浏览器漏洞比对，必须在 CI 侧补一条显式声明（来源为 Dockerfile 中固定的 Chrome 版本 ARG），或换用能识别该二进制的扫描器。

### 3.5 判定

| 项目                             | 等级                                        |
| -------------------------------- | ------------------------------------------- |
| SBOM 生成                        | ✅ `PASS — SBOM GENERATED`                  |
| SBOM 结构与关系校验              | ✅ `PASS — SBOM VALIDATED`                  |
| SBOM 与目标 manifest digest 关联 | ✅ `PASS`（`source.id` 即 manifest digest） |
| SBOM 组件完整性                  | ⚠️ `PARTIAL`（chrome-headless-shell 缺失）  |
| SBOM 在 CI 中生成并发布          | ❌ `FAIL`（未实施）                         |
| SBOM 在真实 registry 中可获取    | `NOT VERIFIED`（仅本地 registry 验证）      |

---

## 4. 镜像签名与篡改测试

### 4.1 工具链与存储方式

- cosign v3.1.4；临时密钥对生成于 `/tmp/opencode/ea47/sign`（私钥与口令均未进入仓库、未进入证据包、未打印）。
- cosign v3 已废弃 `--tlog-upload=false`，改用 `cosign signing-config create` 生成**无 Fulcio/Rekor/TSA** 的配置（`{"rekorTlogConfig":{},"tsaConfig":{}}`），确保测试签名**不会**写入公共透明日志。
- registry:2 **不提供 OCI 1.1 referrers API**（`GET /v2/…/referrers/sha256:be54cfce…` → `404`），cosign 回退到 tag 方案，产物存于标签 `sha256-<digest>`：
  - `sha256-be54cfce…` → OCI index（899 B），内含 2 个 bundle manifest：签名（`0e73d401…`）与 SPDX attestation（`e254f4dd…`）
  - `sha256-9b2156ac…` → index 级签名

### 4.2 正向测试

| 测试                | 命令要点                                                               | 退出码 | 结果                                                  |
| ------------------- | ---------------------------------------------------------------------- | ------ | ----------------------------------------------------- |
| 签名平台 manifest   | `cosign sign --key … --signing-config … …@sha256:be54cfce…`            | 0      | 推送签名成功                                          |
| 验签平台 manifest   | `cosign verify --key … --insecure-ignore-tlog=true …@sha256:be54cfce…` | 0      | payload `docker-manifest-digest = be54cfce…`          |
| 签名 index digest   | `cosign sign … …@sha256:9b2156ac…`                                     | 0      | 成功                                                  |
| 验签 index digest   | `cosign verify … …@sha256:9b2156ac…`                                   | 0      | payload digest 为 index digest                        |
| SBOM attestation    | `cosign attest --type spdxjson --predicate sbom/a1.spdx.json …`        | 0      | DSSE 入 registry                                      |
| 验 SBOM attestation | `cosign verify-attestation --type spdxjson …`                          | 0      | `subject.digest = be54cfce…`，predicate 含 1,521 个包 |

> 注意：`cosign verify` 输出中的 "Existence of the claims in the transparency log was verified offline" 是
> 离线声明校验，**不代表存在 Rekor 条目**。本次签名**没有**上传任何透明日志。

### 4.3 篡改测试

| ID  | 场景                                                                | 退出码 | 结果                                                              |
| --- | ------------------------------------------------------------------- | ------ | ----------------------------------------------------------------- |
| X1  | 对**未签名**的 index digest 验签                                    | 10     | `no signatures found`                                             |
| X2  | 在已签名镜像上**追加一个空层**（内容变更）→ 新 manifest `d603c1ee…` | 0      | append 成功                                                       |
| X3  | 对新 digest 验签                                                    | 10     | `no signatures found`                                             |
| X4  | 把原签名 artifact **移植**到新 digest 的 tag（`sha256-d603c1ee…`）  | 0      | 移植成功（模拟攻击者伪造可寻址签名）                              |
| X5  | 再次对新 digest 验签                                                | 1      | `provided artifact digest does not match any digest in statement` |

**结论：** 签名与 digest 是密码学绑定的；"存在签名对象"不等于"验证通过"。

### 4.4 重要行为：按 tag 验签会失败

`cosign verify … 127.0.0.1:5055/beaconhs-ea47:a1` → **退出码 10 `no signatures found`**。
原因：tag 解析到 **index digest**，而签名对象是**平台 manifest**。
这正是"部署身份（index）"与"签名对象（manifest）"分离后最容易踩的坑，本报告 §6 将其写成显式策略。

### 4.5 判定

| 项目                            | 等级                             |
| ------------------------------- | -------------------------------- |
| 签名 / 验签（隔离 registry）    | ✅ `PASS`（`LOCAL VERIFIED`）    |
| 篡改检测                        | ✅ `PASS`                        |
| 透明日志 / 组织身份             | `N/A`（临时密钥，专门禁用 tlog） |
| CI 内签名                       | ❌ `FAIL`（未实施）              |
| GHCR / 生产 registry 侧签名验证 | `NOT VERIFIED`（无凭据）         |

---

## 5. Provenance 关联

把 EA-45 的候选镜像（本地 `beaconhs:ea45-repro-1`，index `9b2156ac…`）推送到隔离 registry 后：

| 检查项                                  | 结果                                                                                                            |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 推送是否保持 digest                     | ✅ `docker push` 后 index digest **仍为** `9b2156ac…`（未改变）                                                 |
| index 内是否包含 attestation descriptor | ✅ `530bbc28…`，`platform: unknown/unknown`，注解 `vnd.docker.reference.type=attestation-manifest`              |
| attestation manifest 字节               | ✅ 与 `docs/evidence/ea45/builds/a1-att.json` **完全相同**（sha256 `530bbc28…`）                                |
| provenance blob 字节                    | ✅ 与 `docs/evidence/ea45/builds/a1-prov.json` **完全相同**（sha256 `c990513f…`）                               |
| provenance `subject.digest`             | ✅ `be54cfce…` == 同一 index 内 amd64 manifest digest                                                           |
| provenance `vcs.revision` / `source`    | ✅ `51a899b7…` / `https://github.com/xu151077/beaconhs-hse.git`                                                 |
| `buildkit_completeness`                 | `request=false`、`resolvedDependencies=false` → 仍**不能**作为 SLSA L2/L3 证据                                  |
| provenance 自身是否有组织签名           | ❌ 无。BuildKit attestation 是**未签名**的 in-toto 声明；本次只把 SBOM 用 cosign 签名/attest，未伪造 provenance |

**判定：✅ `PASS`（本地 registry 关联）；⚠️ `PARTIAL`（provenance 未签名、completeness=false）；`NOT VERIFIED`（GHCR 侧）。**

---

## 6. index digest 与平台 manifest digest 策略

### 6.1 实测的 digest 关系

| 对象                 | a1 实测值                                  | 说明                                                   |
| -------------------- | ------------------------------------------ | ------------------------------------------------------ |
| OCI index            | `9b2156ac1374…`（856 B）                   | 2 个 descriptor：amd64 manifest + attestation manifest |
| amd64 image manifest | `be54cfce2a45…`（3,729 B）                 | 18 层 + config                                         |
| attestation manifest | `530bbc281086…`（837 B）                   | 1 层 in-toto provenance                                |
| provenance blob      | `c990513f7f73…`（2,304 B）                 | `subject.digest = be54cfce…`                           |
| image config         | `e35ca5349506…`（12,531 B）                | syft 记为 `imageID`                                    |
| 各层                 | 18 个 digest，最大的 `44a27e9e…`（165 MB） | 见 `registry/digest-relationships.txt`                 |
| 签名 artifact index  | 标签 `sha256-be54cfce…`，899 B             | 内含签名 + attestation 两个 bundle                     |

### 6.2 决定性实验：attestation 会改变 index digest

对**同一个** amd64 manifest（`be54cfce…`），分别发布两份 index：

| 发布的 index 内容                     | index digest | 平台 manifest digest |
| ------------------------------------- | ------------ | -------------------- |
| amd64 manifest + attestation manifest | `9b2156ac…`  | `be54cfce…`（不变）  |
| 仅 amd64 manifest                     | `e3e7d6f8…`  | `be54cfce…`（不变）  |

⇒ **index digest 是"包装"身份，其值取决于 attestation descriptor；manifest digest 是"内容"身份。**
由于 provenance 的 `invocationId`/`startedOn`/`finishedOn` 每次都不同，attestation manifest 的 digest 每次不同，
因此**index digest 在冷构建下永远不可复现**——这不是可以修复的缺陷，而是设计使然。

### 6.3 策略比较表

| 策略                         | 优点                                                                                    | 风险或限制                                                                                        | 验证状态                                                       |
| ---------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| **固定 OCI index digest**    | 固定多平台发布对象；一处引用即包含镜像与 attestation；`docker pull` 与 Dokploy 原生支持 | 该 digest 含 attestation，冷构建不可复现；按 tag 验签**不会**命中，必须先解析平台 manifest 再验签 | ✅ `PASS`（拉取、不可变性、digest 保持）；❌ 不可复现（§6.2）  |
| **固定平台 manifest digest** | 与 provenance `subject.digest`、SBOM `source.id`、签名 payload **天然对齐**；语义最精确 | 只覆盖单平台；需要部署工具支持按 manifest digest 拉取（本地实测可行）；未来多平台需逐平台固定     | ✅ `PASS`（本地 registry 拉取 + 验签 + SBOM/attestation 绑定） |
| **使用可变标签**             | 操作简单、可读性好                                                                      | 不构成不可变引用；tag 可被随意改指（实测 `movetest2` 从 `be54cfce…` 改到 `d603c1ee…`）            | ❌ 不可作为唯一发布控制（实测反例）                            |

### 6.4 推荐策略（`PROPOSED`，需书面决策）

1. **部署引用**：继续固定 **完整 OCI index digest**（`IMAGE_NAME@sha256:…`），这是当前 `deploy-dev.yml` 与 runbook 的行为，保持不改。
2. **可复现性与供应链验收对象**：固定 **平台 manifest digest**（linux/amd64）；SBOM、签名、provenance `subject` 三者都指向它，形成同一条可验证链。
3. **部署前校验顺序**（`PROPOSED`，尚未接入流水线）：
   `index digest 正则校验` → `解析目标平台 manifest` → `cosign verify（manifest digest）` → `cosign verify-attestation（spdxjson）` → `provenance.subject.digest == manifest digest` → `SBOM 完整性/关键组件断言`。
4. **禁止**：用"重建后 digest 相同"作为发布校验；用 tag 作为部署身份；关闭 provenance/SBOM/签名换取 digest 一致。
5. **可选加固**：同时签 index digest（本次已实测可行），使"按 index 寻址的消费者"也能直接验签；但**不能**以此替代 manifest 级验证。

---

## 7. 部署与回滚方案验证

### 7.1 现状（只读复核）

| 项目            | 实测/复核结果                                                                                                              |
| --------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 构建与推送      | `.github/workflows/deploy-dev.yml`：`build-push-action`，`platforms: linux/amd64`，`push: true`，`cache-from/to: type=gha` |
| 部署身份来源    | 第 39 行 `image_digest: ${{ steps.build-image.outputs.digest }}` → **index digest**                                        |
| 部署引用        | 第 262 行 `IMAGE="${IMAGE_NAME}@${IMAGE_DIGEST}"`，并有 `^sha256:[0-9a-f]{64}$` 正则校验                                   |
| 回滚机制        | `docs/PRODUCTION_RUNBOOK.md`「Deployment and rollback」：只用 `IMAGE_NAME@sha256:…`，commit tag 永不作为部署身份           |
| 迁移策略        | forward-only；迁移失败时**不得**把旧镜像指回已部分迁移的数据库，只能"修前进"或显式恢复数据库                               |
| SBOM / 签名校验 | 流水线中**不存在**                                                                                                         |

### 7.2 隔离验证结果

| 测试                       | 结果                                                                                                     |
| -------------------------- | -------------------------------------------------------------------------------------------------------- |
| 按 index digest 拉取       | ✅ `docker pull …@sha256:9b2156ac…` → 报告 `Digest: sha256:9b2156ac…`，daemon `.Id` = 同一 index digest  |
| 按 manifest digest 拉取    | ✅ `docker pull …@sha256:be54cfce…` → 报告同一 digest，daemon `.Id` = manifest digest，平台解析为 amd64  |
| 拉取内容与请求 digest 一致 | ✅ 两例均一致（registry 内容寻址 + `DIGEST_INVALID` 拒绝不匹配内容，见 `deploy/registry-integrity.txt`） |
| tag 改写不影响 digest 拉取 | ✅ `movetest2` 从 `be54cfce…` 改指 `d603c1ee…` 后，`…@sha256:be54cfce…` 仍解析为 `be54cfce…`             |
| referrers API              | ❌ `404`（registry:2 不支持 OCI 1.1 referrers；生产 GHCR 支持情况 `NOT VERIFIED`）                       |
| 真实部署 / 真实回滚        | `NOT RUN`（禁止触碰 ceshi / 生产）                                                                       |

### 7.3 四类"回滚"必须分开描述

| 类别               | 现状                                                                                             | 验证状态                                      |
| ------------------ | ------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| 应用镜像回滚       | 可用上一次的**完整 index digest** 重新部署（镜像不可变，digest 长期可取回）                      | ✅ 机制已验证（本地） / `NOT RUN`（真实演练） |
| 数据库迁移后兼容性 | Migration 51 forward-only；旧镜像指向已迁移数据库 = 数据损坏风险。**镜像回滚不能替代数据库方案** | `NOT VERIFIED`（生产预检查未做）              |
| 数据库恢复         | 需独立备份恢复流程，与镜像回滚无关                                                               | `NOT RUN`（生产）                             |
| 对象存储恢复       | 需独立备份/版本恢复流程，与镜像回滚无关                                                          | `NOT RUN`（生产）                             |

**Server Action Key 兼容性**：本次未复测（属 EA-25~EA-30 范围）。镜像回滚时必须保证新旧镜像使用同一把 key，
否则滚动窗口内旧页面提交的 action 无法解密——这一约束与 digest 选择无关，必须写入发布检查单。

---

## 8. preview 密钥差异状态

| 检查项                       | 结果                                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------- |
| 是否存在官方支持的确定化配置 | **不存在**（无 env、无 `next.config` 覆盖；唯一"复用"途径是预置 `.next/cache/.previewinfo`）      |
| 固定密钥是否引入安全风险     | 是：等于把 draft/preview 密钥写入构建输入，扩大泄露面，且被本阶段安全边界禁止                     |
| 是否影响运行时行为           | 否：3 个密钥只出现在 `prerender-manifest.json`（3,889 B），0 个编译 chunk，应用未使用 `draftMode` |
| 是否适合内容级验收           | 是：EA-46 已证明 17/18 层一致、config `history`/`created` 一致，差异可精确归因到该文件            |
| 是否需纳入专门的可复现性控制 | `PROPOSED`：在发布检查单中把该文件列为"已知非确定性产物"，并要求每次发布记录其 digest             |

**判定：`PARTIAL — PREVIEW SECRET NON-DETERMINISM UNRESOLVED`（维持不变，不宣称为已修复）。**

---

## 9. 风险接受草案状态

`docs/ea43-image-reproducibility-risk-acceptance.md` 已更新为 **Revision 4**：

- §1.3 新增 EA-47 事实 28–35（本地 registry 实测）；
- §3 推断 1/2/4 按实测结果更新（"不可按 manifest digest 寻址"被细化；"registry 副本"在本地证实、GHCR 未证实）；
- §4 缺口 3/4/7 状态更新；
- §6 控制措施新增 13–18，并逐项标注 `PASS` / `PROPOSED` / `NOT VERIFIED` / `NOT RUN`；
- §10 证据索引加入 EA-47。

**签字栏保持为空；风险等级未填写；状态 `DRAFT — PENDING SIGNATURE — NOT AN APPROVAL`。**

> **EA-48 更新（2026-10-27）：** 该草案现已推进至 **Revision 5**，新增 §1.4（EA-48 的 CI 审查事实 36–42）
> 与 §6.1 控制措施 19–24。本报告 §9 的描述对应 EA-47 完成时的状态（Revision 4），未改写。
> 见 `docs/ea48-ci-supply-chain-gate-report.md`。

---

## 10. 文件新增与修改清单

### 10.1 新增

| 文件                                        | 说明                                         |
| ------------------------------------------- | -------------------------------------------- |
| `docs/ea47-supply-chain-closure-report.md`  | 本报告                                       |
| `docs/evidence/ea47/**`（51 个文件，18 MB） | 本次证据包，含 `SHA256SUMS` 与 `commands.md` |

### 10.2 修改

| 文件                                                 | 变更                                                                                        |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `docs/ea46-image-determinism-investigation.md`       | 顶部新增 EA-47 复核横幅；§7.1/§7.2/§7.3/§8.2 增加"EA-47 更新"注记（原文保留，不改历史判定） |
| `docs/ea43-image-reproducibility-risk-acceptance.md` | Revision 3 → Revision 4：新增 §1.3、更新 §3/§4、控制措施新增 13–18、§10 证据索引            |
| `docs/release-approval-checklist.md`                 | 新增 **§10.19**（EA-47 阶段结论、判定、缺陷 EA47-1~4、门禁）                                |
| `docs/project-development-state.md`                  | 新增 **EA-47 addendum**（EA-47A~K）                                                         |

`docs/project-development-state.md` 是本次唯一改动的**已跟踪**文件；其余三份在仓库中本就未跟踪。

### 10.3 刻意未修改

`Dockerfile`、`.dockerignore`、`.github/workflows/*`、业务代码、schema、权限、RLS、`packages/storage/**`。

---

## 11. 质量门禁结果

本次只改文档与隔离实验产物，但按要求跑完整六项门禁，且全部绕过 Turbo 缓存（`--force`）：

| 门禁   | 命令                                               | 退出码 | 耗时  | 备注                   |
| ------ | -------------------------------------------------- | ------ | ----- | ---------------------- |
| 格式   | `pnpm format:check`                                | 0      | 26 s  | 全部文件通过 Prettier  |
| 类型   | `pnpm exec turbo run typecheck --force`            | 0      | 11 s  | 27 任务，0 缓存        |
| Lint   | `pnpm exec turbo run lint --force`                 | 0      | 43 s  | 1 任务，0 缓存         |
| 死代码 | `pnpm deadcode:check`                              | 0      | 2 s   | knip 无未使用文件/导出 |
| 测试   | `pnpm exec turbo run test --concurrency=1 --force` | 0      | 345 s | 25 任务全通过，0 缓存  |
| 构建   | `pnpm build --force`                               | 0      | 69 s  | 4 任务，0 缓存         |

- 原始日志：`docs/evidence/ea47/gates/{format,typecheck,lint,deadcode,test,build}.log`，汇总 `gates/summary.txt`。
- `--force` 是必需的：本工作区已存在 EA-46 的 Turbo 缓存，普通运行会直接命中缓存而不构成执行证据。
- `--concurrency=1` 是必需的：本机 7.7 GiB 内存下并行测试会 OOM/超时。
- 测试前启动了本地基础设施容器（postgres / redis / minio / mailpit）；未修改其数据之外的任何内容。
- **没有任何门禁被禁用、跳过或抑制。**

### 11.1 文档与证据专项检查

| 检查项                    | 结果                                                                                                              |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 证据哈希                  | `sha256sum -c SHA256SUMS` → 49/49 通过（退出码 0）；`UNCOMPRESSED-SHA256SUMS` → 5/5 载荷一致                      |
| SBOM 格式与解析           | SPDX 2.3 / CycloneDX 1.7 各 2 份，0 错误（`sbom/validation.json`）                                                |
| 签名验证与篡改测试        | 签名/验签/attestation 共 6 项正向全部通过；篡改测试 X1–X5 中 3 次验签按预期失败（§4）                             |
| Markdown 格式             | `pnpm format:check` 通过                                                                                          |
| 内部链接                  | 新增/修改文档中引用的 `docs/evidence/ea47/**` 路径与 EA-45/EA-46 证据路径逐个确认存在                             |
| digest 与原始工具输出一致 | 报告中的每个 digest 均可在 `registry/digest-relationships.txt` 或原始 JSON 中逐字节核对                           |
| 秘密扫描                  | 证据包与文档中无私钥、无口令、无 Server Action Key、无 DB 连接串（`cosign.key` / `cosign.pw` 留在 `/tmp` 未复制） |
| Git diff 审查             | 修改 4 个既有文档 + 新增 1 个报告与 1 个证据目录，未触碰其他文件（§12）                                           |

---

## 12. Git 状态

| 项目             | 值                                                                                                                                                                   |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 分支             | `hse-platform`                                                                                                                                                       |
| HEAD             | `51a899b7aac0a942da327222a3eed355fca9798a`（**未变**，本阶段无提交）                                                                                                 |
| 已跟踪修改       | 165 个（与执行前一致，无新增已跟踪文件被改动）                                                                                                                       |
| 未跟踪条目       | 502 个（执行前 501，**+1** 即 `docs/ea47-supply-chain-closure-report.md`；`docs/evidence/` 在 Git 中始终折叠为一条 `??`，新增的 `docs/evidence/ea47/` 不改变该计数） |
| 暂存区           | **空**（未执行任何 `git add`）                                                                                                                                       |
| 提交 / 推送 / PR | **无**                                                                                                                                                               |
| 破坏性 Git 操作  | **无**（未执行 `reset --hard` / `clean` / `restore` / `checkout --`）                                                                                                |

本阶段触碰的 6 项（4 个既有文档 + 1 个新报告 + 1 个证据目录）：

| 文件                                                 | 状态                    | 说明                                        |
| ---------------------------------------------------- | ----------------------- | ------------------------------------------- |
| `docs/ea47-supply-chain-closure-report.md`           | `??` 新增               | 本报告                                      |
| `docs/evidence/ea47/`                                | `??` 新增               | 51 个文件，18 MB                            |
| `docs/ea46-image-determinism-investigation.md`       | `??`（原有未跟踪）      | 新增 EA-47 横幅 + §7/§8 注记 + §8.4 更正    |
| `docs/ea43-image-reproducibility-risk-acceptance.md` | `??`（原有未跟踪）      | Revision 3 → 4                              |
| `docs/release-approval-checklist.md`                 | `??`（原有未跟踪）      | 新增 §10.19                                 |
| `docs/project-development-state.md`                  | `M`（**执行前已是 M**） | 仅新增 `## EA-47 addendum`（12 行新增内容） |

> `docs/project-development-state.md` 的 `git diff` 统计（885+/81−）包含 EA-45/EA-46 阶段遗留的未提交改动，
> 不是本阶段产生的；本阶段对该文件的改动仅为顶部插入的 EA-47 addendum 一节。

---

## 13. 安全边界确认

| 边界                                              | 结果                                                                    |
| ------------------------------------------------- | ----------------------------------------------------------------------- |
| 未访问生产环境 / 数据库 / 对象存储                | ✅                                                                      |
| 未修改 ceshi 容器、镜像、配置、数据               | ✅                                                                      |
| 未覆盖 EA-16 / EA-42 / EA-44 / EA-45 / EA-46 镜像 | ✅ 只新增 tag `127.0.0.1:5055/beaconhs-ea47:*`，源镜像未改动            |
| 未删除镜像 / 容器 / 卷 / 备份 / 快照              | ✅ 未执行任何 `docker rm` / `rmi` / `volume rm`                         |
| 未执行破坏性 Git                                  | ✅ 无 `reset --hard` / `clean` / `restore`                              |
| 未 `git add -A`、未提交、未推送、未建 PR          | ✅                                                                      |
| 未修改业务代码 / schema / 权限 / RLS              | ✅                                                                      |
| 未泄露 Server Action Key / DB 密码 / 令牌         | ✅ 证据包不含私钥、口令；`cosign.key`、`cosign.pw` 留在 `/tmp` 且未打印 |
| 未重新调查语言设置问题                            | ✅                                                                      |
| WOPI 状态                                         | ✅ 保持 `KNOWN / UNRESOLVED — LOW PRIORITY — INVESTIGATION PAUSED`      |
| 未关闭 provenance / SBOM / 签名换 digest 一致     | ✅ 明确列为禁止项                                                       |
| 未代替审批人签字                                  | ✅ 所有签字栏为空                                                       |

**新建的本地资源（保留以复现实验，未删除）：**

- 容器 `beaconhs-ea47-registry`（`127.0.0.1:5055`），当前状态 **Exited (2)**——已停止但未删除；
  其数据卷 `bd00abe78a3c…`（挂载点 `/var/lib/registry`）保留全部推送对象与签名产物。
  复现命令：`docker start beaconhs-ea47-registry`。
- 本地 tag `127.0.0.1:5055/beaconhs-ea47:{a1,noatt,tampered,movetest,movetest2}` 及两个签名标签（`sha256-<digest>`）。
- 临时镜像引用 `127.0.0.1:5055/beaconhs-ea47@sha256:{be54cfce…,9b2156ac…}`。
- 本地基础设施容器（postgres / redis / minio / mailpit）在测试后已停止，状态与 EA-46 结束时一致。

未删除任何既有镜像、容器、卷、备份或快照；未执行 `docker rm` / `rmi` / `volume rm`。
35 个既有 `beaconhs:*` 镜像全部保留（仅新增 tag，未覆盖原 tag）。

---

## 14. 未解决问题与下一步建议

| #   | 问题                                                 | 等级           | 建议                                                                                                                 |
| --- | ---------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------- |
| 1   | GHCR 侧 SBOM / 签名 / attestation 是否存在并可验证   | `NOT VERIFIED` | 由具备 GHCR 只读凭据的角色执行 `cosign verify` / `verify-attestation`，并与本报告 §4 的命令逐条对照                  |
| 2   | CI 未生成 SBOM、未签名、未验签                       | `FAIL`         | 在 `deploy-dev.yml` 增加 syft 或 `build-push-action` 的 `sbom:`，cosign keyless 签名（需 OIDC 权限），部署前强制验签 |
| 3   | SBOM 缺少 chrome-headless-shell 组件                 | `PARTIAL`      | 在 SBOM 中显式声明固定版本的 Chrome 组件，或改用可识别该二进制的扫描器，并在 CI 中断言其存在                         |
| 4   | index digest 不可复现（attestation 所致）            | 已知设计属性   | 验收对象改为平台 manifest digest（§6.4），index digest 仅作不可变部署引用                                            |
| 5   | 按 tag 验签必然失败                                  | 已知行为       | 部署校验必须先解析平台 manifest；在 runbook 写明，避免误判"签名缺失"                                                 |
| 6   | 真实 CI 流水线的 double-build digest 对比            | `NOT RUN`      | 在 dev 流水线加非阻断影子作业                                                                                        |
| 7   | 生产部署与回滚演练                                   | `NOT RUN`      | 独立任务执行，禁止用本地实验替代                                                                                     |
| 8   | Migration 51 生产预检查、生产数据库/对象存储备份恢复 | `NOT RUN`      | 独立任务执行                                                                                                         |
| 9   | preview 密钥非确定性                                 | `PARTIAL`      | 保持现状；若必须字节级复现，需另行安全评估后把密钥纳入 secret 管理（本阶段禁止）                                     |
| 10  | EA-16 构建日志永久缺失                               | 不可闭合       | 以新构建为新基线，历史结论保持 `NOT VERIFIED`                                                                        |

**最终发布状态保持：`PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`。**

Migration 51 生产预检查、生产数据库备份与恢复、生产对象存储备份与恢复、完整生产部署与回滚演练、
Technical Approver / Release Engineer / DBA / Ops 的正式签字，以及镜像策略的书面决策，仍是独立的发布阻断项。
