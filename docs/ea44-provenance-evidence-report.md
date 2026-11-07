# EA-44 — 镜像可复现性证据补齐与 Provenance 对比验证报告（2026-10-26）

**Status:** `PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`

**Based on:** EA-42 实验镜像（历史产物）、EA-43 调查报告、EA-16 候选镜像
**Candidate version:** EA-16（source HEAD `51a899b7aac0a942da327222a3eed355fca9798a`）
**Candidate image tag:** `beaconhs:phase-ea16-20261023-052716`
**Candidate image index digest:** `sha256:17126c6e22d20325e36a9bdc93281048c84434c12ae4c68927111bd0a30ad2c5`
**EA-44 completed:** 2026-10-26
**Raw evidence:** `docs/evidence/ea44/`（`sha256sum -c SHA256SUMS` 全通过）

---

## 摘要

EA-44 补齐了 EA-42 缺失的原始 JSON 证据，并用这些证据重新判定了差异根因。

**EA-43 的技术结论有两处错误，本报告予以更正：**

| #   | EA-43 原结论                                                   | EA-44 实测结果                                                                                               | 证据                                                                                             |
| --- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| 1   | "BuildKit 默认不生成 provenance"                               | **错误。** BuildKit/Buildx 默认生成 SLSA provenance v1 attestation，并作为 index 的一个 manifest 存储        | `historical-ea42/att-exp*.json`、`logs/build-a-nc-i1.log` 的 `exporting attestation manifest` 行 |
| 2   | "镜像 digest 差异来自 `/Identity/Build[0]/Ref` 与 `CreatedAt`" | **错误。** `Ref`/`CreatedAt` 是 Docker 本地 image-store 记账字段，不在任何 OCI 对象内，**不参与任何 digest** | `historical-ea42/inspect-exp*.json` 与 OCI 对象逐字节对照                                        |

**真实根因（已追到字节级）：**

完整镜像 digest（OCI image index）不同的**唯一**原因，是 index 内包含
attestation manifest，而 provenance 内容含有构建墙钟时间、随机 invocation ID
以及**内嵌 tag 的 subject name**。镜像本身（manifest + config + 18 层）完全一致。

**关键新发现（EA-43 未识别）：**

- **Image manifest digest 是可复现的**：EA-42 两次构建均为
  `sha256:6b255d15…`；EA-44 探针在不同 tag、`--no-cache`、两次独立构建下均为
  `sha256:141e5a28…`。
- **Index digest 的可复现性由 provenance 开关唯一决定**：`--provenance=false`
  时两次独立构建的 index digest 完全相同（`sha256:141e5a28…`）。
- **Provenance 的 `subject.digest` 指向的正是可复现的 image manifest digest**，
  因此关闭 provenance 并非获得可复现性的必要条件——可复现身份可以取 manifest
  digest，同时完整保留 attestation。

**判定：**

`PARTIAL — LAYERS REPRODUCIBLE` + `PARTIAL — PROVENANCE EFFECT IDENTIFIED`
（差异已完整定位并有原始 JSON 支持；但"能否在保留 provenance 的前提下使
**index** digest 可复现"仍未证明——当前工具链未找到该能力）

---

## 一、执行前状态（阶段 1）

| 项目                        | 实测值                                                   |
| --------------------------- | -------------------------------------------------------- |
| 工作目录                    | `/home/test/projects/beaconhs-hse`                       |
| 分支                        | `hse-platform`                                           |
| HEAD                        | `51a899b7aac0a942da327222a3eed355fca9798a`               |
| `git status --short` 条目数 | 662                                                      |
| 已修改（` M`）              | 165                                                      |
| 暂存区                      | 空（`git diff --cached --stat` 无输出）                  |
| `git diff --stat`           | 165 files changed, 5912 insertions(+), 2053 deletions(-) |

HEAD 与预期一致。662 = 165 修改 + 497 未跟踪条目；EA-43 记录的 "1025 untracked"
是文件数而非条目数的口径差异，本报告以条目数为准。

工具版本：Docker 29.9.2、Buildx v0.38.1、BuildKit v0.34.0（`docker buildx ls`）、
driver `docker`、镜像存储为 containerd image store。

