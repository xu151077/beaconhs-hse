# EA-51：部署/回滚身份一致性设计与旧镜像恢复可行性评估

**状态：** `PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`
**阶段结论：** 身份契约 `PROPOSED`（0 项已强制）· 回滚策略 `PENDING AUTHORIZATION (A8)` · A1–A8 仍 0 批准
**日期：** 2026-10-27
**分支 / HEAD：** `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`
**基线：** `docs/ea50-approval-and-rollback-readiness-report.md`、`docs/evidence/ea50/`、`docs/evidence/ea49/`、`docs/evidence/ea48/proposal/`、`docs/release-approval-checklist.md`、`docs/ea43-image-reproducibility-risk-acceptance.md`（Rev 5）、`docs/project-development-state.md`
**新增证据：** `docs/evidence/ea51/`（`sha256sum -c SHA256SUMS` 见 §12）
**执行边界：** 未访问生产 / ceshi / GHCR / 生产数据库 / 对象存储；未使用真实 OIDC / Fulcio / Rekor / registry 凭据；未修改 `.github/workflows/*`、`Dockerfile`、`.dockerignore`、业务代码；未执行部署、回滚、迁移、备份恢复或流水线；未提交、未推送、未建 PR；未覆盖或删除任何既有镜像、容器、卷、备份、快照或证据。

---

## 0. 结论速览

| #   | 任务                                     | 结论                                                                                                                                    | 等级                         | 证据                                                      |
| --- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | --------------------------------------------------------- |
| 1   | 执行前工作区状态                         | 分支/HEAD 符合预期；165 `M` / 505 `??` / 暂存区空；EA-50 报告与 14 个证据文件俱在                                                       | ✅ `PASS`                    | `environment/workspace.txt`                               |
| 2   | EA-50 证据复核                           | `sha256sum -c` **13/13 通过**；一致性脚本仍 `CONSISTENT`                                                                                | ✅ `PASS`                    | `environment/ea50-recheck.txt`                            |
| 3   | 部署/回滚身份链追踪                      | 8 个环节中 **4 个不存在**（平台 manifest / config digest / deployment record / rollback record）                                        | ❌ `FAIL`                    | `design/deployment-identity-chain-trace.md`               |
| 4   | 十项必查项                               | 2 `PASS`、2 `PARTIAL`、**6 `FAIL`**                                                                                                     | ❌ `FAIL`                    | 同上 §2                                                   |
| 5   | 身份一致性契约                           | 17 个字段，区分 M/C/O；**绝大多数字段无生产者**                                                                                         | ✅ `PROPOSED`                | `design/deployment-identity-contract.md`                  |
| 6   | 历史镜像证据矩阵                         | 8 个对象，digest **全部从原始字节复算**；EA-13 及更早 `NOT VERIFIED`                                                                    | ✅ `PASS`（复算）            | `rollback/historical-image-evidence-matrix.md`            |
| 7   | **新发现 D1：镜像不自证源码版本**        | EA-16 的 `deploymentId = undefined`，`/app` 内源码 SHA 出现 **0** 次；EA-45 镜像有 295 次                                               | ❌ `FAIL`（本阶段新识别）    | `tests/build-identity-corrobation.txt`                    |
| 8   | **新发现 D2：根因是未提交的 turbo.json** | Turbo 2.10.5 严格过滤任务环境；**HEAD 的 turbo.json 未声明 `DEPLOYMENT_VERSION`**，工作区那份是构建后（11:04 vs 05:31）才改的未提交改动 | ❌ `FAIL`（本阶段新识别）    | `tests/turbo-env-probe.txt`、`design/…-chain-trace.md` §6 |
| 9   | **新发现 D3：就绪检查近乎同义反复**      | `ready/route.ts:145` 读运行时 `APP_VERSION`，而它由部署注入 ⇒ 比较的是编排器告诉容器的 SHA，不是镜像本身的 SHA                          | ⚠️ `PARTIAL`（本阶段新识别） | `design/…-chain-trace.md` §5                              |
| 10  | Server Action Key 兼容性                 | 前向/负向/回滚 K1→K2→K1 均已验证（staging）；**EA-16→当前同 key 未知**；跨 key 轮换回滚未测                                             | ⚠️ `PARTIAL`                 | 证据矩阵 §3                                               |
| 11  | Migration 51 与对象存储依赖              | 应用回滚**不能**撤销 forward-only 迁移；生产预检查与备份恢复均 `NOT RUN`                                                                | ⚠️ `PARTIAL`                 | 证据矩阵 §4                                               |
| 12  | 重建耗时                                 | 从既有 6 次冷构建日志复算：**323–363 s，均值 342 s**；**但"冷构建→可服务"仍 `NOT RUN`**                                                 | ⚠️ `PARTIAL`                 | `tests/rebuild-timing.json`                               |
| 13  | R1–R4 风险比较                           | 四方案全部**当前无强制路径**（回滚代码不存在）；推荐标 `RECOMMENDATION ONLY — NOT APPROVED`                                             | ⚠️ `PROPOSED`                | `rollback/unsigned-image-rollback-risk.md`（Rev 2）       |
| 14  | 测试矩阵 T1–T14                          | 4 `PASS`（仅隔离）、2 `PARTIAL`、**8 `NOT RUN`**                                                                                        | ⚠️ `PARTIAL`                 | `tests/deployment-identity-test-matrix.md`                |
| 15  | 正式 CI / 部署 / 回滚                    | **未实施**（阶段边界禁止）                                                                                                              | `NOT RUN`                    | 本报告 §12                                                |

