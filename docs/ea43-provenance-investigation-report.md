# EA-43 — BuildKit Provenance Investigation Report（Revision 2，2026-10-26）

**Status:** `PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION`

**Revision 1:** 2026-10-26（基于推断，缺少原始 JSON 证据）
**Revision 2:** 2026-10-26（EA-44 补齐原始证据后重写；撤回 Revision 1 的错误根因）
**Based on:** EA-42 实验镜像的原始 OCI 数据、EA-44 最小化 provenance 实验
**Candidate version:** EA-16（source HEAD `51a899b7aac0a942da327222a3eed355fca9798a`）
**Candidate image tag:** `beaconhs:phase-ea16-20261023-052716`
**Candidate image index digest:** `sha256:17126c6e22d20325e36a9bdc93281048c84434c12ae4c68927111bd0a30ad2c5`
**Raw evidence:** `docs/evidence/ea44/`
**Companion report:** `docs/ea44-provenance-evidence-report.md`

---

## Revision 2 变更说明

Revision 1 在**没有原始 JSON 证据**的情况下给出了三个结论，EA-44 取证后确认其中两个是错的：

| #   | Revision 1（已撤回）                                    | Revision 2（实测）                                                                         |
| --- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 1   | "BuildKit 默认不生成 provenance"                        | **错。** 默认构建即生成 SLSA provenance v1 attestation                                     |
| 2   | "差异来自 `Identity.Build[0].Ref` / `CreatedAt`"        | **错。** 那是 Docker 本地记账字段，不参与任何 digest                                       |
| 3   | "BuildKit build identity metadata 是固有行为，无法修复" | **过强。** 应表述为"当前工具链未找到确定化选项"；且已证明 image manifest digest 本身可复现 |
| 4   | "Provenance 不影响 manifest/index digest"               | **错。** 在 index 内，且是 index digest 唯一的非确定输入                                   |

Revision 1 的正面价值：正确识别了"需要先区分 manifest / index / config / layers /
provenance"，并正确拒绝在无证据时把 `PARTIAL` 写成 `PASS`。该原则在 Revision 2 保留。

---

## Executive Summary

**问题：** EA-42 两次构建在相同 `SOURCE_DATE_EPOCH` 下产生不同镜像 digest。

**答案（VERIFIED）：**

比较对象是 OCI **image index**。index 内有两个 manifest：

1. **image manifest** —— 引用 config + 18 层。两次构建**逐字节相同**
   （`sha256:6b255d15f9c6a49c…02c68377`）。
2. **attestation manifest** —— 引用 SLSA provenance v1。两次构建不同。

provenance 的差异只有四个字段，且没有一个是 Entropy 之外的业务信息：

| 字段                                         | 性质             |
| -------------------------------------------- | ---------------- |
| `predicate.runDetails.metadata.startedOn`    | 构建开始墙钟时间 |
| `predicate.runDetails.metadata.finishedOn`   | 构建结束墙钟时间 |
| `predicate.runDetails.metadata.invocationId` | 每次构建随机生成 |
| `subject[0].name`                            | 内含镜像 **tag** |

**结论：**

- 应用内容（source → 18 层 → config → image manifest）**完全可复现**（VERIFIED）。
- **index digest 在默认构建参数下不可复现**，唯一原因是 provenance attestation（VERIFIED）。
- 关闭 provenance 可使 index digest 字节级可复现（`--no-cache` 两次独立构建均为
  `sha256:141e5a28…`），但会删除供应链证明，**不作为整改方案**（VERIFIED + 拒绝）。
- 当前工具链未找到"保留 provenance 且 index 可复现"的受支持选项（VERIFIED，以工具链为限）。
- 存在不牺牲 provenance 的替代路径：以 **image manifest digest** 作为可复现身份，
  因为 provenance 的 `subject.digest` 正好绑定该 manifest digest（PROPOSED，部署侧未验证）。

---

## 一、执行前状态

| 项目                       | 值                                         |
| -------------------------- | ------------------------------------------ |
| 分支                       | `hse-platform`                             |
| HEAD                       | `51a899b7aac0a942da327222a3eed355fca9798a` |
| 修改 / 未跟踪（条目）      | 165 / 497                                  |
| 暂存区                     | 空                                         |
| Docker / Buildx / BuildKit | 29.9.2 / v0.38.1 / v0.34.0                 |
| 镜像存储                   | containerd image store                     |

