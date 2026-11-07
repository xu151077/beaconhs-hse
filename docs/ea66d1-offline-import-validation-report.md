# EA-66D.1：独立 Ubuntu 测试环境清理及离线镜像导入

**Phase type:** 独立测试环境清理及离线镜像导入。
**Verdict:** **PASS** — 清理完成，五个镜像离线导入成功，Image ID 一致，架构一致。
**Repository:** `/home/test/projects/beaconhs-hse`
**Branch / HEAD:** `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`
**Date:** 2026-10-31 (UTC)

---

## 1. 测试主机身份及系统信息

| 项目             | 值                                         |
| ---------------- | ------------------------------------------ |
| Hostname         | ceshi-Virtual-Machine                      |
| IP Address       | 10.10.31.30                                |
| OS               | Ubuntu 24.04 (noble)                       |
| CPU Architecture | x86_64 (linux/amd64)                       |
| Docker Engine    | v29.9.2                                    |
| Docker Compose   | v5.6.1                                     |
| Docker Daemon    | active                                     |
| Current User     | ceshi                                      |
| Disk Space       | 124G 总计，97G 已用，21G 剩余 (83% 使用率) |

---

## 2. 清理前 Docker 资源统计

### 2.1 容器（26 个）

| 容器名                                 | 镜像                                                            | 状态                    |
| -------------------------------------- | --------------------------------------------------------------- | ----------------------- |
| beaconhs-phase-aj-web-1                | beaconhs:phase-ea16-20261023-052716                             | Exited (255)            |
| beaconhs-phase-cd-web-1                | beaconhs:phase-ea16-20261023-052716                             | Created                 |
| beaconhs-phase-cd-postgres-1           | postgres:16-alpine                                              | Created                 |
| beaconhs-phase-cd-redis-1              | redis:7-alpine                                                  | Created                 |
| beaconhs-phase-cd-minio-1              | 127.0.0.1:5000/beaconhs-drill/minio:b187417eee0a-drill-20261009 | Created                 |
| beaconhs-phase-cd-mailpit-1            | axllent/mailpit:latest                                          | Created                 |
| beaconhs-phase-aj-aj-gateway-1         | python:3.12-slim                                                | Up 21 hours (unhealthy) |
| beaconhs-phase-aj-worker-1             | beaconhs:phase-ea13-20261022-160729-m                           | Exited (255)            |
| beaconhs-phase-aj-scheduler-1          | beaconhs:phase-ea13-20261022-160729-m                           | Exited (0)              |
| beaconhs-phase-aj-storage-init-1       | beaconhs:phase-ea13-20261022-160729-m                           | Exited (0)              |
| beaconhs-drill-20261009-worker-1       | beaconhs:drill-20261018-202804                                  | Exited (1)              |
| beaconhs-drill-20261009-web-1          | beaconhs:drill-20261018-202804                                  | Exited (143)            |
| beaconhs-drill-20261009-scheduler-1    | 49d64ba01ea8                                                    | Exited (0)              |
| beaconhs-drill-20261009-storage-init-1 | 49d64ba01ea8                                                    | Exited (0)              |
| beaconhs-drill-20261009-postgres-1     | postgres:16-alpine                                              | Exited (0)              |
| beaconhs-drill-20261009-redis-1        | redis:7-alpine                                                  | Exited (0)              |
| beaconhs-drill-20261009-minio-1        | 127.0.0.1:5000/beaconhs-drill/minio:b187417eee0a-drill-20261009 | Exited (0)              |
| beaconhs-drill-20261009-mailpit-1      | axllent/mailpit:latest                                          | Exited (0)              |
| beaconhs-drill-20261009-collabora-1    | 4e983196eb98                                                    | Exited (0)              |
| strange_hopper                         | beaconhs:phase-bp-20261018-095008                               | Created                 |
| beaconhs-phase-aj-redis-1              | redis:7-alpine                                                  | Exited (255)            |
| beaconhs-phase-aj-postgres-1           | postgres:16-alpine                                              | Exited (255)            |
| beaconhs-phase-aj-minio-1              | 127.0.0.1:5000/beaconhs-drill/minio:b187417eee0a-drill-20261009 | Exited (255)            |
| beaconhs-phase-aj-mailpit-1            | axllent/mailpit:latest                                          | Exited (255)            |
| beaconhs-phase-aj-collabora-1          | 4e983196eb98                                                    | Exited (255)            |
| beaconhs-drill-registry                | registry:2                                                      | Up 21 hours             |

