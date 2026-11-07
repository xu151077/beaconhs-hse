# EA-46：镜像非确定性根因整改与供应链安全验证

**状态：** `PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`
**日期：** 2026-10-26
**分支 / HEAD：** `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`
**基线：** `docs/ea45-candidate-reproducibility-report.md` + `docs/evidence/ea45/`
**新增证据：** `docs/evidence/ea46/`
**执行边界：** 未访问生产 / 未改动 ceshi / 未覆盖既有镜像 / 未修改业务代码、schema、权限、Role Scope、RLS / 未提交、未推送、未部署。

> **EA-47 复核更新（2026-10-26）：** 本报告 §7.2「registry 侧签名 `NOT VERIFIED`」与 §7.1「无 SBOM」
> 已在**隔离的本地 registry**（`127.0.0.1:5055`，非生产/非 ceshi/非 GHCR）上补做实测：
> SBOM 生成与校验、cosign 签名与验签、SBOM attestation、三类篡改测试、按 digest 拉取全部通过。
> 详见 `docs/ea47-supply-chain-closure-report.md`。**本报告正文与判定不变**；仅 §7.1、§7.2、§7.3、§8 追加
> 「EA-47 更新」注记，并在 §8.4 记录两处表述更正。GHCR / 真实 CI 侧仍未验证。

---

## 0. 结论速览

| #   | 任务                                  | 结论                                                                                                                                                            | 等级                                                                            | 证据                                                                                          |
| --- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 1   | EA-45 原始证据复核                    | 26/26 SHA-256 通过；四次构建身份与台账逐项一致；层差异集合复算一致                                                                                              | ✅ `PASS`                                                                       | `logs/ea45-recheck.txt`                                                                       |
| 2   | EA-42「两次构建层完全相等」的真实原因 | 两次构建 **0 层不同** ⇒ 必然复用缓存。层 6 含毫秒级时间戳文件名的 npm 日志，两次独立构建不可能同名                                                              | ✅ `PASS`（新证据）                                                             | `comparison/ea42-layer-pairs.txt`                                                             |
| 3   | `.playwright-mcp/` 是否进入构建上下文 | **进入**：464 个文件 / 3,423,084 B 进入上下文；`**/*.log` 已排除其中 73 个                                                                                      | ✅ `PASS`                                                                       | `context/probe1.log`、`context/context-bytes.txt`                                             |
| 4   | 是否进入最终镜像                      | **不进入**：18 层逐层扫描 0 命中；最终阶段只 `COPY` 7 个路径                                                                                                    | ✅ `PASS`                                                                       | `comparison/final-image-scan.txt`                                                             |
| 5   | 最小 `.dockerignore` 修复             | 沿用真实规则 + 一行 `.playwright-mcp`：上下文 3,416 → 2,952 文件（−464），其余规则不变                                                                          | ✅ `PASS`（隔离）                                                               | `context/probe2.log`                                                                          |
| 6   | preview 密钥来源                      | `next/dist/build/preview-key-utils.js:43-49`，`crypto.randomBytes(16/32/32)`；仅当 `.next/cache/.previewinfo` 存在且未过期（14 天）才复用                       | ✅ `PASS`                                                                       | `preview/preview-key-mechanism.txt`                                                           |
| 7   | 容器构建内是否复用                    | BuildKit 中 `is-docker()=false`（`/.dockerenv` 不存在、cgroup 无 docker）→ Next **会**写 `.previewinfo`，但 `.next` 从不跨构建保留 → 每次重新随机               | ✅ `PASS`                                                                       | `context/probe1.log`                                                                          |
| 8   | 是否存在官方确定性配置                | 无。无 env / `next.config` 覆盖；唯一"复用"途径是预置 `.previewinfo`，等于写入固定密钥，被本阶段安全边界禁止                                                    | ✅ `PASS`（否定）                                                               | `preview/preview-key-mechanism.txt`                                                           |
| 9   | 影响面                                | 3 个密钥只出现在 `.next/prerender-manifest.json`（1 个文件，3,889 B）；0 个编译 chunk；应用源码不使用 `draftMode`                                               | ✅ `PASS`                                                                       | `preview/preview-key-blast-radius.txt`                                                        |
| 10  | 逐层根因                              | 600 个内容差异 + 4 个文件增删 + 83,458 个仅 mtime 差异，归入 9 类（§5）                                                                                         | ✅ `PASS`                                                                       | `comparison/layer-diff-by-class.csv`                                                          |
| 11  | 时间戳重写能力                        | **支持**：`--output type=…,rewrite-timestamp=true` + `SOURCE_DATE_EPOCH`。EA-45 的"工具链不支持"结论已更正                                                      | ✅ `PASS`                                                                       | `probe/rewrite-timestamp-probe.txt`                                                           |
| 12  | 整改候选实验（D 组）                  | **17/18 层逐字节相同**；唯一残留是层 11 的 `prerender-manifest.json`（3 个 preview 密钥）；config 差异仅 `rootfs.diff_ids[10]`，`history` 与 `created` 完全相同 | ⚠️ `PARTIAL — APPLICATION CONTENT REPRODUCIBLE; IMAGE CONTENT NOT REPRODUCIBLE` | `logs/build-ledger.txt`、`comparison/d1-vs-d2-matrix.txt`、`comparison/d1-vs-d2-residual.txt` |
| 13  | SBOM                                  | **NOT PRESENT**：无 SBOM attestation layer，CI 未启用 `sbom:`                                                                                                   | ❌ `FAIL`                                                                       | §7.1                                                                                          |
| 14  | 镜像签名                              | CI 无签名步骤；registry 侧验证无凭据                                                                                                                            | `NOT VERIFIED`                                                                  | §7.2                                                                                          |
| 15  | provenance                            | 存在（SLSA v1），`subject` = 平台 manifest digest；`buildkit_completeness=false`；记录 vcs revision                                                             | ⚠️ `PARTIAL`                                                                    | §7.3                                                                                          |
| 16  | 部署身份                              | 部署固定 index digest；但 index 内含 attestation manifest，其 provenance 每次不同 → index 不可复现                                                              | ❌ `FAIL`                                                                       | §8                                                                                            |

**一句话结论：** 本次把"镜像为什么每次不同"从"8 层内容不同"细化为 **"600 个内容差异 + 83,458 个仅时间戳差异"**，并证明其中 **83,458 个纯时间戳差异可以用官方支持的 `rewrite-timestamp=true` 消除**（EA-45 认为不可能，属误判）。在隔离副本上应用"同层清理 + 时间戳重写"后，两次独立冷构建的 **18 层中有 17 层逐字节相同**（EA-45 为 8/18），config 的 `history`/`created` 完全一致，**唯一残留差异是 1 个文件里的 3 个 Next.js preview 随机密钥**。整块镜像仍不能 bit-for-bit，剩余阻断项收敛为 **该 preview 密钥** 与 **attestation manifest 的 provenance 随机性**。

---

## 1. 执行前工作区状态

| 项目       | 值                                                                   |
| ---------- | -------------------------------------------------------------------- |
| 分支       | `hse-platform`                                                       |
| HEAD       | `51a899b7aac0a942da327222a3eed355fca9798a`                           |
| 已跟踪修改 | 165 个                                                               |
| 未跟踪条目 | 500 个（`docs/evidence/` 整体未跟踪，docs 历史报告均未提交）         |
| 暂存区     | 空                                                                   |
| 工具链     | Docker 29.9.2 / Buildx v0.38.1 / BuildKit v0.34.0 / containerd store |
| Node/pnpm  | Node 24 LTS / pnpm 10.30.3                                           |