**一句话结论：** 本阶段把"部署与回滚身份一致"从一句结论拆成了 8 个环节，结果发现**其中 4 个环节根本不存在**——流水线只记录 index digest，从不解析平台 manifest、不记录 config digest、也没有任何部署记录或回滚记录，因此签名/SBOM/provenance 所指向的对象在部署点**无法被确认**。更严重的是本阶段新识别的两处缺陷：**EA-16 候选镜像内部不含自己的源码版本**（`deploymentId=undefined`，`/app` 里源码 SHA 出现 0 次），而根因是 **HEAD 的 `turbo.json` 未声明 `DEPLOYMENT_VERSION`**——工作区里那份声明是 EA-16 构建之后才做的**未提交**改动，所以从已提交代码构建的镜像会重现 EA-16 的行为。这意味着即使把 manifest digest 记录下来，`source_revision` 仍然只是流水线的断言而非产物的属性。回滚方面：**四个方案目前都只是"意图"，因为回滚代码路径根本不存在**——这使 A8 在 DI-7 之前无法被有意义地决定。

---

## 1. 执行前工作区状态

| 项目       | 值                                                            |
| ---------- | ------------------------------------------------------------- |
| 当前目录   | `/home/test/projects/beaconhs-hse`                            |
| 分支       | `hse-platform`                                                |
| HEAD       | `51a899b7aac0a942da327222a3eed355fca9798a`                    |
| 已跟踪修改 | 165 个（`git diff --stat`：6028 insertions / 2053 deletions） |
| 未跟踪条目 | 505 个                                                        |
| 暂存区     | 空                                                            |
| EA-50 报告 | 存在，38,579 B                                                |
| EA-50 证据 | 14 个文件                                                     |

**结论：✅ `PASS`。**

---

## 2. EA-50 证据复核

```
cd docs/evidence/ea50 && sha256sum -c SHA256SUMS → 13/13 OK, exit 0
python3 decisions/check_consistency.py           → CONSISTENT, 0 problems
A1–A8 状态                                        → 0 APPROVED / 8 NOT FOUND（未变化）
```

未发现损坏，未覆盖任何原始证据。
证据：`environment/ea50-recheck.txt`

---

## 3. 当前部署与回滚身份链

完整追踪：`design/deployment-identity-chain-trace.md`。

### 3.1 八环节现状

```
source revision → build invocation → provenance → OCI index
   → platform manifest → image config → deployment record → rollback record
```

| #   | 环节                         | 存在                | 运行时校验                            | 不可变记录                                          |
| --- | ---------------------------- | ------------------- | ------------------------------------- | --------------------------------------------------- |
| L1  | source revision              | 是                  | 部分（就绪检查比较运行时变量，见 §7） | git 提交本身                                        |
| L2  | build invocation             | 部分                | **否**                                | 仅 provenance 内，无人读取                          |
| L3  | provenance                   | 是（BuildKit 默认） | **否**                                | index 内 attestation manifest                       |
| L4  | OCI index digest             | 是                  | 是                                    | 仅 job output，未跨运行留存                         |
| L5  | **platform manifest digest** | **否**              | **否**                                | **无**                                              |
| L6  | **image config digest**      | **否**              | **否**                                | **无**                                              |
| L7  | deployment record            | 部分                | n/a                                   | 仅有 Dokploy compose env（`IMAGE` + `APP_VERSION`） |
| L8  | **rollback record**          | **否**              | **否**                                | **无**                                              |

**L5 是结构性缺口**：签名、SBOM、provenance 的 subject 全是它，而流水线从不推导它。

### 3.2 十项必查项

| #   | 检查                                 | 结论                                                                                              | 位置                                             | 等级      |
| --- | ------------------------------------ | ------------------------------------------------------------------------------------------------- | ------------------------------------------------ | --------- |
| 1   | index digest 如何产生                | `build-push-action` 的 `outputs.digest`（`platforms: linux/amd64` + 默认 provenance ⇒ **index**） | `deploy-dev.yml:82-99,39`                        | `PASS`    |
| 2   | 是否传到部署 job                     | 是（job output → `env.IMAGE_DIGEST`）                                                             | `:38-39,109`                                     | `PASS`    |
| 3   | 部署前是否重新解析 manifest          | **否**，`deploy-dev.yml` 内无任何 manifest 解析                                                   | `:（缺失）`                                      | `FAIL`    |
| 4   | 是否记录平台/manifest/config digest  | **三者皆无**                                                                                      | `:373-374` 只写 `IMAGE`/`APP_VERSION`            | `FAIL`    |
| 5   | 签名 subject 与部署对象一致          | **否**（无签名阶段）                                                                              | —                                                | `FAIL`    |
| 6   | provenance subject/revision 是否校验 | **否**（只产出不读取）                                                                            | `ea48/ci-audit/ci-cd-audit.md` #5                | `FAIL`    |
| 7   | 回滚是否按固定 digest 选镜像         | runbook 如此规定，**但无回滚代码**                                                                | `PRODUCTION_RUNBOOK.md` §Deployment and rollback | `PARTIAL` |
| 8   | 回滚是否重跑签名/来源/身份校验       | **否**（无回滚代码路径）                                                                          | —                                                | `FAIL`    |
| 9   | tag/变量能否绕过 digest 校验         | 无外部输入可达 `IMAGE`/`IMAGE_DIGEST`；**但** Dokploy 侧 `IMAGE=` 可被带外编辑，仓库无约束        | `:27-29,88,262,366,373`                          | `PARTIAL` |
| 10  | 回滚是否记录前后身份链               | **否**（无回滚记录）                                                                              | —                                                | `FAIL`    |