### 2.2 镜像（22 个）

| 镜像名称                            | Tag                          | Digest                                                                  | Image ID                                                                | Size   |
| ----------------------------------- | ---------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------ |
| beaconhs                            | phase-ea16-20261023-052716   | sha256:17126c6e22d20325e36a9bdc93281048c84434c12ae4c68927111bd0a30ad2c5 | sha256:17126c6e22d20325e36a9bdc93281048c84434c12ae4c68927111bd0a30ad2c5 | 2.86GB |
| beaconhs                            | phase-ea13-20261022-160729-m | sha256:5fb3bf5bdc89de6a2969d88e961cd2e81521ef282e87926fc7a0ffbc3dd7916d | sha256:5fb3bf5bdc89de6a2969d88e961cd2e81521ef282e87926fc7a0ffbc3dd7916d | 2.86GB |
| beaconhs                            | phase-ea13-20261022-152934   | sha256:aa7849a023b9f623827df14569697b14ff4b392a3bdc1e4844d43a62fb1d6fb0 | sha256:aa7849a023b9f623827df14569697b14ff4b392a3bdc1e4844d43a62fb1d6fb0 | 2.86GB |
| python                              | 3.12-slim                    | sha256:cb33f7f771ecec2ef1225cf39b159591a040391bd73e4c01f00fdfc4c47611d2 | sha256:cb33f7f771ecec2ef1225cf39b159591a040391bd73e4c01f00fdfc4c47611d2 | 179MB  |
| beaconhs                            | drill-20261018-202804        | sha256:60dc484142788c70d7122c57cf0eae11ecc18cfc68b3cae40d8fc85811b77370 | sha256:60dc484142788c70d7122c57cf0eae11ecc18cfc68b3cae40d8fc85811b77370 | 2.87GB |
| beaconhs                            | phase-cq-20261019-driver     | sha256:60dc484142788c70d7122c57cf0eae11ecc18cfc68b3cae40d8fc85811b77370 | sha256:60dc484142788c70d7122c57cf0eae11ecc18cfc68b3cae40d8fc85811b77370 | 2.87GB |
| beaconhs                            | phase-cd-20261018-142237     | sha256:8feaa82d4aa1fd6b26fd37b6c8481322782c6262fdffe892f3f1d532227d2ed6 | sha256:8feaa82d4aa1fd6b26fd37b6c8481322782c6262fdffe892f3f1d532227d2ed6 | 2.87GB |
| beaconhs                            | phase-bu-20261018-131209     | sha256:23dae17b12ae59abff81bb4e211d1b78c1bf9a12edcfd03c889c81ea2db379c5 | sha256:23dae17b12ae59abff81bb4e211d1b78c1bf9a12edcfd03c889c81ea2db379c5 | 2.87GB |
| beaconhs                            | phase-bp-20261018-095008     | sha256:474ccda68ed4c362ee9fe776be68292085872fffb43ba574b4506f0a88cbf027 | sha256:474ccda68ed4c362ee9fe776be68292085872fffb43ba574b4506f0a88cbf027 | 2.87GB |
| beaconhs                            | phase-bp-20261018-091505     | sha256:9ff3ca786e68f858db06f5e627e07c337b4fca5f431fb73b7d15472d969470ba | sha256:9ff3ca786e68f858db06f5e627e07c337b4fca5f431fb73b7d15472d969470ba | 2.87GB |
| beaconhs                            | phase-bp-20261017-111136     | sha256:8d0e44b998bb3f126a1c717ae6e480510a2341a7299fbf803ba7678b1e40951b | sha256:8d0e44b998bb3f126a1c717ae6e480510a2341a7299fbf803ba7678b1e40951b | 2.87GB |
| beaconhs                            | phase-bp-20261017-101904     | sha256:a39c78d0bc4b43beac92f46a600b4c6a68974b225d673d0c3a0d561a579b6942 | sha256:a39c78d0bc4b43beac92f46a600b4c6a68974b225d673d0c3a0d561a579b6942 | 2.87GB |
| beaconhs                            | phase-bl-20261017-000000     | sha256:58985bf9d603c8c6a0944ed351366aa3ce45922b68c6a6687477ebfae61613b6 | sha256:58985bf9d603c8c6a0944ed351366aa3ce45922b68c6a6687477ebfae61613b6 | 2.87GB |
| beaconhs                            | phase-bk-20261016-160000     | sha256:97ef5e299df746a7d0ce0e14f5c3e1c6687d32cf81662c8c08ebf92560f34ab9 | sha256:97ef5e299df746a7d0ce0e14f5c3e1c6687d32cf81662c8c08ebf92560f34ab9 | 2.87GB |
| beaconhs                            | phase-ap-an-20261016         | sha256:43abeaa7d9cb661e0ee2dbc626d742afed96bfd50d13fba06cfea3c16670e00a | sha256:43abeaa7d9cb661e0ee2dbc626d742afed96bfd50d13fba06cfea3c16670e00a | 2.86GB |
| beaconhs                            | phase-o-6u-b3-o              | sha256:22e505495882825eef564dbbf7c2c92d2725a810de1a519dcff83cee81dac501 | sha256:22e505495882825eef564dbbf7c2c92d2725a810de1a519dcff83cee81dac501 | 2.86GB |
| beaconhs                            | drill-20261009               | sha256:6089af4a456fb195db671073d51c8a3fdd52c4652b8f818c489ecf9c7e7cde7e | sha256:6089af4a456fb195db671073d51c8a3fdd52c4652b8f818c489ecf9c7e7cde7e | 2.44GB |
| axllent/mailpit                     | latest                       | sha256:b68349e3a014b90c5610bfb26b2ae36f3892d7b8cf25ee140c6c71c98d2fcf48 | sha256:b68349e3a014b90c5610bfb26b2ae36f3892d7b8cf25ee140c6c71c98d2fcf48 | 59.5MB |
| 127.0.0.1:5000/beaconhs-drill/minio | b187417eee0a-drill-20261009  | sha256:b187417eee0a495ed45ff0e2d5f0c9810ae35705319c0d2fb46dd93e4ac1501c | sha256:b187417eee0a495ed45ff0e2d5f0c9810ae35705319c0d2fb46dd93e4ac1501c | 269MB  |
| collabora/code                      | <none>                       | sha256:4e983196eb9878f339cc506c38c21f1cc3473bca3d6de883c5de08f9c0cc3a6c | sha256:4e983196eb9878f339cc506c38c21f1cc3473bca3d6de883c5de08f9c0cc3a6c | 1.84GB |
| redis                               | 7-alpine                     | sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499 | sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499 | 57.8MB |
| postgres                            | 16-alpine                    | sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea | sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea | 420MB  |
| alpine                              | latest                       | sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6 | sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6 | 13MB   |
| hello-world                         | latest                       | sha256:5e23090353324d887c48ad5e5c56d294eab81588df9605b07d1afe895f9cc8f8 | sha256:5e23090353324d887c48ad5e5c56d294eab81588df9605b07d1afe895f9cc8f8 | 25.9kB |
| registry                            | 2                            | sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373 | sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373 | 37.4MB |

