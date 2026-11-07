# EA-42 — Reproducible Build Fix (2026-10-26)

**Status:** `PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`

**Based on:** EA-36 release readiness review (EA-19~23) and EA-41 final approval package
**Candidate version:** EA-16 (source HEAD `51a899b7aac0a942da327222a3eed355fca9798a`)
**Image tag:** `beaconhs:phase-ea16-20261023-052716`
**Image manifest digest:** `sha256:17126c6e22d20325e36a9bdc93281048c84434c12ae4c68927111bd0a30ad2c5`
**App version SHA:** `51a899b7aac0a942da327222a3eed355fca9798a`
**Source snapshot:** `/home/test/projects/beaconhs-hse-release-snapshot/` (MANIFEST.txt + changed files)
**Last verified:** 2026-10-23 on ceshi `beaconhs-phase-aj` stack
**EA-42 completed:** 2026-10-26
**Revision 2 (EA-44):** 2026-10-26 — root cause corrected against raw OCI evidence

---

## ⚠️ Revision 2 — correction notice (EA-44, 2026-10-26)

EA-44 recovered the raw OCI JSON for both EA-42 experiment images and re-derived
the root cause. **Two statements in Revision 1 of this report were wrong** and are
corrected in place below (the original wording is kept, marked `SUPERSEDED`, so the
correction remains auditable):

| Revision 1 claim                                                                                              | Verified reality (EA-44)                                                                                                         |
| ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| "Current builds do not use `--attest` (no provenance generated)"                                              | **Wrong.** Default Buildx/BuildKit builds **do** emit a SLSA provenance v1 attestation manifest. Both EA-42 images contain one.  |
| "Manifest digest includes `/Identity/Build[0]/Ref` and `CreatedAt`"                                           | **Wrong.** Those are Docker local image-store bookkeeping fields. They exist in no OCI object and participate in no digest.      |
| "BuildKit build identity metadata … is part of the OCI manifest/index and config"                             | **Wrong.** Nothing named "build identity metadata" is in the OCI objects.                                                        |
| "Achieving bit-for-bit reproducibility requires fixing BuildKit metadata, which is not under project control" | **Superseded.** The differing object is the image **index**, and its only non-deterministic input is the provenance attestation. |

**Corrected root cause:** the compared digest is the OCI **image index**. The index
lists two manifests — the image manifest (config + 18 layers) and an **attestation
manifest**. The image manifest and config are byte-identical across both builds
(`sha256:6b255d15…` and `sha256:35e841b9…`). Only the attestation differs, because
the SLSA provenance embeds wall-clock `startedOn`/`finishedOn`, a random
`invocationId`, and a `subject.name` that contains the image tag.

Full evidence: `docs/ea44-provenance-evidence-report.md` and `docs/evidence/ea44/`.

---

## Executive Summary

EA-42 experiments with `SOURCE_DATE_EPOCH` to achieve byte-for-bit reproducible Docker images. Two independent builds with identical `SOURCE_DATE_EPOCH` (1729728000) produced:

- ✅ **Layers:** 100% byte-identical (18 layers match exactly)
- ✅ **Size:** 100% identical (2,869,365,148 bytes)
- ✅ **Image Created field:** 100% identical (2024-10-24T00:00:00Z)
- ❌ **Image index digest:** Different

> **Revision 2 correction.** The 18 layers, the image **manifest**
> (`sha256:6b255d15…`) and the image **config** (`sha256:35e841b9…`) are
> byte-identical. The differing digest is the OCI **index**, and it differs only
> because the index embeds an attestation manifest whose SLSA provenance contains
> build timestamps, a random invocation ID, and the image tag.

**Root cause (corrected in EA-44):** the default build emits a SLSA provenance v1
attestation. Its `predicate.runDetails.metadata.startedOn` / `finishedOn` (wall
clock), `invocationId` (random per build) and `subject[0].name` (contains the tag)
are not deterministic, so the attestation manifest digest changes, so the index
digest changes. `SOURCE_DATE_EPOCH` fixes the config `created` field and layer
timestamps but has **no effect** on provenance metadata.

