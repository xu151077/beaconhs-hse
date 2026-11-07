# EA-45 — EA-16 候选镜像可复现性与部署身份验证报告

**日期：** 2026-10-26
**状态：** `PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`
**范围：** 仅本地隔离环境。未访问生产，未改动 ceshi 主机/容器/镜像/数据库/对象存储。
**原始证据：** `docs/evidence/ea45/`（26 个文件，`sha256sum -c SHA256SUMS` 退出码 0）

> 本文件是验证报告，不是发布批准，也不是风险接受。
> 文中所有结论均标注证据等级：`PASS` / `PARTIAL` / `FAIL` / `NOT RUN` / `NOT VERIFIED` / `PROPOSED — NOT VERIFIED`。
> 未由本人签署任何审批角色。

> **⚠️ 后续更正（EA-46，2026-10-26）：** 本报告有 4 处结论已被
> `docs/ea46-image-determinism-investigation.md` 更正/细化，尤其是
> "工具链不支持时间戳重写"（实际支持，见 EA-46 §6.5）与"层 6/7 的归属"。
> 为保留历史记录，正文未删除，全部更正集中在 **§14**。

---

## 0. 结论速览

| #   | 结论                                                                                       | 等级                           | 证据                                     |
| --- | ------------------------------------------------------------------------------------------ | ------------------------------ | ---------------------------------------- |
| 1   | EA-16 候选镜像身份完整可核实（index / manifest / config / attestation / provenance）       | ✅ **PASS**                    | `docs/evidence/ea44/ea16/`               |
| 2   | EA-16 的**严格复现不可能成立**：脏工作区构建、快照仅存 3 个文件、**无构建日志**            | ❌ **FAIL**（证据缺口）        | `MANIFEST.txt`、§4.1                     |
| 3   | 自 EA-16 构建后**构建输入已改变**（`turbo.json` 新增 `DEPLOYMENT_VERSION` 到 `globalEnv`） | ❌ **FAIL**（输入漂移）        | §4.3、`comparison/build-id-analysis.txt` |
| 4   | 四次 `--no-cache` 独立构建：**index / manifest / config 全部不同**                         | ❌ **FAIL**                    | §5、`logs/build-ledger.txt`              |
| 5   | 18 层中 **10 层**每次构建都不同；8 层恒定                                                  | ❌ **FAIL**（层可复现性）      | §5.2、`comparison/layer-matrix.txt`      |
| 6   | `SOURCE_DATE_EPOCH` **只**固定 config `created` 与 history 时间戳                          | ⚠️ **PARTIAL**                 | §6                                       |
| 7   | 两次 `SOURCE_DATE_EPOCH` 构建仍在同样的 10 层上不同                                        | ❌ **FAIL**（SDE 不足）        | §6.2、`build-ea45-sde-1/2`               |
| 8   | 差异**不含任何应用代码或依赖二进制**：全部为构建期产物（缓存/日志/随机键/顺序）            | ✅ **PASS**（内容级定性）      | §6.3、`comparison/content-diff.csv`      |
| 9   | CI 部署固定 **OCI index digest**，而 index digest 不可复现                                 | ❌ **FAIL**（部署身份）        | §7.1、`deploy-dev.yml:39`                |
| 10  | 本机镜像引用模型**无法**以 manifest digest 寻址                                            | ❌ **FAIL**                    | §7.2                                     |
| 11  | Option M（以 manifest digest 作可复现身份）前提**已被证伪**                                | ❌ **FAIL**                    | §7.3                                     |
| 12  | Option A 仍为草案，未获签字；其"应用内容稳定"表述需收窄                                    | ⚠️ **PROPOSED — NOT VERIFIED** | §8、`docs/ea43-...risk-acceptance.md`    |
| 13  | EA-44 事实 1–3（manifest/config/层可复现）**不再成立**                                     | ❌ **FAIL**（已撤回）          | §2.3、§6.4                               |

**一句话结论：** EA-16 候选镜像在当前工具链下**既不能被严格复现，也不能被近似复现到同一 digest**；根因不是 provenance，而是**运行时文件时间戳、构建期缓存与日志、以及 Next.js 每次构建随机生成的 preview key**。因此"用 digest 比对证明重建正确"这条控制措施目前不可用。

---

## 1. 工作区状态（阶段 1）

| 项目              | 值                                                                                     | 等级      |
| ----------------- | -------------------------------------------------------------------------------------- | --------- |
| 分支              | `hse-platform`                                                                         | ✅ `PASS` |
| HEAD              | `51a899b7aac0a942da327222a3eed355fca9798a`                                             | ✅ `PASS` |
| `git status`      | 664 条目 = 165 modified + 499 untracked                                                | ✅ `PASS` |
| 暂存区            | 空                                                                                     | ✅ `PASS` |
| `git diff --stat` | 165 files, 5 934 insertions(+), 2 053 deletions(−)                                     | ✅ `PASS` |
| 构建工具链        | Docker 29.9.2 / Buildx v0.38.1 / BuildKit v0.34.0 / driver `docker` / containerd store | ✅ `PASS` |
| 主机资源          | 7.7 GiB RAM / 16 cores / 144 GB 空闲磁盘                                               | ✅ `PASS` |

**未做**：未执行 `git reset --hard` / `git clean` / `git restore` / `git add -A`，未 commit、未 push、未建 PR。

---

## 2. EA-44 证据清单核对（阶段 2）

### 2.1 完整性

