# BeaconHS 合并前整理报告

## 1. 执行前 Git 状态

- HEAD `20d0c78f` / `hse-platform`
- `git status --short` 51 行（33 M + 18 ??）；暂存区 0 文件；未动 0055。

## 2. next-env.d.ts

- 已跟踪、差异仅构建产物（`.next/dev/types→.next/types`），无用户改。
- **未删除、未改 .gitignore、未用 assume-unchanged**；文件保留原样，工作区仍有差异——后续提交时**请勿 `git add apps/web/next-env.d.ts`**（选择性暂存即排除，不属整改合并）。状态：**已排除（约定）**。

## 3. Secret 检查（脱敏：仅路径/行）

- 合并 diff 内：**已确认无敏感信息**——`.env*` 未修改且无差异；diff 无 `10.10.31.13`/DATABASE_URL/真实凭证。
- 命中均为占位：`upload/route.test`、`invites.test`、`email-settings-actions.test`、`wopi.ts:15 dev-insecure-secret`（后者为**非 diff 的既有代码**，不属本次合并；不阻断）。
- 结论：**无阻断泄漏**。

## 4. 产品决策登记

已登记 `BEACONHS_PRODUCT_DECISIONS.md`：PD-01（F2 site/self）、PD-02（审计回溯）、PD-03（A3 回填）——均「待产品负责人确认」，未擅自决定。

## 5. loadDeckMaster（P2）

- 调用方均已 `requireRequestContext`/`requireModuleManage` + `assertCanManageModule`，走租户 ctx.db（RLS）。
- `loadDeckMaster` 仅 `WHERE id=`：同租户下 RLS forced `tenant_isolation` 使跨租户行不可见→404，无真实泄漏路径（攻击者无法枚举/读取他租户行）。
- 风险：**P2（低）**；属纵深缺位，非漏洞。**不建议合并前修复**（加谓词语义不变且可后续顺手硬化）；测试要求：加谓词需补跨租户负例（RLS 下断言两租户隔离不变）。

## 6. 合并候选清单

见 `BEACONHS_MERGE_CANDIDATE_MANIFEST.md`：源码 + 0056 + 测试必并；报告仅归档；`next-env.d.ts`、`.env*` 排除。

## 7. 尚需人工处理

1. 提交时勿 add `next-env.d.ts`。
2. 三项 PD 等产品负责人确认（不阻塞安全合并，但须书面留痕）。
3. `wopi.ts` dev fallback 另议（非本次扩改）。
4. P2 硬化可延后。

## 8. 最终合并建议

**有条件进入 Git 暂存前复核**（前提：按清单选择性 add，排除产物/环境文件）。本轮未执行 add/commit/merge/push/Migration/A3/部署。