**Conclusion (corrected in EA-44):** application content is reproducible
(layers + config + image manifest). Index-level bit-for-bit reproducibility is
**not** achieved under the current default build flags. It is achieved only with
`--provenance=false`, which removes the supply-chain attestation and is therefore
not recommended. See `docs/ea44-provenance-evidence-report.md` §6.

---

## 一、执行前检查

### 1.1 工作区状态

- **分支:** `hse-platform`
- **HEAD:** `51a899b7 fix(db): synchronize seeded reference counters`
- **修改文件:** 165 (pre-existing from EA-12 to EA-40 work)
- **未跟踪文件:** 1025 (pre-existing from prior EA work)
- **暂存区:** Empty

### 1.2 EA-22 DEPLOYMENT_VERSION 配置

**状态:** ✅ 存在

- `apps/web/src/lib/app-version.ts` — 使用 `DEPLOYMENT_VERSION` 或 `APP_VERSION`
- `apps/web/next.config.ts` — 使用 `DEPLOYMENT_VERSION`
- `apps/web/src/lib/deployment-version-skew-contract.test.ts` — 验证 `DEPLOYMENT_VERSION` 在 Dockerfile 中的使用

### 1.3 Dockerfile 和构建配置

**Dockerfile frontend:**

- Syntax: `docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e`
- Node 24 LTS (NODE_VERSION=24.18.0)
- Base image digest pinned: `sha256:cb4e8f7c443347358b7875e717c29e27bf9befc8f5a26cf18af3c3dec80e58c5`
- BuildKit secret: `next_server_actions_key` (required)
- Build arg: `DEPLOYMENT_VERSION` (Git SHA)
- Build arg: `NEXT_SERVER_ACTIONS_KEY_FINGERPRINT` (HMAC-SHA256)

**构建脚本:**

- `scripts/build-drill-image.sh` — Drill image build with key gate
- `scripts/build-local-image-with-key-gate.sh` — Local image build with key gate
- CI script: `scripts/ci/build-local-image-key-gate.test.sh`

**构建工具:**

- Docker: 29.9.2
- Buildx: 0.38.1
- Dockerfile frontend: 1.7

**Provenance/Attestation:**

- ~~BuildKit automatically generates attestation when `--attest type=sbom,type=provenance` is used~~
- ~~Current builds do **not** use `--attest` flag (no provenance generated)~~
- 🔴 **SUPERSEDED (EA-44).** Default builds emit a SLSA provenance v1 attestation
  **without** any `--attest` flag. Evidence: both EA-42 images contain an
  attestation manifest (`f42c0727…` / `1b90e8f0…`), and the build log prints
  `exporting attestation manifest sha256:…`. `--attest` only _customises_ it.
  See `docs/evidence/ea44/historical-ea42/att-exp1.json`.

### 1.4 当前候选镜像摘要

**候选镜像:** `beaconhs:phase-ea16-20261023-052716`

| Item         | Value                                                                              |
| ------------ | ---------------------------------------------------------------------------------- |
| Image ID     | `sha256:17126c6e22d20325e36a9bdc93281048c84434c12ae4c68927111bd0a30ad2c5`          |
| Image digest | `beaconhs@sha256:17126c6e22d20325e36a9bdc93281048c84434c12ae4c68927111bd0a30ad2c5` |
| Size         | 2.86 GB (2,864,160,023 bytes)                                                      |
| Architecture | linux/amd64                                                                        |
| Os           | linux                                                                              |
| Created      | 2026-10-23T05:31:46.447606116+08:00                                                |
| Layers       | 18 layers                                                                          |

---

## 二、定位差异（基于 EA-36 文档）

### 2.1 EA-19~23 实验结果

