# PD-03 目标数据库只读取证报告（P3-1）

**授权范围：** 仅只读查找目标库、确认实例指纹、确认租户范围与对象存储位置、只读盘点历史数据异常。
**未执行：** 任何 Apply / UPDATE / DELETE / 对象存储删除 / 迁移。

## 1. 排查清单

| 主机 / 环境        | 实例                                            | 数据库                          | 结论              |
| ------------------ | ----------------------------------------------- | ------------------------------- | ----------------- |
| 生产 `10.10.31.13` | `beaconhs-local-prod-postgres-1`（运行中）      | `beaconhs`（32 MB）、`postgres` | 无 `beaconhs-dev` |
| 生产 `10.10.31.13` | `risk-postgres`（postgres:13，非 BeaconHS）     | —                               | 不相关            |
| 本机 `10.10.31.26` | `beaconhs-postgres`（已停）                     | `beaconhs`                      | 无 `beaconhs-dev` |
| 本机               | `beaconhs-prod-verify-postgres-1`（已停，4 周） | `beaconhs`                      | 无 `beaconhs-dev` |
| 本机               | `beaconhs-fixture-postgres-1`（Exited 1，8 天） | 未声明 `POSTGRES_DB`            | 非目标，未启动    |

**结论：目标库 `beaconhs-dev` 未定位。** 与 `TEST_HOST_A3_FORENSIC_AUDIT.md` 的结论一致。

## 2. 指纹比对状态

`BEACONHS_CUTOVER_TARGET=beaconhs-dev` 的指纹（pool / direct / secret SHA / storage SHA）无法在本轮比对：

- 指纹需要**目标实例的连接参数与密钥哈希**，属于敏感输入，本轮不读取任何 Secret；
- 已排查的实例中没有任何一个库名为 `beaconhs-dev`，因此不存在可比对对象。

**需要输入才能继续：** 目标实例地址 + 数据库名 + 指纹（或提供该实例的只读访问，由我方计算并比对）。

## 3. 生产库只读基线（非 A3 目标，仅作参照）

| 指标                             | 值  |
| -------------------------------- | --- |
| 租户数                           | 1   |
| `attachments`                    | 8   |
| `storage_object_deletion_outbox` | 0   |
| `audit_log`                      | 285 |
| 迁移账本                         | 57  |

对象存储：生产 MinIO `beaconhs-local-prod-minio-1`，bucket `beaconhs-prod`，数据约 2.1 MB（此前已做目录快照备份）。

## 4. 历史异常盘点（方法已就绪，待目标库执行）

目标库确认后，P3-3 只读执行以下清单（全部 `SELECT`）：

1. **孤儿附件**：`attachments` 中无任何业务表引用的行（按模块引用表逐一 `NOT EXISTS`）
2. **悬空引用**：业务表 `source_attachment_id` / `photo_attachment_id` 等指向不存在的 `attachments.id`
3. **删除标记不一致**：业务行已软删但附件仍被引用，或附件已删但业务行仍指向
4. **outbox 残留**：`storage_object_deletion_outbox` 中 `attempts > 0` 或长期 `pending` 的行
5. **对象缺失**：DB 有附件行但对象存储无对应 key（需对象存储只读列举）
6. **对象多余**：对象存储有 key 但 DB 无附件行

每类输出：计数 + 前 N 条样本 + 所属租户，供复核。

## 5. 结论

- **P3-1 未完成**：目标库未定位。
- **P3-2 及之后不得开始**（备份、清单、回填、验证均依赖目标确认）。
- 本轮未修改任何生产数据，未执行 Apply。

## 6. 下一步所需输入

1. `beaconhs-dev` 所在主机/实例与数据库名
2. 该实例的指纹（或只读访问方式）
3. 目标租户范围（单租户还是全部）
4. 确认对象存储是否同一 MinIO 实例、哪个 bucket