**结论：✅ `PASS`（与 EA-45 记录一致，无新增未提交改动）**

---

## 2. EA-45 原始证据复核

### 2.1 哈希完整性

```
cd docs/evidence/ea45 && sha256sum -c SHA256SUMS
```

- 覆盖 26 个文件，**26/26 `OK`，退出码 0**（目录共 27 个文件，`SHA256SUMS` 自身不在清单内，与 EA-44 的计数约定一致）。
- 原始证据未做任何修改以使校验通过。

**等级：✅ `PASS`**（`docs/evidence/ea46/logs/ea45-recheck.txt`）

### 2.2 身份重算（不复用 EA-45 的结论）

从 `builds/*-index.json` → `*-manifest.json` → `*-config.json` 重新推导：

| 构建  | index                                                                     | manifest                                                                  | config                                                                    | 层数 | 层字节      |
| ----- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ---- | ----------- |
| A1    | `sha256:9b2156ac1374bc1bfa8067add516c0bd2892cc61bef2b9774b7168b0ab944429` | `sha256:be54cfce2a457f7ce23a5a8345d92ddb22987d2be1d6abac7bf4e36a42d63561` | `sha256:e35ca534950661f64f52add74e2b0d9bf6a84dda22c3e5ded31815d5c7709ab9` | 18   | 578,133,721 |
| A2    | `sha256:d76edbad423943f8db9c586598875bc6c33f4a9c25a95a18f8e46e7d41c5dd97` | `sha256:8d9813e42ccd14ca6a80c3b7e7c0ab8c30008dd53e5d1130b0bb9c8447c6ceb7` | `sha256:ebb3c4284982f6b4551cb04d225b9bd270a04d3a71993b1920b1b10181dd123e` | 18   | 578,143,907 |
| B1    | `sha256:ad6266ce1de655a8be1911788163ded2e13d204bf898d809ae3bd8fb80bdf3ec` | `sha256:9142bb14174d56d0952e4d8d7f6306ebe3f6fca33999eb55c4fb5e885ccc0c13` | `sha256:1aba672a98f6bc7d856286fdfb512d1f4446379b95156655ae2f28215379d914` | 18   | 578,134,447 |
| B2    | `sha256:80ac7a1a09b5fbdcac5a12ef55941d6c75625b419d4043b9c658cf68a3c686da` | `sha256:20fa0a576a308c8e5142e77385babdc98d5c280116bd42096f3cef9e2e13fcd6` | `sha256:1b91b679cc06df5702cdd2a1b56f7a78a8a1bef2b3936ac49c179daf0e575843` | 18   | 578,138,109 |
| EA-16 | `sha256:17126c6e22d20325e36a9bdc93281048c84434c12ae4c68927111bd0a30ad2c5` | `sha256:43a7dc279182d71fc82a5dfa2d5408868cf029d73541f27e60630186ab59a943` | `sha256:7e6139af7ac5032e9504fb2f979bb8b537b5302c3871c793e394febdf22d98f3` | 18   | 578,043,276 |

全部与 `logs/build-ledger.txt` 记录逐位一致。

**等级：✅ `PASS`**

### 2.3 层差异矩阵复算

用 `manifests[*].layers[*].digest` 重新配对（1 基层号）：

```
a1      vs a2     : differing=10 set=[6, 7, 9, 10, 11, 12, 13, 14, 15, 16]
ea16    vs a1     : differing=10 set=[6, 7, 9, 10, 11, 12, 13, 14, 15, 16]
ea42e1  vs a1     : differing=10 set=[6, 7, 9, 10, 11, 12, 13, 14, 15, 16]
b1      vs ea42e1 : differing=10 set=[6, 7, 9, 10, 11, 12, 13, 14, 15, 16]
b1      vs b2     : differing=10 set=[6, 7, 9, 10, 11, 12, 13, 14, 15, 16]
a1      vs b1     : differing=10 set=[6, 7, 9, 10, 11, 12, 13, 14, 15, 16]
ea42e1  vs ea42e2 : differing= 0 set=[]
```

**等级：✅ `PASS`**（`comparison/ea42-layer-pairs.txt`）

### 2.4 新增决定性证据：EA-42 的"层完全相等"是缓存复用

`ea42e1 ↔ ea42e2` 的 18 层 digest **完全相同**。但这不可能是两次真正独立的构建：

- 层 6 内存在 `root/.npm/_logs/<ISO-8601-毫秒>-debug-0.log`，文件名内嵌构建时刻：
  - A1：`2026-10-26T00_53_19_699Z-debug-0.log`
  - B1：`2026-10-26T01_05_13_597Z-debug-0.log`
- 两次独立构建若内容逐字节相同，日志文件名也必须相同 —— 即两次构建必须落在**同一毫秒**。概率为零。
- 因此 EA-42 的 exp1/exp2 之间必然存在 **BuildKit 缓存复用**（第二次并非真正 `--no-cache`，或复用了同一份构建缓存记录）。

这把 EA-45 的"EA-42 结论是缓存假象"从**推断**升级为**证明**。

**等级：✅ `PASS`（新证据）**

### 2.5 本次必须更正的 EA-45 结论

| EA-45 原文                                                                     | 更正                                                                                                                                                                                                                                       | 影响                     |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ |
| "buildx v0.38.1 **无** `--rewrite-timestamp`，无法在工具链内固定 RUN 层 mtime" | **错误**。该能力是 **exporter 属性**而非 CLI flag：`--output type=image,rewrite-timestamp=true`（配合 `SOURCE_DATE_EPOCH`）。实测两次独立构建的 manifest/config/层 digest 完全一致（§6.5）；完整镜像上再次验证：17/18 层逐字节相同（§6.6） | 结论从"不可行"改为"可行" |
| §3.1 层 7 = 架构断言、层 8 = `ENV`                                             | **错误**。按 config history 交叉核实：层 7 = `WORKDIR /app`（仅 `app/` 目录），层 8 = 32 字节空层（架构断言 `RUN` 未改变文件系统）                                                                                                         | 仅文档准确性             |
| "`getStorageDirectory` 在 Docker 内返回 `undefined`，因此每次随机"             | **机制不成立**。BuildKit 内 `/.dockerenv` 不存在、cgroup 不含 `docker` → `is-docker()=false` → Next **会**写 `.next/cache/.previewinfo`；随机的真实原因是该缓存目录从不跨构建保留（§4）                                                    | 根因表述更精确           |

**结论不变：** EA-16 严格复现不可能（无构建日志、脏工作区、`turbo.json` 漂移），A1/A2/B1/B2 只是当前树的近似重建，不能称为 EA-16 复现。

---

## 3. `.playwright-mcp/` 构建上下文调查

### 3.1 `.dockerignore` 审计

现有规则覆盖：`.git`、`.github`、`**/node_modules`、`**/.next`、`**/.turbo`、`**/dist`、`.env*`、`**/*.log`、`packages/etl`、`private`、`.local`、`.docker/`、`coverage`、`playwright-report`、`test-results`。

**缺少** `.playwright-mcp`（它也不在 `.gitignore` 内）。

Dockerfile 只有两处会碰到上下文：

- `Dockerfile:33` → `COPY . .`（**builder 阶段，全量复制**）
- `Dockerfile:103-111` → 最终阶段仅复制 7 个明确路径

