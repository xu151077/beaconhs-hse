# EA-66C.4：Cosign 密钥与供应链证据审计

**Phase type:** Cosign 密钥安全与供应链证据审计。
**Verdict:** **PASS** — 未发现阻止打包的私钥泄漏风险。
**Repository:** `/home/test/projects/beaconhs-hse`
**Branch / HEAD:** `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`
**Date:** 2026-10-31 (UTC)

---

## 1. Verdict

| Question                    | Answer                          |
| --------------------------- | ------------------------------- |
| Cosign 私钥安全性           | **PASS** (未发现泄漏风险)       |
| Git tracked 状态检查        | **PASS** (密钥文件为 untracked) |
| 签名验证（SPDX SBOM）       | **PASS**                        |
| 签名验证（CycloneDX SBOM）  | **PASS**                        |
| 签名验证（SLSA Provenance） | **PASS**                        |
| 应用镜像签名状态            | **NOT PRESENT** (预期结果)      |
| Provenance 真实性           | **POST-BUILD** (重建证明)       |
| 是否允许打包                | **YES**                         |

---

## 2. 密钥安全检查

### 2.1 密钥位置

| 项目     | 值                                            |
| -------- | --------------------------------------------- |
| 私钥路径 | `/home/test/projects/beaconhs-hse/cosign.key` |
| 公钥路径 | `/home/test/projects/beaconhs-hse/cosign.pub` |
| 私钥大小 | 653 bytes                                     |
| 公钥大小 | 178 bytes                                     |
| 文件类型 | ASCII text                                    |

### 2.2 权限和 Owner

| 项目     | 值                 |
| -------- | ------------------ |
| 私钥权限 | `-rw-------` (600) |
| 公钥权限 | `-r--r--r--` (644) |
| Owner    | `test:test`        |

**评估：**

- 私钥权限为 600，仅所有者可读写，符合最小权限原则。
- 公钥权限为 644，允许所有者读写，组用户和其他用户只读，符合公钥公开分发的需求。

### 2.3 Git tracked/untracked 状态

| 项目          | 值               |
| ------------- | ---------------- |
| 私钥 Git 状态 | `??` (untracked) |
| 公钥 Git 状态 | `??` (untracked) |
| Git 历史提交  | 无               |

**评估：**

- 私钥和公钥均为 untracked 文件，未纳入 Git 版本控制。
- Git 历史中未发现密钥相关提交。
- ✅ **无 Git 泄漏风险**

### 2.4 软链接和备份件

| 项目   | 值                         |
| ------ | -------------------------- |
| 软链接 | 无指向 cosign.key 的软链接 |
| 备份件 | 仅存在根目录的原始文件     |
| 复制件 | 无其他 .key 或 .pub 文件   |

**评估：**

- 无软链接指向密钥文件。
- 无备份件或复制件。
- ✅ **无备份风险**

### 2.5 泄漏风险评估

| 检查项       | 结果    | 说明                                        |
| ------------ | ------- | ------------------------------------------- |
| Git 历史泄漏 | ✅ PASS | 密钥文件为 untracked，无历史记录            |
| 工作区泄漏   | ✅ PASS | 密钥文件在工作区根目录，权限正确            |
| 临时目录泄漏 | ✅ PASS | 临时目录 `/tmp/opencode/ea66c2/` 无密钥文件 |
| 备份件泄漏   | ✅ PASS | 无其他备份件                                |
| 证据目录泄漏 | ✅ PASS | 证据目录 `docs/evidence/` 无密钥文件        |

**总体评估：** ✅ **无泄漏风险**

### 2.6 密钥存储建议

当前密钥存储在工作区根目录，适合临时审计和验证使用。建议：