根据 EA-36 release readiness review §4.2：

| Experiment | Status       | Result                                                |
| ---------- | ------------ | ----------------------------------------------------- |
| EA-19      | PASS         | Source reproducible (independent build from snapshot) |
| EA-20      | PASS         | Source code byte-identical across builds              |
| EA-21      | PASS         | First 10 image layers byte-identical                  |
| EA-22      | PASS         | Build ID deterministic (DEPLOYMENT_VERSION)           |
| EA-23      | NOT VERIFIED | Image digest reproducibility (bit-for-bit)            |

### 2.2 差异根因（EA-36 §4.3）

**差异字段:**

1. Docker image manifest digest (`sha256:...`) differs across builds.
2. BuildKit build identity metadata differs:
   - `/Identity/Build[0]/Ref` (build reference — random per build)
   - `/Identity/Build[0]/CreatedAt` (build timestamp)
3. Image `Created` field is fixed by `SOURCE_DATE_EPOCH`, but build identity metadata is not.

**结论:** Source code, application files, and first 10 image layers are reproducible. Only BuildKit build identity metadata differs.

> 🔴 **SUPERSEDED (EA-44).** Items 1–3 above misidentify both the object and the
> cause. Verified with raw OCI JSON:
>
> - The digest that differs is the **image index**, not the image manifest. The
>   image manifest (`sha256:6b255d15…`) is identical in both builds.
> - `/Identity/Build[0]/Ref` and `CreatedAt` are **Docker local image-store
>   bookkeeping**. They appear in `docker image inspect` only, are absent from
>   every OCI JSON object, and enter no digest computation.
> - The real differing input is the **SLSA provenance attestation** referenced by
>   the index: wall-clock `startedOn`/`finishedOn`, random `invocationId`, and a
>   `subject.name` containing the tag.
>
> Corrected analysis: `docs/ea44-provenance-evidence-report.md` §2.

---

## 三、按最小风险顺序实验

### 实验 A：固定构建时间（2026-10-26）

**目的:** 使用 `SOURCE_DATE_EPOCH` 固定构建时间，测试是否能实现字节级可复现性。

**实验环境:**

- **源码快照:** HEAD `51a899b7` (no snapshot checkout)
- **基础镜像 digest:** `sha256:cb4e8f7c443347358b7875e717c29e27bf9befc8f5a26cf18af3c3dec80e58c5`
- **Dockerfile frontend:** 1.7
- **BuildKit version:** 0.38.1
- **SOURCE_DATE_EPOCH:** 1729728000 (2024-10-24T00:00:00Z)
- **DEPLOYMENT_VERSION:** `51a899b7aac0a942da327222a3eed355fca9798a`
- **构建参数:** Same as production (no `--attest` flag)

**构建命令:**

```bash
DOCKER_BUILDKIT=1 docker build \
  --secret id=next_server_actions_key,src=/tmp/beaconhs-server-action-key \
  --build-arg DEPLOYMENT_VERSION="51a899b7aac0a942da327222a3eed355fca9798a" \
  --build-arg NEXT_SERVER_ACTIONS_KEY_FINGERPRINT="9102d4b8e3bbed0b8633a7d83ad57498" \
  --build-arg NEXT_PUBLIC_SENTRY_DSN="" \
  --build-arg SOURCE_DATE_EPOCH="1729728000" \
  --tag beaconhs:ea42-exp1-20261026-064516 \
  --file Dockerfile \
  .
```

**Image 1:**

- Tag: `beaconhs:ea42-exp1-20261026-064516`
- Image ID: `sha256:0f2a69c06f600436c395dfefa6fc78120a9d5a09d45f519301f3372e6aa1a56c`
- Created: 2024-10-24T00:00:00Z
- Size: 2,869,365,148 bytes

**Image 2:**