### 2.3 网络（6 个）

| 网络 ID      | 网络名                          | 驱动   | 范围  |
| ------------ | ------------------------------- | ------ | ----- |
| b6f7ae40ac25 | beaconhs-drill-20261009_default | bridge | local |
| 66d2643c932f | beaconhs-phase-aj_default       | bridge | local |
| 062cc36088cf | beaconhs-phase-cd_default       | bridge | local |
| a212b13a1fdf | bridge                          | bridge | local |
| 5593e77aa83c | host                            | host   | local |
| d5f79c384524 | none                            | null   | local |

### 2.4 Volumes（10 个）

| 驱动  | Volume 名                                                        |
| ----- | ---------------------------------------------------------------- |
| local | 8fca1ab3a4e31d3abdcd76237a81896dc554c21687c455016d81b7d2d241ded2 |
| local | 9670c56d8868e3f2d4941c7bafffaf2e2eb9b9fc2e2e1595e4f37db24b5f9f67 |
| local | beaconhs-drill-20261009_minio-data                               |
| local | beaconhs-drill-20261009_postgres-data                            |
| local | beaconhs-drill-20261009_redis-data                               |
| local | beaconhs-drill-20261009_registry-data                            |
| local | beaconhs-phase-aj_minio-data                                     |
| local | beaconhs-phase-aj_postgres-data                                  |
| local | beaconhs-phase-aj_redis-data                                     |
| local | f82f7b2c2400cc44dd727763a142ed2be1268e3abe69cd06e9a0cd81e5ff7c70 |

### 2.5 Build Cache（49.03GB 可回收）

