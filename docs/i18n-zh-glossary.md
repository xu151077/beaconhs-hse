# BeaconHS 中文（HSE 简体）术语表

`zh` 语言包（`packages/i18n/src/messages/zh.json`）的唯一术语事实来源。翻译或审校
任何中文文案前先读这里。英文语言包不受本文影响。

## 语言标识

| 项          | 值         |
| ----------- | ---------- |
| locale code | `zh`       |
| 显示名      | `Chinese`  |
| 原生显示名  | `简体中文` |

项目统一使用 **2 位 locale code**（`en` / `fr` / `es` / `zh`），不使用 `zh-CN`。
新增语言只能扩展 `SUPPORTED_LOCALES`，不得引入第二套命名规则。

## HSE 核心术语

| English                  | 简体中文               | 备注                                   |
| ------------------------ | ---------------------- | -------------------------------------- |
| HSE                      | HSE / 健康、安全与环境 | 缩写保留                               |
| Safety                   | 安全                   |                                        |
| Health                   | 健康                   |                                        |
| Environment              | 环境                   |                                        |
| Safety Observation       | 安全观察               | 缩写 Observation 单独出现时译「观察」  |
| Incident                 | 事故事件               | 不译「事件」，避免与 Workflow/流程混淆 |
| Accident                 | 事故                   |                                        |
| Near Miss                | 未遂事件               |                                        |
| Hazard                   | 危险源                 |                                        |
| Risk                     | 风险                   |                                        |
| Risk Assessment          | 风险评估               |                                        |
| Risk Matrix              | 风险矩阵               |                                        |
| Severity                 | 严重度                 |                                        |
| Likelihood               | 可能性                 | 风险矩阵两轴                           |
| Risk Band                | 风险等级               |                                        |
| Inspection               | 检查                   |                                        |
| Inspection Finding       | 检查发现               |                                        |
| Corrective Action        | 纠正措施               | 缩写 CA                                |
| Preventive Action        | 预防措施               |                                        |
| Observation Finding      | 观察发现               |                                        |
| Verification             | 验证                   | 必须是「验证」而非「校验」             |
| Sign-off                 | 签核                   |                                        |
| Owner                    | 负责人                 |                                        |
| Due Date                 | 截止日期               |                                        |
| Overdue                  | 逾期                   |                                        |
| Aging                    | 超期分析               | 用于 CA/合规超期报表，不译「账龄」     |
| Work Permit              | 作业许可证             |                                        |
| Permit to Work (PTW)     | 作业许可证 (PTW)       | 缩写保留                               |
| Method Statement         | 施工方案               |                                        |
| JSA                      | 作业安全分析           |                                        |
| JHA                      | 作业危害分析           |                                        |
| Toolbox Talk             | 班前会                 |                                        |
| Lift Plan                | 吊装方案               |                                        |
| HAZID                    | 危险源辨识             |                                        |
| Emergency                | 应急                   |                                        |
| Emergency Response       | 应急响应               |                                        |
| Fire Safety              | 消防安全               |                                        |
| Environmental            | 环境管理               |                                        |
| Environmental Management | 环境管理               |                                        |
| Waste                    | 废弃物                 |                                        |
| Spill                    | 泄漏                   |                                        |
| Confined Space           | 受限空间               |                                        |
| Working at Height        | 高处作业               |                                        |
| Hot Work                 | 动火作业               |                                        |
| Lockout / Tagout (LOTO)  | 上锁挂牌               |                                        |
| Competency               | 能力                   |                                        |
| Competency Assessment    | 能力评估               |                                        |
| Training                 | 培训                   |                                        |
| Training Record          | 培训记录               |                                        |
| Course                   | 课程                   |                                        |
| Lesson                   | 课时                   |                                        |
| Attendance               | 出席                   |                                        |
| Credential               | 资格证书               |                                        |
| Certificate              | 证书                   |                                        |
| Licence / License        | 执照                   | 视语境可译「许可证」                   |
| PPE                      | 个人防护用品           |                                        |
| Inspection Record        | 检查记录               |                                        |
| Daily Inspection         | 日常检查               |                                        |
| Recordable               | 可记录                 | 用于事故可记录性统计                   |
| TRIR / DART              | 保留原缩写             | 事故率指标，附中文注解                 |

## 组织与人员

