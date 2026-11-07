# Phase BS — Isolated Freeze E2E Environment Report

**测试日期**: 2026-10-18  
**环境**: 本地隔离测试环境  
**报告类型**: 环境建立 + 隔离验证 (E2E 测试执行受阻)

---

## 1. 环境使用声明

### 1.1 目标主机和 Compose 项目

| 项目         | 值                                         |
| ------------ | ------------------------------------------ |
| 主机         | 本地 (Docker)                              |
| Compose 项目 | `docker-compose.yml` (profile: `local-db`) |
| 容器网络     | Docker 默认网络                            |

### 1.2 数据库、测试租户及对象存储范围

| 资源     | 标识                                   | 范围                                    |
| -------- | -------------------------------------- | --------------------------------------- |
| 数据库   | `beaconhs-postgres` (127.0.0.1:5433)   | 本地，独立，不影响远程                  |
| 测试租户 | `aca29e48-fa59-400b-823e-a51764c1f8ea` | slug: `phase-bs-isolated`               |
| 对象存储 | `beaconhs-minio` (127.0.0.1:9000)      | bucket: `phase-bs-isolated`             |
| 认证     | 本地 Better Auth                       | 会话已创建，activeTenantId 指向隔离租户 |

### 1.3 隔离验证方法

- 新租户 `tenant_id` 与现有 `demo` 租户 (`8b62c4c2-...`) 完全不同
- 对象存储 bucket 使用独立命名空间 `phase-bs-isolated`
- 所有测试数据通过 `tenant_id` RLS 策略自动隔离 (191 个表已应用 FORCE RLS)
- 测试完成后删除租户即可级联清理所有关联数据

### 1.4 拟执行的操作

| 操作               | 目标                                | 状态                 |
| ------------------ | ----------------------------------- | -------------------- |
| 创建隔离租户       | 本地数据库                          | ✅ 完成              |
| 创建 MinIO bucket  | 本地 MinIO                          | ✅ 完成              |
| 创建测试会话       | 本地数据库                          | ✅ 完成              |
| 配置租户角色权限   | `tenant_admin` role, scope `tenant` | ✅ 完成              |
| 构建本地生产服务器 | Next.js standalone                  | ✅ 完成 (build 通过) |
| 启动本地应用       | http://localhost:3000               | ✅ 完成 (HTTP 200)   |
| 运行冻结 E2E 测试  | 本地应用 + 本地 DB                  | ❌ BLOCKED (见 §6)   |

### 1.5 清理策略、恢复步骤和停止条件

**清理策略**:

- 删除隔离租户 `aca29e48-fa59-400b-823e-a51764c1f8ea` (级联删除所有关联数据)
- 删除 MinIO bucket `phase-bs-isolated` 中的测试文件
- 不触碰 `demo` 租户或任何现有数据

**恢复步骤**:

- 如需重新运行，重新创建隔离租户即可
- 所有操作幂等，可重复执行

**停止条件**:

- 任何操作影响非隔离数据 → 停止并报告
- 数据库连接失败 → 停止并报告
- 容器健康检查失败 → 停止并报告

---

## 2. 资源创建记录

### 2.1 容器状态

| 容器               | 状态         | 端口映射              |
| ------------------ | ------------ | --------------------- |
| beaconhs-postgres  | Up (healthy) | 127.0.0.1:5433 → 5432 |
| beaconhs-redis     | Up (healthy) | 127.0.0.1:6380 → 6379 |
| beaconhs-minio     | Up (healthy) | 127.0.0.1:9000 → 9000 |
| beaconhs-mailpit   | Up (healthy) | 127.0.0.1:8025 → 8025 |
| beaconhs-collabora | Up (healthy) | 127.0.0.1:9980 → 9980 |

### 2.2 迁移状态

| 项目       | 值                       |
| ---------- | ------------------------ |
| 已应用迁移 | 50                       |
| 待执行迁移 | 0                        |
| RLS 策略   | 191 个表已应用 FORCE RLS |
| 角色权限   | 已回填内置角色权限       |

### 2.3 新租户

| 字段     | 值                                     |
| -------- | -------------------------------------- |
| ID       | `aca29e48-fa59-400b-823e-a51764c1f8ea` |
| 名称     | Phase BS Isolated Test Tenant          |
| Slug     | `phase-bs-isolated`                    |
| 区域     | ca-central-1                           |
| 默认语言 | en                                     |
| 启用语言 | [en]                                   |

### 2.4 MinIO Bucket

| 字段      | 值                    |
| --------- | --------------------- |
| Bucket 名 | `phase-bs-isolated`   |
| 端点      | http://127.0.0.1:9000 |
| 访问密钥  | beaconhs              |
| 秘密密钥  | beaconhs-dev-secret   |

