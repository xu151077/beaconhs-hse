# EA-43 — Image Reproducibility Risk Acceptance（DRAFT，Revision 5）

**Date:** 2026-10-26（EA-47 实验，UTC）；2026-10-27（Revision 4 定稿）
**Revision:** 5（Revision 1 基于推断；Revision 2 基于原始 OCI 证据；Revision 3 撤回 EA-44 的层/manifest 可复现结论；Revision 4 依据 EA-47 的隔离 registry 实测补入 SBOM / 签名 / digest 策略证据；Revision 5 依据 EA-48 的 CI 审查与门禁实测补入 CI 侧事实，见 §1.4）
**Status:** `DRAFT — PENDING SIGNATURE — NOT AN APPROVAL`
**Release status:** `PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`
**Risk ID:** `R-20261026-001`

> **本文件是风险接受草案，不构成风险接受、不构成生产发布批准。**
> 所有签字与日期字段为空。风险等级字段为空，须由有权责任人填写。
> 本草案对应的镜像**未部署到生产环境**，也未获得任何签字。

---

## 0. 适用对象

| 项目                          | 值                                                                        |
| ----------------------------- | ------------------------------------------------------------------------- |
| 项目                          | BeaconHS HSE Platform                                                     |
| 版本                          | EA-16                                                                     |
| Source HEAD                   | `51a899b7aac0a942da327222a3eed355fca9798a`                                |
| 镜像 tag                      | `beaconhs:phase-ea16-20261023-052716`                                     |
| 镜像 index digest（发布引用） | `sha256:17126c6e22d20325e36a9bdc93281048c84434c12ae4c68927111bd0a30ad2c5` |
| 镜像 manifest digest          | `sha256:43a7dc279182d71fc82a5dfa2d5408868cf029d73541f27e60630186ab59a943` |
| Attestation manifest          | `sha256:0f7e823e53002bbe51976af1f332ee7d315bb028a72ebe72d305f777cd52eca6` |
| SLSA provenance               | `sha256:153584313d8d0f19e92eccac6a5ba3c2b8247f5e75f813c5358b303484fe0452` |
| 平台                          | linux/amd64                                                               |
| 镜像大小                      | ≈ 2.87 GB                                                                 |

**请求接受的已知差异：** 在相同输入下重复构建，OCI **image index** digest 不稳定。
**Revision 3 更正：** 原先此处写作"应用内容本身稳定"，该表述过于宽泛。EA-45 的实测结论是
**应用源码与编译产物逐字节稳定，但镜像层产物不稳定**（缓存、日志、随机 preview 密钥、映射表顺序、
构建耗时都会变化）。详见 `docs/ea45-candidate-reproducibility-report.md` §6.3。

---

## 1. 已验证事实（VERIFIED — 有原始证据）

证据目录：`docs/evidence/ea44/`（`sha256sum -c SHA256SUMS` 33/33 通过）。

| #   | 事实                                                                                                                   | 证据                                                            |
| --- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 1   | EA-42 两次构建的 **image manifest** digest 完全相同：`sha256:6b255d15…02c68377`                                        | `historical-ea42/manifest-exp1.json`、`manifest-exp2.json`      |
| 2   | 两次构建的 **image config** 逐字节相同：`sha256:35e841b9…31bbf698`                                                     | `config-exp1.json`、`config-exp2.json`                          |
| 3   | 18 个 layer digest 全部相同                                                                                            | `manifest-exp*.json`                                            |
| 4   | 两次构建的 **index** digest 不同：`0f2a69c0…` vs `33cd283e…`                                                           | `nested-index-exp*.json`                                        |
| 5   | index 的差异**仅**在 attestation manifest descriptor 一处                                                              | `diff nested-index-exp1.json nested-index-exp2.json`            |
| 6   | attestation manifest 的差异**仅**在其内嵌 in-toto 证明 digest 一处                                                     | `att-exp*.json`                                                 |
| 7   | provenance 差异**仅**四处：`startedOn`、`finishedOn`、`invocationId`、`subject.name`                                   | `provenance-exp*.json`                                          |
| 8   | 默认构建**会**生成 provenance（无需 `--attest`）                                                                       | `logs/build-a-nc-i1.log` 的 `exporting attestation manifest` 行 |
| 9   | `--provenance=false` 时两次 `--no-cache` 独立构建 index digest 完全相同：`sha256:141e5a28…`                            | `probe/p-b-nc-i1-idx.json`、`p-b-nc-i2-idx.json`                |
| 10  | 开启 provenance 时两次 `--no-cache` 独立构建 index 不同（`6313fe79…` vs `6e37f789…`），但 manifest 相同（`141e5a28…`） | `probe/p-a-nc-i*.json`                                          |
| 11  | `SOURCE_DATE_EPOCH` 不影响 provenance 的 `startedOn`/`finishedOn`                                                      | 事实 7 + EA-42 两次构建使用同一 epoch                           |
| 12  | provenance 的 `subject.digest` 恒等于 image manifest digest                                                            | `provenance-exp*.json`、`p-a-nc-i*-prov.json`                   |
| 13  | `docker inspect` 的 `Identity.Build[0].Ref`/`CreatedAt` 不在任何 OCI 对象内                                            | `inspect-exp*.json` 与 OCI 对象逐文件比对                       |
| 14  | EA-16 候选镜像 config `created` 为 `2026-10-23T05:31:46…`（未用 `SOURCE_DATE_EPOCH`）                                  | `ea16/ea16-manifest.json` + config                              |