**统计：2 `PASS` · 2 `PARTIAL` · 6 `FAIL`。**

### 3.3 两条部署路径写入的身份

| 路径            | 触发                      | 写入身份                                                     | 位置                   |
| --------------- | ------------------------- | ------------------------------------------------------------ | ---------------------- |
| Dokploy compose | `DOKPLOY_DEPLOY_MODE=api` | `IMAGE=<repo>@<index>` + `APP_VERSION=<sha>`，写入后回读比对 | `:366,373-374,419-427` |
| 直连 Swarm      | 回退                      | `docker service update --image <repo>@<index>`               | `:450-458`             |

两条路径都只把 **index digest + commit SHA** 落到持久位置。

---

## 4. 身份一致性契约

完整契约：`design/deployment-identity-contract.md`。17 个字段，M（必需）/ C（条件必需）/ O（可选），并标注**是否存在生产者**。

| 字段                           | 需求 | 生产者                                                 |
| ------------------------------ | ---- | ------------------------------------------------------ |
| `source_revision`              | M    | 部分——流水线有 `github.sha`，**镜像无法自证**（见 §7） |
| `build_invocation_id`          | C    | **缺**（在 provenance 内，无人读取）                   |
| `oci_index_digest`             | M    | 有                                                     |
| `target_platform`              | M    | **缺**（硬编码，未记录）                               |
| `platform_manifest_digest`     | M    | **缺**                                                 |
| `image_config_digest`          | M    | **缺**                                                 |
| `provenance_subject_digest`    | M    | 部分（在 attestation 内，未校验）                      |
| `provenance_source_revision`   | M    | 部分（同上）                                           |
| `signature_subject_digest`     | C    | **无签名**                                             |
| `signature_identity`           | C    | **无签名**                                             |
| `sbom_subject_digest`          | C    | **无 SBOM**                                            |
| `deployment_timestamp`         | M    | 隐式                                                   |
| `deployment_environment`       | M    | 隐式                                                   |
| `previous_deployment_identity` | C    | **缺**                                                 |
| `rollback_reason`              | C    | **缺**                                                 |
| `rollback_approval_reference`  | C    | **缺**                                                 |

### 4.1 关键规则

1. **只用完整 digest**（`sha256:` + 64 小写十六进制）；短前缀可用于展示，不可用于比较。**EA-48 的 G1 与本阶段脚本首跑都踩过前缀/裸十六进制混比的坑**，因此比较必须规范化。
2. **digest 不得由 tag 推导**。
3. **缺失 ≠ 空**：无生产者记为 `null` 并注明原因，不得用相邻字段替代（"adjacent evidence" 陷阱）。
4. **一个身份集一个对象**：`platform_manifest` / `provenance_subject` / `signature_subject` / `sbom_subject` 必须同值，任意两个不等即失败关闭。
5. **index 是包装，manifest 是内容**：EA-47 实测同一 manifest 下 index 因 attestation descriptor 而从 `9b2156ac…` 变 `e3e7d6f8…`。两者都必须记录，互不替代。

### 4.2 回滚四类

| 类   | 定义                         | 必需校验                            | 路径                 |
| ---- | ---------------------------- | ----------------------------------- | -------------------- |
| RB-A | 已签名且证明链完整           | N1–N9 全部                          | 自动                 |
| RB-B | 未签名历史镜像（如 EA-16）   | N1–N2、N4–N5；**N3/N6/N7 无法通过** | 需 A8/R3 例外        |
| RB-C | provenance 不完整            | 同 RB-B，并在记录中标注不完整       | 需 A7 例外           |
| RB-D | 来源无法确认（EA-13 及更早） | **无自动路径**                      | 需逐次单独批准并留痕 |

**核心规则：回滚必须重跑校验；"曾经部署过"不构成信任。**

---

## 5. 历史镜像证据矩阵

完整矩阵：`rollback/historical-image-evidence-matrix.md`。**所有 digest 均由原始证据字节复算**（脚本 `tests/extract_identities.py`，输出 `tests/historical-identities.json`）。