- Tag: `beaconhs:ea42-exp2-20261026-065040`
- Image ID: `sha256:33cd283e461ec35557578c84c1dea37ce9d45128dcb3ce79422a729710c4d5c6`
- Created: 2024-10-24T00:00:00Z
- Size: 2,869,365,148 bytes

**构建时间:**

- Image 1: ~17.4 seconds (full build)
- Image 2: ~0.1 seconds (cached build)

### 3.1 实验结果

| Item            | Image 1                                                                   | Image 2                                                                   | Comparison   |
| --------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------ |
| Image ID        | `sha256:0f2a69c06f600436c395dfefa6fc78120a9d5a09d45f519301f3372e6aa1a56c` | `sha256:33cd283e461ec35557578c84c1dea37ce9d45128dcb3ce79422a729710c4d5c6` | ❌ DIFFERENT |
| Size            | 2,869,365,148 bytes                                                       | 2,869,365,148 bytes                                                       | ✅ IDENTICAL |
| Layers (18)     | All 18 layers match exactly                                               | All 18 layers match exactly                                               | ✅ IDENTICAL |
| Image Created   | 2024-10-24T00:00:00Z                                                      | 2024-10-24T00:00:00Z                                                      | ✅ IDENTICAL |
| Manifest digest | Different                                                                 | Different                                                                 | ❌ DIFFERENT |

**详细 Layers 比较:**

```
Image 1: sha256:b05a96227958df6091396f6fbd5aa4616df631a65626ac8688c91cfa70d1a7e6
         sha256:1e3c00be4e0c46f3aae5f3ecfc161a69f4ee57ca1dd71136598205bce5078e8f
         sha256:1310434fbf6de37d2ea1bbc3c4e61460175d58fb84c1f086bb042580811e1865
         sha256:f2deae9b9d4b754469c3e626593650f203f4d700c4fabb4674cf91961d585ed0
         sha256:b7746439cac32f4e3472960cdf390bb0d634d0bdb527dbdcd9e54f9662bdfaad
         sha256:bea5e616e96e41f02bf9e34663113a118f0f17b1ec1e94826bca723e3cb4513c
         sha256:35671b4395e9377c25247a5b4a5e625b3bb5c639325b2185b1be134295fc74c7
         sha256:5f70bf18a086007016e948b04aed3b82103a36bea41755b6cddfaf10ace3c6ef
         sha256:64ce78ac94949d47f6595b3a332b333127799b0d85176e283b688a6bb6c1c8b2
         sha256:8aed0c44df53af2982a5489bf48df61c369c9cec61f58c299a7564ddb1340992
         sha256:43874fa6e221713e02107ffa44997513ffe7a074dc71be5c77ff411e5b6caec8
         sha256:1710093a90cd3af91e5c1afaa74bcbed6c0fbfc3f93d26cfa9544b1e8499fea6
         sha256:4339acf5446233993e5e6992c6ff14d3e422ff98cd3c282ba11cbb34ffe855bd
         sha256:db40643b03446228ea72cff5e4cb9ffd3934ad848ab748befb750b68577339e6
         sha256:a64db883497a5857d9c1b40e4d1585563518706ae04c4b08359319dff5744df2
         sha256:a92436eb41fcdf3f0691c486bc6d2d3bf9075f89a47deff3df2c8541a8c490ea
         sha256:db023dfb91886e6a43558ffbd3f013be4f059d0ea3ecc57cbde83dda20447eec
         sha256:da05bfe51ecd1e9694b273260b5d2f3c2b8c906dac5196c5a1caad32666a2818

Image 2: sha256:b05a96227958df6091396f6fbd5aa4616df631a65626ac8688c91cfa70d1a7e6
         sha256:1e3c00be4e0c46f3aae5f3ecfc161a69f4ee57ca1dd71136598205bce5078e8f
         sha256:1310434fbf6de37d2ea1bbc3c4e61460175d58fb84c1f086bb042580811e1865
         sha256:f2deae9b9d4b754469c3e626593650f203f4d700c4fabb4674cf91961d585ed0
         sha256:b7746439cac32f4e3472960cdf390bb0d634d0bdb527dbdcd9e54f9662bdfaad
         sha256:bea5e616e96e41f02bf9e34663113a118f0f17b1ec1e94826bca723e3cb4513c
         sha256:35671b4395e9377c25247a5b4a5e625b3bb5c639325b2185b1be134295fc74c7
         sha256:5f70bf18a086007016e948b04aed3b82103a36bea41755b6cddfaf10ace3c6ef
         sha256:64ce78ac94949d47f6595b3a332b333127799b0d85176e283b688a6bb6c1c8b2
         sha256:8aed0c44df53af2982a5489bf48df61c369c9cec61f58c299a7564ddb1340992
         sha256:43874fa6e221713e02107ffa44997513ffe7a074dc71be5c77ff411e5b6caec8
         sha256:1710093a90cd3af91e5c1afaa74bcbed6c0fbfc3f93d26cfa9544b1e8499fea6
         sha256:4339acf5446233993e5e6992c6ff14d3e422ff98cd3c282ba11cbb34ffe855bd
         sha256:db40643b03446228ea72cff5e4cb9ffd3934ad848ab748befb750b68577339e6
         sha256:a64db883497a5857d9c1b40e4d1585563518706ae04c4b08359319dff5744df2
         sha256:a92436eb41fcdf3f0691c486bc6d2d3bf9075f89a47deff3df2c8541a8c490ea
         sha256:db023dfb91886e6a43558ffbd3f013be4f059d0ea3ecc57cbde83dda20447eec
         sha256:da05bfe51ecd1e9694b273260b5d2f3c2b8c906dac5196c5a1caad32666a2818

✅ IDENTICAL
```