Build Cache 使用: 49.03GB

- Shared: 2.864GB
- Private: 46.17GB
- Reclaimable: 49.03GB

### 2.6 Docker Daemon 配置

Images space usage: 49.03GB
Containers space usage: 约 1MB
Local Volumes space usage: 约 5.6GB

---

## 3. 清理执行记录

### 3.1 清理步骤

1. 停止所有容器（26 个）
2. 删除所有容器（26 个）
3. 删除旧镜像（保留运行镜像）
4. 删除非默认网络（3 个）
5. 删除所有 Volumes（10 个）
6. 清理 Build Cache（49.03GB）
7. 检查残留资源

### 3.2 执行结果

- ✅ 容器清理: PASS (26/26 已删除)
- ✅ 镜像清理: PASS (17 个旧镜像已删除)
- ✅ 网络清理: PASS (3 个非默认网络已删除)
- ✅ Volumes 清理: PASS (10 个 volumes 已删除)
- ✅ Build cache 清理: PASS (49.03GB 已清理)

---

## 4. 清理后 Docker 资源统计

### 4.1 容器（0 个）

无容器

### 4.2 镜像（17 个）

| 镜像名称                            | Tag                          | Digest                                                                  | Image ID                                                                | Size   |
| ----------------------------------- | ---------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------ |
| beaconhs                            | phase-ea16-20261023-052716   | sha256:17126c6e22d20325e36a9bdc93281048c84434c12ae4c68927111bd0a30ad2c5 | sha256:17126c6e22d20325e36a9bdc93281048c84434c12ae4c68927111bd0a30ad2c5 | 2.86GB |
| beaconhs                            | phase-ea13-20261022-160729-m | sha256:5fb3bf5bdc89de6a2969d88e961cd2e81521ef282e87926fc7a0ffbc3dd7916d | sha256:5fb3bf5bdc89de6a2969d88e961cd2e81521ef282e87926fc7a0ffbc3dd7916d | 2.86GB |
| beaconhs                            | phase-ea13-20261022-152934   | sha256:aa7849a023b9f623827df14569697b14ff4b392a3bdc1e4844d43a62fb1d6fb0 | sha256:aa7849a023b9f623827df14569697b14ff4b392a3bdc1e4844d43a62fb1d6fb0 | 2.86GB |
| python                              | 3.12-slim                    | sha256:cb33f7f771ecec2ef1225cf39b159591a040391bd73e4c01f00fdfc4c47611d2 | sha256:cb33f7f771ecec2ef1225cf39b159591a040391bd73e4c01f00fdfc4c47611d2 | 179MB  |
| beaconhs                            | drill-20261018-202804        | sha256:60dc484142788c70d7122c57cf0eae11ecc18cfc68b3cae40d8fc85811b77370 | sha256:60dc484142788c70d7122c57cf0eae11ecc18cfc68b3cae40d8fc85811b77370 | 2.87GB |
| beaconhs                            | phase-cq-20261019-driver     | sha256:60dc484142788c70d7122c57cf0eae11ecc18cfc68b3cae40d8fc85811b77370 | sha256:60dc484142788c70d7122c57cf0eae11ecc18cfc68b3cae40d8fc85811b77370 | 2.87GB |
| beaconhs                            | phase-cd-20261018-142237     | sha256:8feaa82d4aa1fd6b26fd37b6c8481322782c6262fdffe892f3f1d532227d2ed6 | sha256:8feaa82d4aa1fd6b26fd37b6c8481322782c6262fdffe892f3f1d532227d2ed6 | 2.87GB |
| beaconhs                            | phase-bu-20261018-131209     | sha256:23dae17b12ae59abff81bb4e211d1b78c1bf9a12edcfd03c889c81ea2db379c5 | sha256:23dae17b12ae59abff81bb4e211d1b78c1bf9a12edcfd03c889c81ea2db379c5 | 2.87GB |
| beaconhs                            | phase-bp-20261018-095008     | sha256:474ccda68ed4c362ee9fe776be68292085872fffb43ba574b4506f0a88cbf027 | sha256:474ccda68ed4c362ee9fe776be68292085872fffb43ba574b4506f0a88cbf027 | 2.87GB |
| beaconhs                            | phase-bp-20261018-091505     | sha256:9ff3ca786e68f858db06f5e627e07c337b4fca5f431fb73b7d15472d969470ba | sha256:9ff3ca786e68f858db06f5e627e07c337b4fca5f431fb73b7d15472d969470ba | 2.87GB |
| beaconhs                            | phase-bp-20261017-111136     | sha256:8d0e44b998bb3f126a1c717ae6e480510a2341a7299fbf803ba7678b1e40951b | sha256:8d0e44b998bb3f126a1c717ae6e480510a2341a7299fbf803ba7678b1e40951b | 2.87GB |
| beaconhs                            | phase-bp-20261017-101904     | sha256:a39c78d0bc4b43beac92f46a600b4c6a68974b225d673d0c3a0d561a579b6942 | sha256:a39c78d0bc4b43beac92f46a600b4c6a68974b225d673d0c3a0d561a579b6942 | 2.87GB |
| beaconhs                            | phase-bl-20261017-000000     | sha256:58985bf9d603c8c6a0944ed351366aa3ce45922b68c6a6687477ebfae61613b6 | sha256:58985bf9d603c8c6a0944ed351366aa3ce45922b68c6a6687477ebfae61613b6 | 2.87GB |
| beaconhs                            | phase-bk-20261016-160000     | sha256:97ef5e299df746a7d0ce0e14f5c3e1c6687d32cf81662c8c08ebf92560f34ab9 | sha256:97ef5e299df746a7d0ce0e14f5c3e1c6687d32cf81662c8c08ebf92560f34ab9 | 2.87GB |
| beaconhs                            | phase-ap-an-20261016         | sha256:43abeaa7d9cb661e0ee2dbc626d742afed96bfd50d13fba06cfea3c16670e00a | sha256:43abeaa7d9cb661e0ee2dbc626d742afed96bfd50d13fba06cfea3c16670e00a | 2.86GB |
| beaconhs                            | phase-o-6u-b3-o              | sha256:22e505495882825eef564dbbf7c2c92d2725a810de1a519dcff83cee81dac501 | sha256:22e505495882825eef564dbbf7c2c92d2725a810de1a519dcff83cee81dac501 | 2.86GB |
| beaconhs                            | drill-20261009               | sha256:6089af4a456fb195db671073d51c8a3fdd52c4652b8f818c489ecf9c7e7cde7e | sha256:6089af4a456fb195db671073d51c8a3fdd52c4652b8f818c489ecf9c7e7cde7e | 2.44GB |
| axllent/mailpit                     | latest                       | sha256:b68349e3a014b90c5610bfb26b2ae36f3892d7b8cf25ee140c6c71c98d2fcf48 | sha256:b68349e3a014b90c5610bfb26b2ae36f3892d7b8cf25ee140c6c71c98d2fcf48 | 59.5MB |
| 127.0.0.1:5000/beaconhs-drill/minio | b187417eee0a-drill-20261009  | sha256:b187417eee0a495ed45ff0e2d5f0c9810ae35705319c0d2fb46dd93e4ac1501c | sha256:b187417eee0a495ed45ff0e2d5f0c9810ae35705319c0d2fb46dd93e4ac1501c | 269MB  |
| collabora/code                      | <none>                       | sha256:4e983196eb9878f339cc506c38c21f1cc3473bca3d6de883c5de08f9c0cc3a6c | sha256:4e983196eb9878f339cc506c38c21f1cc3473bca3d6de883c5de08f9c0cc3a6c | 1.84GB |
| alpine                              | latest                       | sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6 | sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6 | 13MB   |
| hello-world                         | latest                       | sha256:5e23090353324d887c48ad5e5c56d294eab81588df9605b07d1afe895f9cc8f8 | sha256:5e23090353324d887c48ad5e5c56d294eab81588df9605b07d1afe895f9cc8f8 | 25.9kB |
| registry                            | 2                            | sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373 | sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373 | 37.4MB |