| 对象         | index                 | manifest                  | config         | 源码 revision  | 签名   | SBOM   | provenance                    |
| ------------ | --------------------- | ------------------------- | -------------- | -------------- | ------ | ------ | ----------------------------- |
| EA-16 候选   | `17126c6e…`           | `43a7dc27…`               | `7e6139af…`    | `51a899b7…`    | **无** | **无** | SLSA v1, `completeness=false` |
| EA-45 a1     | `9b2156ac…`           | `be54cfce…`               | `e35ca534…`    | `51a899b7…`    | **无** | **无** | SLSA v1                       |
| EA-45 a2     | `d76edbad…`           | `8d9813e4…`               | `ebb3c428…`    | `51a899b7…`    | **无** | **无** | SLSA v1                       |
| EA-45 b1     | `ad6266ce…`           | `9142bb14…`               | `1aba672a…`    | `51a899b7…`    | **无** | **无** | SLSA v1                       |
| EA-45 b2     | `80ac7a1a…`           | `20fa0a57…`               | `1b91b679…`    | `51a899b7…`    | **无** | **无** | SLSA v1                       |
| EA-46 d1/d2  | n/a（导出器丢 index） | `41a45fae…` / `1387b03d…` | `ddf4c5eb…`    | 未嵌入         | **无** | **无** | 无                            |
| EA-13 及更早 | `NOT VERIFIED`        | `NOT VERIFIED`            | `NOT VERIFIED` | `NOT VERIFIED` | **无** | **无** | `NOT VERIFIED`                |

**内部一致性复算结果**：每个有证据包的对象，其 `config` 与 manifest 声明一致、provenance subject 等于 manifest digest、index 确实包含该 manifest —— 全部 ✅。也就是说这些对象**内部自洽**，但**没有任何签名，也没有 SBOM**。

---

## 6. Server Action Key 与应用回滚兼容性

| 场景                                 | 结果                          | 证据                                      | 等级                                           |
| ------------------------------------ | ----------------------------- | ----------------------------------------- | ---------------------------------------------- |
| 同 key 跨版本                        | 可用                          | `ea36-release-readiness-review.md:45,364` | `PASS — SPECIFIC SCENARIO VERIFIED`（staging） |
| 异 key 跨版本                        | 404 `Server action not found` | 同上                                      | `PASS — SPECIFIC SCENARIO VERIFIED`（负向）    |
| K1→K2→K1 回滚 + 完整业务操作         | 功能恢复                      | `ea36:222-236`（EA-33）                   | `PASS — SPECIFIC SCENARIO VERIFIED`（staging） |
| 部署时"镜像内嵌 key == 期望 key"闸门 | 已实现并每次执行              | `deploy-dev.yml:286-296`                  | `PASS`（机制）                                 |
| 逐副本 key/commit 收敛（直连路径）   | 已实现                        | `deploy-dev.yml:500-505`                  | `PASS`（机制）                                 |
| **EA-16 → 当前 是否同 key**          | **未知**                      | —                                         | **`NOT VERIFIED`**                             |
| 跨 key 轮换后的回滚                  | 未测                          | —                                         | **`NOT RUN`**                                  |
| 回滚 + Migration 51 + 数据丢失 组合  | 未测                          | —                                         | **`NOT RUN`**                                  |

**范围限制（必须一并引用）**：EA-33 的回滚证据只覆盖它当时使用的镜像与 key，不能外推为"任何镜像的任何回滚"，也不涉及 EA-16。本阶段未读取、未输出、未派生任何 key 材料。

---

## 7. 新发现：镜像不自证源码版本（D1 + D2）

这是本阶段最重要的发现，且它**改变了对 `source_revision` 字段的信心**。

### 7.1 现象

| 镜像                   | `.next` `deploymentId` | `/app` 内出现 `51a899b7…` 的文件数 |
| ---------------------- | ---------------------- | ---------------------------------- |
| EA-16 候选（生产候选） | **`undefined`**        | **0**                              |
| EA-45 `repro-1`        | `"51a899b7…"`          | 295                                |

证据：`tests/build-identity-corrobation.txt`（只读检查既有本地镜像，未构建新镜像）

### 7.2 根因

| 步骤                                                                                              | 证据                                                             |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Dockerfile 要求 40-hex `DEPLOYMENT_VERSION` 并导出为 `ENV`                                        | `Dockerfile:23,25,28`                                            |
| Web 构建经 Turbo：`pnpm turbo run build …`                                                        | `Dockerfile:50-52`                                               |
| Turbo 2.10.5 默认**严格**环境模式，只把 `globalEnv`/task `env` 中声明的变量传给任务               | 隔离探针实测（下表）                                             |
| **HEAD 的 `turbo.json` 未声明 `DEPLOYMENT_VERSION`**                                              | `git show HEAD:turbo.json \| grep -c DEPLOYMENT_VERSION` → **0** |
| 工作区那份声明了——但它是**未提交**改动，且 mtime `2026-10-23T11:04`，**晚于** EA-16 构建（05:31） | `git status --short turbo.json`、`git diff turbo.json`           |

**隔离探针**（`/tmp/opencode/ea51/turbo-probe`，一次性 workspace，只有一个打印变量的任务）：

| 变体       | turbo 配置                                   | 结果               |
| ---------- | -------------------------------------------- | ------------------ |
| A 对照     | `globalEnv` **含** `DEPLOYMENT_VERSION`      | `D="aaaa1111…"` ✅ |
| B 复现缺陷 | `globalEnv` **不含**，变量在 shell 中 export | `D=undefined` ❌   |
| C 修复形态 | task 级 `env: ["DEPLOYMENT_VERSION"]`        | `D="aaaa1111…"` ✅ |

证据：`tests/turbo-env-probe.txt`

### 7.3 影响