| English              | 简体中文    |
| -------------------- | ----------- |
| Company              | 公司        |
| Contractor           | 承包商      |
| Employee             | 员工        |
| Worker               | 作业人员    |
| Crew                 | 班组        |
| Trade                | 工种        |
| Job Title            | 职位        |
| Department           | 部门        |
| Supervisor           | 主管        |
| Manager              | 经理        |
| Administrator        | 管理员      |
| User                 | 用户        |
| Role                 | 角色        |
| Permission           | 权限        |
| Super-admin          | 超级管理员  |
| Badge                | 工牌        |
| Org Chart            | 组织架构    |
| Headcount            | 人数        |
| Time Zone            | 时区        |
| Signature            | 签名        |
| Check In / Check Out | 签到 / 签退 |

## 平台与租户语义

BeaconHS 是多租户 SaaS，**Tenant = 租户**，不得译作「客户」或「企业」。

| English             | 简体中文        | 备注                         |
| ------------------- | --------------- | ---------------------------- |
| Tenant              | 租户            |                              |
| Workspace           | 工作台          | 指当前租户上下文             |
| Site                | 项目现场        | `org_units.level='site'`     |
| Location            | 位置            |                              |
| Area                | 区域            | `org_units.level='area'`     |
| Project             | 项目            | `org_units.level='project'`  |
| Customer            | 客户            | `org_units.level='customer'` |
| Org Unit            | 组织单元        |                              |
| Dashboard           | 仪表板          |                              |
| Feed                | 动态            |                              |
| Inbox               | 收件箱          | 通知中心                     |
| Builder             | 构建器          | 表单构建器                   |
| Insights            | 数据洞察        |                              |
| Compliance          | 合规            |                              |
| Obligation          | 合规义务        |                              |
| Jurisdiction        | 辖区 / 主管部门 | 法规语境                     |
| Authority           | 主管部门        |                              |
| Legislation         | 法规            |                              |
| Regulatory          | 法规            |                              |
| Settings            | 设置            |                              |
| Branding            | 品牌            |                              |
| Slug                | 标识符          |                              |
| Reports             | 报表            |                              |
| Documents           | 文档            |                              |
| Journals            | 工作日志        | 班组/个人的每日记录          |
| Manual (user guide) | 用户手册        | `/help` 路由                 |
| Walkthrough         | 引导巡览        | 聚光灯式新手引导             |
| Kiosk               | 自助终端        | 现场平板签到终端             |
| Asset               | 资产            |                              |
| Equipment           | 设备            |                              |
| Vehicle Log         | 车辆台账        |                              |
| Maintenance         | 保养            |                              |
| Work Order          | 工单            |                              |
| Integration         | 集成            |                              |
| Data Source         | 数据源          |                              |
| Outbound            | 对外发送        |                              |
| Audit Log           | 审计日志        |                              |
| Export / Import     | 导出 / 导入     |                              |
| Attachment          | 附件            |                              |
| Notification        | 通知            |                              |
| Magic Link          | 登录链接        | 免密登录邮件链接             |
| Password Reset      | 重置密码        |                              |
| Sign In / Sign Out  | 登录 / 退出登录 |                              |

## 不得翻译的内容

以下必须与英文原文逐字一致：

1. **品牌名**：`BeaconHS`
2. **HSE / 技术缩写**：HSE、PPE、PTW、JSA、JHA、HAZID、LOTO、SDS、TRIR、DART、JDG、SIS、GB、ISO
3. **技术标识符**：`serverName`、`tenant_id`、`incidents.read`、`all`、`self` 等字段名、权限键、枚举值、数据库列名
4. **URL 与路由**：`https://…`、`/journals`、`/api/v1`
5. **Markdown 链接与强调**：`[文字](/路径)`、`**文字**`、代码块围栏；只译链接文字，路径保持不变
6. **版本号、时间戳、cron 表达式、哈希值**（如 `m_00005ef3258bbe`）

## 翻译格式规则

1. **占位符逐字保留**：`{value1}`、`{name}`、`{count}`、`{authority}` 必须原样出现，数量不变。
2. **ICU 复数/选择结构保留**，只译其中的词：
   - 英文：`{count, plural, one {# unread} other {# unread}}`
   - 中文：`{count, plural, one {# 条未读} other {# 条未读}}`
   - 结构 token `plural, one {, other {` 与结尾大括号不可改动。
3. **中文使用全角标点**（，。：；！？（）「」），但句中夹带代码/路径时用半角。
4. **中文与英文/数字之间留一个空格**（例：`共 5 项`、`PPE 记录`）。
5. **按钮标签、菜单项保持简短**，不写成整句。
6. **用户手册正文**（`m_…` 中的长 Markdown）保持原有章节结构、编号列表和标题层级，段数一致。