EA-42 两个实验镜像仍然存在，digest 与 EA-42 报告完全一致（见 §二）。

### 1.1 证据分级方法

本报告把每条结论标为三级，后续不再混用：

| 等级         | 含义                                        |
| ------------ | ------------------------------------------- |
| **VERIFIED** | 有本阶段采集的原始 JSON/日志/哈希可直接复核 |
| **REPORTED** | 只存在于既往报告，无原始证据                |
| **INFERRED** | 由已验证事实推理得出，未直接测量            |

---

## 二、EA-42 历史证据找回（阶段 2）

**结论：`RECOVERED — VERIFIED`。** EA-42 的 EVIDENCE GAP 已闭合。

两个镜像仍在本地，digest 与报告一致，因此可直接做只读提取，无需重建：

| 标签                                 | Index digest（实测 = 报告）                                               |
| ------------------------------------ | ------------------------------------------------------------------------- |
| `beaconhs:ea42-exp1-20261026-064516` | `sha256:0f2a69c06f600436c395dfefa6fc78120a9d5a09d45f519301f3372e6aa1a56c` |
| `beaconhs:ea42-exp2-20261026-065040` | `sha256:33cd283e461ec35557578c84c1dea37ce9d45128dcb3ce79422a729710c4d5c6` |

提取方式：`docker save` 导出 OCI layout，再按 digest 逐层取出 index / manifest /
config / attestation / provenance。未重建、未重打标签、未覆盖任何镜像。

原始文件：`docs/evidence/ea44/historical-ea42/`。

### 2.1 完整 digest 链（EA-42 两次构建）

| OCI 对象                    | exp1                 | exp2                 | 结果            |
| --------------------------- | -------------------- | -------------------- | --------------- |
| Image **index**（比较目标） | `0f2a69c0…a1a56c`    | `33cd283e…c4d5c6`    | ❌ **不同**     |
| Image **manifest**          | `6b255d15…02c68377`  | `6b255d15…02c68377`  | ✅ **相同**     |
| Image **config**            | `35e841b9…31bbf698`  | `35e841b9…31bbf698`  | ✅ **相同**     |
| Layer 数量 / 各层 digest    | 18 层                | 18 层                | ✅ **全部相同** |
| **Attestation manifest**    | `f42c0727…873f7833c` | `1b90e8f0…14057acef` | ❌ **不同**     |
| **SLSA provenance**         | `d264928f…93eae5c`   | `c5156f30…096d8f9e`  | ❌ **不同**     |

manifest 与 config 是**逐字节相同**（`cmp` 无差异），不是"摘要相同"的同义表述。

### 2.2 Index 的差异只有一处

两份 index（均为 856 字节）逐行 diff 后，**唯一**差异是 attestation manifest 的
digest 字段：

```
     {
       "mediaType": "application/vnd.oci.image.manifest.v1+json",
-      "digest": "sha256:f42c072739f2833660b72ad4b09f15ebd3683f21eacdf6861e68985873f7833c",
+      "digest": "sha256:1b90e8f0a24452025c5d47e689896ae5a5634fec5983b5595ba0cd814057acef",
       "annotations": {
         "vnd.docker.reference.digest": "sha256:6b255d15…",
         "vnd.docker.reference.type": "attestation-manifest"
```

指向镜像本身的 descriptor（`6b255d15…`、size 3729、platform linux/amd64）**完全相同**。

### 2.3 Attestation manifest 的唯一差异

两份 attestation manifest（837 字节）唯一差异是内嵌 in-toto 证明的 digest：

```
-      "digest": "sha256:d264928fab5f0a9bdc95193b767d568b159eba5b87c38a0b00eb67f3293eae5c",
+      "digest": "sha256:c5156f30a7bf9949df5e414e2063abf6b55c5e2c9a48fd3cfbe44293096d8f9e",
       "annotations": { "in-toto.io/predicate-type": "https://slsa.dev/provenance/v1" }
```

`subject` 仍指向 `sha256:6b255d15…`，即镜像本体。

### 2.4 Provenance 的四个差异字段（根因所在）

两份 SLSA provenance v1（2289 字节）归一化后 diff，差异**仅四处**：