| 检查                                         | 结果                                                           | 等级      |
| -------------------------------------------- | -------------------------------------------------------------- | --------- |
| `sha256sum -c docs/evidence/ea44/SHA256SUMS` | 33/33 通过，退出码 0                                           | ✅ `PASS` |
| 六项验收比对复跑                             | 全部与 EA-44 结论一致                                          | ✅ `PASS` |
| manifest 逐字节相同（EA-42 两次构建）        | 相同                                                           | ✅ `PASS` |
| nested index 差异位置                        | 仅 attestation descriptor 一处                                 | ✅ `PASS` |
| provenance 差异字段                          | 仅 `startedOn`/`finishedOn`/`invocationId`/`subject.name` 四处 | ✅ `PASS` |
| 探针 B（`--provenance=false`）两次 index     | 相同                                                           | ✅ `PASS` |
| 风险接受草案的等级/签字字段                  | 仍为空                                                         | ✅ `PASS` |

### 2.2 路径差异记录

任务描述将 `nested-index-exp*.json` / `provenance-exp*.json` 记在 `docs/evidence/ea44/` 根目录；
实际位置为 `docs/evidence/ea44/historical-ea42/`。`SHA256SUMS` 内的相对路径与磁盘一致，
属**描述偏差**而非证据缺失。等级：✅ `PASS`（已核实）。

### 2.3 必须撤回的结论

EA-44 事实 1–3 声称"18 层 + config + image manifest 跨独立构建逐字节相同"。

EA-45 用四次**真正 `--no-cache`** 的完整应用镜像构建证明：该性质**不成立于本应用镜像**。

- EA-42 两次构建的缓存状态从未记录（EA-44 自己已列为证据缺口 1）。
- 本环境中两次构建间隔 5 分钟、输入完全相同，仍产生 10 层差异。
- 因此事实 1–3 是**缓存命中**的产物，不是可复现性的证据。

等级：❌ `FAIL — CLAIM WITHDRAWN`。更正已落入 `docs/ea44-provenance-evidence-report.md` 与
`docs/ea43-image-reproducibility-risk-acceptance.md`。

---

## 3. EA-16 候选镜像身份（阶段 2）

| 字段             | 值                                                                        | 等级                |
| ---------------- | ------------------------------------------------------------------------- | ------------------- |
| Tag              | `beaconhs:phase-ea16-20261023-052716`                                     | ✅ `PASS`           |
| Index digest     | `sha256:17126c6e22d20325e36a9bdc93281048c84434c12ae4c68927111bd0a30ad2c5` | ✅ `PASS`           |
| Descriptor       | `application/vnd.oci.image.index.v1+json`，Size `2864160023`              | ✅ `PASS`           |
| Manifest digest  | `sha256:43a7dc279182d71fc82a5dfa2d5408868cf029d73541f27e60630186ab59a943` | ✅ `PASS`           |
| Config digest    | `sha256:7e6139af7ac5032e9504fb2f979bb8b537b5302c3871c793e394febdf22d98f3` | ✅ `PASS`           |
| Config `created` | `2026-10-23T05:31:46.447606116+08:00`                                     | ✅ `PASS`           |
| Attestation      | `sha256:0f7e823e53002bbe51976af1f332ee7d315bb028a72ebe72d305f777cd52eca6` | ✅ `PASS`           |
| Provenance       | `sha256:153584313d8d0f19e92eccac6a5ba3c2b8247f5e75f813c5358b303484fe0452` | ✅ `PASS`           |
| Layers           | 18 层，压缩总计 `578 043 276` 字节                                        | ✅ `PASS`           |
| Config history   | 32 条                                                                     | ✅ `PASS`           |
| SBOM             | **无**（attestation 仅含 SLSA provenance）                                | ⚠️ `FAIL`（见 §12） |

### 3.1 层结构（由 config history 顺序与层内容交叉核实）

| 层    | 来源                                                                                                                    |
| ----- | ----------------------------------------------------------------------------------------------------------------------- |
| 1–5   | 上游 `node:24.18.0-bookworm-slim` 基础镜像层（debian rootfs / useradd / node 安装 / ca-certificates / 基础 entrypoint） |
| 6     | `corepack@0.35.0` + `pnpm@10.30.3` 安装（history #10）                                                                  |
| 7     | `WORKDIR /app` —— 仅创建 `app/` 目录，无文件（history #11）                                                             |
| 8     | 空层（32 字节）：`RUN test "$TARGETARCH" = amd64` 架构断言未改变文件系统（history #13）                                 |
| 9     | `apt-get` 运行时依赖（LibreOffice、字体、poppler，history #15）                                                         |
| 10    | Chrome headless shell 下载（history #17）                                                                               |
| 11–16 | `COPY --from=builder`：standalone / static / public / worker / ops-bootstrap / ops-migrate（history #20–25）            |
| 17    | `COPY docker/entrypoint.sh`（history #26）                                                                              |
| 18    | `RUN chmod +x /entrypoint.sh`（history #27，仅模式变化）                                                                |

等级：✅ `PASS`（层与内容一一对应，无悬空层）。

---

## 4. 构建输入核实（阶段 2）

### 4.1 EA-16 的构建输入**不可完整重建**

| 证据                                                             | 内容                                                                | 等级      |
| ---------------------------------------------------------------- | ------------------------------------------------------------------- | --------- |
| `/home/test/projects/beaconhs-hse-release-snapshot/MANIFEST.txt` | 明确记录 EA-16 **由脏工作区构建**（165 modified + 1 022 untracked） | ✅ `PASS` |
| 快照归档内容                                                     | **仅** 3 个变更文件                                                 | ✅ `PASS` |
| EA-16 构建日志                                                   | **不存在**                                                          | ❌ `FAIL` |
| 当前工作区                                                       | 165 modified + 499 untracked（与构建时不同）                        | ✅ `PASS` |

三个归档文件的当前哈希与 `MANIFEST.txt` 比对：