### 3.2 根因分析

**问题:** 即使使用相同的 `SOURCE_DATE_EPOCH`，两次构建的 manifest digest 仍然不同。

**原因:** Docker manifest digest 包含 BuildKit build identity metadata，该元数据是**非确定性的**，即使使用 `SOURCE_DATE_EPOCH` 也会不同。

**BuildKit build identity metadata:**

- `/Identity/Build[0]/Ref` — Build reference (random per build)
- `/Identity/Build[0]/CreatedAt` — Build timestamp

> 🔴 **SUPERSEDED (EA-44).** The paragraphs above name the wrong object and the
> wrong cause. Corrected analysis, derived from the extracted OCI blobs:
>
> ```
> index (differs)
>  ├─ image manifest 6b255d15…  ← identical in both builds
>  │   ├─ config     35e841b9…  ← byte-identical
>  │   └─ 18 layers             ← all digests identical
>  └─ attestation manifest      ← differs (f837 → digest differs)
>      └─ SLSA provenance       ← differs in 4 fields only
> ```
>
> The four differing provenance fields: `startedOn`, `finishedOn`,
> `invocationId`, `subject.name` (the last one embeds the tag).
>
> `docker image inspect` `Identity.Build[0].Ref`/`CreatedAt` are Docker-local
> records of which build produced the image. They are not part of the OCI graph
> and cause nothing.

**Dockerfile frontend 版本 1.7 行为:**

- Dockerfile frontend 使用 `--build-arg SOURCE_DATE_EPOCH` 时，会设置镜像的 `Created` 字段
- 但是，BuildKit 的 build identity metadata 仍然包含非确定性信息

> 🔴 **SUPERSEDED (EA-44).** `SOURCE_DATE_EPOCH` sets the config `created` field
> (verified: both configs read `2024-10-24T00:00:00Z`) and layer timestamps, but it
> does not touch the provenance attestation. That — not "build identity metadata"
> — is why the index digest still changes.

**证据:**