| JSON 路径                                    | exp1                                                                   | exp2                                                                   |
| -------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `predicate.runDetails.metadata.startedOn`    | `2026-10-26T06:45:16.967929986+08:00`                                  | `2026-10-26T06:50:40.161984418+08:00`                                  |
| `predicate.runDetails.metadata.finishedOn`   | `2026-10-26T06:49:49.639387257+08:00`                                  | `2026-10-26T06:50:40.505927325+08:00`                                  |
| `predicate.runDetails.metadata.invocationId` | `k365919ilopj86ht440w787qc`                                            | `kmoghv5wkvq89zuafnjcljkmd`                                            |
| `subject[0].name`                            | `pkg:docker/beaconhs@ea42-exp1-20261026-064516?platform=linux%2Famd64` | `pkg:docker/beaconhs@ea42-exp2-20261026-065040?platform=linux%2Famd64` |

其余全部一致，包括 `buildDefinition`、`resolvedDependencies`
（frontend `a57df69d…`、base image `cb4e8f7c…`）、`vcs:revision` `51a899b7…`、
`buildkit_completeness`。

**`SOURCE_DATE_EPOCH` 对这三个 metadata 字段无效**：两次构建使用同一
`SOURCE_DATE_EPOCH=1729728000`，`startedOn`/`finishedOn` 仍为墙钟时间。
这是直接实测结论，不是推断。

### 2.5 关于 `Identity.Build[0].Ref` 的更正

`docker image inspect` 中的 `Identity` 是 Docker 本地 image-store 的记账信息：

```json
"Identity": { "Build": [ { "Ref": "ahhz48q23lfrzmr5rwv9uokqj",
                           "CreatedAt": "2026-10-26T06:49:57.166005631+08:00" } ] }
```

它**不出现在** index / manifest / config / attestation / provenance 任何一份
OCI JSON 中（已逐文件核对），因此**不参与任何 digest 计算**。它与 digest 差异
同步变化只是因为它同样"每次构建都不同"，属于相关而非因果。

EA-43 把它当作根因，是把 Docker 本地记账误当成 OCI 元数据。

---

## 三、构建输入确认（阶段 3）

### 3.1 EA-42 历史构建的可确认输入（VERIFIED）

| 输入                | 值                                                        | 来源                                                                  |
| ------------------- | --------------------------------------------------------- | --------------------------------------------------------------------- |
| Dockerfile frontend | `docker/dockerfile:1.7@sha256:a57df69d…d83dda33e`         | provenance `resolvedDependencies` + `externalParameters.request.args` |
| 基础镜像            | `node@24.18.0-bookworm-slim@sha256:cb4e8f7c…c80e58c5`     | provenance `resolvedDependencies`                                     |
| 源码 revision       | `51a899b7aac0a942da327222a3eed355fca9798a`                | provenance `buildkit_metadata.vcs.revision`                           |
| 源码来源            | `https://github.com/xu151077/beaconhs-hse.git`            | provenance `vcs:source`                                               |
| `SOURCE_DATE_EPOCH` | `1729728000`（config `created` = `2024-10-24T00:00:00Z`） | `config-exp*.json`                                                    |
| 平台                | linux/amd64                                               | manifest platform                                                     |
| 镜像层              | 18 层，全部 digest 相同                                   | `manifest-exp*.json`                                                  |

**未确认（REPORTED only）：** 两次 EA-42 构建是否使用了同一构建缓存状态。
构建日志未保存，无法复核。这不影响"产物内容一致"的结论，但意味着
"独立冷构建"这一点在 EA-42 层面属于 `NOT VERIFIED`——EA-44 的 `--no-cache`
探针补上了这一环（§四）。

### 3.2 EA-44 探针输入（VERIFIED）

`FROM scratch` + 单个 `COPY`，`--no-cache`，`SOURCE_DATE_EPOCH=1729728000`，
平台 linux/amd64，无 secret、无 SSH mount、无远程缓存、无 Git context。

---

## 四、最小化 Provenance 对比实验（阶段 4）

### 4.1 实验状态