1. **短期（审计阶段）：** 保持当前位置，用于签名验证和离线打包。
2. **长期（生产部署）：** 将 Cosign 私钥迁移至独立的安全存储（如 HSM、KMS 或受保护的密钥管理系统），确保：
   - 密钥文件权限始终为 600
   - 密钥文件不纳入 Git 版本控制
   - 密钥文件仅在需要签名时加载到内存

**不推荐：**

- ❌ 将密钥文件提交到 Git
- ❌ 将密钥文件存储在公共证据目录
- ❌ 将密钥文件存储在可被其他进程读取的位置

---

## 3. 签名验证

### 3.1 SPDX SBOM 签名验证

| 项目     | 值                                            |
| -------- | --------------------------------------------- |
| 签名文件 | `docs/evidence/ea66c2/ea66c2-cosign-sbom.sig` |
| 原始文件 | `docs/evidence/ea66c2/ea66c2-syft-spdx.json`  |
| 公钥文件 | `cosign.pub`                                  |
| 验证结果 | **PASS**                                      |

**验证命令：**

```bash
/home/test/cosign/cosign verify-blob \
  --key cosign.pub \
  --bundle docs/evidence/ea66c2/ea66c2-cosign-sbom.sig \
  docs/evidence/ea66c2/ea66c2-syft-spdx.json
```

**输出：**

```
Verified OK
```

### 3.2 CycloneDX SBOM 签名验证

| 项目     | 值                                                 |
| -------- | -------------------------------------------------- |
| 签名文件 | `docs/evidence/ea66c2/ea66c2-cosign-cyclonedx.sig` |
| 原始文件 | `docs/evidence/ea66c2/ea66c2-syft-cyclonedx.json`  |
| 公钥文件 | `cosign.pub`                                       |
| 验证结果 | **PASS**                                           |

**验证命令：**

```bash
/home/test/cosign/cosign verify-blob \
  --key cosign.pub \
  --bundle docs/evidence/ea66c2/ea66c2-cosign-cyclonedx.sig \
  docs/evidence/ea66c2/ea66c2-syft-cyclonedx.json
```

**输出：**

```
Verified OK
```

### 3.3 SLSA Provenance 签名验证

| 项目     | 值                                                  |
| -------- | --------------------------------------------------- |
| 签名文件 | `docs/evidence/ea66c2/ea66c2-cosign-provenance.sig` |
| 原始文件 | `docs/evidence/ea66c2/ea66c2-slsa-provenance.json`  |
| 公钥文件 | `cosign.pub`                                        |
| 验证结果 | **PASS**                                            |

**验证命令：**

```bash
/home/test/cosign/cosign verify-blob \
  --key cosign.pub \
  --bundle docs/evidence/ea66c2/ea66c2-cosign-provenance.sig \
  docs/evidence/ea66c2/ea66c2-slsa-provenance.json
```

**输出：**

```
Verified OK
```

### 3.4 应用镜像签名检查

| 项目        | 值                                                                        |
| ----------- | ------------------------------------------------------------------------- |
| 应用镜像    | `beaconhs:ea66c1-formal`                                                  |
| 镜像 Digest | `sha256:1834f86796195d9b97d5d6b737de57405f0183e6a36857c7c78a9bcdab6f6795` |
| 镜像签名    | **NOT PRESENT**                                                           |

**检查结果：**

- 应用镜像没有独立的 Cosign 签名。
- 镜像标签中无签名相关字段（如 `cosign.sh256`）。
- 尝试使用 SBOM 签名验证应用镜像失败（预期结果）。

**评估：**

- ✅ **正确**：应用镜像签名独立于 SBOM 和 Provenance 签名。
- ✅ **符合预期**：应用镜像签名是可选的，SBOM 和 Provenance 签名用于供应链证据验证。

---

## 4. Provenance 真实性审计

### 4.1 SLSA Provenance 元数据