因此"是否进入 builder 层"取决于 `.dockerignore`，"是否进入最终镜像"取决于最终阶段的 COPY 清单。

### 3.2 探针实验（真实规则）

用 `--mount=type=bind,target=/ctx,source=.` 直接观察 BuildKit 过滤后的上下文，不产生任何镜像层、不写入仓库：

```
docker buildx build --output type=cacheonly --progress=plain \
  -f /tmp/opencode/ea46/probe/Dockerfile.probe1 .
```

结果（`context/probe1.log`）：

```
P1_PLAYWRIGHT_MCP=PRESENT
P1_PLAYWRIGHT_FILES=464
P1_PLAYWRIGHT_BYTES=0
P1_PLAYWRIGHT_YML=459
P1_PLAYWRIGHT_LOG=0
P1_CTX_FILES=3416
P1_DOCKERENV=no
P1_CGROUP=not-docker
P1_NODE_MODULES=0
P1_GIT=absent
```

解读：

- `.playwright-mcp/` **确实进入构建上下文**；
- 磁盘上共 537 个文件，其中 73 个 `.log` 被 `**/*.log` 排除 → 进入上下文的是 **464 个文件 / 3,423,084 B**（459 `.yml` + 3 `.png` + 2 `.docx`）；
  该字节数由宿主机测得，见 `context/context-bytes.txt`；
- 探针里 `P1_PLAYWRIGHT_BYTES=0` 是 BusyBox `find` 不支持 GNU `-printf` 造成的**测量失真**，不是"0 字节"，
  同一行的文件数（不依赖 `-printf`）仍然有效，并与 `P1_CTX_FILES` / probe 2 交叉一致；
- `.git`、`node_modules` 确认被排除（规则确实生效，不是"猜测没被忽略"）；
- **`/.dockerenv` 不存在、`/proc/self/cgroup` 不含 `docker`** → 容器构建内 `is-docker()` 返回 `false`。

### 3.3 是否进入最终镜像

对 b1 的 18 个层逐个解包并按路径搜索（`comparison/final-image-scan.txt`）：

- `.playwright-mcp` 路径命中 **0**；
- 仅有的 "playwright" 命中全部是 `node_modules/.pnpm/next@…/@playwright+test`（Next.js 的 peer 依赖目录名），属正常依赖。

**最终镜像不含 Playwright 产物 —— 但 builder 阶段的 `COPY . .` 层与 BuildKit 构建缓存仍会持有它。**

### 3.4 内容敏感性

| 检查项                                         | 结果                                                                              |
| ---------------------------------------------- | --------------------------------------------------------------------------------- |
| 含邮箱样字符串的 `.yml`                        | 42（域名：`@beaconhs.test`、`@beaconhs.local`、`@company.com`、`@example.local`） |
| 含 `bearer ` 的 `.yml`（进入上下文的文件）     | 8                                                                                 |
| 含 `password` 的 `.yml`（多为登录页字段标签）  | 32                                                                                |
| 含 `Authorization:` / `access_token` 的 `.log` | 1（`.log` 被 `.dockerignore` 排除，**不进入**上下文）                             |

这些是**本地测试环境**的页面快照与令牌，不是生产秘密；但页面快照属应用内数据，出现在共享 CI runner 的 BuildKit 缓存与 builder 层中，属**不应存在的暴露面**。

### 3.5 最小修复（隔离验证）

只把真实 `.dockerignore` 复制一份并追加一行（不修改仓库文件），通过 `<Dockerfile>.dockerignore` 命名让 BuildKit 使用它：

```
docker buildx build --output type=cacheonly --progress=plain \
  -f /tmp/opencode/ea46/probe/Dockerfile.probe2 .
```

结果（`context/probe2.log`）：

```
P2_PLAYWRIGHT_MCP=ABSENT
P2_PLAYWRIGHT_FILES=0
P2_CTX_FILES=2952
```

3,416 − 2,952 = **464**，与探针 1 统计完全吻合 → 该一行即可精确移除，不误伤其他文件。

**风险评估结论：**

| 问题               | 结论                                                                    |
| ------------------ | ----------------------------------------------------------------------- |
| 是否进入构建上下文 | **是**（464 文件 / 3.42 MB）                                            |
| 是否被构建阶段复制 | **是**（`COPY . .` → builder 层 `/app/.playwright-mcp`）                |
| 是否进入最终镜像   | **否**（最终阶段 COPY 清单不含）                                        |
| 是否含敏感信息     | 测试环境页面快照、8 个含 bearer 令牌的 YAML；无生产秘密                 |
| 最小修复           | 在 `.dockerignore` 追加一行 `.playwright-mcp`（隔离实验已证明精确生效） |
| 等级               | **风险存在但有限：✅ `PASS`（已定性 + 已验证修复）**                    |

---

## 4. Next.js 随机 preview 密钥

### 4.1 版本与生成位置

- 版本：`next@16.3.5`（`apps/web/package.json`）。
- 生成器：`node_modules/next/dist/build/preview-key-utils.js`

```js
const CONFIG_FILE = '.previewinfo';
const EXPIRATION = 1000 * 60 * 60 * 24 * 14; // 14 days
async function generatePreviewKeys({ distDir, isBuild }) { … }
```

- 生成（`preview-key-utils.js:43-49`）：

  | 键                         | 来源                     |
  | -------------------------- | ------------------------ |
  | `previewModeId`            | `crypto.randomBytes(16)` |
  | `previewModeSigningKey`    | `crypto.randomBytes(32)` |
  | `previewModeEncryptionKey` | `crypto.randomBytes(32)` |

- 复用条件：`getStorageDirectory(distDir)` 返回可写目录 **且** 该目录下存在未过期的 `.previewinfo`。
- 调用点：`next/dist/build/index.js:736`。

### 4.2 容器内为什么仍是随机

`next/dist/server/cache-dir.js`：

```js
function getStorageDirectory(distDir) {
  const isLikelyEphemeral = isDocker()
  if (isLikelyEphemeral) return undefined
  return path.join(distDir, 'cache')
}
```

`is-docker` 判定 = `/.dockerenv` 存在 **或** `/proc/self/cgroup` 含 `docker`。

探针实测（§3.2）：BuildKit 的 `RUN` 里两者都**不成立** → `is-docker()=false` → `getStorageDirectory` 返回 `apps/web/.next/cache` → Next **确实**写入 `.previewinfo`。

但：

1. `.next` 被 `.dockerignore` 排除，从不进入构建上下文；
2. 每次构建的 builder 阶段从空目录开始；
3. 因此 `.previewinfo` 永远只存在于"本次构建内部"，下一次构建看不到 → 每次重新随机。

（即使 `isDocker()` 为 `true`，结论相同：没有持久存储就直接生成新密钥。）

### 4.3 四次构建的实际差异字段

| 文件                                     | 差异内容                                                                                | 大小    |
| ---------------------------------------- | --------------------------------------------------------------------------------------- | ------- |
| `apps/web/.next/prerender-manifest.json` | `preview.previewModeId` / `previewModeSigningKey` / `previewModeEncryptionKey` 三个字段 | 3,889 B |

A1 中 `prerender-manifest.json` 的 sha256 前缀为 `7373d65595ab0dba`，B1 为 `3cb3bdc5d7ad6e67`；文件大小、结构、其余字段完全一致。

### 4.4 影响面

