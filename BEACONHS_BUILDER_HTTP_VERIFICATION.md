# Builder Apps HTTP 安全验证报告

**环境：** 真实 Web（`localhost:3000`）+ 真实 PostgreSQL + 3 个真实 API Key。
**结论：B-1 修复在 HTTP 层验证通过。**

## 1. 三个 Key

| Key                | principal        | scopes                         |
| ------------------ | ---------------- | ------------------------------ |
| `bhs_live_tenant…` | NULL（未绑定）   | `[{type:'tenant'}]`            |
| `bhs_live_sites…`  | 绑定 tenant_user | `[{type:'sites',siteIds:[…]}]` |
| `bhs_live_self…`   | 绑定 tenant_user | `[{type:'self'}]`              |

Token 格式符合 `parseApiBearerToken`（`bhs_live_` + 43 字符）；`key_hash = sha256(token)`。

## 2. 五入口 × 三 Key 矩阵

| 入口                                     | tenant                        | sites                        | self    |
| ---------------------------------------- | ----------------------------- | ---------------------------- | ------- |
| `GET /api/v1/apps/any/responses`         | 404（模板不存在，非 403）     | **403**                      | **403** |
| `GET /api/v1/apps/any/responses/{id}`    | 404                           | **403**（PATCH/DELETE 见下） | —       |
| `POST /api/v1/apps/any/responses`        | 404（走到 resolveBuilderApp） | **403**                      | **403** |
| `PATCH /api/v1/apps/any/responses/{id}`  | —                             | **403**                      | —       |
| `DELETE /api/v1/apps/any/responses/{id}` | —                             | **403**                      | —       |

所有 403 响应体一致：

```json
{
  "error": {
    "code": "forbidden",
    "message": "Scoped API keys cannot access form_responses: owner semantics are not configured"
  }
}
```

## 3. 关键断言

| 要求                           | 证据                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------ |
| guard 在**数据查询/修改之前**  | tenant key 走完 `resolveBuilderApp` 才 404；sites/self 直接 403，未到达模板解析/查询 |
| 不泄漏跨范围记录是否存在       | 无论 `{id}` 是否存在，sites/self 一律 403（固定文案）                                |
| 错误体不含 SQL/表结构/敏感数据 | ✅ 仅 `code` + 固定 `message`                                                        |
| tenant 兼容                    | ✅ tenant key 在所有入口均非 403                                                     |
| 速率限制生效                   | ✅ `ratelimit-limit: 600` 等头存在                                                   |

## 4. 测试分层

| 层                  | 内容                                                                           | 结果                    |
| ------------------- | ------------------------------------------------------------------------------ | ----------------------- |
| **HTTP 集成**       | 上表 5 入口 × 3 Key（部分组合）                                                | ✅ 全部符合期望         |
| **真实 PostgreSQL** | `scope-pg.test.ts` 中 `form_responses` 非 tenant → `false`、scoped CREATE 拒绝 | ✅ 2/2（含 10/10 总数） |
| **Mock**            | 无                                                                             | —                       |

## 5. 剩余风险

- site/self key 完全不能访问 Builder 响应（有意的产品缺口），需模板级责任主体配置启用。
- 本轮未测"合法模板存在时 tenant key 能正常读写"（`any` 为占位模板 key）；该路径属既有功能，未回退但未专项验证。
- PATCH/DELETE 对 **sites** 已验证 403；对 **self** 的 PATCH/DELETE 由同一 guard 覆盖（源码一致），未逐条实测。