| 文件                                      | MANIFEST 期望 | 当前        | 结论      |
| ----------------------------------------- | ------------- | ----------- | --------- |
| `apps/web/src/app/invite/accept/route.ts` | `eeee2ba2…`   | `eeee2ba2…` | ✅ 一致   |
| `docs/phase-6u-b3-ea14-final-report.md`   | `f909eafa…`   | `2a971a81…` | ❌ 不一致 |
| `docs/project-development-state.md`       | `1cd1f158…`   | `d9a68345…` | ❌ 不一致 |

两个不一致文件均为**文档**（本次 EA-43/44 编辑与 Prettier 格式化所致），不进入运行时镜像层。
但结论不变：**当前工作区 ≠ EA-16 构建树，且缺失部分无法从快照还原。**

**因此：本次四次构建只能称为"近似复现"。等级：`NOT VERIFIED`（严格复现）。**

### 4.2 EA-16 provenance 中固定下来的输入

| 项目                   | 值                                                                                                       | 等级      |
| ---------------------- | -------------------------------------------------------------------------------------------------------- | --------- |
| `vcs:revision`         | `51a899b7aac0a942da327222a3eed355fca9798a`                                                               | ✅ `PASS` |
| `vcs:source`           | `https://github.com/xu151077/beaconhs-hse.git`                                                           | ✅ `PASS` |
| `vcs:localdir:context` | `.`                                                                                                      | ✅ `PASS` |
| Dockerfile frontend    | `dockerfile@1.7` → `sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e`             | ✅ `PASS` |
| Base image             | `node@24.18.0-bookworm-slim` → `sha256:cb4e8f7c443347358b7875e717c29e27bf9befc8f5a26cf18af3c3dec80e58c5` | ✅ `PASS` |

> 注：provenance 的 `buildkit_completeness` 为 `false`，本身不声称输入完整。这与 §4.1 的证据缺口一致，
> 不能把 provenance 当作"输入已固定"的证明。

### 4.3 构建后发生的输入漂移（关键发现）

| 变更                                                                                              | 时间                  | 与构建的先后                 | 等级      |
| ------------------------------------------------------------------------------------------------- | --------------------- | ---------------------------- | --------- |
| `turbo.json` 修改                                                                                 | `2026-10-23T11:04:04` | 构建结束 **后** 5 小时 32 分 | ✅ `PASS` |
| 新增 `R2_ENDPOINT`、`R2_INTERNAL_ENDPOINT`、`PUBLIC_APP_URL`、`DEPLOYMENT_VERSION` 到 `globalEnv` | 同上                  | 同上                         | ✅ `PASS` |
| `.playwright-mcp/` 63 个文件                                                                      | 构建后                | 构建后                       | ✅ `PASS` |
| `apps/web/next.config.ts`                                                                         | `2026-10-15T15:56:29` | 构建 **前**                  | ✅ `PASS` |

**因果链（已核实到文件行级）：**

1. `apps/web/next.config.ts:19` → `deploymentId: process.env.DEPLOYMENT_VERSION`。
2. `Dockerfile:23,25` → `ARG`/`ENV DEPLOYMENT_VERSION`，变量确实存在于 builder 环境。
3. `pnpm turbo --version` = `2.10.5`；`pnpm turbo run build --dry=json --filter=@beaconhs/web` → `"envMode":"strict"`，且 `@beaconhs/web#build` **未声明任何** `env`/`passThroughEnv`。
4. strict 模式下未声明的变量不会传给任务，因此 `DEPLOYMENT_VERSION` 只能经 `globalEnv` 进入 `next build`。
5. `turbo.json` 在构建**之后**才把 `DEPLOYMENT_VERSION` 加入 `globalEnv`。
6. 结论：EA-16 构建时 `process.env.DEPLOYMENT_VERSION` 为 `undefined` → 无 `deploymentId` → Next.js 生成**随机** build id。

**观测证据（非推断）：**

| 对象                      | EA-16                           | A1 / A2 / B1 / B2              |
| ------------------------- | ------------------------------- | ------------------------------ |
| `.next/BUILD_ID`          | `T79KItdA9zMY3BiGlR7x1`         | `build-TfctsWXpff2fKS`         |
| `nextConfig.deploymentId` | **缺失**                        | `51a899b7…`                    |
| 静态资源前缀              | `static/T79KItdA9zMY3BiGlR7x1/` | `static/build-TfctsWXpff2fKS/` |

后果：46 个 chunk 文件被重命名、8 658 个同名文件中 1 653 个内容不同（manifest、route manifest、
`.nft.json`、`server.js`），其余 8 658 个逐字节相同。

| 结论                                   | 等级                                                    |
| -------------------------------------- | ------------------------------------------------------- |
| 上述观测与文件行级引用                 | ✅ `PASS`                                               |
| strict env mode 导致变量被过滤这一机制 | ⚠️ `PROPOSED — NOT VERIFIED`（无 EA-16 构建日志可直证） |

详见 `docs/evidence/ea45/comparison/build-id-analysis.txt`。

---

## 5. 构建对比（阶段 3）

### 5.1 四次构建

| 组  | Tag                     | `--no-cache` | `SOURCE_DATE_EPOCH` | 耗时  | 退出码 | Index digest      |
| --- | ----------------------- | ------------ | ------------------- | ----- | ------ | ----------------- |
| A1  | `beaconhs:ea45-repro-1` | 是           | 未设置              | 323 s | 0      | `9b2156ac…944429` |
| A2  | `beaconhs:ea45-repro-2` | 是           | 未设置              | 327 s | 0      | `d76edbad…c5dd97` |
| B1  | `beaconhs:ea45-sde-1`   | 是           | `1729728000`        | 339 s | 0      | `ad6266ce…bdf3ec` |
| B2  | `beaconhs:ea45-sde-2`   | 是           | `1729728000`        | 363 s | 0      | `80ac7a1a…c686da` |