- **从已提交代码（`51a899b7`）构建的镜像，其行为等同 EA-16**，而非 EA-45 那几个镜像——因为让差异生效的那行声明**没有提交**。
- EA-16 的身份完全依赖证据包里的 provenance blob。如果该包是唯一副本，那么"恢复 EA-16"意味着信任一个文件而不是一个产物。
- 这与 EA-43 事实 19 / EA-45 §4.3 描述的是同一件事，但那两处把它记为**可复现性**备注；本阶段确认它同时是**身份链缺陷**。

---

## 8. 新发现：就绪检查近乎同义反复（D3）

| 事实                                                                 | 证据                                                                         |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 就绪端点返回 **`process.env.APP_VERSION`**                           | `apps/web/src/app/api/health/ready/route.ts:145`                             |
| `appVersion()` 助手会优先取 `DEPLOYMENT_VERSION`，但**该端点没用它** | `apps/web/src/lib/app-version.ts:12`；唯一引用者是 `app/(app)/layout.tsx:24` |
| `APP_VERSION` **不**在镜像 config 里，由部署时注入                   | `deploy-dev.yml:374,455`                                                     |
| 部署侧比较 `.version == $GITHUB_SHA`                                 | `deploy-dev.yml:471-478`                                                     |

因此该检查证明的是"编排器告诉这个容器的 SHA 就是期望的 SHA"，**并不证明镜像由该 SHA 构建**。它是有用的存活/收敛检查，但不是身份检查。

---

## 9. Migration 51 与对象存储依赖

| 项目                                | 事实                                                                | 证据                                    | 等级             |
| ----------------------------------- | ------------------------------------------------------------------- | --------------------------------------- | ---------------- |
| 迁移 forward-only                   | 迁移器拒绝"账本超前"的检出                                          | `backup-restore-runbook.md` §7          | `PASS`（设计）   |
| 旧镜像 + 新 schema                  | 就绪端点抛 `[schema] the database is ahead of this build`，拒绝服务 | `ready/route.ts:76`                     | `PASS`（已实现） |
| Migration 51 内容                   | 删除 3 个死列（`certificate`、`due_on`、`expires_on`）              | `0051_ea12_drop_dead_columns.sql`       | `PASS`（已读）   |
| 51 已应用 + 数据丢失 ⇒ 旧镜像不兼容 | 确认                                                                | `ea38-release-decision-record.md:86-90` | `PASS`（分析）   |
| 51 生产预检查                       | —                                                                   | —                                       | **`NOT RUN`**    |
| 生产 DB 备份/恢复                   | —                                                                   | —                                       | **`NOT RUN`**    |
| 生产对象存储备份/恢复               | —                                                                   | —                                       | **`NOT RUN`**    |

**决定性区分**：应用镜像回滚**不会**撤销 Migration 51。迁移已跑且数据已变时，回滚镜像要么被就绪检查拒绝（schema ahead），要么让旧镜像对着新 schema 服务。镜像签名问题与数据库问题正交，互不吸收。

---

## 10. 重建耗时

EA-50 记为 `NOT RUN`；EA-51 从**仓库内既有日志**复算（**未执行任何新构建**，因为现有数据正好切题）。

| 构建     | 来源                            | 墙钟      | 退出码 |
| -------- | ------------------------------- | --------- | ------ |
| EA-45 a1 | `ea45/logs/build-ledger.txt:20` | **323 s** | 0      |
| EA-45 a2 | `:28`                           | **327 s** | 0      |
| EA-45 b1 | `:36`                           | **339 s** | 0      |
| EA-45 b2 | `:44`                           | **363 s** | 0      |
| EA-46 d1 | `ea46/logs/build-ledger.txt:24` | **347 s** | 0      |
| EA-46 d2 | `:29`                           | **356 s** | 0      |

| 统计   | 值                        |
| ------ | ------------------------- |
| n      | 6                         |
| 区间   | 323–363 s                 |
| 均值   | ≈ 342 s（**5 分 42 秒**） |
| 离散度 | 40 s（均值的 12 %）       |

**必须随数字一起引用的限制**：

1. 六次全部 `--no-cache`，台账明示每个 `RUN`/`COPY` 都重新执行（仅两个元数据步骤 `CACHED`）⇒ 是真冷构建。
2. 包含 `pnpm install`，但其 pnpm store 来自**本地 cache mount**，不是网络冷启动；真正空 store 的 runner 会更慢，幅度**未测量**。
3. 是**本地 7.7 GiB 工作站**构建，不是 GitHub-hosted runner，也不是自托管 Dokploy runner；不含 push 传输时间。
4. **不含**迁移、镜像拉取到目标、服务收敛、就绪等待（部署 job 单独给了 600 s 就绪预算，`deploy-dev.yml:468`）。

**结论：构建 ≈ 5.7 分钟，但"冷构建→可服务"仍为 `PARTIAL`**——部署侧各阶段在任何证据包中都未测量。用 5.7 分钟当恢复时间会低估。

证据：`tests/rebuild-timing.json`

---

## 11. R1–R4 风险比较

完整分析（Revision 2）：`rollback/unsigned-image-rollback-risk.md`。

### 11.1 新增判断：四个方案目前都只是意图

因为**回滚代码路径根本不存在**（见 §3 L8、十项必查 #8），R1（强制验签）与 R4（禁止回滚）**没有可执行的强制点**；R3（例外）也无处附加；R2 只能产出声明。所以**在选择 R1–R4 之前必须先有 DI-7**，否则任何选择都只是文字。