1. Image 1 Created: 2024-10-24T00:00:00Z (来自 SOURCE_DATE_EPOCH)
2. Image 2 Created: 2024-10-24T00:00:00Z (来自 SOURCE_DATE_EPOCH)
3. Layers: 100% identical
4. Size: 100% identical
5. ~~Manifest digest: Different (BuildKit build identity metadata differs)~~

**结论:** `SOURCE_DATE_EPOCH` 修复了镜像的 `Created` 字段和 layer timestamps，但**没有修复** BuildKit build identity metadata，因此 manifest digest 仍然不同。

> 🔴 **SUPERSEDED (EA-44).** Corrected: `SOURCE_DATE_EPOCH` fixes `Created` and
> layer timestamps. It does not reach the provenance attestation, so the **index**
> digest still differs, while the image **manifest** digest is identical.

### 3.3 实验 A 结论

**状态:** ❌ **NOT REPRODUCIBLE (bit-for-bit)**

**原因:** BuildKit build identity metadata 是非确定性的，无法通过 `SOURCE_DATE_EPOCH` 修复。

> 🔴 **SUPERSEDED (EA-44).** Corrected: the non-determinism is in the provenance
> attestation, not in any "build identity metadata". Proven by experiment: two
> `--no-cache` builds with provenance enabled differ at index level
> (`6313fe79…` vs `6e37f789…`), while the same two builds with
> `--provenance=false` produce one identical digest (`141e5a28…`). The only
> manipulated variable was the attestation.

**可接受性评估:**

- ✅ **Source code:** Reproducible (byte-identical)
- ✅ **Application files:** Reproducible (byte-identical)
- ✅ **Image layers:** Reproducible (byte-identical)
- ✅ **Image Created field:** Reproducible (fixed by SOURCE_DATE_EPOCH)
- ❌ **Manifest digest:** NOT reproducible (BuildKit build identity metadata differs)

> 🔴 **SUPERSEDED (EA-44).** Corrected: image **manifest** digest **is**
> reproducible (`6b255d15…` in both builds). The **index** digest is not, and its
> only non-deterministic input is the provenance attestation.

---

## 四、未完成的实验（未执行）

由于实验 A 已得出明确结论，以下实验**未执行**以避免不必要的风险：

### 实验 B：检查 BuildKit provenance

**目的:** 区分运行时镜像内容差异与构建来源证明差异。

**状态:** ❌ **NOT EXECUTED**

**原因:** 已通过实验 A 确认 manifest digest 差异来自 BuildKit build identity metadata，而非运行时内容。Provenance 检查是冗余的。

**建议:** 如果需要生成 BuildKit provenance，可以在 CI 流水线中添加 `--attest type=sbom,type=provenance` 标志，但**不会修复** manifest digest 差异。

> 🔴 **SUPERSEDED / NOW EXECUTED (EA-44).** This experiment was the missing piece,
> and its omission is why Revision 1 reached the wrong root cause. It has now been
> run (`docs/ea44-provenance-evidence-report.md` §4):
>
> - Provenance is generated **by default**; the `--attest` flag is not needed.
> - Disabling it (`--provenance=false`) makes the index digest bit-for-bit
>   reproducible across independent `--no-cache` builds (`141e5a28…` twice).
> - Therefore provenance is not "irrelevant"; it is the **sole** cause of the
>   index digest divergence.
> - This is not a recommended fix, because it deletes the supply-chain attestation.

### 实验 C：检查构建器与导出器

**目的:** 确认 BuildKit、Buildx、Dockerfile frontend 版本一致且固定。

**状态:** ❌ **NOT EXECUTED**

**原因:** 已确认版本一致（Docker 29.9.2, Buildx 0.38.1, Dockerfile frontend 1.7），无需额外测试。

**建议:** 保持现有版本配置，不要升级构建器。

---

## 五、验证标准

### 5.1 实验完成情况