`--no-cache` 生效证明：每次构建只有 2 个步骤报 `CACHED`（内部 metadata 载入 `#3`、基础镜像 `FROM` 解析 `#6`），
**没有任何 `RUN` / `COPY` 命中缓存**。证据：`docs/evidence/ea45/logs/cached-steps.txt`。等级：✅ `PASS`。

### 5.2 层矩阵

| 层    | EA-16 | A1  | A2  | B1  | B2  | 是否变化 |
| ----- | ----- | --- | --- | --- | --- | -------- |
| 1–5   | 同    | 同  | 同  | 同  | 同  | 否       |
| 6     | —     | 异  | 异  | 异  | 异  | **是**   |
| 7     | —     | 异  | 异  | 异  | 异  | **是**   |
| 8     | 同    | 同  | 同  | 同  | 同  | 否       |
| 9     | —     | 异  | 异  | 异  | 异  | **是**   |
| 10    | —     | 异  | 异  | 异  | 异  | **是**   |
| 11–16 | —     | 异  | 异  | 异  | 异  | **是**   |
| 17–18 | 同    | 同  | 同  | 同  | 同  | 否       |

**8 层恒定，10 层每次都不同。** 完整 digest 与字节数见
`docs/evidence/ea45/comparison/layer-matrix.txt`。等级：❌ `FAIL`（层可复现性）。

关键判据：**无论配对哪两个构建，差异层集合完全相同（6, 7, 9–16）。**

| 配对                        | 差异层数 | 差异层集合   |
| --------------------------- | -------- | ------------ |
| A1 ↔ A2（均无 SDE）         | 10       | 6,7,9–16     |
| EA-16 ↔ A1                  | 10       | 6,7,9–16     |
| EA-42 exp1（有 SDE）↔ A1    | 10       | 6,7,9–16     |
| B1 ↔ EA-42 exp1（均有 SDE） | 10       | 6,7,9–16     |
| **B1 ↔ B2（均有 SDE）**     | **10**   | **6,7,9–16** |

这说明差异不是"某一方特殊"，而是**构建过程本身的确定性缺陷**。等级：✅ `PASS`（判据成立）。

### 5.3 汇总

| 指标             | EA-16               | A1                  | A2                  | B1                   | B2                   |
| ---------------- | ------------------- | ------------------- | ------------------- | -------------------- | -------------------- |
| Index            | `17126c6e…`         | `9b2156ac…`         | `d76edbad…`         | `ad6266ce…`          | `80ac7a1a…`          |
| Manifest         | `43a7dc27…`         | `be54cfce…`         | `8d9813e4…`         | `9142bb14…`          | `20fa0a57…`          |
| Config           | `7e6139af…`         | `e35ca534…`         | `ebb3c428…`         | `1aba672a…`          | `1b91b679…`          |
| 层字节合计       | 578 043 276         | 578 133 721         | 578 143 907         | 578 134 447          | 578 138 109          |
| Config `created` | 2026-10-23T05:31:46 | 2026-10-26T08:58:14 | 2026-10-26T09:04:13 | 2024-10-24T00:00:00Z | 2024-10-24T00:00:00Z |

等级：❌ `FAIL`（三个身份层级全部不可复现）。

---

## 6. `SOURCE_DATE_EPOCH` 结果（阶段 3 组 B）

### 6.1 SDE 实际做了什么

| 项目                               | 结果                                        | 等级      |
| ---------------------------------- | ------------------------------------------- | --------- |
| Config 顶层 `created`              | 固定为 `2024-10-24T00:00:00Z`               | ✅ `PASS` |
| Config `history[].created`         | 构建步骤时间戳固定                          | ✅ `PASS` |
| **`RUN` 层内文件的 mtime**         | **未固定**（仍为墙钟）                      | ❌ `FAIL` |
| `COPY`（构建上下文）层内文件 mtime | 沿用源文件 mtime（与 SDE 无关，跨构建恒定） | ✅ `PASS` |

直接观测（三处独立证据）：

```
A1 layer7: 2026-10-26 08:53:26   app/            （WORKDIR 创建的目录）
B1 layer7: 2026-10-26 09:05:20   app/
B2 layer7: 2026-10-26 09:11:22   app/            （SDE=2024-10-24，仍为构建墙钟时间）

A1 layer6: 2026-10-26 08:53:26   root/.cache/node/corepack/lastKnownGood.json
B1 layer6: 2026-10-26 09:05:20   root/.cache/node/corepack/lastKnownGood.json

A1 layer6: 2026-10-26T00_53_19_699Z-debug-0.log   （npm 调试日志，时间戳在文件名里）
B1 layer6: 2026-10-26T01_05_13_597Z-debug-0.log
```

即 `SOURCE_DATE_EPOCH` 生效后，`RUN`/`WORKDIR` 产生的层内条目仍是构建时的墙钟时间；
层 6 的 npm 调试日志甚至把时间戳写进了**文件名**，因此该层不可能在时间维度上复现。

### 6.2 SDE 是否使镜像可复现

| 对比                               | Index    | Manifest | Config       | 层            | 等级      |
| ---------------------------------- | -------- | -------- | ------------ | ------------- | --------- |
| A1 ↔ A2（无 SDE）                  | 不同     | 不同     | 不同         | 10 层不同     | ❌ `FAIL` |
| **B1 ↔ B2（有 SDE）**              | **不同** | **不同** | **不同**     | **10 层不同** | ❌ `FAIL` |
| B1 ↔ B2 的 config（排除 `rootfs`） | —        | —        | **完全相同** | —             | ✅ `PASS` |

**结论：`SOURCE_DATE_EPOCH` 只固定元数据，不固定层内容。**
因此 manifest digest 与 index digest 依旧不可复现，config digest 的差异是 `rootfs.diff_ids` 的**派生结果**。