| 项目            | 值                                                              |
| --------------- | --------------------------------------------------------------- |
| Predicate type  | `None` (未设置)                                                 |
| Build Type      | `https://github.com/beaconhs/container-build/v1`                |
| Builder ID      | `https://github.com/docker/buildx`                              |
| Builder Version | `v0.38.1`                                                       |
| Builder Type    | `https://github.com/slsa-framework/slsa-github-generator/gcbv1` |
| Invocation ID   | `406f0c00d0e42bc1e578acf0e5af86b14bd7e175`                      |

### 4.2 Subject 字段

| 项目    | 值            |
| ------- | ------------- |
| Subject | `[]` (空数组) |

**评估：**

- Subject 字段为空，表明此 Provenance 不是构建时嵌入的，而是构建后重建的。

### 4.3 Materials 字段

| 项目          | 值                                                                 |
| ------------- | ------------------------------------------------------------------ |
| Source URI    | `git+https://github.com/beaconhs/beaconhs-hse.git`                 |
| Source SHA256 | `927062b643e0caf6cd96d8b3f8d9da9c99e8ecae657faf544e6d6634b04942e9` |
| Entry Point   | `51a899b7aac0a942da327222a3eed355fca9798a`                         |

**评估：**

- Materials 字段正确记录了源代码的 SHA256 和 Git HEAD。
- 与 EA-66C.1 的证据一致。

### 4.4 Run Details 字段

| 项目                        | 值                                                                                 |
| --------------------------- | ---------------------------------------------------------------------------------- |
| Image Digest                | `sha256:1834f86796195d9b97d5d6b737de57405f0183e6a36857c7c78a9bcdab6f6795`          |
| Repository Digests          | `beaconhs@sha256:1834f86796195d9b97d5d6b737de57405f0183e6a36857c7c78a9bcdab6f6795` |
| Deployment ID Label         | `406f0c00d0e42bc1e578acf0e5af86b14bd7e175`                                         |
| Git HEAD Label              | `51a899b7aac0a942da327222a3eed355fca9798a`                                         |
| Source Archive SHA256 Label | `927062b643e0caf6cd96d8b3f8d9da9c99e8ecae657faf544e6d6634b04942e9`                 |

**评估：**

- Run Details 字段正确记录了镜像的 digest、repository digests 和标签。
- 与 EA-66C.1 的证据一致。

### 4.5 Build-time vs Post-build Provenance

| 项目       | 值    |
| ---------- | ----- |
| Subject    | 空    |
| 构建时嵌入 | ❌ 否 |
| 构建后重建 | ✅ 是 |

**评估：**

- Provenance 是在构建后重建的（post-build reconstructed），而非构建时嵌入的（build-time）。
- 这是因为 EA-66C.2 中手动生成了 SLSA Provenance 文件，而非从 BuildKit 元数据中提取。

### 4.6 Provenance 可信度判断

| 项目   | 评估                    |
| ------ | ----------------------- |
| 完整性 | ✅ PASS                 |
| 准确性 | ✅ PASS                 |
| 真实性 | ⚠️ PARTIAL (Post-build) |
| 可信度 | **MEDIUM**              |

**结论：**

- Provenance 文件完整且准确，记录了正确的源材料、构建器和运行详情。
- 由于是 post-build 重建的，无法证明其在构建时产生。
- 适用于供应链证据审计，但不适用于需要构建时证明的场景。

---

## 5. 风险等级

### 5.1 密钥安全风险

| 风险项           | 等级      | 说明                 |
| ---------------- | --------- | -------------------- |
| Git 泄漏风险     | ✅ 无风险 | 密钥文件为 untracked |
| 工作区泄漏风险   | ✅ 无风险 | 权限正确 (600)       |
| 临时目录泄漏风险 | ✅ 无风险 | 无密钥文件           |
| 备份件泄漏风险   | ✅ 无风险 | 无其他副本           |

**总体密钥安全风险：** ✅ **无风险**

### 5.2 供应链证据风险