### 1.1 EA-45 复核（2026-10-26）——事实 1–3 已撤回

EA-45 用四次**真正 `--no-cache`** 的完整应用镜像构建复核了上面的事实 1–3。

| 原事实                          | EA-45 结果                                                                             | 结论                 |
| ------------------------------- | -------------------------------------------------------------------------------------- | -------------------- |
| 1. EA-42 两次构建 manifest 相同 | 四次独立构建的 manifest 全部不同（`be54cfce…`、`8d9813e4…`、`9142bb14…`、`20fa0a57…`） | ❌ **FAIL — 已撤回** |
| 2. 两次构建 config 逐字节相同   | 每次构建的 config 都不同；`SOURCE_DATE_EPOCH` 下仅 `rootfs.diff_ids` 之外相同          | ❌ **FAIL — 已撤回** |
| 3. 18 个 layer digest 全部相同  | 每次构建有 **10/18** 层不同，且差异层集合恒为 6、7、9–16                               | ❌ **FAIL — 已撤回** |

原因：EA-42 两次构建的缓存状态从未记录（本文件 §4 缺口 1）。缓存命中会原样复用层，
从而"看起来"可复现；真正冷构建不具备该性质。

**新增事实（EA-45，VERIFIED）：**

| #   | 事实                                                                                                                                               | 证据                                                      |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| 15  | `SOURCE_DATE_EPOCH` 固定 config `created` 与 history 时间戳，**不**固定 `RUN` 层内文件 mtime                                                       | `docs/evidence/ea45/logs/build-ledger.txt`、§6.3 对应报告 |
| 16  | 独立构建之间**没有任何**应用源码、编译 chunk 或依赖二进制不同                                                                                      | `docs/evidence/ea45/comparison/content-diff.csv`          |
| 17  | 差异全部来自构建期产物：npm 缓存/日志、V8 编译缓存、fontconfig/ldconfig 缓存、apt 日志、Next.js 随机 preview 密钥、pnpm 映射表顺序、turbo 日志耗时 | 同上                                                      |
| 18  | 本机 containerd image store **只**能按 index digest 寻址镜像；manifest/config digest 不可作为镜像引用解析                                          | `docs/ea45-candidate-reproducibility-report.md` §7.2      |
| 19  | EA-16 之后 `turbo.json` 新增 `DEPLOYMENT_VERSION` 到 `globalEnv`，导致重建镜像内嵌 `deploymentId`，与 EA-16 语义不同                               | `docs/evidence/ea45/comparison/build-id-analysis.txt`     |

**风险含义：** 事实 1–3 曾是本草案"内容可复现、仅包装层不可复现"论断的基础。
该基础不成立后，**manifest digest 同样不可复现**，因此"以 manifest digest 作为可复现身份"
（§6 控制措施 4）不再成立。

### 1.2 EA-46 复核与新增事实（2026-10-26）

证据目录：`docs/evidence/ea46/`（`sha256sum -c SHA256SUMS` 全通过）。