等级：❌ `FAIL`（SDE 单独使用不足以达成可复现构建）。

### 6.3 内容级差异的精确归因（最重要的一节）

方法：把每层解包，对每个普通文件做 `sha256sum`，逐路径比对（A1 vs B1；层 9 用 B1 vs B2 复核）。

| 层    | 文件数 | 不同  | 归因                                                                                       |
| ----- | ------ | ----- | ------------------------------------------------------------------------------------------ |
| 6     | 1 689  | 541   | 538 个 V8 `node-compile-cache` + 2 个 npm `_cacache` 索引 + 1 个 npm 调试日志              |
| 7     | 1      | 0     | 内容相同，**仅 mtime 不同**                                                                |
| 9     | 5 320  | 10    | 5 个 fontconfig 缓存 + `ldconfig` aux-cache + 4 个 apt/dpkg 日志；**无任何软件包文件不同** |
| 10    | 630    | 44    | 33 个 npm `_cacache` 索引 + 10 个 V8 编译缓存 + 1 个 npm 日志；**Chrome 二进制完全相同**   |
| 11    | 8 704  | **1** | `.next/prerender-manifest.json` —— **3 个随机生成的 preview mode 密钥**                    |
| 12    | 411    | 0     | 完全相同                                                                                   |
| 13    | 5      | 0     | 完全相同                                                                                   |
| 14    | 40 911 | 2     | `worker/node_modules/.modules.yaml` **键顺序** + `.turbo/turbo-build.log` **耗时毫秒数**   |
| 15    | 18 134 | 2     | 同上（ops-bootstrap-admin）                                                                |
| 16    | 6 031  | 2     | 同上（ops-migrate）                                                                        |
| 17–18 | 各 1   | 0     | 完全相同                                                                                   |

`prerender-manifest.json` 的差异内容：

```
A1: previewModeId 3cfd574a01287cab1b35ce8ee8f0cbf7
B1: previewModeId ddb03a8c96593c5f18ccf325d857f7fe
（previewModeSigningKey / previewModeEncryptionKey 同样每次随机）
```

**结论：独立构建之间，没有任何应用源码、编译产物 chunk 或依赖二进制不同。**
全部差异来自：构建期缓存与日志、V8 编译缓存、Next.js 随机 preview 密钥、pnpm 映射表顺序、turbo 日志耗时。

| 结论                       | 等级                                               |
| -------------------------- | -------------------------------------------------- |
| 内容级归因（上表全部计数） | ✅ `PASS`                                          |
| "应用行为等价"             | ⚠️ `PROPOSED — NOT VERIFIED`（未做运行时行为比对） |

### 6.4 与 EA-44 的关系

EA-44 的"层可复现"结论来自 EA-42 的两次构建。EA-45 证明：该结论在真正 `--no-cache` 条件下不成立。
EA-42 两次构建的缓存状态无日志可查，因此**不能**据此主张可复现性。等级：❌ `FAIL — CLAIM WITHDRAWN`。

### 6.5 工具链能力核查

| 项目                                          | 结果                                 | 等级                |
| --------------------------------------------- | ------------------------------------ | ------------------- |
| buildx `--rewrite-timestamp`                  | **不存在**（v0.38.1 帮助中无此选项） | ✅ `PASS`（已核查） |
| `SOURCE_DATE_EPOCH` 归一化 RUN 层 mtime       | 不支持                               | ✅ `PASS`（实测）   |
| 通过禁用 provenance/SBOM/签名换取 digest 相等 | **未采用**（任务禁止，且无必要）     | ✅ `PASS`           |

---

## 7. Digest 与部署身份评估（阶段 4）

### 7.1 部署实际固定的对象

| 事实                                                                       | 证据                                                  | 等级         |
| -------------------------------------------------------------------------- | ----------------------------------------------------- | ------------ |
| CI 使用 `docker/build-push-action`，`platforms: linux/amd64`，`push: true` | `.github/workflows/deploy-dev.yml`                    | ✅ `PASS`    |
| 部署入口取 `steps.build-image.outputs.digest`                              | `deploy-dev.yml:39`                                   | ✅ `PASS`    |
| 该值在带 attestation 的导出路径上是 **OCI index digest**                   | 本地四次构建 `.Id` 均为 index digest                  | ✅ `PASS`    |
| 部署与回滚只使用 `IMAGE_NAME@sha256:...`，commit tag 从不作为部署身份      | `docs/PRODUCTION_RUNBOOK.md` §Deployment and rollback | ✅ `PASS`    |
| 实际 CI 流水线运行                                                         | 未运行                                                | ⚠️ `NOT RUN` |

**推论：** 部署固定的是 index digest；而 §5、§6 已证明 index digest 不可复现。
所以"重新构建 → 比对 digest → 证明部署内容正确"这条审计控制**当前不可用**。

| 结论                           | 等级      |
| ------------------------------ | --------- |
| 部署按 digest 固定（流程层面） | ✅ `PASS` |
| 该 digest 可由独立重建复现     | ❌ `FAIL` |
| "重建比对"可作发布门禁         | ❌ `FAIL` |

### 7.2 本机镜像引用模型的可寻址性

| 引用形式                            | 结果            | 等级      |
| ----------------------------------- | --------------- | --------- |
| `beaconhs@sha256:<index digest>`    | 可解析          | ✅ `PASS` |
| `beaconhs@sha256:<manifest digest>` | `No such image` | ❌ `FAIL` |
| `beaconhs@sha256:<config digest>`   | `No such image` | ❌ `FAIL` |

即：在 containerd image store 下，**只有 index digest 是可寻址的镜像引用**。
manifest 与 config 的 blob 存在于内容库，但不可作为镜像引用解析。