与预期一致，未切换分支、未恢复文件。

---

## 二、EA-42 证据缺口：已闭合

| Revision 1 陈述              | Revision 2                                                                 |
| ---------------------------- | -------------------------------------------------------------------------- |
| `EVIDENCE GAP` — 无原始 JSON | ✅ **CLOSED**。两个实验镜像仍存在且 digest 与报告一致，已提取全部 OCI 对象 |

提取内容见 `docs/evidence/ea44/historical-ea42/`：index、manifest、config、
attestation manifest、SLSA provenance，外加 `docker image inspect` 输出。

镜像未被重建、未被重打标签、未被覆盖。因此这是**历史原始产物**，不是复现品。

---

## 三、Provenance 实际行为（VERIFIED）

### 3.1 默认行为

**默认构建生成 provenance。** 证据有三层：

1. 两个 EA-42 镜像的 index 都含 `vnd.docker.reference.type: attestation-manifest` 成员。
2. attestation manifest 的 layer 标注为 `in-toto.io/predicate-type: https://slsa.dev/provenance/v1`。
3. 构建日志明确打印 `#5 exporting attestation manifest sha256:… done`。

`--attest` 不是"开启"开关，而是**自定义**开关。Revision 1 的"未使用 `--attest`
所以没有 provenance"是错的。

### 3.2 provenance 内容

SLSA provenance v1，`buildType` 为 BuildKit 的 SLSA 定义，包含：

- `resolvedDependencies`：Dockerfile frontend `a57df69d…`、基础镜像 `node@24.18.0-bookworm-slim@cb4e8f7c…`
- `externalParameters.request.root.request.args`：`vcs:revision` = `51a899b7…`、`vcs:source`
- `internalParameters`：`builderPlatform` / `targetPlatform`
- `runDetails.builder.id`：空
- `runDetails.metadata`：上述四个可变字段
- `buildkit_completeness`：`request=false`、`resolvedDependencies=false`

`buildkit_completeness` 为 false 值得记录：说明 provenance 未声称构建请求与依赖
列表完整，审计时不应把它当作完全性证明。

### 3.3 EA-16 候选镜像的 provenance

候选镜像同样是带 attestation 的 index：

| 对象                 | digest                      |
| -------------------- | --------------------------- |
| index（发布引用）    | `sha256:17126c6e…30ad2c5`   |
| image manifest       | `sha256:43a7dc27…59a943`    |
| attestation manifest | `sha256:0f7e823e…52eca6`    |
| SLSA provenance      | `sha256:15358431…484fe0452` |

provenance 记录 `vcs:revision = 51a899b7…`，与候选版本一致。候选镜像的
config `created` 为 `2026-10-23T05:31:46…`（墙钟），说明 **EA-16 本身未使用
`SOURCE_DATE_EPOCH`**，因此候选镜像当前不具备可复现构建属性；这一点 EA-42/EA-43
此前均未说明。

---

## 四、OCI 对象模型（VERIFIED）

```
index.json (docker save 包装层)
└─ OCI image index  ← 这是被比较、也是被 docker 记为 RepoDigest 的对象
   ├─ image manifest (linux/amd64)
   │  ├─ config
   │  └─ layers[18]
   └─ attestation manifest (platform unknown/unknown)
      └─ SLSA provenance (in-toto)
```

| 对象                                    | 参与 index digest？                                 | 影响容器运行内容？ |
| --------------------------------------- | --------------------------------------------------- | ------------------ |
| image manifest                          | 是（被 index 引用）                                 | 否（间接）         |
| config                                  | 是（被 manifest 引用）                              | 是                 |
| layers                                  | 是（被 manifest 引用）                              | 是                 |
| attestation manifest                    | **是**（index 成员）                                | 否                 |
| provenance                              | **是**（通过 attestation manifest 的 layer digest） | 否                 |
| Docker `Identity.Build[].Ref/CreatedAt` | **否**                                              | 否                 |

Revision 1 认为 attestation "独立存储、不影响 digest"，与实测相反。

---

## 五、实验（VERIFIED）