| #   | 事实                                                                                                                                                                                                                                                    | 证据                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 20  | `.playwright-mcp/` 磁盘上 537 个文件 / 3,530,121 B；其中 **464 个 / 3,423,084 B 进入构建上下文**（73 个 `.log` 被 `**/*.log` 排除）                                                                                                                     | `ea46/context/probe1.log`                                      |
| 21  | `.playwright-mcp` **不进入最终镜像**：18 层逐层扫描 0 命中                                                                                                                                                                                              | `ea46/comparison/final-image-scan.txt`                         |
| 22  | 在 `.dockerignore` 追加一行 `.playwright-mcp` 后，上下文文件数 3,416 → 2,952（**−464**），其余规则不变                                                                                                                                                  | `ea46/context/probe2.log`                                      |
| 23  | Next.js 16.3.5 preview 密钥由 `crypto.randomBytes(16/32/32)` 生成，仅当 `.next/cache/.previewinfo` 存在且未过期才复用；该目录从不跨构建保留 → 每次重新随机。密钥只出现在 `prerender-manifest.json` 1 个文件、0 个编译 chunk；应用源码未使用 `draftMode` | `ea46/preview/preview-key-mechanism.txt`、`…blast-radius.txt`  |
| 24  | 层差异分解：**600 个内容差异 + 4 个文件增删 + 83,458 个仅 mtime 差异**（占全部 100,066 条层条目的 83.4%）                                                                                                                                               | `ea46/comparison/layer-summary.csv`、`layer-diff-by-class.csv` |
| 25  | `--output type=…,rewrite-timestamp=true` **存在且有效**，但**必须**配合 `SOURCE_DATE_EPOCH`：两次独立 `--no-cache` 构建的 manifest / config / 层 digest 完全一致                                                                                        | `ea46/probe/rewrite-timestamp-probe.txt`                       |
| 26  | 镜像**无 SBOM**；CI **无签名步骤**；provenance `buildkit_completeness={request:false,resolvedDependencies:false}`，`subject` 为平台 manifest digest                                                                                                     | `ea46/logs/build-ledger.txt`、EA-46 报告 §7                    |
| 27  | EA-42 exp1/exp2 的 18 层完全相同，而层 6 含毫秒时间戳文件名的 npm 日志 ⇒ 两次构建必为**缓存复用**（由推断升级为证明）                                                                                                                                   | `ea46/comparison/ea42-layer-pairs.txt`                         |

**对控制措施 4 / 8 的影响（结论更新）：**

- 事实 25 推翻了 §1.1 中"工具链不支持时间戳重写"的隐含前提。
  "manifest digest 完全不可复现"应改为"**在 preview 密钥消除之前**不可复现"。
- 但 preview 密钥无官方确定性方案（事实 23），所以控制措施 4 **仍不能**判定为 `PASS`；
  正确的验收对象是 **manifest digest**，且必须同时接受"preview 密钥属于已知非确定性产物"。
- 事实 26 说明供应链要求（SBOM / 签名）**单独就不满足**，与 digest 是否可复现无关。

### 1.3 EA-47 新增事实（2026-10-26，隔离本地 registry）

证据目录：`docs/evidence/ea47/`（`sha256sum -c SHA256SUMS` 49/49 通过）。
实验对象为 EA-45 候选镜像 `beaconhs:ea45-repro-1`，推送到本地 `registry:2`
（`127.0.0.1:5055`，镜像 digest `sha256:a3d8aaa6…`），**非生产、非 ceshi、非 GHCR**。

| #   | 事实                                                                                                                                                                                                                                         | 证据                                                                                |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 28  | `docker push` 到 registry **保持 index digest 不变**：推送前后均为 `sha256:9b2156ac…`                                                                                                                                                        | `ea47/environment/workspace.txt`、`ea47/registry/index-a1.json`                     |
| 29  | index 内含 attestation descriptor `sha256:530bbc28…`（`platform: unknown/unknown`，注解 `vnd.docker.reference.type=attestation-manifest`）；其 provenance blob `sha256:c990513f…` 与 `docs/evidence/ea45/builds/a1-prov.json` **逐字节相同** | `ea47/registry/attestation-manifest.json`、`ea47/registry/provenance.json`          |
| 30  | 对**同一** amd64 manifest（`be54cfce…`），发布"含 attestation"的 index → `9b2156ac…`，"不含 attestation"的 index → `e3e7d6f8…`；manifest digest 完全不变 ⇒ **index digest 的不可复现性来自 attestation descriptor**                          | `ea47/registry/digest-relationships.txt`                                            |
| 31  | syft 1.55.0 可对 registry 对象与 OCI 归档生成 SPDX 2.3 / CycloneDX 1.7，`source.id` **精确等于平台 manifest digest**（a1：1,521 包 / d1：1,504 包）；**`chrome-headless-shell` 未被识别为组件**，只在文件清单中出现                          | `ea47/sbom/*.json.xz`、`ea47/sbom/source-binding.json`、`ea47/sbom/validation.json` |
| 32  | cosign 3.1.4（临时密钥、禁用 tlog）可对 manifest digest 与 index digest 分别签名并验签通过；SBOM attestation 的 DSSE `subject.digest` 等于 manifest digest                                                                                   | `ea47/signing/verify-manifest.txt`、`verify-index.txt`、`verify-attestation.txt.xz` |
| 33  | 三类篡改测试全部被拒：未签名 digest → `no signatures found`（exit 10）；追加空层后的新 digest → 同上；**把签名 artifact 移植到新 digest → `provided artifact digest does not match any digest in statement`（exit 1）**                      | `ea47/signing/tamper-*.txt`                                                         |
| 34  | **从 registry 按 manifest digest 拉取可行**，拉取后 daemon 以该 manifest digest 作为镜像 `Id`；但**本地已存在的镜像仍只能按 index digest 寻址**（`beaconhs@sha256:be54cfce…` → `no such object`）                                            | `ea47/deploy/pull-manifest-digest.txt`                                              |
| 35  | registry 强制内容寻址：digest 与内容不匹配 → `400 DIGEST_INVALID`；tag 可被改指而 digest 内容不变；本地 `registry:2` **不提供 OCI 1.1 referrers API**（`404`），cosign 回退到 `sha256-<digest>` 标签方案                                     | `ea47/deploy/registry-integrity.txt`、`tag-mutation.txt`、`referrers-api.txt`       |