| 问题                        | 结论                                                                              |
| --------------------------- | --------------------------------------------------------------------------------- |
| 是否只影响构建元数据        | 是。3 个值只出现在 `prerender-manifest.json` 这 1 个文件里                        |
| 是否出现在编译产物（chunk） | **否**：在最终镜像的 11,490 个 standalone 条目中检索，命中数为 0                  |
| 是否影响运行时行为          | 应用源码 **未使用** `draftMode` / `enableDraftMode`，预览模式在本应用里不会被启用 |
| 是否影响缓存与安全边界      | 仅当启用 Draft/Preview 模式时用于 cookie 签名与加密；本应用未启用                 |
| 是否影响最终 digest         | **是**：内容变化直接改变层 11 → manifest → index                                  |

### 4.5 官方确定性方案评估

| 方案                                         | 是否官方支持       | 是否可用                                                                        |
| -------------------------------------------- | ------------------ | ------------------------------------------------------------------------------- |
| env / `next.config` 指定密钥                 | 无此配置           | ❌ 不存在                                                                       |
| 预置 `.next/cache/.previewinfo` 复用         | 是（内部缓存机制） | ⚠️ 需要把固定密钥写入构建输入 —— 被本阶段安全边界禁止（"不得自行编造固定密钥"） |
| 构建后删除 `preview` 字段                    | 否                 | ❌ 非受支持行为，未测试                                                         |
| 关闭 provenance/attestation 换取 digest 一致 | 否                 | ❌ 明令禁止                                                                     |

**结论：** preview 密钥属于**结构性不可确定性**。正确处置是 **把它记录为已知非确定性因素，并将 `prerender-manifest.json` 视为"不适合跨构建逐字节比较"的产物**，而不是硬编码密钥。

**等级：✅ `PASS`（来源、机制、影响面均已核实；确定性方案为否定结论）**

---

## 5. 各层非确定性根因表

方法：对 A1 / B1 的 18 个层逐文件计算 `(size, sha256, mode, mtime)`，再做集合比对（脚本与原始输出见 `/tmp/opencode/ea46/scan_layers.py`、`diff_layers.py`；汇总见 `comparison/layer-summary.csv`）。

### 5.1 逐层总览

| 层             | A1 → B1 digest            | 条目数 | 内容差异 | 增/删 | 仅权限 | 仅 mtime |
| -------------- | ------------------------- | ------ | -------- | ----- | ------ | -------- |
| 6              | `26509c94…` → `cefe764b…` | 1,972  | 540      | 1 / 1 | 0      | 339      |
| 7              | `baf5e183…` → `487131af…` | 1      | 0        | 0     | 0      | 1        |
| 9              | `44a27e9e…` → `591933fa…` | 6,666  | 10       | 0     | 0      | 1,194    |
| 10             | `02f07589…` → `4da2d431…` | 828    | 43       | 1 / 1 | 0      | 495      |
| 11             | `13022214…` → `72f5111a…` | 11,490 | 1        | 0     | 0      | 11,489   |
| 12             | `858b16fc…` → `0e1f2063…` | 419    | 0        | 0     | 0      | 419      |
| 13             | `b7891df9…` → `89be50be…` | 10     | 0        | 0     | 0      | 3        |
| 14             | `ffac5387…` → `a29952f1…` | 45,085 | 2        | 0     | 0      | 44,480   |
| 15             | `7cd6be58…` → `8e84da99…` | 19,885 | 2        | 0     | 0      | 19,447   |
| 16             | `ac4fc68c…` → `97cf7d13…` | 6,430  | 2        | 0     | 0      | 6,100    |
| 1–5, 8, 17, 18 | 完全相同                  | —      | 0        | 0     | 0      | 0        |

**总计：600 个内容差异 + 4 个文件增删 + 83,458 个"内容相同、仅 mtime 不同"的条目。**
83,458 占全部 100,066 个层条目的 **83.4%** —— 层 digest 发散的主因是**时间戳**，不是内容。

D 组实验直接验证了这一点：启用 `rewrite-timestamp=true` 后，这 83,458 个 mtime 差异全部归零
（层 11 的 mtime 差异 = 0，见 `comparison/d1-vs-d2-residual.txt`），层差异由 10 层降到 **1 层**。

> 注：`mtime` 只影响 tar 条目头部，不改变文件内容；因此"仅 mtime 不同"的层在运行时完全等价，
> 却会带来完全不同的 layer digest —— 这正是"内容可复现但镜像不可复现"的技术根源。

### 5.2 逐类根因表

| 类                                                            | 层                         | 内容差异 | 增/删 | 仅 mtime | 字节      | 差异类型         | 运行时影响                             | digest 影响 | 官方确定性方案                                                          |
| ------------------------------------------------------------- | -------------------------- | -------- | ----- | -------- | --------- | ---------------- | -------------------------------------- | ----------- | ----------------------------------------------------------------------- |
| V8 编译缓存 `/tmp/node-compile-cache/v24.18.0-x64-…/*`        | 6, 10                      | 548      | 0     | 4        | 1,456,704 | 内容 + 元数据    | 无（缺失即重建，仅首次编译变慢）       | 是          | `NODE_DISABLE_COMPILE_CACHE=1`，或同层 `rm -rf /tmp/node-compile-cache` |
| npm 缓存索引 `/root/.npm/_cacache/index-v5/**`                | 6, 10                      | 35       | 0     | 181      | 26,313    | 内容 + 元数据    | 无（仅 npm 安装期使用）                | 是          | 同层 `rm -rf /root/.npm`                                                |
| npm 调试日志 `/root/.npm/_logs/<毫秒时间戳>-debug-0.log`      | 6, 10                      | —        | 4     | 2        | 18,177    | **文件名**       | 无                                     | 是          | 随 `/root/.npm` 一并删除                                                |
| fontconfig 缓存 `/var/cache/fontconfig/**`                    | 9                          | 5        | 0     | 2        | 29,400    | 内容             | 无（首次字体渲染时重建）               | 是          | `rm -rf /var/cache/fontconfig/*`（保留目录）                            |
| ldconfig 辅助缓存 `/var/cache/ldconfig/aux-cache`             | 9                          | 1        | 0     | 1        | 21,931    | 内容             | 无（仅 `ldconfig -p` 优化）            | 是          | 同层删除                                                                |
| apt / dpkg 日志 `/var/log/{apt/*,dpkg.log,alternatives.log}`  | 9                          | 4        | 0     | 2        | 264,389   | 内容             | 无                                     | 是          | 同层删除                                                                |
| `.modules.yaml`（worker / ops-bootstrap-admin / ops-migrate） | 14, 15, 16                 | 3        | 0     | 0        | 77,265    | 内容（键顺序）   | 无（仅 pnpm CLI 读取；运行时不再安装） | 是          | 同层删除，或对文件做键排序重写                                          |
| `turbo-build.log`                                             | 14, 15, 16                 | 3        | 0     | 0        | 738       | 内容（耗时毫秒） | 无                                     | 是          | 构建后删除                                                              |
| `prerender-manifest.json`                                     | 11                         | 1        | 0     | 0        | 3,889     | 内容（随机密钥） | 无（应用未启用 draft mode）            | 是          | **无官方方案**（§4.5）                                                  |
| 其余全部条目的 mtime                                          | 6,7,9,10,11,12,13,14,15,16 | 0        | 0     | 83,458   | —         | **元数据**       | 无                                     | 是          | `rewrite-timestamp=true` + `SOURCE_DATE_EPOCH`                          |

