# EA-35B — "设置"灰色 & 中文语言选择问题排查报告

**日期：** 2026-10-24
**环境：** ceshi `beaconhs-phase-aj`（Phase AJ Test Tenant），super-admin `admin@beaconhs.local`
**结论：** 已定位根因并确认可复现。中文支持在代码中已完整实现，问题属于**租户语言配置未启用**，加上**超级管理员无租户成员身份时语言选择器按设计禁用**。

---

## 1. 复现结果

| 步骤                                              | 结果                                                         |
| ------------------------------------------------- | ------------------------------------------------------------ |
| 打开 `/account`（右上角 Account menu → 账户设置） | 页面正常渲染，"Language" 区域可见                            |
| 观察 Language 下拉框                              | `combobox [disabled]`、`button "Language" [disabled]`        |
| 下拉框当前值                                      | "Use tenant default (English)"                               |
| 选项列表                                          | 仅含租户已启用语言（当前只有 English）                       |
| `/admin/settings` → Languages 区域                | English ✅ / French ☐ / Spanish ☐ / **Simplified Chinese ☐** |
| 普通租户成员（有 membership）                     | 选择器可用，但选项仍只有 English                             |

## 2. 根因及证据链

### 根因 1：超级管理员无租户成员身份 → 选择器按设计禁用

**代码位置：** `apps/web/src/app/(app)/account/page.tsx:95`

```tsx
canOverrideLocale={ctx.membership !== null}
```

**证据链：**

1. `apps/web/src/components/account-menu.tsx` — Settings 链接指向 `/account`。
2. `apps/web/src/app/(app)/account/page.tsx:95` — `canOverrideLocale={ctx.membership !== null}`。
3. `apps/web/src/app/(app)/account/_profile-form.tsx:93` — `<Select ... disabled={!canOverrideLocale}>`。
4. `packages/tenant/src/index.ts:54` — `membership: { id: string; displayName: string } | null`。
5. ceshi 数据库验证：`admin@beaconhs.local` 在 `tenant_users` 中 **0 行** → `ctx.membership === null` → `canOverrideLocale = false` → **下拉框 disabled（灰色）**。

### 根因 2：租户 `enabled_languages` 仅含 English → 中文不在选项中

**代码位置：** `apps/web/src/lib/auth.ts:39` → `enabledLocales: tenant.enabledLanguages`

**证据链：**

1. `packages/i18n/src/index.ts:9` — `SUPPORTED_LOCALES = ['en', 'fr', 'es', 'zh']`，**zh 已注册**。
2. `apps/web/src/app/(app)/account/_profile-form.tsx:98` — 选项列表 = `enabledLocales.map(...)`。
3. `apps/web/src/lib/auth.ts:39` — `enabledLocales = tenant.enabledLanguages`。
4. ceshi `tenants` 表：两个租户的 `enabled_languages` 均为 `["en"]`。
5. Playwright `/admin/settings` → Languages：English ✅，**Simplified Chinese ☐**。
6. 翻译文件 `packages/i18n/src/messages/zh.json` **存在**（i18n-coverage 测试也验证了 zh 的完整性）。

## 3. 排除的假设

| 假设                           | 结论                                                             |
| ------------------------------ | ---------------------------------------------------------------- |
| 中文未注册到 SUPPORTED_LOCALES | ❌ 已注册（`['en','fr','es','zh']`）                             |
| 中文翻译文件缺失               | ❌ `zh.json` 存在且覆盖测试通过                                  |
| 语言选择器被权限或功能开关禁用 | ⚠️ 部分正确——仅 super-admin 因无 membership 被禁用；这是设计行为 |
| 设置页面被角色权限控制         | ❌ /account 页面正常渲染                                         |
| 语言偏好保存 API 失败          | ❌ 未触发（选择器禁用时无法保存）                                |
| 页面只展示固定语言、未实现切换 | ❌ 切换功能已实现，仅受租户语言配置控制                          |
| 服务端与客户端 locale 不一致   | ❌ 未发现此问题                                                  |

## 4. 影响范围

- **所有租户的普通成员：** 语言选择器可用，但只能看到租户 `enabled_languages` 中的语言（ceshi 当前只有 English）。中文无法选择。
- **超级管理员（无 membership）：** 语言选择器直接禁用（灰色），无法操作。
- **已启用 zh 的租户成员：** 可正常切换到中文（代码和翻译文件完整）。

## 5. 最小修复方案（无需修改业务代码）

### 方案 A（推荐）：通过管理界面启用中文

1. 以租户管理员登录 → `/admin/settings` → **Languages** 区域。
2. 勾选 **Simplified Chinese** → 保存。
3. 租户成员刷新 `/account` 页面 → Language 下拉框出现中文选项。
4. 选择中文并保存 → `tenant_users.locale_override` 更新 → 界面切换为中文。

**性质：** 租户配置变更，不是代码修复。不需要数据库迁移。

### 方案 B（可选，代码变更）：允许超级管理员覆盖语言

如果需要让无 membership 的超级管理员也能设置个人语言，可修改 `account/page.tsx:95`：

```tsx
canOverrideLocale={ctx.isSuperAdmin || ctx.membership !== null}
```

**风险：** 超级管理员的语言偏好存到哪个租户的 `tenant_users` 行？当前实现要求 membership 才能写入 `locale_override`，因此方案 B 需要额外处理"无 membership 时偏好存到哪"的问题。**不建议在发布前实施**，除非有明确的产品需求。

## 6. 回归测试建议

1. 启用 zh 后，普通成员在 `/account` 看到 Simplified Chinese 选项。
2. 选择中文后，界面文案切换为中文（`zh.json` 生效）。
3. 未启用 zh 的租户成员看不到中文选项。
4. 超级管理员（无 membership）仍看到禁用的语言选择器（如未实施方案 B）。
5. RLS：`tenant_users.locale_override` 仅影响当前用户。

## 7. 是否需要修改数据库或迁移

**不需要。** `enabled_languages` 是 `tenants` 表的 JSONB 字段，通过 `/admin/settings` 界面即可修改。`locale_override` 是 `tenant_users` 表的字段，已存在。

## 8. 修复风险与审批

- 方案 A：无代码变更，无数据库迁移，风险极低。可由租户管理员自行操作。
- 方案 B：涉及权限模型（超级管理员偏好存储），建议在发布后再评估。

## 9. 未验证事项

- 方案 A 启用中文后，`zh.json` 在浏览器端的完整渲染效果（本次未执行端到端中文切换测试）。
- 方案 B 的具体实现细节（超级管理员偏好存储方案）。