**对控制措施的影响（结论更新）：**

- 控制措施 11（SBOM）与 12（签名）**技术上可行且已在隔离环境验证**，但 **CI 仍未实施**，
  因此这两项在此仍记为 `FAIL`（"组织内尚未具备该控制"≠"技术上不可行"）。
- 控制措施 4（以 manifest digest 作为可复现身份）**仍为 `FAIL`**：可寻址性和可验证性已解决
  （事实 34、32），但**可复现性仍未解决**（EA-46 事实 23 的 preview 密钥）。
- 事实 30 使"index digest 不可复现"从推断变成**可直接演示的设计属性**，应写入发布策略，
  而不是当作待修复缺陷。

### 1.4 EA-48 新增事实（2026-10-26，CI 只读审查 + 隔离门禁实测）

证据目录：`docs/evidence/ea48/`（`sha256sum -c SHA256SUMS` 81/81 通过）。

| #   | 事实                                                                                                                                                                                                                                       | 证据                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| 36  | 三个 workflow 中 `sbom`/`cosign`/`sigstore`/`attest`/`provenance`/`notation` 关键字**命中 0**；无 `id-token`、无 `attestations`、无 `environment:` 保护                                                                                    | `ea48/ci-audit/ci-cd-audit.md` §2、`ea48/tests/T14-yaml-validation.json` |
| 37  | 部署**只**记录 index digest（`deploy-dev.yml:39`）；平台 manifest digest 既不解析也不记录，而签名/SBOM/provenance 的 subject 都是 manifest digest                                                                                          | 同上 §2 #3                                                               |
| 38  | 镜像在 build 步骤内即 `push: true`（`deploy-dev.yml:82-99`）→ 任何后置门禁**只能阻止部署，不能阻止发布**                                                                                                                                   | 同上 §3.1                                                                |
| 39  | 最小权限部分成立：全仓无 `contents: write`（由 `scripts/ci/workflow-repository-immutability.test.sh` 强制）；但 caller job 持有 `packages: write`，且 `ci.yml:183` 使用 `secrets: inherit`                                                 | 同上 §3、§4                                                              |
| 40  | 对**同一不可变 digest** 连续两次扫描，SBOM 原始字节**不同**（SPDX `0e91a7f8…` vs `0f91b0d6…`；CycloneDX `782b1054…` vs `42c414ef…`），差异仅来自随机 `documentNamespace`/`serialNumber` UUID 与时间戳；**规范组件摘要相同**（`0064dce9…`） | `ea48/sbom/det-*.json.xz`、`ea48/tests/T13-canonical-*.json`             |
| 41  | `chrome-headless-shell 140.0.7339.207` 在 syft 1.55.0 输出中**不是组件**（仅 5 条 `files[]`）；声明式补充机制可幂等补齐，且会拒绝证据路径不存在的声明                                                                                      | `ea48/sbom/enrichment-*.json`、`ea48/tests/T11-*`                        |
| 42  | 7 阶段门禁在隔离环境拒绝了全部 8 类攻击/故障（未签名、篡改、签名移植、身份不符、revision 不符、平台歧义、tag 改指、组件缺失），且不误杀正确镜像                                                                                            | `ea48/proposal/verification-matrix.md`、`ea48/tests/T*-gate.log`         |

**对控制措施的影响（结论更新）：**