### 7.3 Option M 判定

Option M 的设想是"以 image manifest digest 作为可复现的部署身份"。两项前提均不成立：

| 前提                                      | 结果              | 证据             |
| ----------------------------------------- | ----------------- | ---------------- |
| manifest digest 本身可复现                | ❌ `FAIL`         | §5.2、§6.2       |
| manifest digest 可作为镜像引用被拉取/固定 | ❌ `FAIL`（本地） | §7.2             |
| registry 端是否可按 manifest digest 拉取  | ⚠️ `NOT VERIFIED` | 无 registry 访问 |

等级：❌ `FAIL`（本地）；registry 侧 ⚠️ `NOT VERIFIED`。

---

## 8. Option A 状态（阶段 5）

| 项目                           | 状态                                                 | 等级         |
| ------------------------------ | ---------------------------------------------------- | ------------ |
| 风险接受草案存在               | `docs/ea43-image-reproducibility-risk-acceptance.md` | ✅ `PASS`    |
| 状态                           | `DRAFT — PENDING SIGNATURE — NOT AN APPROVAL`        | ✅ `PASS`    |
| 风险等级字段                   | 空（未预设）                                         | ✅ `PASS`    |
| 签字                           | 全部空白                                             | ✅ `PASS`    |
| 是否已获批准                   | **否**                                               | ✅ `PASS`    |
| 草案中"应用内容本身稳定"的表述 | **需收窄**（见下）                                   | ⚠️ `PARTIAL` |

### 8.1 必须修正的表述

草案原文称"OCI index digest 不稳定；**应用内容本身稳定**"。EA-45 的精确结果是：

- 应用**源码与编译产物**在不同构建间逐字节相同（层 11 中 8 704 个文件仅 1 个不同，且该 1 个是随机 preview 密钥）。
- 但**镜像层不是内容稳定的**：层 6/9/10 的缓存与日志、层 14–16 的映射表顺序与构建耗时都会变化。

因此准确表述应为：**"应用代码逐字节稳定；镜像层产物不稳定"**。原表述会让读者误以为镜像内容可复现。

### 8.2 草案中已失效的控制措施

| #   | 原控制措施                                               | EA-45 结论                                   |
| --- | -------------------------------------------------------- | -------------------------------------------- |
| 3   | 生产部署按完整 digest 固定                               | ✅ 已由 CI/runbook 证实（流程层面 `PASS`）   |
| 4   | 以 manifest digest 作可复现身份，并校验 `subject.digest` | ❌ `FAIL`（manifest 不可复现、不可寻址）     |
| 8   | CI 固定 `SOURCE_DATE_EPOCH` 并记录 provenance digest     | ⚠️ `PARTIAL`（SDE 只固定元数据，不足以复现） |

Option A 的决策状态**保持 `PENDING APPROVAL`**，本次不替代、不预判、不签署。

---

## 9. 文件与质量（阶段 6）

### 9.1 新增

| 文件                                            | 说明                       |
| ----------------------------------------------- | -------------------------- |
| `docs/ea45-candidate-reproducibility-report.md` | 本报告                     |
| `docs/evidence/ea45/README.md`                  | 证据包说明                 |
| `docs/evidence/ea45/builds/*.json`（20 个）     | 四次构建的 OCI 对象        |
| `docs/evidence/ea45/comparison/*`（3 个）       | 层矩阵、内容差异、build id |
| `docs/evidence/ea45/logs/*`（2 个）             | 构建台账、缓存命中证明     |
| `docs/evidence/ea45/SHA256SUMS`                 | 26 个文件的哈希清单        |

### 9.2 修改

| 文件                                                 | 变更                                                                 |
| ---------------------------------------------------- | -------------------------------------------------------------------- |
| `docs/ea43-image-reproducibility-risk-acceptance.md` | 补发布状态行、EA-44/EA-45 分期、撤回失效结论、更新控制表             |
| `docs/ea44-provenance-evidence-report.md`            | 更正"层/manifest 可复现"结论（§6.0、§6.1、§6.3、§十三）              |
| `docs/release-approval-checklist.md`                 | 新增 §10.17；修复重复的 `## 11` 标题（→ `## 12`）                    |
| `docs/project-development-state.md`                  | 新增 EA-45 addendum                                                  |
| `.prettierignore`                                    | 排除原始 OCI 证据与 Playwright 产物，确保 SHA-256 与 digest 保持对应 |

### 9.3 质量检查

本次改动仅涉及文档与证据文件，但按仓库门禁要求仍完整执行并逐个记录退出码：

| 门禁                   | 命令                                         | 退出码 | 结果                                                   |
| ---------------------- | -------------------------------------------- | ------ | ------------------------------------------------------ |
| 格式                   | `pnpm format:check`                          | **0**  | ✅ `PASS`（All matched files use Prettier code style） |
| 类型检查               | `pnpm typecheck`                             | **0**  | ✅ `PASS`（27/27 tasks）                               |
| Lint                   | `pnpm lint`                                  | **0**  | ✅ `PASS`                                              |
| 测试（默认并行）       | `pnpm test`                                  | **1**  | ❌ `FAIL` — 见下方说明                                 |
| 测试（串行，用于定性） | `pnpm exec turbo run test --concurrency=1`   | **0**  | ✅ `PASS`（25/25 tasks）                               |
| 死代码                 | `pnpm deadcode:check`                        | **0**  | ✅ `PASS`（knip 无输出）                               |
| 构建                   | `pnpm build`                                 | **0**  | ✅ `PASS`（4/4 tasks）                                 |
| 证据校验               | `sha256sum -c docs/evidence/ea45/SHA256SUMS` | **0**  | ✅ `PASS`（26/26）                                     |
| 证据 JSON 解析         | `jq empty` × 20 个文件                       | **0**  | ✅ `PASS`                                              |