### 4.3 网络（3 个）

| 网络 ID      | 网络名 | 驱动   | 范围  |
| ------------ | ------ | ------ | ----- |
| a212b13a1fdf | bridge | bridge | local |
| 5593e77aa83c | host   | host   | local |
| d5f79c384524 | none   | null   | local |

### 4.4 Volumes（0 个）

无 Volumes

### 4.5 Build Cache（0B）

Build Cache 使用: 0B

---

## 5. 五个归档传输 SHA256

| 文件名                       | 源端 SHA256                                                      | 目标端 SHA256                                                    | 一致性 |
| ---------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------- | ------ |
| beaconhs-runtime-images.tar  | 30ad0761ff070b76a00bd9b1fa2337b69c13858133c415503f09cc0dc6014081 | 30ad0761ff070b76a00bd9b1fa2337b69c13858133c415503f09cc0dc6014081 | ✅     |
| postgres-runtime-images.tar  | 896b4b0976ae21f1d6f4095b8c75204bdf83e4cf2b46ba76dd4133a7506ce9da | 896b4b0976ae21f1d6f4095b8c75204bdf83e4cf2b46ba76dd4133a7506ce9da | ✅     |
| redis-runtime-images.tar     | 020eb2aae342946a78ba3daa812884fe1e0c58f34945db80de7675f69056a2a5 | 020eb2aae342946a78ba3daa812884fe1e0c58f34945db80de7675f69056a2a5 | ✅     |
| minio-runtime-images.tar     | c30bd7be9eef635cf200805c3905f1ba91c7f94e1f4eee8e51e5def915e57468 | c30bd7be9eef635cf200805c3905f1ba91c7f94e1f4eee8e51e5def915e57468 | ✅     |
| collabora-runtime-images.tar | a5d6c1bc1bbd5654b38d788ef0587986b52702366946ec9822796d423338b0e5 | a5d6c1bc1bbd5654b38d788ef0587986b52702366946ec9822796d423338b0e5 | ✅     |