- 新增控制措施 19–24（见 §6），全部标注为 `PROPOSED` 或 `PASS（隔离）`，**不改变**任何既有 `FAIL` 判定。
- 事实 37 与 38 说明：即使引入签名，当前流水线结构也**无法**在发布前完成验证，必须先补"记录 manifest digest"与"把证明生成前移到 build job"两项。
- 事实 40 说明：SBOM 的可复现性验收**必须**用规范摘要，不能用文件哈希；这与 EA-46 的"应用内容可复现、镜像字节不可复现"是同一类问题，但对象不同。

---

## 2. 有证据支持的技术解释

1. 被比较的 digest 是 OCI **index**，它同时收录 image manifest 与 attestation manifest。
2. attestation manifest 的内容变化 → 其 digest 变化 → index 中该 descriptor 变化 →
   index digest 变化。这是一条纯内容寻址链，无需任何"隐藏元数据"假设。
3. provenance 的三个 metadata 字段是墙钟/随机值，不受 `SOURCE_DATE_EPOCH` 约束。
4. `subject.name` 内嵌 tag，因此"同一内容、不同 tag"也会产生不同 index digest。
5. 因此：**内容可复现，index 包装层不可复现**。

---

## 3. 尚未验证的推断（INFERRED — 不得作为已确认事实引用）

| #   | 推断                                                        | 状态                                                                                                    |
| --- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 1   | 以 **image manifest digest** 作为部署固定对象可保留可复现性 | ❌ **FAIL**（可复现性未解决：EA-46 preview 密钥）。**可寻址性与可验证性已由 EA-47 解决**（事实 32、34） |
| 2   | 该路径在回滚与多架构解析下同样可用                          | `PROPOSED — NOT VERIFIED`（本地单平台拉取已实测；多平台选择与真实回滚未实测）                           |
| 3   | 全量应用镜像在 `--no-cache` 跨 tag 下同样满足事实 1/10      | ❌ **FAIL**（EA-45 已在全量镜像上实测并证伪）                                                           |
| 4   | registry 端存在与本地一致的 attestation 副本                | ⚠️ **本地 registry 已证实**（EA-47 事实 29，逐字节相同）；**GHCR 侧 `NOT VERIFIED`**                    |

---

## 4. 尚未解决的证据缺口

| #   | 缺口                                                                  | 状态 / 影响                                                                                                                |
| --- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 1   | EA-42 构建日志未保存，无法确认两次构建均未复用缓存                    | **已解释**：EA-45 冷构建证伪了可复现性 → 事实 1–3 撤回（§1.1）                                                             |
| 2   | 未在真实应用镜像上执行 `--no-cache` 可复现性实验                      | **已关闭（结果为负面）**：四次全量构建，10/18 层每次不同                                                                   |
| 3   | 未验证 registry 端 attestation 的独立存储形态                         | ✅ **本地已关闭**：attestation 作为 index 内的独立 descriptor 存储，字节与本地证据一致（EA-47 事实 29）。**GHCR 侧仍开放** |
| 4   | 未验证按 manifest digest 固定镜像的部署/回滚行为                      | ⚠️ **部分关闭**：拉取与寻址已实测（事实 34）；**真实部署/回滚仍 `NOT RUN`**；且可复现性仍未解决                            |
| 5   | EA-16 候选镜像本身未使用 `SOURCE_DATE_EPOCH`                          | 仍然成立；且 SDE 本身也不足以复现（§1.1 事实 15）                                                                          |
| 6   | EA-16 **构建日志不存在**、源码快照仅含 3 个变更文件、且由脏工作区构建 | ❌ **不可闭合**：EA-16 无法被严格复现（`NOT VERIFIED`）                                                                    |
| 7   | 应用镜像**无 SBOM** attestation                                       | ⚠️ **技术路径已证实**（EA-47：生成、校验、签名 attestation 全通过）；**CI 仍未实施**（`FAIL`）                             |

> Revision 1 在存在缺口 1–4 的情况下给出了确定根因结论；Revision 2 不再重复该错误。
> Revision 3 进一步撤回 Revision 2 依赖的"层/manifest 可复现"结论。
> Revision 4 补入 EA-47 的隔离 registry 实测，关闭缺口 3、部分关闭 4 与 7，但**不触碰**任何可复现性结论。

---

## 5. 影响评估

