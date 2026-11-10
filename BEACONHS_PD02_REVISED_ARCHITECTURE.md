# PD-02 修订架构 — 专用只读审计通道（方案 A）

**决策：** 产品选择方案 A。本文件为修订设计，**未创建任何角色/函数/迁移，未修改 RLS**。

## 1. 角色模型

| 角色                                                  | 属性                                            | 权限                                                   | 用途                     |
| ----------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------ | ------------------------ |
| `beaconhs_owner`                                      | NOLOGIN / NOSUPERUSER / **NOBYPASSRLS**（不变） | 表 owner                                               | 迁移                     |
| `beaconhs_app` / `beaconhs_super` / `beaconhs_backup` | 现状不变                                        | 现状不变                                               | 运行时                   |
| **`audit_reader`**                                    | **NOLOGIN / NOSUPERUSER / BYPASSRLS**           | **仅 `SELECT ON audit_log`**                           | 跨租户读取的唯一执行身份 |
| **`audit_service`**                                   | **LOGIN / NOSUPERUSER / NOBYPASSRLS**           | **仅 `GRANT audit_reader TO audit_service`**，无表权限 | 审计服务的独立连接身份   |

硬约束（实现时逐条校验）：

1. `REVOKE audit_reader FROM PUBLIC`；`beaconhs_app`/`beaconhs_super`/`beaconhs_backup` **不是** `audit_reader` 成员，且无权 `SET ROLE audit_reader`。
2. `audit_reader` 不授予任何业务表（`tenants`、`incidents`…）任何权限；只有 `audit_log` 的 `SELECT`。
3. `audit_service` 除 `audit_reader` 成员资格外无任何权限，且**不能**登录后访问业务表。
4. `audit_log` 的 `FORCE RLS` 与 `audit_log_immutable_trigger` **原样保留**（`0057`）。

**为什么 BYPASSRLS 是必要的**：`audit_log` 是 `FORCE ROW LEVEL SECURITY`，owner 与普通角色都只能看到当前 `app.tenant_id`；只有 BYPASSRLS 身份能跨租户读取。把它限制在"仅 SELECT audit_log 的 NOLOGIN 角色 + 仅能通过成员资格到达"是最小暴露面。

## 2. 访问通道（隔离审计服务，而非 SECURITY DEFINER 函数）

采用**独立连接**，不创建 `SECURITY DEFINER` 函数：

```
应用进程 ──(AUDIT_DATABASE_URL, 身份 audit_service)──> PG
   │  1. 应用层校验 ctx.permissions 含 audit.read.tenant|platform
   │  2. SET ROLE audit_reader（仅该连接可做；普通应用角色无此成员资格）
   │  3. 执行**参数化只读**查询（无动态 SQL、无字符串拼接）
   └─ 4. 断开/回滚；写一条 platform_audit_access_log
```

理由：函数注入面（`SECURITY DEFINER` + 动态 SQL + search_path）被完全规避；连接身份本身就是边界。

**若后续坚持函数方案**，最低要求：`SECURITY DEFINER`、owner=`audit_reader`、`SET search_path = pg_catalog, public`、`REVOKE ALL … FROM PUBLIC`、只接受 `uuid/timestamptz/int` 参数、函数体不含 `EXECUTE`。

## 3. 授权、审批、有效期、撤销

新增权限键（进入 `PERMISSION_CATALOGUE`，**默认不授予任何内置角色**）：

| 键                    | 语义                                           |
| --------------------- | ---------------------------------------------- |
| `audit.read.tenant`   | 读取本租户全部审计（跨 site/self，但不出租户） |
| `audit.read.platform` | 跨租户只读追溯                                 |

新增表 `audit_access_grants`（平台级，`tenant_id` **nullable**）：

| 列                                  | 说明                             |
| ----------------------------------- | -------------------------------- |
| `id`                                | uuid                             |
| `grantee_user_id`                   | 被授权人                         |
| `grantee_tenant_id`                 | nullable；平台级授权为 NULL      |
| `scope`                             | `tenant` \| `platform`           |
| `purpose`                           | 必填，申请理由（自由文本，限长） |
| `approved_by_user_id`               | 审批人（不得与 grantee 相同）    |
| `starts_at` / `expires_at`          | **有效期必填**，最长 90 天       |
| `revoked_at` / `revoked_by_user_id` | 撤销                             |
| `created_at`                        |                                  |

规则：

- **超级管理员不自动获得**审计读取；仍需 `audit.read.platform` 授权 + 有效 grant。
- `audit.read.tenant` 授予需 `tenant_admin` + 同租户审批人；`audit.read.platform` 需平台审批人。
- 每次查询前校验：权限键 + 有效 grant（未过期、未撤销）+ purpose 非空。
- 撤销立即生效（无缓存；每次请求重新校验）。

## 4. 访问事件模型（独立、不可篡改）

新增表 `platform_audit_access_log`（**不强制归属业务 tenant**）：

| 列                | 说明                                  |
| ----------------- | ------------------------------------- |
| `id`              | uuid                                  |
| `actor_user_id`   | 操作者                                |
| `actor_tenant_id` | nullable；平台级访问为 NULL           |
| `scope`           | `tenant` \| `platform`                |
| `grant_id`        | 关联 `audit_access_grants`            |
| `purpose`         | 从 grant 复制，固化当时理由           |
| `filter`          | jsonb（时间范围、目标租户、实体类型） |
| `row_count`       | 返回行数                              |
| `occurred_at`     | timestamptz                           |

不可篡改：与 `audit_log` 相同的模式 —— `BEFORE UPDATE OR DELETE` 触发器，非 owner 抛错；`TRUNCATE` 由权限撤销控制；写入后不可改。**该表自身没有 BYPASSRLS 读取通道**（只有 owner 与受控查询）。

## 5. 保留项（不得破坏）

- `audit_log` 的 `FORCE RLS`、`tenant_isolation` 策略、`audit_log_immutable_trigger`、`audit_log_tenant_id_tenants_id_fk ON DELETE RESTRICT` —— 全部原样。
- 普通应用角色的 `audit_log` 权限（`SELECT, INSERT`）不变。
- 业务表的 RLS 与权限不变。

## 6. 与既有实现的冲突点（已解决）

| 冲突                                                 | 解决                                             |
| ---------------------------------------------------- | ------------------------------------------------ |
| FORCE RLS 阻止 owner 跨租户读                        | 引入 `audit_reader`（BYPASSRLS）作为唯一执行身份 |
| `audit_access_log` 需要 tenant_id 但平台级访问无租户 | `tenant_id` nullable；不建 tenant FK             |
| 超管自动全权                                         | 权限键独立，超管也需显式 grant                   |
| 审计访问自身可被篡改                                 | 复用 append-only 触发器模式                      |

## 7. 实施顺序（待评审通过后）

1. 迁移：创建 `audit_reader` / `audit_service`（含成员资格与 REVOKE）、两张新表、权限键
2. 迁移后校验脚本：断言 `audit_reader` 仅有 `audit_log.SELECT`、普通角色无成员资格、`audit_log` 策略未变
3. 审计服务连接与只读查询（参数化）
4. 授权/审批 UI 与访问事件写入
5. 真 PG 测试矩阵（见评审 V2）

## 8. 明确不做

- 不修改 `audit_log` 的 RLS 或触发器
- 不把审计读取暴露给 `/api/v1/*`
- 不允许 `beaconhs_app` / `beaconhs_super` 切换到 `audit_reader`
- 不创建 `SECURITY DEFINER` 函数（本版）