| 组    | 配置                          | 重复                             | 状态                                                    |
| ----- | ----------------------------- | -------------------------------- | ------------------------------------------------------- |
| **A** | 默认（provenance 开启）       | 2 次，`--no-cache`，两个不同 tag | ✅ **RUN — VERIFIED**                                   |
| **B** | `--provenance=false`          | 2 次，`--no-cache`，两个不同 tag | ✅ **RUN — VERIFIED**                                   |
| **C** | 改变 provenance 导出/存储方式 | —                                | ❌ **NOT RUN** — A/B 已足够定位差异，无需再改变导出方式 |

早期一次带缓存的 A 组（`COPY … CACHED`）已作废，不作为结论依据；`probe/` 与
`logs/` 中只保留 `--no-cache` 的完整证据。

### 4.2 结果

| 组    | 重复 | Image index digest         | Image manifest digest     | Attestation                 |
| ----- | ---- | -------------------------- | ------------------------- | --------------------------- |
| **A** | i1   | `sha256:6313fe79…06b34e8f` | `sha256:141e5a28…036fca4` | `sha256:8bf098ba…3d9e3c842` |
| **A** | i2   | `sha256:6e37f789…15374af`  | `sha256:141e5a28…036fca4` | `sha256:51b6ae23…65bfd96f`  |
| **B** | i1   | `sha256:141e5a28…036fca4`  | `sha256:141e5a28…036fca4` | 无                          |
| **B** | i2   | `sha256:141e5a28…036fca4`  | `sha256:141e5a28…036fca4` | 无                          |

**读法（重要）：**

- A 组两次 index **不同**，但 image manifest **完全相同、且跨 tag 相同**。
- B 组两次 index **完全相同**，且等于 image manifest digest（因为 index 包装层消失）。
- A 组 index 与 B 组 index 的差别，**只**来自 attestation 的有无。

A 组两次 provenance diff 与 §2.4 同构：仍是 `startedOn`、`finishedOn`、
`invocationId`、`subject.name` 四处，其余一致。

### 4.3 对象模型澄清（阶段 4.2 要求）

| 对象                     | 文件证据                   | 是否参与"镜像 digest"                                        | 是否影响容器运行内容       |
| ------------------------ | -------------------------- | ------------------------------------------------------------ | -------------------------- |
| OCI image **index**      | `nested-index-exp*.json`   | **是**（这是被比较的 digest）                                | 否                         |
| OCI image **manifest**   | `manifest-exp*.json`       | 是（index 引用的 descriptor）                                | 否（它引用 config+layers） |
| OCI image **config**     | `config-exp*.json`         | 是（manifest 引用）                                          | 是（Env/Cmd/Labels）       |
| **Layers**               | manifest 中的 18 个 digest | 是                                                           | 是                         |
| **Attestation manifest** | `att-exp*.json`            | **是**（index 的一个成员，故其 digest 进入 index）           | 否                         |
| **SLSA provenance**      | `provenance-exp*.json`     | **是**（通过 attestation manifest 的 layer digest 间接进入） | 否                         |
| Docker `Identity`        | `inspect-exp*.json`        | **否**                                                       | 否                         |

EA-43 把 attestation/provenance 当成"独立存储、不影响 digest"，与实测相反：
在本工具链下它**在 index 内**，因此直接决定 index digest。

---

## 五、判定（阶段 5）

| 判定项                                               | 结果                                | 依据                          |
| ---------------------------------------------------- | ----------------------------------- | ----------------------------- |
| `PASS — BIT-FOR-BIT REPRODUCIBLE`（index）           | ❌ 不成立（默认构建）               | A 组 index 不同               |
| `PASS — BIT-FOR-BIT REPRODUCIBLE`（provenance 关闭） | ✅ 成立，但**以关闭安全证明为代价** | B 组 index 相同               |
| `PARTIAL — LAYERS REPRODUCIBLE`                      | ❌ **已撤回（EA-45）**              | EA-45 冷构建 10/18 层不同     |
| `PARTIAL — METADATA SOURCE IDENTIFIED`               | ✅ 成立                             | §2.2–§2.4 逐层定位            |
| `PARTIAL — PROVENANCE EFFECT IDENTIFIED`             | ✅ 成立                             | A vs B 唯一变量是 attestation |
| `FAIL — REPRODUCIBILITY REGRESSION`                  | ❌ 无                               | 无任何层的意外差异            |