> 注：不采用"直接删除所有缓存"的粗暴做法。上表每一类的删除都限定在**该层内、该命令执行后**，并且已确认对应路径不参与运行时功能（V8 缓存、npm 缓存、apt 日志、ldconfig 辅助缓存、pnpm 元数据、turbo 日志）。fontconfig 缓存删除后由库在首次渲染时重建，属标准基础镜像瘦身做法。

---

## 6. 独立实验

### 6.1 固定输入

| 输入            | 值                                                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 源码            | HEAD `51a899b7…`，工作区 165 modified（未提交，与 EA-45 相同）                                                                        |
| 基础镜像        | `node:24.18.0-bookworm-slim@sha256:cb4e8f7c443347358b7875e717c29e27bf9befc8f5a26cf18af3c3dec80e58c5`                                  |
| Dockerfile 前端 | `docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e`                                       |
| 依赖锁          | `pnpm-lock.yaml`（未改动）                                                                                                            |
| 平台            | `linux/amd64`                                                                                                                         |
| 构建参数        | `DEPLOYMENT_VERSION=<HEAD>`、`NEXT_PUBLIC_SENTRY_DSN=`、`NEXT_SERVER_ACTIONS_KEY_FINGERPRINT=<PRF>`、secret `next_server_actions_key` |
| 缓存            | 每次 `--no-cache`，仅 `#3`/`#6` 两步为元数据/基础镜像解析                                                                             |

EA-16 构建日志从未保存，本节所有构建均为**当前树的近似重建**，不构成 EA-16 复现。

### 6.2 A 组 —— 基线（沿用 EA-45 A1/A2，2 次冷构建）

| 构建 | index       | manifest    | 结果          |
| ---- | ----------- | ----------- | ------------- |
| A1   | `9b2156ac…` | `be54cfce…` | exit 0，323 s |
| A2   | `d76edbad…` | `8d9813e4…` | exit 0，327 s |

`--no-cache` 真实生效（`logs/cached-steps.txt`：每次仅 2 步 `CACHED`）。

**等级：✅ `PASS`（基线可复现性为零：18 层中 10 层不同）**

### 6.3 B 组 —— `.dockerignore` 最小变更

见 §3.5。该变更**不改变最终镜像内容**（`.playwright-mcp` 本就不在最终镜像），因此本组验收指标是"上下文精确减少 464 个文件"，已由探针 1/2 在同一上下文上对照验证。

**等级：✅ `PASS`（隔离实验，未修改仓库 `.dockerignore`）**

### 6.4 C 组 —— 固定构建时间（沿用 EA-45 B1/B2，2 次冷构建）

| 构建 | `SOURCE_DATE_EPOCH` | index       | 结果          |
| ---- | ------------------- | ----------- | ------------- |
| B1   | 1729728000          | `ad6266ce…` | exit 0，339 s |
| B2   | 1729728000          | `80ac7a1a…` | exit 0，363 s |

SDE 只固定了 config `created` 与 history 时间戳；层内 mtime 仍是构建墙钟时间（层 7 `app/`：A1 `08:53:26`、B1 `09:05:20`、B2 `09:11:22`），18 层中仍有 10 层不同。

**等级：⚠️ `PARTIAL`（SDE 单独不足）**

### 6.5 时间戳重写能力验证（本次新发现）

Buildx 0.38.1 的 `--help` 里确实没有 `--rewrite-timestamp`，但它是 **exporter 属性**：

```
SOURCE_DATE_EPOCH=1729728000 docker buildx build --no-cache \
  --output type=oci,dest=…,rewrite-timestamp=true …
```

探针（`probe/rewrite-timestamp-probe.txt`）：

| 构建     | manifest            | config              | 层                  | `created`              | 层内 mtime         |
| -------- | ------------------- | ------------------- | ------------------- | ---------------------- | ------------------ |
| rw+sde-1 | `3d1e105129e90bdc…` | `f304ce956eacbba5…` | `80eeed45c3f344aa…` | `2024-10-24T00:00:00Z` | `2024-10-24 08:00` |
| rw+sde-2 | `3d1e105129e90bdc…` | `f304ce956eacbba5…` | `80eeed45c3f344aa…` | `2024-10-24T00:00:00Z` | `2024-10-24 08:00` |

**两次独立 `--no-cache` 构建的 manifest / config / 层 digest 完全一致。**

对照：只加 `rewrite-timestamp=true` 而不设 `SOURCE_DATE_EPOCH` **无效**（层 mtime 仍为墙钟，两次层 digest 不同）→ 必须两者同时使用。

**等级：✅ `PASS`（能力已验证；EA-45 的否定结论已更正）**

### 6.6 D 组 —— 整改候选（2 次冷构建）

在**隔离副本**中同时应用 §5.2 的"每类同层清理" + `rewrite-timestamp=true` + `SOURCE_DATE_EPOCH`。
仓库的 `Dockerfile` / `.dockerignore` **未修改**；候选文件的完整 diff 见
`docs/evidence/ea46/builds/Dockerfile.remediation.diff`。

| 构建 | manifest    | config      | 层字节      | 退出码 | 时长  |
| ---- | ----------- | ----------- | ----------- | ------ | ----- |
| D1   | `41a45fae…` | `ddf4c5eb…` | 576,299,009 | 0      | 347 s |
| D2   | `1387b03d…` | `368c111c…` | 576,299,033 | 0      | 356 s |

逐层比对（`comparison/d1-vs-d2-matrix.txt`）：

| 结果                  | 数值                                                              |
| --------------------- | ----------------------------------------------------------------- |
| 逐字节相同的层        | **17 / 18**（1–10、12–18）                                        |
| 唯一不同的层          | 层 11（standalone 运行树）                                        |
| 层 11 条目数          | 11,490 / 11,490                                                   |
| 层 11 增删 / 权限差异 | 0 / 0                                                             |
| 层 11 **mtime 差异**  | **0**（`rewrite-timestamp` 生效）                                 |
| 层 11 内容差异        | **1 个文件**：`apps/web/.next/prerender-manifest.json`（3,889 B） |

该文件的 JSON 级差异（`comparison/d1-vs-d2-residual.txt`）：

| path                               | d1（长度 / 值 sha256）   | d2（长度 / 值 sha256）   |
| ---------------------------------- | ------------------------ | ------------------------ |
| `preview.previewModeId`            | 32 / `8486a761dbd80a10…` | 32 / `0184887976916f29…` |
| `preview.previewModeSigningKey`    | 64 / `3a041b46388423ff…` | 64 / `812b5cb9dde3e0d7…` |
| `preview.previewModeEncryptionKey` | 64 / `42bf07a5c23f0bd4…` | 64 / `6a464f0c969ea212…` |

`routes`、`dynamicRoutes`、`notFoundRoutes`、`version` 完全一致（差异路径数 = 3）。

两个 config 的差异同样只有一处：

```
diff <(jq -S . d1-config.json) <(jq -S . d2-config.json)
213c213
< "sha256:247c898f29ee0fbbf4d623274114fb4e590c97d26b3b19cf7623e5c4dd66dfd4"
---
> "sha256:c8312bb722351cec92f817c608cb94b678e31d95295a76797c320d9f507503cc"
```

即 `rootfs.diff_ids[10]`（对应层 11）；`history`、`created` **逐字节相同**。

**量化收益：**