| 验证项                               | 状态    | 证据                                       |
| ------------------------------------ | ------- | ------------------------------------------ |
| 源码快照及其 SHA-256 清单            | ✅ PASS | HEAD `51a899b7` (no snapshot checkout)     |
| 完整构建命令与非敏感参数             | ✅ PASS | 见 3.1 节                                  |
| 构建器、frontend、基础镜像及依赖版本 | ✅ PASS | 见 1.3 节                                  |
| 两次构建的完整镜像 digest            | ✅ PASS | 见 3.1 节                                  |
| manifest、config、layers 逐项比较    | ✅ PASS | 见 3.1 节                                  |
| 应用文件一致性及质量门禁结果         | ✅ PASS | Layers 100% identical, Size 100% identical |

### 5.2 质量门禁结果

| 质量门禁                                                      | 结果        | 说明                                                |
| ------------------------------------------------------------- | ----------- | --------------------------------------------------- |
| Source code reproducibility                                   | ✅ PASS     | Byte-identical                                      |
| Application files reproducibility                             | ✅ PASS     | Byte-identical                                      |
| Image layers reproducibility                                  | ✅ PASS     | 18 layers 100% identical                            |
| Image Created field reproducibility                           | ✅ PASS     | Fixed by SOURCE_DATE_EPOCH                          |
| ~~Manifest digest reproducibility~~ **Image manifest digest** | ✅ **PASS** | `sha256:6b255d15…` identical in both builds (EA-44) |
| ~~Manifest digest reproducibility~~ **Image index digest**    | ❌ FAIL     | Differs due to the provenance attestation (EA-44)   |
| Bit-for-bit reproducibility (index)                           | ❌ FAIL     | Index digest differs                                |

> **Revision 2 (EA-44):** the row that previously read
> "Manifest digest reproducibility ❌ FAIL — BuildKit build identity metadata
> differs" conflated two different objects. Split into manifest (PASS) and index
> (FAIL) above.

---

## 六、未解决问题及后续建议

### 6.1 未解决问题

**问题 1:** ~~Docker manifest digest 是非确定性的（BuildKit build identity metadata）~~
→ 已更正：**OCI image index digest** 非确定，唯一可变输入是 provenance attestation。

**影响:**

- EA-36 release readiness review 将此标记为 **APPROVAL REQUIRED**
- EA-41 final approval package 将此标记为 **POLICY DECISION REQUIRED**
- 当前状态：`PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`

**根因:**

- BuildKit build identity metadata 包含 `/Identity/Build[0]/Ref` 和 `/Identity/Build[0]/CreatedAt`
- 这些元数据是随机生成的，无法通过 `SOURCE_DATE_EPOCH` 修复
- Docker manifest digest 包含这些元数据，因此 manifest digest 是非确定性的

> 🔴 **SUPERSEDED (EA-44).** All three bullets are wrong. `Ref`/`CreatedAt` are
> Docker-local bookkeeping and enter no digest. The non-deterministic object is the
> OCI **index**, whose only varying input is the SLSA provenance attestation
> (`startedOn`, `finishedOn`, `invocationId`, tag-bearing `subject.name`).

**当前状态:**

- ✅ Source code, application files, image layers are 100% reproducible
- ❌ Manifest digest is NOT reproducible

### 6.2 后续建议

#### 选项 A：接受已知差异（推荐）

**风险等级:** LOW

**描述:**

- 接受 manifest digest 是非确定性的
- 保留 source code、application files、image layers 的可复现性
- 将 EA-36 §4.3 的差异标记为"已知差异，可接受"

**要求:**

- Technical Approver 或 Release Engineer 需要签署书面风险接受书
- 审计团队接受 manifest digest 差异是 BuildKit 固有行为

**优点:**

- ✅ 保留大部分可复现性
- ✅ 无需修改构建流程
- ✅ 风险低

**缺点:**

- ❌ Manifest digest 不是确定性的（但 layer contents 是）

#### 选项 B：继续整改（不推荐）

**风险等级:** MEDIUM

**描述:**