### 11.2 比较

| 维度           | R1 强制验签            | R2 事后补来源证明 | R3 限定例外   | R4 禁止回滚旧镜像 |
| -------------- | ---------------------- | ----------------- | ------------- | ----------------- |
| 今日技术可行性 | 低（无强制点）         | 中                | 中（需 DI-7） | 低（无强制点）    |
| 证据门槛       | 高（EA-16 不可能满足） | 中                | 中            | 无                |
| 恢复可用性     | 低                     | 中                | **高**        | 低                |
| 安全强度       | 高                     | **低/虚幻**       | 中            | 高                |
| 误用风险       | 低                     | **最高**          | 中            | 低                |
| 退出条件       | n/a                    | 到期              | 到期          | n/a               |
| 诚实标注       | 无控制的政策           | 对过去的断言      | 无控制的例外  | 无控制的政策      |

**R2 的误用风险因 §7 而升高**：EA-16 无法自证 revision，一次"再声明"会成为**唯一**声称其来源的东西，因此极易在日后被读成"当年已验证"。

### 11.3 建议

`RECOMMENDATION ONLY — NOT APPROVED`

维持 Revision 1 的方向（**R3 + 明确到期日，R2 仅作保管性声明**），并追加两条：

1. **把决定排在 DI-7 之后**——无法执行的例外比没有例外更糟，因为它制造了"有控制"的错觉。
2. **在"冷构建→可服务"被测量之前，把"我们可以重建代替回滚"视为未证实**。构建 342 s 有数据，部署侧 `NOT RUN`。

**在 A8 决定且 DI-7 存在之前，实际生效的仍是最严读法（R1），§1 的缺口保持打开。**

---

## 12. 测试矩阵

完整设计：`tests/deployment-identity-test-matrix.md`。**T1–T14：4 `PASS`（仅隔离）、2 `PARTIAL`、8 `NOT RUN`。**

| ID  | 场景                      | 可运行？                       | 等级      |
| --- | ------------------------- | ------------------------------ | --------- |
| T1  | 完整 index digest 正确    | 是（EA-48 T9）                 | `PASS`    |
| T2  | 目标平台 manifest 唯一    | 是（EA-48 T10a/T10b）          | `PASS`    |
| T3  | manifest ≠ 签名对象       | 需 A1/A2                       | `NOT RUN` |
| T4  | provenance subject 不匹配 | 部分（EA-48 T8 覆盖 revision） | `PARTIAL` |
| T5  | 源码 revision 不匹配      | 是（EA-48 T8b）                | `PASS`    |
| T6  | SBOM subject 不匹配       | 部分（EA-48 T3 覆盖移植）      | `PARTIAL` |
| T7  | 签名身份不符              | 需 keyless                     | `NOT RUN` |
| T8  | tag 改指                  | 是（EA-48 T9 双向）            | `PASS`    |
| T9  | 回滚对象与记录不一致      | 需 DI-7                        | `NOT RUN` |
| T10 | 未签名旧镜像无例外        | 需 DI-7 + A8                   | `NOT RUN` |
| T11 | Server Action Key 不兼容  | 需双镜像                       | `NOT RUN` |
| T12 | Migration 51 与旧镜像     | 需真实 DB                      | `NOT RUN` |
| T13 | 对象存储恢复证据缺失      | 需恢复演练                     | `NOT RUN` |
| T14 | 审批引用缺失/无效         | 需 DI-7 + A8                   | `NOT RUN` |

T9/T10/T14 三项都卡在同一件事上：**没有回滚代码就没有可断言的测试**——这本身就是最大的缺口。

---

## 13. 新增及修改文件

### 13.1 新增

| 文件                                                              | 说明                                           |
| ----------------------------------------------------------------- | ---------------------------------------------- |
| `docs/ea51-deployment-identity-and-rollback-report.md`            | 本报告                                         |
| `docs/evidence/ea51/design/deployment-identity-chain-trace.md`    | 八环节追踪 + 十项必查 + 新发现 D1/D2/D3        |
| `docs/evidence/ea51/design/deployment-identity-contract.md`       | 17 字段契约 + N1–N9 + RB-A~~D + DI-1~~DI-8     |
| `docs/evidence/ea51/rollback/historical-image-evidence-matrix.md` | 8 对象证据矩阵 + Key 兼容 + DB/存储 + 重建耗时 |
| `docs/evidence/ea51/rollback/unsigned-image-rollback-risk.md`     | R1–R4 Revision 2                               |
| `docs/evidence/ea51/tests/deployment-identity-test-matrix.md`     | T1–T14 设计                                    |
| `docs/evidence/ea51/tests/extract_identities.py`                  | 身份复算脚本（含 `norm()` 规范化）             |
| `docs/evidence/ea51/tests/historical-identities.json`             | 复算结果                                       |
| `docs/evidence/ea51/tests/rebuild-timing.json`                    | 重建耗时统计                                   |
| `docs/evidence/ea51/tests/turbo-env-probe.txt`                    | Turbo 环境过滤探针（A/B/C）                    |
| `docs/evidence/ea51/tests/build-identity-corrobation.txt`         | 镜像自证源码版本检查                           |
| `docs/evidence/ea51/environment/*`                                | 工作区快照 + EA-50 复核                        |