**关于 `pnpm test` 默认并行失败（重要，不得掩盖）：**

- 失败包为 `@beaconhs/jobs`、`@beaconhs/storage`、`@beaconhs/db`（另有 `web`、`object-store-backup` 在并发下出现 `EPIPE` worker 崩溃）。
- **这三个包全部是本工作区中已有的未提交改动**（`git status` 显示其源码与测试文件均处于 modified/untracked 状态），与本次纯文档改动无关。
- 单独运行全部通过：
  - `pnpm --filter @beaconhs/jobs test` → 退出码 **0**，20/20 测试通过
  - `pnpm --filter @beaconhs/db test` → 退出码 **0**，508 passed / 41 skipped
  - `pnpm --filter @beaconhs/storage test` → 退出码 **0**，148/148 通过
- 串行执行全仓测试 → 退出码 **0**，25/25 任务成功（其中 22 个为同输入缓存重放，`object-store-backup`、`worker`、`web` 为本轮实际执行）。
- 根因是本机资源竞争（260 MiB multipart 用例 + jsdom 并行导致超时与 worker `EPIPE`），符合 AGENTS.md 已记录的"本机内存受限、并行负载下易 OOM"环境问题。**这不是本次改动引入的缺陷，也不能据此声称 CI 会红。**

### 9.4 证据自校验

| 检查                                      | 结果                                                                                                                         | 等级      |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------- |
| `docs/evidence/ea45/SHA256SUMS`           | 26 个文件，`-c` 退出码 0                                                                                                     | ✅ `PASS` |
| 每个 OCI 文件的 SHA-256 与其 digest 一致  | 20/20 一致（16 个 index/manifest/config/attestation 等于其 OCI digest；4 个 `prov` 等于 attestation 内 in-toto 层的 digest） | ✅ `PASS` |
| 证据目录中 Server Action 密钥指纹出现次数 | 0                                                                                                                            | ✅ `PASS` |
| `docs/evidence/ea44/SHA256SUMS` 未被改动  | 33/33 仍通过                                                                                                                 | ✅ `PASS` |

---

## 10. Git 状态（阶段 7）

| 检查                                     | 结果                                                 | 等级      |
| ---------------------------------------- | ---------------------------------------------------- | --------- |
| 新增 commit                              | **无**                                               | ✅ `PASS` |
| push / PR                                | **无**                                               | ✅ `PASS` |
| `git add -A`                             | **未执行**                                           | ✅ `PASS` |
| `git reset --hard` / `clean` / `restore` | **未执行**                                           | ✅ `PASS` |
| 暂存区                                   | 空                                                   | ✅ `PASS` |
| 既有镜像被覆盖/删除                      | **无**（四次构建均为全新 tag，创建前已确认为非存在） | ✅ `PASS` |

**注意：** 本报告中"修改"的文件均停留在工作区，未提交。是否提交由用户决定。

---

## 11. 安全边界（阶段 7）

| 边界                                            | 结果                                                            |
| ----------------------------------------------- | --------------------------------------------------------------- |
| 访问生产环境                                    | ❌ 未访问                                                       |
| 生产 SQL / 迁移 / 备份 / 恢复 / 部署 / 回滚     | ❌ 未执行                                                       |
| 改动 ceshi 主机、容器、镜像、数据库、对象存储   | ❌ 未改动                                                       |
| 覆盖 EA-16 候选 / EA-42 历史 / EA-44 实验镜像   | ❌ 未覆盖                                                       |
| 删除任何资源                                    | ❌ 未删除                                                       |
| 业务代码 / schema / 权限模型 / Role Scope / RLS | ❌ 未改动                                                       |
| Server Action 密钥泄漏                          | ❌ 未泄漏（仅以 BuildKit secret 传入；证据目录指纹出现次数 0）  |
| 禁用 provenance / SBOM / 签名以换取 digest 相等 | ❌ 未采用                                                       |
| 把本地实验当作生产验证                          | ❌ 未如此表述                                                   |
| 代替审批人签字                                  | ❌ 未签字                                                       |
| WOPI                                            | 保持 `KNOWN / UNRESOLVED — LOW PRIORITY — INVESTIGATION PAUSED` |

等级：✅ `PASS`（全部边界保持）。

---

## 12. 未决问题与发现的缺陷

### 12.1 本次发现并已记录的缺陷

| ID     | 缺陷                                                                                                     | 状态                              |
| ------ | -------------------------------------------------------------------------------------------------------- | --------------------------------- |
| EA45-1 | `.playwright-mcp/` **不在** `.dockerignore` 中，63 个浏览器产物进入构建上下文                            | 已记录，未修复（见 12.2）         |
| EA45-2 | `docs/release-approval-checklist.md` 存在两个 `## 11` 标题（Release decision matrix 与 Approval status） | ✅ **已修复**（重编号为 `## 12`） |
| EA45-3 | 应用镜像**无 SBOM** attestation（仅 provenance），与供应链要求可能不符                                   | 已记录                            |
| EA45-4 | buildx v0.38.1 **无** `--rewrite-timestamp`，无法在本工具链内固定 RUN 层 mtime                           | 已记录                            |
| EA45-5 | Next.js 每次构建随机生成 `previewModeId`/`SigningKey`/`EncryptionKey`，进入生产布局文件                  | 已记录                            |

### 12.2 未修复的原因

EA45-1 属构建配置变更，会改变构建上下文；在实验进行中修改会使 A/B 对照失效，且超出 EA-45 授权范围。
EA45-3/4/5 属工具链与构建配置层面的独立工程（见 §12.4），不在本次文档验证范围内。

### 12.3 仍未验证的事项