- 层差异：`10/18` → **`1/18`**；
- 层字节：578,133,721 → 576,299,009（**−1,834,712 B，约 −1.75 MB**）；
- 仅 mtime 差异：83,458 → **0**；
- 内容差异：600 → **1**。

**候选整改的具体动作（全部限定在产生该产物的同一条 `RUN` 内）：**

| 位置                     | 动作                                                                                                                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `base` 的 corepack `RUN` | 末尾 `rm -rf /root/.npm /tmp/node-compile-cache`                                                                                                                                                                         |
| `runner` 的 apt `RUN`    | 末尾 `rm -rf /var/log/apt /var/log/dpkg.log /var/log/alternatives.log`、`rm -f /var/cache/ldconfig/aux-cache`、`find /var/cache/fontconfig -mindepth 1 -delete`（保留目录）、`rm -rf /root/.npm /tmp/node-compile-cache` |
| `runner` 的 Chrome `RUN` | 末尾 `rm -rf /root/.npm /tmp/node-compile-cache`                                                                                                                                                                         |
| builder 的 `turbo build` | 末尾 `find . -path "*/.turbo/*.log" -delete`                                                                                                                                                                             |
| 三个 `pnpm deploy`       | 末尾 `rm -f /prod/<app>/node_modules/.modules.yaml`                                                                                                                                                                      |
| 导出                     | `SOURCE_DATE_EPOCH=1729728000` + `--output type=oci,dest=…,rewrite-timestamp=true`                                                                                                                                       |
| 构建上下文               | `.dockerignore` 追加 `.playwright-mcp`（§3.5）                                                                                                                                                                           |

**已知代价（必须在采纳前验证）：**

1. 删除 `/var/cache/fontconfig/*` 后，运行用户 `node` 无法写入该系统目录，字体缓存只能落在进程内/临时目录；
   首次 PDF 渲染可能变慢。删除 `/var/cache/ldconfig/aux-cache` 只影响 `ldconfig -p` 的枚举速度。
2. 删除 V8 编译缓存会拉长首次冷启动（Node 会按需重建）。
3. 删除 `.modules.yaml` 只影响 `pnpm` CLI；运行时不执行 `pnpm`，但若有运维脚本在容器内运行 `pnpm`，需先确认。
4. `rewrite-timestamp` 会把镜像内所有文件 mtime 统一为 `SOURCE_DATE_EPOCH`（2024-10-24），
   任何依赖"文件 mtime 反映构建时间"的外部检查都会失去该信号。

**以上代价均未在仓库中生效 —— 本组仅为隔离实验。**

**等级：⚠️ `PARTIAL — APPLICATION CONTENT REPRODUCIBLE; IMAGE CONTENT NOT REPRODUCIBLE`**

### 6.7 E 组 —— preview manifest 确定化

**`NOT RUN`** —— 原因：Next.js 16.3.5 不提供任何官方确定性配置（§4.5）；唯一可行途径是把固定密钥写入构建输入，被本阶段安全边界明令禁止。记录为已知非确定性因素。

### 6.8 验收判定

| 判定对象                           | 结果                                                                             | 依据                                        |
| ---------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------- |
| 层内容                             | ⚠️ **17/18 逐字节相同**（仅层 11 不同）                                          | `comparison/d1-vs-d2-matrix.txt`            |
| image manifest digest              | ❌ 不同（`41a45fae…` vs `1387b03d…`）                                            | 同上                                        |
| image config                       | ⚠️ 仅 `rootfs.diff_ids[10]` 不同；`history`/`created` 完全相同                   | `builds/d1-config.json` vs `d2-config.json` |
| 应用内容（源码 / 依赖 / 编译产物） | ✅ 可复现（唯一差异是 preview 密钥）                                             | `comparison/d1-vs-d2-residual.txt`          |
| index digest                       | ❌ 不可复现（attestation 的 `invocationId` / 时间戳每次不同）                    | §7.3、§8.2                                  |
| SBOM                               | ❌ 不存在                                                                        | §7.1                                        |
| 镜像签名                           | ❌ CI 无签名                                                                     | §7.2                                        |
| **整体**                           | **`PARTIAL — APPLICATION CONTENT REPRODUCIBLE; IMAGE CONTENT NOT REPRODUCIBLE`** |                                             |

**为什么不能判 `PASS`：** 任务口径要求"两次独立构建的完整目标镜像 digest 一致，且签名、来源证明
和供应链安全要求均得到满足"。本次四项均不满足（层 17/18、manifest 不同、index 不同、无 SBOM/签名）。

**相对 EA-45 的改进：** EA-45 的 `FAIL — LAYERS REPRODUCIBLE` 是 18 层中 10 层不同（8 层相同）；
本次在隔离副本上把差异压缩到 **1 层 / 1 个文件 / 3 个字段**，并把 83,458 个纯 mtime 差异降为 0。

**要达到更高等级还缺什么：**

1. **preview 密钥**（唯一的内容阻断项）。无官方确定性方案；要么接受"该文件不参与逐字节比较"，
   要么另行批准把密钥纳入 secret 管理后预置 `.next/cache/.previewinfo`（本阶段禁止）。
2. **attestation 的随机性**。只要开启 provenance（且不得为 digest 一致而关闭），
   index digest 就不可能复现。因此**可复现身份的正确对象是 image manifest digest，不是 index digest**。
   即使 preview 密钥被消除，index 仍然每次不同。
3. **SBOM 与签名**。与 digest 是否可复现相互独立；缺失即不满足供应链要求。

**结论：** 在当前工具链与安全边界下，**可达到的上限是"manifest digest 可复现 + 层 18/18"**，
而不是"index digest 可复现"。建议把发布验收标准改为
**"manifest digest 可复现 + SBOM 存在 + 签名可验证"**，index digest 仅作为不可变部署引用。

---

## 7. SBOM、签名与 provenance

### 7.1 SBOM

| 检查项                                       | 结果                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------ |
| 镜像 attestation manifest 的 layer           | 仅 1 层，`application/vnd.in-toto+json`（provenance）                          |
| 是否存在 SPDX / CycloneDX SBOM               | **无**                                                                         |
| CI 是否启用 SBOM                             | 否（`.github/workflows/deploy-dev.yml` 的 `build-push-action` 未设置 `sbom:`） |
| 覆盖范围（OS 包 / Node 依赖 / 浏览器二进制） | 不适用 —— 无 SBOM 可覆盖                                                       |

**结论：`NOT PRESENT`（❌ `FAIL` 于供应链要求）。**
建议（未实施）：在 `build-push-action` 增加 `sbom: true`，并对最终镜像执行一次 SBOM 内容校验（OS 包 + Node 依赖 + Chrome/LibreOffice 二进制），不要只以"attestation 存在"代替。

> **EA-47 更新：** "镜像与 CI 均无 SBOM"的结论仍然成立。隔离实验已证明 SBOM 可生成
> （syft 1.55.0，SPDX 2.3 / CycloneDX 1.7）、可结构化校验，并以 `source.id = 平台 manifest digest`
> 与镜像绑定；**组件并不完整**——`chrome-headless-shell 140.0.7339.207` 只出现在文件清单，
> 不是 package/component。见 `docs/ea47-supply-chain-closure-report.md` §3。

### 7.2 签名

| 检查项                        | 结果                                                                    |
| ----------------------------- | ----------------------------------------------------------------------- |
| CI 是否存在签名步骤           | **无**（无 cosign / `actions/attest-build-provenance` / notation）      |
| 签名对象（index vs manifest） | 不适用 —— 未签名                                                        |
| registry 侧签名验证           | `NOT VERIFIED`（本阶段无 registry 凭据，且不得访问生产/ceshi 代替验证） |