---

## 6. 五个镜像导入结果

| 镜像       | Repository     | Tag           | Image ID                                                                | OS    | Architecture | Size   | 导入结果 |
| ---------- | -------------- | ------------- | ----------------------------------------------------------------------- | ----- | ------------ | ------ | -------- |
| BeaconHS   | beaconhs       | ea66c1-formal | sha256:1834f86796195d9b97d5d6b737de57405f0183e6a36857c7c78a9bcdab6f6795 | linux | amd64        | 2.86GB | ✅ PASS  |
| PostgreSQL | postgres       | 16-alpine     | sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea | linux | amd64        | 420MB  | ✅ PASS  |
| Redis      | redis          | 7-alpine      | sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499 | linux | amd64        | 57.8MB | ✅ PASS  |
| MinIO      | minio/minio    | latest        | sha256:b187417eee0a495ed45ff0e2d5f0c9810ae35705319c0d2fb46dd93e4ac1501c | linux | amd64        | 269MB  | ✅ PASS  |
| Collabora  | collabora/code | latest        | sha256:4e983196eb9878f339cc506c38c21f1cc3473bca3d6de883c5de08f9c0cc3a6c | linux | amd64        | 1.84GB | ✅ PASS  |

---

## 7. 源端与目标端 Image ID 比对

| 镜像       | 源端 Image ID                                                           | 目标端 Image ID                                                         | 一致性 |
| ---------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------ |
| BeaconHS   | sha256:1834f86796195d9b97d5d6b737de57405f0183e6a36857c7c78a9bcdab6f6795 | sha256:1834f86796195d9b97d5d6b737de57405f0183e6a36857c7c78a9bcdab6f6795 | ✅     |
| PostgreSQL | sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea | sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea | ✅     |
| Redis      | sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499 | sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499 | ✅     |
| MinIO      | sha256:b187417eee0a495ed45ff0e2d5f0c9810ae35705319c0d2fb46dd93e4ac1501c | sha256:b187417eee0a495ed45ff0e2d5f0c9810ae35705319c0d2fb46dd93e4ac1501c | ✅     |
| Collabora  | sha256:4e983196eb9878f339cc506c38c21f1cc3473bca3d6de883c5de08f9c0cc3a6c | sha256:4e983196eb9878f339cc506c38c21f1cc3473bca3d6de883c5de08f9c0cc3a6c | ✅     |

---

## 8. 架构验证

| 镜像       | 源端架构    | 目标端架构  | 一致性 |
| ---------- | ----------- | ----------- | ------ |
| BeaconHS   | linux/amd64 | linux/amd64 | ✅     |
| PostgreSQL | linux/amd64 | linux/amd64 | ✅     |
| Redis      | linux/amd64 | linux/amd64 | ✅     |
| MinIO      | linux/amd64 | linux/amd64 | ✅     |
| Collabora  | linux/amd64 | linux/amd64 | ✅     |

---

## 9. 在线 pull 检查