| #   | 事项                                             | 等级                         | 原因                   |
| --- | ------------------------------------------------ | ---------------------------- | ---------------------- |
| 1   | registry 端 attestation 副本与签名链验证         | ⚠️ `NOT VERIFIED`            | 无 registry 访问       |
| 2   | registry 侧按 manifest digest 拉取/固定          | ⚠️ `NOT VERIFIED`            | 无 registry 访问       |
| 3   | 真实 CI 流水线产出的 digest 与本次本地构建的关系 | ⚠️ `NOT RUN`                 | 不能在本地复现 CI 环境 |
| 4   | 重建镜像的运行时行为等价性（非字节等价）         | ⚠️ `PROPOSED — NOT VERIFIED` | 未做运行时比对         |
| 5   | EA-16 构建日志（已确认不存在，不可补）           | ❌ `FAIL`                    | 从未保存               |
| 6   | 生产部署/回滚演练                                | ⚠️ `NOT RUN`                 | 超出授权，禁止访问生产 |
| 7   | 遗留缺陷 D8（82 个外键不在 Drizzle 快照链）      | 未触碰                       | 与本任务无关           |
| 8   | 遗留缺陷 D9（`canSeeWidget` 默认放行）           | 未触碰                       | 与本任务无关           |

### 12.4 建议的后续动作（不构成本次结论）

1. **若要求字节级可复现**：需先固定 `apt` 包版本、清理 `npm`/V8/fontconfig/ldconfig 缓存与日志、为 Next.js 提供固定 `previewModeId` 来源，并在工具链中引入可重写 mtime 的能力（当前 buildx 不支持）。这是一项独立工程。
2. **若只要求部署身份可追溯**：现行 `index digest` 固定已满足"不可变引用"，但**不能**用"重建得到同一 digest"作为验证手段；应改为记录构建 provenance + 独立复跑冒烟测试。
3. **补 SBOM**：在 CI 中启用 `--sbom`，否则供应链审计缺少组件清单。
4. **修补 EA45-1**：把 `.playwright-mcp` 加入 `.dockerignore`。

---

## 13. 交付检查清单

- [x] `docs/evidence/ea44/SHA256SUMS`（33 个文件）校验通过 — 退出码 0
- [x] `docs/evidence/ea45/SHA256SUMS`（26 个文件）校验通过 — 退出码 0
- [x] 报告中每个结论都带 `PASS`/`PARTIAL`/`FAIL`/`NOT RUN`/`NOT VERIFIED`/`PROPOSED — NOT VERIFIED` 标签
- [x] 未把"近似复现"写成"严格复现"
- [x] 未把"部分 manifest 相等"写成"完整 index 相等"
- [x] Option A 仍标注为草案
- [x] 未签署任何审批角色
- [x] 未提交、未推送、未部署
- [ ] **待审批人决定：** 接受 Option A（不可复现但可追溯），或启动可复现构建工程

---

## 14. EA-46 更正记录（2026-10-26）

以下 5 项由 `docs/ea46-image-determinism-investigation.md` 与 `docs/evidence/ea46/` 核实。
正文保留原文不改，以便审计追溯。

| #   | 本报告原文（保留）                                                                 | 更正                                                                                                                                                                                            | 证据                                                               |
| --- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 1   | §12.1 `EA45-4`：buildx v0.38.1 **无** `--rewrite-timestamp`，无法固定 RUN 层 mtime | **该能力存在**，只是形式为 exporter 属性：`--output type=…,rewrite-timestamp=true`，且**必须**配合 `SOURCE_DATE_EPOCH`。实测两次独立 `--no-cache` 构建的 manifest / config / 层 digest 完全一致 | EA-46 §6.5；`docs/evidence/ea46/probe/rewrite-timestamp-probe.txt` |
| 2   | §3.1 层 7 = 架构断言、层 8 = `ENV`                                                 | 层 7 = `WORKDIR /app`（仅创建 `app/` 目录，0 个文件）；层 8 = 32 字节空层（架构断言 `RUN` 未改变文件系统）                                                                                      | EA-46 §2.5；`docs/evidence/ea46/logs/ea45-recheck.txt`             |
| 3   | §6.1 / §12.1 `EA45-5`：`getStorageDirectory` 在 Docker 内返回 `undefined` 导致随机 | BuildKit 内 `is-docker()=false`（`/.dockerenv` 不存在、cgroup 不含 docker），Next **会**写 `.next/cache/.previewinfo`；随机的真实原因是该缓存目录**从不跨构建保留**，而非 Docker 短路           | EA-46 §4.2；`docs/evidence/ea46/context/probe1.log`                |
| 4   | §5 / §6.3 "10 个层不同" 的表述                                                     | 更精确：**600 个内容差异 + 4 个文件增删 + 83,458 个仅 mtime 差异**；mtime 占全部层条目的 83.4%，是层 digest 发散的主因                                                                          | EA-46 §5；`docs/evidence/ea46/comparison/layer-summary.csv`        |
| 5   | §2.3 "EA-42 的相等是缓存假象"（推断）                                              | 升级为**证明**：EA-42 exp1/exp2 的 18 层完全相同，而层 6 含毫秒时间戳文件名的 npm 日志，独立构建不可能同名                                                                                      | EA-46 §2.4；`docs/evidence/ea46/comparison/ea42-layer-pairs.txt`   |

**未更正的结论：** EA-16 严格复现不可能、四次构建 18 层中 10 层不同、index digest 不可复现、
`EA45-1`（`.playwright-mcp` 进入构建上下文）、`EA45-3`（无 SBOM）—— EA-46 全部复核后仍然成立。

**Document Status:** `PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`
**Next:** 由 Technical Approver 与 Release Engineer 依据 §6.3 的内容级结论与 §12.3 的未验证项，决定是否接受 Option A 或启动可复现构建工程。