**结论：`NOT VERIFIED`（CI 侧确认为"无签名"；registry 侧无法证实）。**

> **EA-47 更新：** CI 侧"无签名步骤"仍然成立（三个 workflow 中 sbom/sigstore/attest/provenance 关键字命中 0）。
> 隔离 registry 上已完成 keyless 之外的临时密钥签名实验：签 manifest → 验签通过；追加空层 → `no signatures found`；
> 把签名 artifact 移植到新 digest → `provided artifact digest does not match any digest in statement`；
> 按 tag 验签失败（tag 解析到未签名的 index）。**GHCR 侧仍 `NOT VERIFIED`。**
> 见 `docs/ea47-supply-chain-closure-report.md` §4。

### 7.3 provenance

| 检查项                  | 结果                                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 是否存在                | 是（`application/vnd.in-toto+json`，`predicateType=https://slsa.dev/provenance/v1`）                                      |
| `subject` 绑定对象      | **平台 manifest digest**（如 A1：`be54cfce…`），不是 index digest                                                         |
| 与镜像的关联            | 同一 OCI index 内附带 attestation manifest（`platform: unknown/unknown`）→ 拉取 index 即可获得                            |
| `buildkit_completeness` | `{request:false, resolvedDependencies:false}` → **不完整**，不能作为 SLSA Build L2/L3 证据                                |
| 记录的可复现输入        | `resolvedDependencies`：dockerfile 前端 digest、基础镜像 digest                                                           |
| 记录的源码版本          | `runDetails.metadata.buildkit_metadata.vcs.revision = 51a899b7…`，`source = https://github.com/xu151077/beaconhs-hse.git` |
| 每次构建是否不同        | **是**：`invocationId`、`startedOn`、`finishedOn` 每次不同 → provenance 层 digest 不同                                    |

**结论：⚠️ `PARTIAL`。** provenance 能把镜像关联到提交与基础镜像，但因 `invocationId`/时间戳不可复现，**attestation manifest 的 digest 每次不同**，进而使整个 index digest 不可复现（§8）。

> **EA-47 更新：** 把 EA-45 候选镜像推送到隔离 registry 后，index 内 attestation descriptor
> （`530bbc28…`）与 provenance blob（`c990513f…`）与 `docs/evidence/ea45/builds/` 中的证据**逐字节相同**，
> `subject.digest` 等于同一 index 内 amd64 manifest digest，`vcs.revision` 为 `51a899b7…`。
> provenance 本身**没有组织签名**，`buildkit_completeness` 仍为 false → 仍不能作为 SLSA L2/L3 证据。

---

## 8. 部署与回滚评估

### 8.1 当前部署身份

- `deploy-dev.yml`：`image_digest: ${{ steps.build-image.outputs.digest }}`（第 39 行）→ **index digest**；
- 部署步骤校验 `^sha256:[0-9a-f]{64}$` 并以 `IMAGE_NAME@${IMAGE_DIGEST}` 固定；
- `docs/PRODUCTION_RUNBOOK.md` §Deployment and rollback：只用 `IMAGE_NAME@sha256:...`，commit tag 永不作为部署身份。

### 8.2 index digest vs manifest digest

| 项目         | index digest                                    | 平台 manifest digest                |
| ------------ | ----------------------------------------------- | ----------------------------------- |
| 内容         | amd64 镜像 manifest + attestation manifest      | 单平台镜像（config + 18 层）        |
| 谁在用       | Docker / containerd / Dokploy 解析入口、CI 部署 | provenance `subject`                |
| 本机可否寻址 | 是                                              | 否（containerd store 只解析 index） |
| 可复现性     | **不可**（含 attestation 的随机 provenance）    | 理论上可（若 18 层一致）            |

### 8.3 结论

1. **部署固定 index digest 是正确做法**（不可变引用），但**不能**用"重建得到同一 digest"来验证发布 —— 即使所有层一致，attestation 的 `invocationId`/时间戳也会改变 index digest。
2. 因此可复现性验收的正确对象是 **平台 manifest digest**，而 index digest 只作为不可变引用。
3. 回滚：按**完整 index digest** 回滚上一次镜像；数据库迁移 forward-only，不构成回滚保障（runbook 已明确）。
4. Server Action Key：跨版本必须保持同一密钥，否则滚动窗口内旧页面提交的 action 无法解密；当前通过 fingerprint build-arg 保证缓存失效正确，但**密钥轮换仍需与发布窗口协调**。
5. 签名/attestation 校验：当前 CI 不签名、部署不校验签名 → 供应链校验链不完整（`NOT VERIFIED`）。

**等级：❌ `FAIL`（策略本身正确，但缺少可复现身份与签名校验）**

### 8.4 EA-47 更正（2026-10-26）

| #   | 本报告原表述                                                                | 实测结果                                                                                                                                                                                                |
| --- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | §8.2「平台 manifest digest：本机不可寻址（containerd store 只解析 index）」 | **需分场景**：本地构建的镜像确实只能用 index digest 寻址；但**从 registry 按 manifest digest 拉取可行**，拉取后 daemon 以该 manifest digest 作为镜像 `Id`。多平台选择此时由 registry 的该 manifest 决定 |
| 2   | 隐含"OCI 导出不含 attestation"（§6.4 D 组 `--output type=oci`）             | **取决于导出方式**：`--output type=oci` 导出的归档只有单 manifest；**`docker save`（containerd store）导出的归档保留完整 index + attestation**。审计取证应优先 `docker save`                            |

**新增实验（EA-47）：** 对同一 amd64 manifest（`be54cfce…`），发布"含 attestation"与"不含 attestation"两份 index，
digest 分别为 `9b2156ac…` 与 `e3e7d6f8…`，而 manifest digest 完全不变（`registry/digest-relationships.txt`）。
这以直接实验证明：**index digest 的不可复现性来自 attestation descriptor，而非镜像内容**。

---

## 9. 文件变更清单

### 9.1 新增

| 文件                                           | 说明                          |
| ---------------------------------------------- | ----------------------------- |
| `docs/ea46-image-determinism-investigation.md` | 本报告                        |
| `docs/evidence/ea46/**`                        | 本次证据包（含 `SHA256SUMS`） |

### 9.2 修改

| 文件                                                 | 变更                                                                                    |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `docs/ea45-candidate-reproducibility-report.md`      | 顶部新增"⚠️ 后续更正（EA-46）"横幅；文末新增 **§14 更正记录**（5 项）；正文原文完整保留 |
| `docs/ea43-image-reproducibility-risk-acceptance.md` | 新增 **§1.2**（事实 20–27）；§6 控制措施 4/8/9 更新并新增 10–12；§10 证据索引加入 EA-46 |
| `docs/release-approval-checklist.md`                 | 新增 **§10.18**（阶段结论、判定、缺陷 EA46-1~5、门禁）                                  |
| `docs/project-development-state.md`                  | 新增 **EA-46 addendum**（EA-46A~J）                                                     |

上述 4 个文件中，`docs/project-development-state.md` 是唯一已跟踪文件（`M`）；
其余 3 个在仓库中本来就是未跟踪状态（`??`，历史遗留），本阶段未改变该状态。

### 9.3 未修改（刻意）