### 13.2 修改

| 文件                                 | 变更                                                      |
| ------------------------------------ | --------------------------------------------------------- |
| `docs/project-development-state.md`  | 仅新增 `## EA-51 addendum`                                |
| `docs/release-approval-checklist.md` | 仅新增 §10.23 与 §12 状态句；**未改动任何既有生产阻断项** |

### 13.3 刻意未修改

`.github/workflows/*`、`Dockerfile`、`.dockerignore`、`turbo.json`、业务代码、schema/权限/RLS；
**EA-43 签字栏与风险等级栏保持为空**。
`turbo.json` 的未提交改动**保持原样**——本阶段只记录它，不提交也不回退。

---

## 14. 质量检查结果

### 14.1 六项标准门禁

| 门禁                  | 状态            | 原因              |
| --------------------- | --------------- | ----------------- |
| `pnpm format:check`   | **RUN, exit 0** | Markdown 必须检查 |
| `pnpm typecheck`      | `NOT RUN`       | 无 TS/TSX 改动    |
| `pnpm lint`           | `NOT RUN`       | 无源码改动        |
| `pnpm deadcode:check` | `NOT RUN`       | 无导入/导出改动   |
| `pnpm test`           | `NOT RUN`       | 无行为改动        |
| `pnpm build`          | `NOT RUN`       | 无构建输入改动    |

### 14.2 本阶段实际执行的检查

| 检查                             | 结果                                        |
| -------------------------------- | ------------------------------------------- |
| EA-50 证据 SHA-256               | **13/13 通过**                              |
| EA-51 证据 SHA-256               | 见 `docs/evidence/ea51/SHA256SUMS`          |
| digest 复算（8 对象 × 5 类对象） | 全部由原始字节复算，未沿用散文值            |
| 镜像自证检查（只读）             | 2 个既有本地镜像，未构建新镜像              |
| Turbo 探针                       | 一次性 `/tmp` workspace，三种配置，结论一致 |
| Markdown 格式                    | `format:check` exit 0                       |
| 内部链接                         | 见 §14.3                                    |
| 秘密扫描                         | 0 命中（见 §14.4）                          |
| Git diff / 暂存区                | 见 §15                                      |

### 14.3 内部链接

所有内部链接以脚本核验（非人工目测）：抽取反引号内的仓库相对路径与证据包相对路径，剥离 `:行号` 后逐条检查存在性。

| 范围                                                               | 结果                                                                                                              |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| 仓库相对路径（以 `docs` 开头）                                     | 全部存在，0 缺失                                                                                                  |
| 证据包相对路径（`design/`、`rollback/`、`tests/`、`environment/`） | 全部存在，0 缺失                                                                                                  |
| 跨迭代证据引用                                                     | EA-48 的日志统一写成完整路径（`docs/evidence/ea48/tests/` 下的具体文件名），避免与 EA-51 自己的 `tests/` 同名混淆 |
| 尚未创建的路径                                                     | 无（本阶段所有引用指向已存在文件）                                                                                |

> `docs/evidence/ea51/SHA256SUMS` 在报告初稿时尚不存在；生成后已重新校验（12/12 通过）。

### 14.4 秘密扫描

扫描范围：`docs/ea51-deployment-identity-and-rollback-report.md`、`docs/evidence/ea51/**`。

| 检查                                          | 结果                                                 |
| --------------------------------------------- | ---------------------------------------------------- |
| 私钥头（`BEGIN … PRIVATE KEY`）               | 0 命中                                               |
| 私钥/口令文件（`*.key` / `*.pem` / `*.pw`）   | 证据包内**不存在**                                   |
| `ghp_` / `github_pat_` / `xox*` / `AKIA` 令牌 | 0 命中                                               |
| 含口令的数据库连接串                          | 0 命中                                               |
| Server Action Key 赋值形态                    | 0 命中（本阶段未读取、未派生任何 key 材料）          |
| Turbo 探针使用的值                            | `aaaa1111…` 为合成占位串，不是任何真实 commit 或密钥 |

本阶段全程未读取、未生成、未存储任何凭据。`extract_identities.py` 只读仓库内证据文件并计算 SHA-256；
Turbo 探针运行在 `/tmp/opencode/ea51/turbo-probe` 的一次性 workspace 内。

---

## 15. Git 状态

| 项目             | 值                                                                                                                      |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 分支             | `hse-platform`                                                                                                          |
| HEAD             | `51a899b7aac0a942da327222a3eed355fca9798a`（**未变**，本阶段无提交）                                                    |
| 已跟踪修改       | 165 个（与执行前一致）                                                                                                  |
| 未跟踪条目       | 506 个（执行前 505，**+1** = `docs/ea51-deployment-identity-and-rollback-report.md`；`docs/evidence/` 折叠为一条 `??`） |
| 暂存区           | **空**（未执行任何 `git add`）                                                                                          |
| 提交 / 推送 / PR | **无**                                                                                                                  |
| 破坏性 Git 操作  | **无**（未执行 `reset --hard` / `clean` / `restore` / `checkout --`）                                                   |

### 15.1 正式 CI 工作流确认未被修改

`.github/workflows/*`、`Dockerfile`、`.dockerignore`、`turbo.json` 均显示 `M`，但属**执行前既有**改动：