| 组  | 配置                     | 重复                        | 结果                                                                 |
| --- | ------------------------ | --------------------------- | -------------------------------------------------------------------- |
| A   | 默认 provenance          | 2（`--no-cache`，不同 tag） | index `6313fe79…` vs `6e37f789…` ❌ 不同；manifest 均 `141e5a28…` ✅ |
| B   | `--provenance=false`     | 2（`--no-cache`，不同 tag） | index 均 `141e5a28…` ✅ **完全相同**                                 |
| C   | 改变 provenance 导出方式 | —                           | `NOT RUN`，A/B 已足够定位                                            |

A 与 B 的唯一差异是 attestation 的有无，因此 provenance 与 index digest 的因果
关系是直接观测，不是推断。

早期带缓存的一次 A 组构建（`COPY … CACHED`）不作为结论依据，已排除。

---

## 六、判定

| 标准                                     | 结果                                  |
| ---------------------------------------- | ------------------------------------- |
| `PASS — BIT-FOR-BIT REPRODUCIBLE`        | ❌ 不成立（默认构建）                 |
| `PARTIAL — LAYERS REPRODUCIBLE`          | ✅ 成立                               |
| `PARTIAL — METADATA SOURCE IDENTIFIED`   | ✅ 成立                               |
| `PARTIAL — PROVENANCE EFFECT IDENTIFIED` | ✅ 成立                               |
| `FAIL — REPRODUCIBILITY REGRESSION`      | ❌ 无                                 |
| `NOT VERIFIED`                           | 部署侧按 manifest digest 固定的可行性 |

**综合：`PARTIAL — LAYERS REPRODUCIBLE` + `PARTIAL — PROVENANCE EFFECT IDENTIFIED`。**

---

## 七、可复现性结论

1. source / 18 层 / config / image manifest：**可复现**，且**跨 tag 可复现**。
2. index digest：**在默认参数下不可复现**；唯一可变输入是 provenance。
3. `SOURCE_DATE_EPOCH`：约束 config `created` 与层时间戳，**不约束** provenance 时间戳。
4. 关闭 provenance 可换取 index 可复现，代价是失去供应链证明，**不推荐**。
5. 以 manifest digest 作可复现身份：技术上成立（provenance `subject.digest` 即为该
   manifest digest），但部署/回滚工具链兼容性未验证，状态 `PROPOSED — NOT VERIFIED`。

**不得**把以上任何一条表述为"生产已验证"。全部为本地实验结论。

---

## 八、Option A 草案状态

`docs/ea43-image-reproducibility-risk-acceptance.md` 已按 Revision 2 重写：

- 分离"已验证事实 / 有证据支持的解释 / 未验证推断 / 证据缺口"；
- 删除错误根因；
- 风险等级**留空**（Revision 1 曾预填 LOW，已移除）；
- 签字字段全部为空；
- 明确草案不构成批准。

**状态：`DRAFT — PENDING SIGNATURE`。**

---

## 九、发布阻断项（未变）

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

---

## 十、仍未验证

| 事项                                      | 状态                                            |
| ----------------------------------------- | ----------------------------------------------- |
| EA-42 两次构建是否冷构建                  | `NOT VERIFIED`（日志未保存）                    |
| 全量应用镜像 `--no-cache` 跨 tag 可复现性 | `NOT VERIFIED`（探针层面已验证）                |
| registry 端独立 attestation 副本          | `NOT VERIFIED`（无 registry 访问）              |
| 按 manifest digest 部署/回滚              | `NOT VERIFIED`                                  |
| EA-16 候选镜像自身可复现性                | `NOT VERIFIED`（未用 `SOURCE_DATE_EPOCH` 构建） |

---

## 十一、安全边界

- ✅ 未访问生产环境 / 生产数据库 / 生产对象存储
- ✅ 未执行生产 SQL、迁移、备份恢复、部署、回滚
- ✅ 未修改 ceshi 任何资源
- ✅ 未覆盖 EA-16 / EA-42 镜像（只读 `docker save`）
- ✅ 未删除任何镜像、容器、卷、备份、快照
- ✅ 未执行破坏性 Git 操作，未 `git add -A`，未提交 / 推送 / PR
- ✅ 未修改业务代码、权限、Role Scope、RLS
- ✅ 未泄露秘密；未代替审批人签字；未把推荐写成批准
- ✅ WOPI 保持 `KNOWN / UNRESOLVED — LOW PRIORITY — INVESTIGATION PAUSED`

---

**Document Status:** Revision 2 — completed 2026-10-26
**Supersedes:** Revision 1（错误根因，已撤回并保留变更说明供审计）