- 仓库 `.dockerignore`、`Dockerfile`、`.github/workflows/*`：整改方案只在 `/tmp/opencode/ea46/` 的隔离副本中验证。
- 业务代码、schema、权限、Role Scope、RLS：未触碰。

---

## 10. 质量门禁

本次改动只涉及文档，但仍按要求跑完整门禁，且全部使用 `--force` 绕过 Turbo 缓存。

| 门禁   | 命令                                               | 退出码 | 耗时  | 执行情况                                                |
| ------ | -------------------------------------------------- | ------ | ----- | ------------------------------------------------------- |
| 格式   | `pnpm format:check`                                | 0      | 27 s  | Prettier 无缓存机制，真实全仓检查                       |
| 类型   | `pnpm exec turbo run typecheck --force`            | 0      | 11 s  | 27/27 任务，**0 缓存**                                  |
| Lint   | `pnpm exec turbo run lint --force`                 | 0      | 43 s  | 1/1 任务，0 缓存                                        |
| 死代码 | `pnpm deadcode:check`                              | 0      | 3 s   | knip 真实执行，无未使用文件 / 导出                      |
| 测试   | `pnpm exec turbo run test --concurrency=1 --force` | 0      | 276 s | 25/25 任务，0 缓存；`@beaconhs/web` 2,118 通过 / 9 跳过 |
| 构建   | `pnpm build --force`                               | 0      | 73 s  | 4/4 任务，0 缓存，Next 构建产物完整                     |

摘要与汇总证据：`docs/evidence/ea46/logs/gates.txt`。

**缓存说明（重要）：** 首次按默认方式运行 `pnpm typecheck / lint / test / build` 时，
Turbo 全部命中 EA-45 留下的缓存（`FULL TURBO`，typecheck 0 s、build 1 s），
那些退出码不能作为"本次执行"的证据，因此上表全部改用 `--force` 重跑。
`format:check` 与 `deadcode:check` 不经 Turbo，本身即真实执行。

**测试环境说明：** 第一次 `--force` 测试在 6 s 内失败，
`@beaconhs/storage` 的 3 个集成测试 `ECONNREFUSED 127.0.0.1:9000` ——
原因是本地 MinIO 未启动，属环境缺失而非代码/断言失败。
用 `docker start beaconhs-postgres beaconhs-redis beaconhs-minio beaconhs-mailpit`
恢复基础设施后完整串行重跑：**25/25 通过**。
期间另有一次重跑被会话终止（Turbo 打印 `Shutting down Turborepo tasks…`），
不是断言失败，最终以 `test-forced3.log` 为准。
本机 7.7 GiB 内存不足以支撑默认并行测试，故使用 `--concurrency=1`（与 CI 串行一致）。

---

## 11. Git 状态

| 项目             | 值                                                                                                       |
| ---------------- | -------------------------------------------------------------------------------------------------------- |
| 分支             | `hse-platform`                                                                                           |
| HEAD             | `51a899b7aac0a942da327222a3eed355fca9798a`                                                               |
| 已跟踪修改       | 165（与 EA-45 相同；仅 `docs/project-development-state.md` 属本阶段改动）                                |
| 未跟踪           | 501（`docs/evidence/` 历史上整体未跟踪；本阶段新增 `docs/ea46-image-determinism-investigation.md` 一项） |
| 暂存区           | 空                                                                                                       |
| 提交 / 推送 / PR | **无**                                                                                                   |

本阶段涉及的 5 个文档中：

```
 M docs/project-development-state.md          (已跟踪)
?? docs/ea43-image-reproducibility-risk-acceptance.md   (历史遗留未跟踪)
?? docs/ea45-candidate-reproducibility-report.md        (历史遗留未跟踪)
?? docs/release-approval-checklist.md                   (历史遗留未跟踪)
?? docs/ea46-image-determinism-investigation.md         (本阶段新增)
?? docs/evidence/ea46/                                  (本阶段新增，位于历史未跟踪的 docs/evidence/ 下)
```

即：**未新增任何已跟踪文件的状态变化，未 `git add`，未提交，未推送。**
仓库的 `Dockerfile`、`.dockerignore`、`.github/workflows/**` 无改动。

---

## 12. 安全边界确认

| 边界                                          | 结果                                                               |
| --------------------------------------------- | ------------------------------------------------------------------ |
| 未访问生产环境 / 数据库 / 对象存储            | ✅                                                                 |
| 未修改 ceshi 容器、镜像、配置、数据           | ✅                                                                 |
| 未覆盖 EA-16 / EA-42 / EA-44 / EA-45 镜像     | ✅ 全部构建使用新 tag 或 `--output type=oci,dest=…`（不落镜像）    |
| 未删除镜像 / 容器 / 卷 / 备份 / 快照          | ✅（`rm` 被策略禁止；仅停止过测试用本地容器后恢复原状态）          |
| 未执行破坏性 Git                              | ✅ 无 `reset --hard` / `clean` / `restore`                         |
| 未 `git add -A`、未提交、未推送、未建 PR      | ✅                                                                 |
| 未修改业务代码 / schema / 权限 / RLS          | ✅                                                                 |
| 未泄露 Server Action Key / DB 密码 / 令牌     | ✅ 证据包内指纹出现次数 0（已脱敏）                                |
| 未重新调查语言设置问题                        | ✅                                                                 |
| WOPI 状态                                     | ✅ 保持 `KNOWN / UNRESOLVED — LOW PRIORITY — INVESTIGATION PAUSED` |
| 未代替审批人签字                              | ✅                                                                 |
| 未关闭签名 / SBOM / provenance 换 digest 一致 | ✅ 明确列为禁止选项                                                |

---

## 13. 未决问题与下一阶段建议

| #   | 问题                                           | 等级             | 建议                                                                                          |
| --- | ---------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------- |
| 1   | preview 密钥不可确定化                         | 已知限制         | 接受"应用内容可复现、镜像字节不可复现"，或另行批准把密钥纳入 secret 管理后预置 `.previewinfo` |
| 2   | index digest 因 attestation 不可复现           | `FAIL`           | 验收对象改为平台 manifest digest；index digest 仅作不可变引用                                 |
| 3   | 无 SBOM                                        | `FAIL`           | CI 开启 `sbom: true` 并校验内容                                                               |
| 4   | 无镜像签名                                     | `NOT VERIFIED`   | 引入 cosign keyless 签名 + 部署前验证；需 registry 权限                                       |
| 5   | registry 侧 attestation / 签名链验证           | `NOT VERIFIED`   | 需 registry 只读凭据                                                                          |
| 6   | 真实 CI 流水线能否得到同样结论                 | `NOT RUN`        | 在 dev 流水线加入"双次构建 + digest 比对"的影子作业（不阻断发布）                             |
| 7   | `buildkit_completeness=false`                  | `PARTIAL`        | 若需 SLSA L2+，需把构建迁移到受控 builder 并保留完整 provenance                               |
| 8   | EA-16 构建日志缺失                             | `FAIL`（不可补） | 记录为永久缺口；后续发布必须以新构建为基线                                                    |
| 9   | 本地 `pnpm test` 默认并行在 7.7 GiB 主机上超时 | 环境问题         | CI 使用串行或更高内存；本机用 `turbo run test --concurrency=1`                                |

**最终发布状态保持：`PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`**

Migration 51 生产预检查、生产数据库备份恢复、生产对象存储备份恢复、完整生产部署与回滚演练、责任人签字、镜像策略决策，仍是独立的发布阻断项。