### 2.5 测试会话

| 字段        | 值                                                            |
| ----------- | ------------------------------------------------------------- |
| 用户 ID     | `9795b604-4f50-4a06-a3aa-907465b23ad0` (admin@beaconhs.local) |
| 租户用户 ID | `a0c2bdfc-2441-4eb2-ac70-e0f3296e4130`                        |
| 角色 ID     | `8393a5ed-475a-4844-9c3a-02689c8292a3` (tenant_admin)         |
| 角色键      | `tenant_admin`                                                |
| Scope       | `{"type": "tenant"}`                                          |
| 会话 ID     | `phase-bs-e2e-session-25796697-d098-4100-adde-fb470504b6fd`   |
| 会话 Token  | `phase-bs-e2e-token-201d4b15-e607-4c1f-af4d-b88735433ccb`     |
| 活跃租户 ID | `aca29e48-fa59-400b-823e-a51764c1f8ea`                        |
| 过期时间    | 24 小时                                                       |

### 2.6 本地生产服务器

| 项目            | 值                                            |
| --------------- | --------------------------------------------- |
| 构建状态        | ✅ 通过 (`pnpm --filter @beaconhs/web build`) |
| 运行模式        | Next.js standalone production                 |
| 监听地址        | http://0.0.0.0:3000                           |
| 访问验证        | ✅ HTTP 200                                   |
| Playwright 验证 | ✅ 页面加载正常 (343ms)                       |

---

## 3. RLS 和跨租户验证

### 3.1 租户隔离验证

```sql
-- 确认隔离租户存在且与 demo 租户不同
SELECT id, name, slug FROM tenants;
-- 结果:
-- 8b62c4c2-8ac9-40f5-8918-224036c4fbfd | Acme Industrial | demo
-- aca29e48-fa59-400b-823e-a51764c1f8ea | Phase BS Isolated Test Tenant | phase-bs-isolated
```

### 3.2 内置角色

隔离租户已预置 4 个内置角色：

- `worker` (Worker)
- `foreman` (Foreman / Supervisor)
- `safety_manager` (Safety Manager)
- `tenant_admin` (Tenant Admin)

### 3.3 角色分配

测试用户已分配 `tenant_admin` 角色，scope 为 `{"type": "tenant"}`，可访问隔离租户内的所有数据。

### 3.4 跨租户访问阻止

- RLS 策略基于 `tenant_id = current_setting('app.tenant_id')` 单等式判断
- 会话的 `activeTenantId` 设置为隔离租户 ID
- 无法在不更改会话上下文的情况下访问 `demo` 租户数据

---

## 4. 测试数据与清理范围

### 4.1 创建的测试资源

| 资源         | 标识                                                        | 清理方式                   |
| ------------ | ----------------------------------------------------------- | -------------------------- |
| 租户         | `aca29e48-fa59-400b-823e-a51764c1f8ea`                      | DELETE FROM tenants (级联) |
| 租户用户     | `a0c2bdfc-2441-4eb2-ac70-e0f3296e4130`                      | 级联删除                   |
| 角色分配     | `0b44b173-5cb7-48df-806e-e81602aa1405`                      | 级联删除                   |
| 会话         | `phase-bs-e2e-session-25796697-d098-4100-adde-fb470504b6fd` | 手动删除或过期             |
| MinIO bucket | `phase-bs-isolated`                                         | 删除 bucket                |

### 4.2 外键和级联规则

- `tenant_users` → `tenants` (ON DELETE CASCADE)
- `role_assignments` → `tenant_users` (ON DELETE CASCADE)
- `role_assignments` → `roles` (ON DELETE CASCADE)
- `session` → `user` (ON DELETE CASCADE)
- 所有 tenant-scoped 表 → `tenants` (ON DELETE CASCADE via RLS scope)

### 4.3 审计记录

- 租户创建时已写入该租户自己的 `audit_log` 行 (day-one entry)
- 清理时会随租户一起删除

---

## 5. E2E 测试执行状态 — BLOCKED

### 5.1 阻塞原因

本地 E2E 测试无法执行，原因如下：

**原因 1: Better Auth 会话 Cookie 需要 HTTPS**