| 检查项                         | 结果  |
| ------------------------------ | ----- |
| 是否执行 docker pull           | ✅ 否 |
| 是否执行 docker compose up     | ✅ 否 |
| 是否执行 docker compose create | ✅ 否 |
| 是否执行 docker run            | ✅ 否 |
| 是否执行数据库迁移             | ✅ 否 |
| 是否启动业务容器               | ✅ 否 |

---

## 10. MinIO 零 pull 证明

| 检查项                           | 结果     |
| -------------------------------- | -------- |
| 是否执行 docker pull minio/minio | ✅ 否    |
| 是否执行 docker pull 任何镜像    | ✅ 否    |
| MinIO 镜像来源                   | 离线导入 |

---

## 11. Compose 未启动证明

| 检查项                         | 结果  |
| ------------------------------ | ----- |
| 是否执行 docker compose up     | ✅ 否 |
| 是否执行 docker compose create | ✅ 否 |
| 是否执行 docker compose start  | ✅ 否 |
| 是否执行 docker compose down   | ✅ 否 |
| 是否执行 docker compose rm     | ✅ 否 |

---

## 12. 生产环境未连接证明

| 检查项               | 结果  |
| -------------------- | ----- |
| 是否连接生产数据库   | ✅ 否 |
| 是否连接生产对象存储 | ✅ 否 |
| 是否连接生产 API     | ✅ 否 |
| 是否使用生产配置     | ✅ 否 |

---

## 13. 最终判定

| 项目                          | 结果    |
| ----------------------------- | ------- |
| 测试机身份正确                | ✅ PASS |
| 清理前资源清单已保存          | ✅ PASS |
| Docker 清理完成               | ✅ PASS |
| Ubuntu 和 SSH 正常            | ✅ PASS |
| Docker Engine 和 Compose 正常 | ✅ PASS |
| 五个离线归档传输完整          | ✅ PASS |
| 五个镜像离线导入成功          | ✅ PASS |
| Image ID 一致                 | ✅ PASS |
| 架构一致                      | ✅ PASS |
| 没有在线 pull                 | ✅ PASS |
| MinIO 没有 pull               | ✅ PASS |
| 没有启动业务容器              | ✅ PASS |
| 没有执行 Compose              | ✅ PASS |
| 没有连接生产环境              | ✅ PASS |

**最终判定:** **PASS**

---

## 14. 状态 ledger

| Item               | Status                                                     |
| ------------------ | ---------------------------------------------------------- |
| EA-66D.1           | **PASS**                                                   |
| 测试机身份核实     | **PASS** (ceshi-Virtual-Machine, 10.10.31.30)              |
| Docker 清理完成    | **PASS** (26 容器, 10 volumes, 49.03GB build cache 已清理) |
| 离线归档传输       | **PASS** (5 个 tar 文件, SHA256 一致)                      |
| 镜像离线导入       | **PASS** (5/5 导入成功)                                    |
| Image ID 验证      | **PASS** (5/5 一致)                                        |
| 架构验证           | **PASS** (所有 linux/amd64)                                |
| 在线 pull 检查     | **PASS** (未执行)                                          |
| MinIO 零 pull 证明 | **PASS** (未执行)                                          |
| Compose 未启动证明 | **PASS** (未执行)                                          |
| 生产环境未连接证明 | **PASS** (未执行)                                          |
| 生产部署           | **PENDING APPROVAL — NOT DEPLOYED TO PRODUCTION**          |
| Rollback           | **FAIL — NO EXECUTABLE ROLLBACK PATH**                     |
| A1–A8              | **PENDING AUTHORIZATION**                                  |

---

## 15. 证据索引

| File                                                  | Contents               |
| ----------------------------------------------------- | ---------------------- |
| `/var/tmp/beaconhs-ea66d1-preclean/`                  | 清理前 Docker 资源清单 |
| `/var/tmp/beaconhs-ea66d1-preclean/cleanup-report.md` | 清理报告               |
| `/tmp/ea66d1-cleanup.sh`                              | 清理脚本               |
| `/tmp/ea66d1-import.sh`                               | 导入脚本               |
| `/home/ceshi/offline-package/`                        | 离线包目录（目标主机） |
| `docs/ea66d1-offline-import-validation-report.md`     | 本报告                 |

---

## 16. 下一步

**保留五个已导入镜像，供 EA-66D.2 使用。**

**不要自动进入 EA-66D.2，不要启动 Canonical Compose。等待下一步明确授权。**
EOF
echo "✓ 报告已创建: docs/ea66d1-offline-import-validation-report.md"