**综合判定：`PARTIAL — LAYERS REPRODUCIBLE` + `PARTIAL — PROVENANCE EFFECT IDENTIFIED`。**

不写成 `PASS`，因为默认构建配置下 index digest 仍未可复现；
不写成 `FAIL`，因为不存在应用内容层面的回归。

---

## 六、可复现性结论

> ### 6.0 更正（EA-45，2026-10-26）— 本报告 §5/§6.1 的"层可复现"结论已撤回
>
> EA-45 用四次 **真正 `--no-cache`** 的完整应用镜像构建复核了本节结论，结果相反：
>
> | 原结论                       | EA-45 结果                                          |
> | ---------------------------- | --------------------------------------------------- |
> | 18 层 digest 全部相同        | 每次构建 **10/18** 层不同（层 6、7、9–16）          |
> | config 逐字节相同            | 每次构建都不同；SDE 下仅 `rootfs.diff_ids` 之外相同 |
> | image manifest digest 可复现 | **不可复现**（四次构建四个不同 digest）             |
>
> **原因：** §6.1 第 1 条的结论建立在 EA-42 两次构建之上，而那两次构建的缓存状态
> 从未记录。缓存命中会原样复用层，使构建"看起来"可复现；冷构建不具备该性质。
>
> **仍然成立的部分：** 独立构建之间没有任何应用源码、编译 chunk 或依赖二进制不同；
> 差异全部来自构建期产物（npm 缓存/日志、V8 编译缓存、fontconfig/ldconfig 缓存、
> apt 日志、Next.js 随机 preview 密钥、pnpm 映射表顺序、turbo 日志耗时）。
>
> **因此 §6.3 的 Option M（以 manifest digest 作可复现身份）整体失效**：
> manifest digest 本身不可复现，且本机 containerd image store 不可按 manifest digest 寻址。
>
> 完整证据：`docs/ea45-candidate-reproducibility-report.md`、`docs/evidence/ea45/`。

### 6.1 VERIFIED 的事实

1. ~~**应用内容可复现**：18 层 + config + image manifest，跨独立构建、跨 tag 全部逐字节一致。~~
   **已撤回（EA-45）**：应用**代码**逐字节稳定，但镜像**层产物**不稳定。
2. **Index digest 的唯一非确定来源是 provenance**：`startedOn`/`finishedOn`（墙钟）、
   `invocationId`（随机）、`subject.name`（内含 tag）。
3. **`SOURCE_DATE_EPOCH` 不能约束 provenance 时间戳**。
4. **`subject.name` 内嵌 tag**，因此"同一内容、不同 tag"也会产生不同 index digest。
5. **`subject.digest` 始终等于 image manifest digest**，即 provenance 与可复现产物
   之间的绑定关系是可验证的。

### 6.2 是否能"保留安全证明且使 index 可复现"

当前工具链（Buildx 0.38.1 / BuildKit v0.34.0）**未发现**让 `invocationId` 与
`startedOn`/`finishedOn` 确定化的受支持选项；provenance `mode=min` 亦包含这三项。
本结论的等级是 `VERIFIED (以当前工具链为限)`，**不是**"BuildKit 固有、永久无法修复"。
EA-43 的"固有行为、无法修复"表述过强，本报告撤回。

唯一实测可让 index 字节级可复现的手段是 `--provenance=false`，但这会**移除**
SLSA provenance，削弱供应链证明能力，因此不作为推荐整改方案。

### 6.3 不削弱安全性的可行路径（PROPOSED — **已被 EA-45 证伪**）

> ❌ **本节前提已失效。** EA-45 证明 image manifest digest 在冷构建下同样不可复现，
> 且本机 containerd image store 不能按 manifest digest 寻址。保留本节仅为记录历史推理。

以 **image manifest digest** 作为可复现身份，attestation 独立校验：

- 可复现性比较对象 = image manifest digest（~~已验证可复现，跨 tag 亦可~~ — **已证伪**）；
- provenance 仍发布，且 `subject.digest` 恰好绑定该 manifest digest，校验链完整；
- index digest 仍会随构建变化，但不再被当作"可复现性判据"。