| 领域          | 影响                                                                                                                             | 依据                  |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| 构建追溯      | **低**：source revision、frontend、base image、build args 均在 provenance 中固定；`buildkit_completeness` 为 false，不声称完全性 | 事实 12、§2           |
| 镜像身份      | **中**：tag 与 index digest 不能互相推定；同一 tag 重建会产生新 index digest                                                     | 事实 4、10            |
| 签名/证明验证 | **低**：provenance 保留且 `subject.digest` 绑定 manifest digest，可验证                                                          | 事实 8、12            |
| 部署          | **中**：若部署以 index digest 固定，则每次重建都需更新部署清单                                                                   | 事实 4、9             |
| 回滚          | **中**：回滚镜像需与 Server Action Key 兼容；按 digest 固定的回滚流程未验证                                                      | §3 推断 2             |
| 审计          | **低**：本次已保存完整原始 JSON 与哈希清单                                                                                       | `docs/evidence/ea44/` |
| 重建验证      | **高**：独立重建**不能**复现 index 或 manifest digest，"重建→比对 digest"无法作为验证手段                                        | EA-45 §5、§6.2        |

> **Revision 3 补充：** 上表"镜像身份/部署"两项的影响等级需由有权责任人在知悉以下事实后重新评估——
> 部署固定的是 **index digest**，而 index digest 在冷构建下不可复现；同时 manifest digest 也不可复现。
> 因此当前不存在"可独立复现的镜像身份"。这属于**政策层面的取舍**，本草案不代为决定。

> **Revision 4 补充：** EA-47 在隔离 registry 上证实"镜像身份"的**可寻址性与可验证性**已经成立
> （按 index / manifest digest 均可拉取并验签、篡改必失败），但**可复现性仍不成立**（preview 密钥）。
> 影响等级不变，仍需有权责任人决定"可复现性是否为发布前置条件"。

**风险等级：** `__________`（由有权责任人填写；本草案不预设 LOW）

---

## 6. 补偿控制措施

只把**已实际实施并验证**的项标 `PASS`；其余标 `PROPOSED` / `NOT VERIFIED`。

| #   | 控制措施                                                                                 | 状态                | 说明                                                                                                                                                             |
| --- | ---------------------------------------------------------------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 保存镜像原始 OCI 证据（index/manifest/config/attestation/provenance）+ SHA-256 清单      | ✅ **PASS**         | `docs/evidence/ea44/`，33 个文件全部校验通过                                                                                                                     |
| 2   | 保存 build 输入证据（frontend digest、base image digest、`vcs:revision`）                | ✅ **PASS**         | 来自 provenance `resolvedDependencies`                                                                                                                           |
| 3   | 生产部署按**完整 digest** 固定，而非可变标签                                             | ✅ **PASS**         | EA-45 核实：`deploy-dev.yml:39` 取 `build-push-action` 的 digest；runbook 规定只用 `IMAGE_NAME@sha256:…`                                                         |
| 4   | 以 **image manifest digest** 作为可复现身份，并校验 provenance `subject.digest` 与之相等 | ❌ **FAIL**         | 可寻址性与可验证性已解决（EA-47 事实 32、34），但**可复现性未解决**：EA-46 D 组差异收敛到 **1 层 / 1 个文件 / 3 个 preview 密钥**（17/18 层一致），digest 仍不同 |
| 5   | 验证镜像签名与来源证明（签名链、attestation 可获取性）                                   | ⚠️ **PARTIAL**      | **本地 registry 已验证**（签名、验签、attestation、篡改测试全通过，EA-47 §4–§5）；**GHCR 侧 `NOT VERIFIED`**（无凭据）                                           |
| 6   | 校验候选镜像与回滚镜像的 Server Action Key 兼容性                                        | ⚠️ **NOT VERIFIED** | 属 EA-25~30/33 范围，本阶段未复测                                                                                                                                |
| 7   | 对镜像重建、重新标记、导出、发布保留审计轨迹                                             | ⚠️ **PROPOSED**     | 尚无流程化记录机制；EA-47 的 `commands.md` + `SHA256SUMS` 可作为模板                                                                                             |
| 8   | 在 CI 中固定 `SOURCE_DATE_EPOCH` 并记录每次构建的 provenance digest                      | ⚠️ **PARTIAL**      | SDE 只固定 config 元数据（事实 15）；**必须同时**使用 `--output …,rewrite-timestamp=true`（事实 25）。CI 目前两者都未启用                                        |
| 9   | 能证明独立构建的差异**不涉及应用代码或依赖二进制**                                       | ✅ **PASS**         | EA-45 `content-diff.csv` + EA-46 D 组：600 个内容差异降为 **1 个**（preview 密钥）                                                                               |
| 10  | 构建上下文卫生：`.dockerignore` 覆盖全部非源码产物                                       | ❌ **FAIL**         | `.playwright-mcp` 464 文件 / 3.42 MB 进入上下文（事实 20）；一行修复已验证（事实 22）但**未实施**                                                                |
| 11  | 生成 SBOM 并在部署前校验内容                                                             | ❌ **FAIL**         | 镜像无 SBOM attestation，CI 未启用 `sbom:`（事实 26）。**技术路径已验证**（EA-47 事实 31），但 CI 未实施                                                         |
| 12  | 镜像签名 + 部署前验签                                                                    | ❌ **FAIL**         | CI 无签名步骤（事实 26）。**技术路径已验证**（EA-47 事实 32、33），但 CI 未实施                                                                                  |
| 13  | SBOM 覆盖关键组件（OS / Node / 浏览器 / 办公套件）                                       | ⚠️ **PARTIAL**      | Debian 267 包、npm 1250 包、node 二进制具备；**`chrome-headless-shell` 缺失**（事实 31）                                                                         |
| 14  | SBOM 与目标 digest 的可验证绑定                                                          | ✅ **PASS**         | `source.id` = 平台 manifest digest；cosign attestation `subject.digest` 相同（事实 31、32）                                                                      |
| 15  | 签名产物可获取且篡改可检测                                                               | ✅ **PASS**         | 三类篡改测试全部拒绝（事实 33）；registry:2 无 referrers API 时回退到 `sha256-<digest>` 标签（事实 35）                                                          |
| 16  | 明确 index / manifest digest 的使用边界                                                  | ✅ **PASS**         | 实测同一 manifest 下 index digest 因 attestation 而变（事实 30）；策略见 EA-47 §6.4                                                                              |
| 17  | 部署与回滚只使用不可变 digest                                                            | ✅ **PASS**（机制） | tag 可改指、digest 不可变（事实 35）；EA-47 §7.2 本地实测；**真实部署/回滚 `NOT RUN`**                                                                           |
| 18  | 部署前强制校验签名 + attestation + provenance `subject`                                  | ❌ **FAIL**         | 流水线中不存在该步骤；仅在本地实验中手工执行                                                                                                                     |