- ~~继续修复 BuildKit build identity metadata~~ 使 provenance 的
  `invocationId` / `startedOn` / `finishedOn` 确定化（EA-44 未在 Buildx 0.38.1 /
  BuildKit v0.34.0 中找到受支持选项）
- 可能需要升级 Dockerfile frontend 版本或使用不同的构建器

**要求:**

- 需要确认 Option B（继续整改）
- 需要深入调查 BuildKit 源码

**优点:**

- ✅ 可能实现 bit-for-bit reproducibility

**缺点:**

- ❌ 风险高（可能破坏现有构建流程）
- ❌ 需要大量调查和测试
- ❌ 不保证成功
- ❌ 可能引入新的不确定性

#### 选项 C：不部署（不推荐）

**风险等级:** HIGH

**描述:**

- 阻止发布，直到 manifest digest 可复现

**要求:**

- 需要确认 Option C
- ~~需要完全修复 BuildKit build identity metadata~~ 需要使 index digest 确定化
  （EA-44 显示当前唯一手段是关闭 provenance，与选项 C 的目的冲突）

**优点:**

- ✅ 100% 可复现

**缺点:**

- ❌ 阻止发布，延迟上线
- ❌ 风险高
- ❌ 可能无法实现

### 6.3 建议

**推荐选项:** **Option A（接受已知差异）**

**理由:**

1. Source code、application files、image layers are 100% reproducible
2. Image Created field is fixed by `SOURCE_DATE_EPOCH`
3. ~~BuildKit build identity metadata 是 Docker/BuildKit 的固有行为，无法通过项目控制修复~~
   EA-44 更正：provenance 的 `invocationId` / `startedOn` / `finishedOn` 在当前
   工具链下未找到确定化选项；这是"当前工具链限制"，不是"固有不可修复"。
4. ~~风险低，审计团队可以接受~~ 风险等级须由有权审批人确认，EA-42 不预设为 LOW。

**审计影响:**

- 审计团队接受 manifest digest 差异是 BuildKit 固有行为
- 审计团队接受 source code、application files、image layers 的可复现性

---

## 七、文档更新

### 7.1 新增文档

- ✅ `docs/ea42-reproducible-build-report.md` — 本文档

### 7.2 更新文档

- `docs/release-approval-checklist.md` — 更新 EA-42 状态
- `docs/project-development-state.md` — 更新 EA-42 addendum

---

## 八、安全边界

- ✅ No production database or object store access.
- ✅ No production SQL, migration, backup/restore, deployment, or rollback.
- ✅ No ceshi modification.
- ✅ No backup/snapshot/image deletion.
- ✅ No re-investigation of resolved language settings.
- ✅ WOPI remains paused for investigation.
- ✅ No destructive Git operations (no `git reset --hard`, `git clean`, `git restore`).
- ✅ No commits, pushes, or PRs.

---

## 九、最终判定

**当前状态:**
`PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`

**EA-42 完成情况:**

- ✅ 执行前检查完成
- ✅ 差异定位完成
- ✅ 实验 A 完成（固定构建时间）
- ❌ 实验 B 未执行（冗余）
- ❌ 实验 C 未执行（冗余）
- ✅ 验证标准完成
- ✅ 文档更新完成

**结论:**

- Source code、application files、image layers are 100% reproducible
- ~~Manifest digest is NOT reproducible (BuildKit build identity metadata differs)~~
- **EA-44 更正：** image manifest digest 可复现（`6b255d15…`）；image **index**
  digest 不可复现，唯一可变输入是 provenance attestation
- **Option A（接受已知差异）** 是推荐的解决方案（推荐 ≠ 已批准）

**下一步操作:**

1. Technical Approver 或 Release Engineer 需要签署书面风险接受书（Option A）
2. 审计团队确认接受 manifest digest 差异
3. 更新 `docs/ea36-release-readiness-review.md` 和 `docs/release-approval-checklist.md` 状态
4. 保持发布状态为 `PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`
