# EA-66D.5 — 文档母版支持 Word / PowerPoint / Excel

**状态：** DEPLOYED — 服务端链路已验证；浏览器内导入待用户确认
**日期：** 2026-11-01
**镜像：** `beaconhs@sha256:cec17683aedcdaa736f9e3689d1034ef3376d60fb980a2d2d276366dc06c829d`
**部署：** `e7895e6df332ad5af4849f284fda04883ec70bfc-20261101-001`（`https://hse.xuhaoqing.top`）
**前置：** `docs/ea66d4-production-deployment-report.md`

---

## 1. 问题

生产环境里文档模块只能导入 `.docx`（编写型）和 `.pdf`（文件型），PPT 与 Excel 被拒绝。用户要求完整支持，包括 PDF 发布与签收。

## 2. 根因（三处，缺一不可）

| #   | 根因                                                                                                 | 证据                                                                      |
| --- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 1   | 上传/导入 UI 只接受 `.docx`，服务端策略 `documentMasterMetadataError` 只认 DOCX MIME                 | `_document-pane.tsx` accept、`document-authoring-policy.ts`               |
| 2   | 发布与渲染链写死 DOCX：文件名强制 `.docx`、快照 MIME 强制 DOCX、worker `assertOfficeInput` 只收 DOCX | `_master-actions.ts`、`apps/worker/src/workers/document-render.ts`        |
| 3   | 运行镜像只装了 LibreOffice Writer + Impress，**没有 Calc**                                           | `Dockerfile`；容器内 `/usr/lib/libreoffice/share/registry/` 无 `calc.xcd` |

第 3 条意味着：即使放开上传，`.xlsx → PDF` 也会在 worker 里失败，所以必须重建镜像。

## 3. 改动

| 文件                                                       | 改动                                                                                                                                      |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/office/src/limits.ts`                            | 新增 `XLSX_MIME_TYPE`、`OFFICE_SOURCE_MIME_TYPES`、`MAX_OFFICE_SOURCE_BYTES`、`officeSourceExtension()`、`officeSourceMimeFromFilename()` |
| `apps/web/src/lib/document-authoring-policy.ts`            | 母版接受 docx/pptx/xlsx；**扩展名必须与 MIME 一致**（Collabora 用文件名选编辑器）；统一 100 MB 上限                                       |
| `apps/web/src/app/(app)/documents/[id]/_master-actions.ts` | 发布快照保留真实 MIME 与扩展名；会话按 MIME 选择 Collabora 应用；错误文案去掉 “Word only”                                                 |
| `apps/web/src/lib/collabora.ts`                            | 新增 `spreadsheet` 应用（Calc）；导出 `collaboraAppForMime()`                                                                             |
| `apps/web/src/app/wopi/files/[fileId]/route.ts`            | `BaseFileName` 回退扩展名按附件类型（原来 xlsx 会被当成 docx）                                                                            |
| `apps/web/src/app/(app)/documents/[id]/_document-pane.tsx` | accept 改 `.docx,.pptx,.xlsx`；AI 面板仅对 `.docx` 显示（AI 走 Flat ODT 改写，不能碰 PPT/Excel）                                          |
| `apps/worker/src/workers/document-render.ts`               | `renderOfficeSourceToPdf()`：DOCX 保留纸张/页眉处理，PPTX/XLSX 用原版式直接 `soffice --convert-to pdf`；文本提取同样按类型                |
| `Dockerfile`                                               | 增加 `libreoffice-calc`                                                                                                                   |
| i18n（en/zh/fr/es）                                        | “Import Office file / Imported an Office file… / Source file / no Office file to render”等文案                                            |
| `apps/web/src/lib/manual/content/knowledge-assets.ts`      | 文档手册文章改写为三种格式、说明 AI 仅支持 Word                                                                                           |
| 测试                                                       | 母版策略新增 PPTX/XLSX 与错配扩展名用例；新增 `collaboraAppForMime` 映射测试                                                              |

## 4. 行为定义

- **导入**：文档 Write 面板的 **Import Office file** 接受 `.docx/.pptx/.xlsx`，最大 100 MB，扩展名必须与文件类型一致。
- **编辑**：编辑器按类型自动选择 Collabora Writer / Impress / Calc；PPT/Excel 不显示 AI 按钮。
- **发布**：发布时把当前 Office 母版按原类型快照为不可变版本；worker 用 LibreOffice 转成 PDF 并提取文本。PDF 仍是阅读、签收、邮件与文档合集的唯一载体。
- **版本历史**：下载按钮显示 **Source file**，下载的是该版本的原始 `.docx/.pptx/.xlsx`。
- **PDF 文件型文档**：行为不变（PDF 本身就是文档）。

## 5. 验证

### 5.1 镜像内（真实转换）

```text
soffice --headless --convert-to xlsx  t.csv   → 4,845 bytes
soffice --headless --convert-to pdf   t.xlsx  → 12,105 bytes, %PDF-
ls /usr/lib/libreoffice/share/registry/ → calc.xcd, impress.xcd, writer.xcd
```

### 5.2 生产环境

| 项          | 结果                                                                                                               |
| ----------- | ------------------------------------------------------------------------------------------------------------------ |
| 运行镜像    | `beaconhs@sha256:cec17683…`                                                                                        |
| 部署 ID     | `e7895e6d…-20261101-001`                                                                                           |
| Gate 5      | **PASS**                                                                                                           |
| 服务        | 8/8 healthy / READY                                                                                                |
| 容器内 Calc | `calc.xcd` 存在                                                                                                    |
| 数据        | `users=1, tenants=1, migrations=51` 未变                                                                           |
| 公网        | `https://hse.xuhaoqing.top/` 200                                                                                   |
| 编辑器路由  | `/hosting/discovery` 200 XML；`urlsrc=https://hse.xuhaoqing.top/browser/…`；WOPI aliasgroup 已含 `http://web:3000` |

### 5.3 六项门禁（各自捕获退出码）

| 门禁                  | 退出码                           |
| --------------------- | -------------------------------- |
| `pnpm format:check`   | 0                                |
| `pnpm deadcode:check` | 0                                |
| `pnpm lint`           | 0                                |
| `pnpm typecheck`      | 0                                |
| `pnpm test --force`   | 0（25/25 任务，web 2152 passed） |
| `pnpm build --force`  | 0（4/4）                         |

证据：`docs/evidence/ea66d4-2/gates/exit-codes.txt` 与同目录日志；构建证据 `docs/evidence/ea66d4-2/build/`；源归档 SHA256 `d8de7eee…`（3477 条目，无禁用条目）。

## 6. 浏览器验收（待用户确认）

用户需在 `/documents` 新建文档 → **Import Office file** 选择：

1. 一个 `.pptx`：编辑器应为 **Impress**，发布后 PDF 版本可预览/签收。
2. 一个 `.xlsx`：编辑器应为 **Calc**，发布后 PDF 版本可预览/签收。

服务端转换与配置已经实测；浏览器内的最终确认由用户完成，结果回填到本文件。

## 7. 风险与边界

- **PPT/Excel 的 PDF 保真度**取决于 LibreOffice 的导入滤镜，与 Microsoft Office 的排版可能有细微差异；这是文档渲染链的固有限制，不是本次改动引入的。
- **AI 助手仍然只支持 Word**，因为它的精修路径是 DOCX ↔ Flat ODT；PPT/Excel 不显示该按钮，不会产生错误的改写。
- 100 MB 上限沿用原转换上限；更大的文件需要单独评估内存与超时。
- 未 commit、未 push；生产回滚仍为 `FAIL — NO EXECUTABLE ROLLBACK PATH`（快照材料已存在）。