| 文件                               | mtime（本机）        | 判定                                                            |
| ---------------------------------- | -------------------- | --------------------------------------------------------------- |
| `Dockerfile`                       | 2026-10-21T09:54     | 早于 EA-47…51                                                   |
| `.dockerignore`                    | 2026-10-14T07:43     | 早于 EA-47…51                                                   |
| `.github/workflows/ci.yml`         | 2026-10-22T08:53     | 早于 EA-47…51                                                   |
| `.github/workflows/deploy-dev.yml` | 2026-10-21T23:53     | 早于 EA-47…51                                                   |
| **`turbo.json`**                   | **2026-10-23T11:04** | 早于 EA-47…51，但**晚于 EA-16 构建（05:31）**——这正是 §7 的根因 |
| `.github/workflows/security.yml`   | 2026-09-27T17:18     | 未修改                                                          |

补充校验：三个 workflow 中 `cosign|syft|sbom|attest|id-token` 命中仍为 **0**。

### 15.2 本阶段触碰的文件

| 文件                                                   | 状态                    | 说明                                                   |
| ------------------------------------------------------ | ----------------------- | ------------------------------------------------------ |
| `docs/ea51-deployment-identity-and-rollback-report.md` | `??` 新增               | 本报告                                                 |
| `docs/evidence/ea51/**`                                | `??` 新增               | 13 个文件（含 `SHA256SUMS`）                           |
| `docs/project-development-state.md`                    | `M`（**执行前已是 M**） | 仅新增 `## EA-51 addendum`                             |
| `docs/release-approval-checklist.md`                   | `??`（原有未跟踪）      | 仅新增 §10.23 与 §12 状态句；**未改动 §11 任何既有行** |

---

## 16. 未解决问题与所需授权

| #   | 问题                                     | 等级                    | 说明                                                     |
| --- | ---------------------------------------- | ----------------------- | -------------------------------------------------------- |
| 1   | A1–A8 全部无授权记录                     | `NOT FOUND`             | 未变化                                                   |
| 2   | 身份链 L5/L6/L7/L8 缺失                  | `FAIL`                  | 平台 manifest / config / 部署记录 / 回滚记录             |
| 3   | **镜像不自证源码版本（D1）**             | `FAIL`                  | EA-16 `deploymentId=undefined`，源码 SHA 0 命中          |
| 4   | **turbo.json 声明未提交（D2）**          | `FAIL`                  | HEAD 缺 `DEPLOYMENT_VERSION` ⇒ 从已提交代码构建会重现 D1 |
| 5   | **就绪检查近乎同义反复（D3）**           | `PARTIAL`               | 比较运行时变量，非镜像身份                               |
| 6   | 回滚代码路径不存在                       | `FAIL`                  | 使 R1–R4 均无法强制执行                                  |
| 7   | 旧镜像回滚未决定（A8）                   | `PENDING AUTHORIZATION` | 暴露今天已存在                                           |
| 8   | `buildkit_completeness=false` 未决（A7） | `PENDING AUTHORIZATION` | —                                                        |
| 9   | 冷构建→可服务未测量                      | `NOT RUN`               | 影响 R4 可行性                                           |
| 10  | EA-16→当前同 key 未知                    | `NOT VERIFIED`          | —                                                        |
| 11  | EA-13 及更早身份                         | `NOT VERIFIED`          | 无证据包                                                 |
| 12  | OIDC 预检 O3–O6                          | `NOT VERIFIED`          | 未执行                                                   |
| 13  | Observe-only                             | `NOT STARTED`           | 0 天 / 0 构建                                            |
| 14  | 转换条件                                 | `NOT MET`               | 0/9                                                      |
| 15  | 生产 Migration 51 / 备份恢复 / 回滚演练  | `NOT RUN`               | 独立阻断项                                               |
| 16  | 镜像可复现性书面决策                     | 待决策                  | EA-43 Rev 5 仍为草案                                     |

### 所需授权（按解锁顺序）

| 顺序 | 授权                                            | 负责人                                      | 解锁                                |
| ---- | ----------------------------------------------- | ------------------------------------------- | ----------------------------------- |
| 1    | **A1** Rekor 策略                               | Technical Approver                          | keyless 可行性                      |
| 2    | **A2** OIDC + attestation                       | Release Engineer                            | 签名能力                            |
| 3    | **OIDC 预检** O3–O6                             | Release Engineer + Ops                      | 证明"批准≠可用"                     |
| 4    | **A5** 观察窗口（含日期）                       | Release Engineer                            | 观察阶段                            |
| 5    | **A8** 回滚例外                                 | Release Engineer + Audit                    | 回滚路径（**需先有 DI-7**）         |
| 6    | **DI-8 授权**（提交 turbo 声明或改用 task env） | Release Engineer                            | 镜像自证源码版本                    |
| 7    | A3 / A4 / A6 / A7                               | Release Engineer / Ops / Technical Approver | 权限、环境门、GHCR、provenance 例外 |

**最终发布状态保持：`PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`。**

EA-51 只完成**只读追踪、契约设计、证据复算与风险分析**。生产 Migration 51 预检查、生产数据库与对象存储
备份恢复、完整生产部署与回滚演练、正式审批签字，以及镜像可复现性书面决策，均仍未完成，且不因本阶段改变。