**限制（必须写明）：** 该路径的部署侧可行性（按 manifest digest 而非 index digest
固定镜像、registry/回滚工具兼容性、多架构解析行为）**尚未在本环境验证**，
状态 `PROPOSED — NOT VERIFIED`。不得据此宣称整改已完成。

---

## 七、Option A 草案状态（阶段 6）

`docs/ea43-image-reproducibility-risk-acceptance.md` 已修订，保留草案性质：

- 新增"已验证事实 / 有证据支持的解释 / 未验证推断 / 证据缺口"四段式；
- 删除"provenance 未生成"与"Ref/CreatedAt 为根因"的错误陈述；
- 风险等级字段**留空**，不再预填 LOW（EA-43 曾预填，已移除）；
- 全部签字字段仍为空；
- 明确：草案不构成风险接受，不构成生产发布批准，Option A 仍是"推荐"而非"批准"。

**状态：`DRAFT — PENDING SIGNATURE`。**

---

## 八、发布阻断项（未变）

| #   | 阻断项                         | 状态                 |
| --- | ------------------------------ | -------------------- |
| 1   | Migration 51 生产预检查        | ❌ NOT RUN           |
| 2   | 生产数据库备份与恢复演练       | ❌ NOT RUN           |
| 3   | 生产对象存储备份与恢复演练     | ❌ NOT RUN           |
| 4   | 完整生产部署与回滚演练         | ❌ NOT RUN           |
| 5   | Technical Approver 正式审批    | ⚠️ PENDING SIGNATURE |
| 6   | Release Engineer 正式确认      | ⚠️ PENDING SIGNATURE |
| 7   | DBA 授权及签字                 | ⚠️ PENDING SIGNATURE |
| 8   | Ops 授权及签字                 | ⚠️ PENDING SIGNATURE |
| 9   | 镜像可复现性政策决策及书面记录 | ⚠️ PENDING DECISION  |

EA-44 只改变第 9 项的**技术输入质量**（从无原始证据变为有原始证据），
**不改变**其"待决策"状态，也不关闭任何阻断项。

---

## 九、仍未验证的事项

| 事项                                              | 状态           | 原因                                                                            |
| ------------------------------------------------- | -------------- | ------------------------------------------------------------------------------- |
| EA-42 两次构建是否冷构建（无缓存复用）            | `NOT VERIFIED` | 构建日志未保存                                                                  |
| 全量应用镜像在 `--no-cache` 下的跨 tag 可复现性   | `NOT VERIFIED` | 未重建 3 GB 应用镜像（资源约束）；探针层面已验证                                |
| registry 端是否另有独立 attestation 副本          | `NOT VERIFIED` | 无 registry 访问权限                                                            |
| 按 manifest digest 部署/回滚的工具链兼容性        | `NOT VERIFIED` | 需在预发布环境实测                                                              |
| EA-16 候选镜像在 `SOURCE_DATE_EPOCH` 下的可复现性 | `NOT VERIFIED` | EA-16 构建未使用 `SOURCE_DATE_EPOCH`（config `created` 为 2026-10-23 墙钟时间） |

最后一条值得注意：**EA-16 候选镜像本身未固定构建时间**，其
config `created` 为 `2026-10-23T05:31:46…`，与 EA-42 实验镜像
（`2024-10-24T00:00:00Z`）不同。若要实现候选镜像的可复现性，需要用
`SOURCE_DATE_EPOCH` 重新构建，这会改变候选镜像 digest，属于发布决策的一部分，
本阶段未执行。

---

## 十、文件变更

**新增：**

- `docs/evidence/ea44/`（README.md、historical-ea42/、ea16/、probe/、logs/、SHA256SUMS）
- `docs/ea44-provenance-evidence-report.md`（本报告）

**修改：**

- `docs/ea42-reproducible-build-report.md`（补证据索引、更正 provenance 陈述）
- `docs/ea43-provenance-investigation-report.md`（更正根因、撤回"无法修复"）
- `docs/ea43-image-reproducibility-risk-acceptance.md`（四段式重构、移除预填 LOW）
- `docs/release-approval-checklist.md`（EA-44 状态）
- `docs/project-development-state.md`（EA-44 addendum）

**未修改：** 业务代码、数据库 schema、权限模型、RLS、Dockerfile、构建脚本。