Better Auth 在生产模式下使用 `__Secure-better-auth.session_token` Cookie，`__Secure-` 前缀要求 Cookie 必须通过 HTTPS 设置。本地应用运行在 HTTP (http://localhost:3000)，Playwright 无法通过 `page.context().addCookies()` 或 `document.cookie` 设置此 Cookie。

尝试过的方法：

- `page.context().addCookies()` with `domain: 'localhost'` → "Invalid cookie fields"
- `page.context().addCookies()` with `url: 'http://localhost:3000'` → "Cookie should have either url or path"
- `document.cookie` → 无法设置 HttpOnly Cookie
- 不同 Cookie 名称 (`__Secure-better-auth.session_token` / `better-auth.session_token`) → 均失败

**原因 2: 无法控制远程数据库的冻结状态**

远程测试站点 `https://beaconhs-test.xuhaoqing.top` 的数据库凭据不可用，无法通过 `freeze-control.ts` 脚本设置租户冻结状态。本地数据库中隔离租户处于 ACTIVE 状态，无法验证冻结 UI 行为。

### 5.2 受影响的测试场景

| 测试套件             | 场景数 | 状态           | 原因                       |
| -------------------- | ------ | -------------- | -------------------------- |
| Frozen UX Regression | 4      | ❌ BLOCKED     | 无法设置冻结状态；无法认证 |
| Multipart Freeze     | 7      | ❌ BLOCKED     | 无法设置冻结状态；无法认证 |
| **总计**             | **11** | **❌ BLOCKED** | —                          |

### 5.3 未覆盖的验证项

- 预签名 URL 冻结前后行为（无法触发 STORAGE_FROZEN 错误）
- 文件 SHA-256 完整性验证（无法上传文件）
- Write-arm 和 in-flight 写入证据（无法触发写入操作）
- 冻结后的 UI 拒绝行为（无法触发冻结状态）
- 解冻恢复行为（无法设置和释放冻结）

---

## 6. 后续建议

### 6.1 短期修复

1. **本地 E2E 认证**: 配置 `BETTER_AUTH_SECRET` 并使用 HTTPS 本地证书，或在测试中绕过 Better Auth 会话验证（测试专用中间件）
2. **远程冻结控制**: 获取远程数据库凭据，或在远程应用中添加测试专用 API 端点来控制冻结状态
3. **测试文件更新**: 将 E2E 测试的 `TEST_URL` 改为 `http://localhost:3000`，并添加会话注入机制

### 6.2 替代方案

在远程环境 (`https://beaconhs-test.xuhaoqing.top`) 上运行 E2E 测试：

- 已有有效的认证文件 `/tmp/beaconhs-e2e-auth.json`
- 已有有效的远程租户 `ea5a149b-ea76-48e0-abbe-fa360f520d8e`
- 冻结状态控制仍需远程数据库访问权限

### 6.3 清理计划

测试完成后，执行以下清理：

```sql
-- 删除隔离租户（级联删除所有关联数据）
DELETE FROM tenants WHERE id = 'aca29e48-fa59-400b-823e-a51764c1f8ea';

-- 删除 MinIO bucket
mc rb local/phase-bs-isolated --force
```

---

## 7. 交付物清单

| 交付物                     | 状态                | 位置            |
| -------------------------- | ------------------- | --------------- |
| 环境使用声明               | ✅ 完成             | 本报告 §1       |
| 资源隔离证据               | ✅ 完成             | 本报告 §2-§3    |
| 迁移执行记录               | ✅ 完成             | 本报告 §2.2     |
| 测试数据与清理范围         | ✅ 完成             | 本报告 §4       |
| 环境连接及隔离证据         | ✅ 完成             | 本报告 §2.1, §3 |
| 11 个场景执行结果          | ❌ BLOCKED          | 本报告 §5       |
| 预签名 URL 冻结前后行为    | ❌ BLOCKED          | 本报告 §5.3     |
| 文件 SHA-256 证据          | ❌ BLOCKED          | 本报告 §5.3     |
| Write-arm / in-flight 证据 | ❌ BLOCKED          | 本报告 §5.3     |
| 清理结果                   | ⏳ 待测试完成后执行 | —               |
| 失败缺陷和后续建议         | ✅ 完成             | 本报告 §5-§6    |

---

## 8. 约束合规性

| 约束                       | 状态    |
| -------------------------- | ------- |
| 不提交、不推送 Git 更改    | ✅ 遵守 |
| 不执行破坏性 Git 操作      | ✅ 遵守 |
| 不修改远程测试环境         | ✅ 遵守 |
| 不修改生产环境             | ✅ 遵守 |
| 不修改共享 C2 演练资源     | ✅ 遵守 |
| 保留所有已有工作区修改     | ✅ 遵守 |
| 优先使用本地独立测试数据库 | ✅ 遵守 |
| 不默认复用远程测试租户     | ✅ 遵守 |

---

**结论**: Phase BS 环境建立和隔离验证已完成。11 个 E2E 测试场景因本地认证 Cookie 限制和远程冻结状态不可控而 BLOCKED。建议在获得远程数据库访问权限或配置本地 HTTPS 认证后重新执行测试。