> 不得把第 3–12、18 项在未实施的情况下引用为"已具备控制"。
> 第 13–17 项为 EA-47 在**隔离环境**中实测的能力，不代表生产流水线已具备。

### 6.1 EA-48 新增控制措施（CI 侧，2026-10-26）

| #   | 控制措施                                                 | 状态            | 说明                                                                           |
| --- | -------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------ |
| 19  | CI 中生成 SBOM 并绑定平台 manifest digest                | ❌ **FAIL**     | 当前 CI 无 SBOM（事实 36）；生成/校验/绑定路径已在隔离环境验证（EA-47、EA-48） |
| 20  | CI 中对镜像签名并在部署前验签                            | ❌ **FAIL**     | 当前 CI 无签名、无 OIDC（事实 36）；keyless 方案与 7 阶段门禁已设计并本地验证  |
| 21  | 流水线记录平台 manifest digest 作为供应链 subject        | ❌ **FAIL**     | 当前只记录 index digest（事实 37）                                             |
| 22  | 证明生成前移到 build job，使门禁能阻断发布而非仅阻断部署 | ❌ **FAIL**     | 当前镜像在任何门禁之前即已推送（事实 38）                                      |
| 23  | 用规范摘要而非文件哈希验收 SBOM 可复现性                 | ⚠️ **PROPOSED** | 机制已验证（事实 40、`ea48/gate/sbom_canonical.py`），CI 未实施                |
| 24  | 对扫描器未识别的关键二进制做声明式组件补充并断言         | ⚠️ **PROPOSED** | 机制已验证（事实 41），CI 未实施                                               |

> 第 19–22 项为**真实缺口**，第 23–24 项为**已验证但未落地的机制**。任何一项在未实施前都不得表述为"已具备"。

---

## 7. 风险所有人与审批责任人

| 角色                     | 姓名 | 状态                 | 日期 |
| ------------------------ | ---- | -------------------- | ---- |
| 风险所有人（Risk Owner） | —    | ⏳ 待指派            | —    |
| Technical Approver       | —    | ⏳ PENDING SIGNATURE | —    |
| Release Engineer         | —    | ⏳ PENDING SIGNATURE | —    |
| DBA                      | —    | ⏳ PENDING SIGNATURE | —    |
| Ops                      | —    | ⏳ PENDING SIGNATURE | —    |
| 审计责任人（Audit）      | —    | ⏳ PENDING REVIEW    | —    |

---

## 8. 审批意见、签字与日期

| 角色               | 意见 | 签字 | 日期 |
| ------------------ | ---- | ---- | ---- |
| Technical Approver |      |      |      |
| Release Engineer   |      |      |      |
| DBA                |      |      |      |
| Ops                |      |      |      |
| Audit              |      |      |      |