---

## 十一、安全边界确认

- ✅ 未访问生产环境、生产数据库、生产对象存储
- ✅ 未执行生产 SQL / 迁移 / 备份恢复 / 部署 / 回滚
- ✅ 未修改 ceshi 服务器、容器、镜像、数据库、对象存储、配置
- ✅ 未覆盖 EA-16 候选镜像、EA-42 实验镜像（只读 `docker save`）
- ✅ 未删除任何镜像、容器、卷、备份、快照、源码快照
- ✅ 未执行 `git reset --hard` / `git clean` / `git restore` / 破坏性 checkout
- ✅ 未执行 `git add -A`，未提交、未推送、未创建 PR
- ✅ 未修改业务代码、权限模型、Role Scope、RLS
- ✅ 未泄露任何密钥、数据库密码、访问令牌（构建日志已扫描）
- ✅ WOPI 保持 `KNOWN / UNRESOLVED — LOW PRIORITY — INVESTIGATION PAUSED`
- ✅ 未代替任何审批人签字；未将 Option A 推荐改写为已批准

**新增的本地资源（全部为新标签，未覆盖既有资源）：**

| 资源                                  | 用途                                       |
| ------------------------------------- | ------------------------------------------ |
| `beaconhs:ea44-probe-a` / `-c`        | 早期带缓存的探针（结论已作废，保留未删）   |
| `beaconhs:ea44-probe-a-nc`            | 早期 `--no-cache` 探针（保留未删）         |
| `beaconhs:ea44-probe-b`               | 早期 `--provenance=false` 探针（保留未删） |
| `beaconhs:ea44-probe-a-nc-i1` / `-i2` | 有效证据 A 组                              |
| `beaconhs:ea44-probe-b-nc-i1` / `-i2` | 有效证据 B 组                              |

`/tmp/opencode/ea44/` 保存了 3 个 552 MB 的 `docker save` 导出物（含 SHA-256）。
该目录为临时位置，不是持久存储。

---

## 十二、下一步（EA-45 后已更新）

1. ~~**技术决策人**基于本报告重新评估第 9 项：Option A 还是 Option M。~~
   **EA-45 已证伪 Option M**：manifest digest 不可复现、本地不可寻址。
   剩余可选路径为 Option A（接受不可复现）或启动可复现构建工程。
2. ~~若选择 Option M，需在预发布环境实测按 manifest digest 固定镜像。~~
   **前提失效，不再适用。**
3. ~~若要候选镜像本身可复现，需用 `SOURCE_DATE_EPOCH` 重建 EA-16。~~
   **EA-45 证明 SDE 不足以复现**：它只固定 config 元数据，不固定 `RUN` 层文件 mtime。
4. 其余 8 个阻断项按 EA-41 计划推进，本阶段未改变其状态。

**本阶段到此停止。未执行生产变更，未签署风险接受书，未提交或推送代码。**

---

## 十三、EA-45 复核结果（2026-10-26）

| 项目              | 内容                                                                  |
| ----------------- | --------------------------------------------------------------------- |
| 复核报告          | `docs/ea45-candidate-reproducibility-report.md`                       |
| 原始证据          | `docs/evidence/ea45/`（26 个文件，`sha256sum -c` 退出码 0）           |
| 构建次数          | 4 次全量应用镜像，全部 `--no-cache`（2 次无 SDE、2 次有 SDE）         |
| 层可复现性        | ❌ **FAIL** — 每次 10/18 层不同（层 6、7、9–16）                      |
| Manifest 可复现性 | ❌ **FAIL** — 四次构建四个不同 digest                                 |
| Index 可复现性    | ❌ **FAIL**                                                           |
| Config 可复现性   | ❌ **FAIL**（差异为 `rootfs.diff_ids` 的派生结果）                    |
| 应用代码差异      | ✅ **无** — 8 658 个同名文件仅 1 个不同，且该 1 个是随机 preview 密钥 |
| 部署身份          | 固定 index digest（`deploy-dev.yml:39`）→ 不可由独立重建复现          |

**本报告 §5「`PARTIAL — LAYERS REPRODUCIBLE`」与 §6.1 第 1 条、§6.3 已按 EA-45 结果撤回。**
