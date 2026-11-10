# PD-01 L1 修复报告 — 通配符死代码与注释矛盾

**基线：** `684053db`（独立审查 CONDITIONAL PASS）。**状态：已关闭，经独立代理复核确认。**

## 1. 缺陷回顾

`principal.ts` `narrowPermissions` 存在不可达分支：

```ts
if (principal.has(permission)) effective.add(permission)
else if (permission.endsWith('.*')) {
  // "A wildcard credential grant survives only when the principal holds the
  // same wildcard …"
  if (principal.has(permission)) effective.add(permission) // else 臂内必为 false → 死代码
}
```

- 该分支在结构上不可达（进入 `else if` 时 `principal.has(permission)` 已为 false）。
- 注释暗示"通配符授权可能到达决策层"，与实际不符。
- 核实（本轮）：`PERMISSION_CATALOGUE` **不含任何通配符键**（`iam.ts:155-375` 逐项扫描为空）；`sanitizeApiPermissions`（`permissions.ts:20-26`）在 PD-01 之前就已应用于 API Key 权限（`origin/hse-platform` 的 `auth.ts:121` 已存在），通配符在到达 `authorizeApiCredential` 之前即被剥离。

**结论：通配符不属于当前 API Key 权限设计 → 删除死分支，修正注释，不新增通配符能力。**

## 2. 修复

`principal.ts:68-78`：删除 `else if` 死分支，仅保留精确匹配交集；重写注释，明确说明"通配符不是 API Key 权限模型的一部分 —— 目录无通配符键、`sanitizeApiPermissions` 一直会剥离凭证上的通配符（早于 PD-01），因此此处不做通配符展开，存量 `x.*` 授权按既有方式被丢弃"。

**行为变化：无。** 被删除的分支不可达；删除前后函数输出一致（见测试 15 钉住的兼容行为）。

## 3. 回归测试（`principal.test.ts`，新增 14–17）

| #   | 断言                                                                                                                       | 目的                            |
| --- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| 14  | credential 持有 `incidents.*` 而 principal 不持有 → 该权限被剥离，仅保留 `incidents.read.all`                              | 通配符不产生能力                |
| 15  | credential 与 principal **同时**持有字面 `incidents.*` → 经精确匹配保留（下游 `can()` 展开）；钉住删除死分支前后的兼容行为 | 兼容回归                        |
| 16  | 未绑定 credential 权限逐字保留（legacy）                                                                                   | 兼容回归                        |
| 17  | 源码契约：`principal.ts` 不再含 `endsWith('.*')`；`auth.ts` 仍调用 `sanitizeApiPermissions(row.permissions …)`             | 钉住"死代码已移除 + 剥离层仍在" |

命令与退出码：

```bash
NODE_OPTIONS=--max-old-space-size=6144 pnpm --filter @beaconhs/web exec vitest run \
  src/lib/api/principal.test.ts
# 18 passed (18)，退出码 0（原 13 例 + 新增 4 例 + 既有 auth wiring 契约 1 例）
```

## 4. 范围控制

- 未修改 `PERMISSION_CATALOGUE`、`permissions.ts`、`sanitizeApiPermissions` —— API Key 权限过滤与兼容行为不变。
- 未新增通配符能力；`keyHasPermission` 的通配符腿（`permissions.ts:50`）因剥离层存在而保持惰性（独立代理确认非重新打开的洞）。
- 修正了与实际行为不一致的注释（L1 的核心要求之一）。

## 5. 独立复核结论

L1 **CLOSED**：死分支已删、注释不再声称通配符支持、未新增能力、测试 14–17 钉住行为；删除分支不改变任何真实行为（该分支重测的条件与第一个 `if` 完全相同）。