**风险等级确认（由有权责任人填写）：**

| 项目                                          | 内容 |
| --------------------------------------------- | ---- |
| 采纳的风险等级                                |      |
| 决策（Option A / Option M / Option C / 其他） |      |
| 决策人                                        |      |
| 日期                                          |      |

---

## 9. 决策边界（必须随本草案一并阅读）

- 选择 Option A **不能证明**完整镜像摘要可复现。
- 选择 Option A **不代表**生产部署自动获批。
- 选择 Option A **不代表**放弃 provenance；本报告已证明 provenance 可保留。
- 若组织政策强制要求完整镜像**字节级**可复现，Option A 不能替代该要求，
  必须先解决政策冲突（或采用尚未验证的 Option M 路径）。
- 风险等级不得由起草人预设；Revision 1 曾预填 LOW，Revision 2 已移除。
- 未获得正式签字前，决策状态保持 `PENDING APPROVAL`。

---

## 10. 证据索引

| 证据                                                 | 位置                                            | 状态                                                                    |
| ---------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------- |
| EA-44 原始 OCI 证据（EA-42 镜像）                    | `docs/evidence/ea44/historical-ea42/`           | ✅ 可用                                                                 |
| EA-44 原始 OCI 证据（EA-16 候选）                    | `docs/evidence/ea44/ea16/`                      | ✅ 可用                                                                 |
| EA-44 探针实验证据                                   | `docs/evidence/ea44/probe/`                     | ✅ 可用                                                                 |
| EA-44 构建日志                                       | `docs/evidence/ea44/logs/`                      | ✅ 可用                                                                 |
| EA-44 报告                                           | `docs/ea44-provenance-evidence-report.md`       | ✅ 可用                                                                 |
| EA-43 调查报告（Revision 2）                         | `docs/ea43-provenance-investigation-report.md`  | ✅ 可用                                                                 |
| EA-42 报告（Revision 2）                             | `docs/ea42-reproducible-build-report.md`        | ✅ 可用（含更正说明）                                                   |
| EA-36 release readiness review                       | `docs/ea36-release-readiness-review.md`         | ⚠️ 未在 EA-44 复核                                                      |
| EA-41 final approval package                         | `docs/ea41-final-approval-package.md`           | ✅ 可用                                                                 |
| EA-45 可复现性与部署身份验证报告                     | `docs/ea45-candidate-reproducibility-report.md` | ✅ 可用                                                                 |
| EA-45 原始证据（4 次构建 + 比对）                    | `docs/evidence/ea45/`                           | ✅ 可用（26 文件）                                                      |
| EA-46 根因整改与供应链验证报告                       | `docs/ea46-image-determinism-investigation.md`  | ✅ 可用                                                                 |
| EA-46 原始证据（探针 / 层扫描 / D 组构建）           | `docs/evidence/ea46/`                           | ✅ 可用（`SHA256SUMS`）                                                 |
| EA-47 发布策略与供应链闭环验证报告                   | `docs/ea47-supply-chain-closure-report.md`      | ✅ 可用                                                                 |
| EA-47 原始证据（SBOM / 签名 / 篡改 / digest）        | `docs/evidence/ea47/`                           | ✅ 可用（51 文件；`SHA256SUMS` 49 项 + `UNCOMPRESSED-SHA256SUMS` 5 项） |
| EA-48 CI 供应链门禁审查报告                          | `docs/ea48-ci-supply-chain-gate-report.md`      | ✅ 可用                                                                 |
| EA-48 原始证据（CI 审查 / T1–T14 / 提案 / 门禁实现） | `docs/evidence/ea48/`                           | ✅ 可用（82 文件；`SHA256SUMS` 81 项 + `UNCOMPRESSED-SHA256SUMS` 7 项） |

---

**Document Status:** `DRAFT — PENDING SIGNATURE`
**Release Status:** `PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`
**Next:** 由 Technical Approver 与 Release Engineer 评估第 3 节推断与第 6 节控制措施后决定。
EA-47 已证明"可寻址、可验证、可签名、可出 SBOM"的技术路径成立，EA-48 进一步证明
CI 侧门禁可被实现并能拒绝 8 类攻击/故障（`docs/ea48-ci-supply-chain-gate-report.md` §7）。
剩余决策是 **是否要求镜像字节级可复现**、**是否接受公共 Rekor**，以及
**在 CI 中实施哪些强制校验、何时从 observe 转为 blocking**（EA-47 §6.4 / §14，EA-48 §14）。