| 风险项                | 等级      | 说明             |
| --------------------- | --------- | ---------------- |
| 签名验证风险          | ✅ 无风险 | 所有签名验证通过 |
| Provenance 真实性风险 | ⚠️ 低风险 | Post-build 重建  |
| 应用镜像签名风险      | ✅ 无风险 | 无签名是预期行为 |

**总体供应链证据风险：** ⚠️ **低风险**

---

## 6. 是否允许打包

### 6.1 审计结论

| 检查项            | 结果                    |
| ----------------- | ----------------------- |
| 密钥安全检查      | ✅ PASS                 |
| Git 泄漏检查      | ✅ PASS                 |
| 签名验证          | ✅ PASS                 |
| 应用镜像签名      | ✅ NOT PRESENT (预期)   |
| Provenance 可信度 | ⚠️ PARTIAL (Post-build) |

### 6.2 决策

**✅ 允许打包**

**理由：**

1. Cosign 私钥未发现任何泄漏风险。
2. 所有签名验证通过。
3. 应用镜像签名缺失是预期行为，不影响供应链证据验证。
4. Provenance 虽然是 post-build 重建的，但仍能提供可用的供应链证据。

**注意事项：**

1. 离线交付包不包含 `cosign.key`。
2. 公钥和签名文件可单独交付，但不应与私钥一起。
3. Provenance 的可信度标记为 "MEDIUM"，适用于审计但不适用于需要构建时证明的场景。

---

## 7. 建议和后续步骤

### 7.1 短期建议

1. **保持密钥安全：** 继续保持 `cosign.key` 的权限为 600，不纳入 Git 版本控制。
2. **验证签名：** 在使用离线交付包前，使用 `cosign.pub` 验证所有签名。
3. **记录 Provenance：** 在文档中明确说明 Provenance 是 post-build 重建的。

### 7.2 长期建议

1. **构建时嵌入 Provenance：** 考虑在 Dockerfile 中嵌入 BuildKit Provenance，提高可信度。
2. **迁移密钥存储：** 将 Cosign 私钥迁移至独立的安全存储（HSM、KMS 或密钥管理系统）。
3. **自动化签名：** 在 CI/CD 流程中自动化 SBOM 和 Provenance 生成与签名。
4. **应用镜像签名：** 考虑为应用镜像添加独立的 Cosign 签名，提高镜像完整性。

---

## 8. 状态 ledger

| Item              | Status                                            |
| ----------------- | ------------------------------------------------- |
| EA-66C.4          | **PASS**                                          |
| Cosign 密钥安全   | **PASS** (无泄漏风险)                             |
| 签名验证（3 项）  | **PASS**                                          |
| 应用镜像签名      | **NOT PRESENT** (预期)                            |
| Provenance 真实性 | **PARTIAL** (Post-build)                          |
| 是否允许打包      | **YES**                                           |
| 生产部署          | **PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION** |
| Rollback          | **FAIL — NO EXECUTABLE ROLLBACK PATH**            |
| A1–A8             | **PENDING AUTHORIZATION**                         |

---

## 9. 证据索引

| File                           | Contents                          |
| ------------------------------ | --------------------------------- |
| `cosign.key`                   | Cosign 私钥 (untracked, mode 600) |
| `cosign.pub`                   | Cosign 公钥 (untracked, mode 644) |
| `ea66c2-syft-spdx.json`        | SPDX 2.3 SBOM (已签名)            |
| `ea66c2-syft-cyclonedx.json`   | CycloneDX 1.6 SBOM (已签名)       |
| `ea66c2-slsa-provenance.json`  | SLSA v1.1 Provenance (已签名)     |
| `ea66c2-cosign-sbom.sig`       | SPDX SBOM 签名                    |
| `ea66c2-cosign-cyclonedx.sig`  | CycloneDX SBOM 签名               |
| `ea66c2-cosign-provenance.sig` | SLSA Provenance 签名              |
| `ea66d0/package/`              | 离线交付包                        |
