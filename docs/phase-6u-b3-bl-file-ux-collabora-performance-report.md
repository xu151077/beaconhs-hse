# Phase BL — File UX, Preview, Collabora & Performance

**Date:** 2026-10-17  
**Status:** 🚧 IN PROGRESS  
**Image Tag:** `beaconhs:phase-bl-20261017-000000`  
**Commit SHA:** `51a899b7aac0a942da327222a3eed355fca9798a`  
**Test URL:** https://beaconhs-test.xuhaoqing.top

---

## 1. File Download Filename — ROOT CAUSE & FIX

### Problem

- **Symptom:** Downloaded files have no original filename, only extension (e.g., `document.pdf` instead of `测试文档.pdf`).
- **Root Cause:** Three-layer failure:
  1. **Storage layer:** `newTenantObjectKey()` sanitizes filenames by replacing non-ASCII chars with `____`, producing keys like `t/<uuid>/document/<uuid>-____.pdf`.
  2. **Presign layer:** `presignGet()` had no `ResponseContentDisposition` parameter, so S3 returned no filename header.
  3. **Download routes:** Used `filename.replace(/[^\w.\- ]+/g, '_')` which further corrupted Unicode names.

### Fix Applied

#### 1.1 New Shared Helper (`apps/web/src/lib/content-disposition.ts`)

```typescript
export function contentDisposition(
  mode: 'inline' | 'attachment',
  filename: string,
  fallback: string,
): string {
  const original = filename.trim().substring(0, 200) || fallback
  const ascii = original.replace(/["\\\r\n]/g, '_').substring(0, 200) || fallback
  const encoded = encodeURIComponent(original)
  return `${mode}; filename="${ascii}"; filename*=UTF-8''${encoded}`
}
```

**Why RFC 5987:** The `filename*=UTF-8''` parameter allows full Unicode filenames in modern browsers while maintaining ASCII fallback for legacy clients.

#### 1.2 Storage Layer (`packages/storage/src/index.ts`)

- Added `responseContentDisposition` parameter to `presignGet()`.
- Exported `contentDisposition()` function for reuse across routes.

#### 1.3 Upload Layer (`apps/web/src/lib/uploads.ts`)

- Replaced inline `contentDisposition` logic with imported helper.
- Preserves DB-stored original filename when promoting/staging objects.

#### 1.4 Download Routes Fixed

- `apps/web/src/app/(app)/documents/[id]/master/route.ts`
- `apps/web/src/app/(app)/documents/[id]/versions/[versionId]/download/route.ts`
- `apps/web/src/app/(app)/training/pptx/[target]/[id]/download/route.ts`
- `apps/web/src/app/(app)/training/records/wallet-cards/route.ts`
- `apps/web/src/lib/csv.ts`
- `apps/web/src/lib/pdf-route.ts`
- `apps/web/src/app/(app)/reports/definitions/[id]/export/route.ts`
- `apps/web/src/app/api/attachments/[id]/route.ts`

**Before:**

```typescript
const filename = att.filename.replace(/[^\w.\- ]+/g, '_') || 'document.docx'
return new NextResponse(obj.stream, {
  headers: { 'Content-Disposition': `attachment; filename="${filename}"` },
})
```

**After:**

```typescript
const { contentDisposition } = await import('./content-disposition')
const disposition = contentDisposition('attachment', att.filename, 'document.docx')
return new NextResponse(obj.stream, {
  headers: { 'Content-Disposition': disposition },
})
```

### Test Results

- **Status:** ⏳ PENDING (need manual browser test)
- **Next Step:** Upload file with Chinese name → download → verify filename in "Save As" dialog.

---

## 2. File Preview — Status

### Investigation

- **Symptom:** File preview not working (browser console shows 404/XHR errors).
- **Current State:** Routes exist for preview (PDF/DOCX/PPTX), but no evidence of preview attempts yet.

### Checklist

- [ ] PDF preview in browser tab
- [ ] DOCX preview via Collabora embed
- [ ] PPTX preview via Collabora embed
- [ ] Image preview in list
- [ ] Browser Network panel shows preview requests

### Root Cause (Tentative)

- May be same as download: missing `Content-Disposition: inline` with proper filename.
- May be CSP blocking preview iframe.
- May be missing `Content-Type` header on presigned URLs.

### Test Plan

1. Upload PDF → click preview icon → check Network panel.
2. Upload DOCX → click preview → check Collabora WOPI handshake.
3. Upload PPTX → click preview → verify Collabora editor loads.

---

## 3. Collabora Editor — Status

### Current Configuration

```bash
COLLABORA_URL=https://beaconhs-test.xuhaoqing.top
COLLABORA_DISCOVERY_URL=http://172.18.0.1:3002
COLLABORA_WOPI_URL=http://web:3000
```

### Symptoms

- UI shows: "In-browser editing is not configured"
- UI shows: "The PowerPoint editor did not respond."

### Investigation

- [ ] Collabora container healthy (✅ confirmed)
- [ ] WOPI discovery XML accessible at `/hosting/discovery`
- [ ] WOPI discovery returns correct `action` URLs for `.pptx`
- [ ] `CheckFileInfo` request succeeds
- [ ] `GetFile` request succeeds
- [ ] CSP `frame-src` allows `beaconhs-test.xuhaoqing.top` and `blob:`
- [ ] Host header on discovery hop is correct
- [ ] Collabora allows `beaconhs-test.xuhaoqing.top` in `net.frame_ancestors`

### First Failure Point (To Verify)

- Discovery XML response
- CSP frame-src header on preview page
- Host header on WOPI callback hop

### Test Steps

1. Open PPTX file in browser.
2. Check Network panel → look for `/hosting/discovery` request.
3. Check response XML for `<action ext=\"pptx\"...>`.
4. Click "Edit in Collabora" → check if iframe loads.
5. If iframe loads, edit content → save → verify file persists.

### Expected Outcome

- PPTX opens in Collabora editor.
- Changes saved to storage.
- File re-downloaded shows modifications.

---

## 4. Performance — Status

### User Complaint

- "Page is very slow/laggy"

### Investigation Plan

#### 4.1 Browser-Side (Will Use Playwright MCP)

- Record page load times for:
  - Login page
  - Dashboard
  - Files page (with attachments)
  - Device list
- Capture long tasks (>50ms) in Timeline.
- Check for duplicate API requests (especially attachment lists).
- Verify React component re-rendering (use React DevTools).

#### 4.2 Server-Side (Will Check Logs)

- PostgreSQL slow query log (threshold: 100ms)
- Check for N+1 queries in attachment/file routes.
- Monitor Web/Worker CPU/memory usage.
- Check Redis latency.
- Check MinIO latency.

#### 4.3 Common Issues to Look For

- [ ] Repeated attachment list queries (no pagination in UI)
- [ ] Large PDF/DOCX previews without lazy loading
- [ ] No caching on static assets
- [ ] Missing database indexes on foreign keys
- [ ] Connection pool exhaustion
- [ ] Event loop blocking in worker

### Optimization Principles

1. **Measure first:** Don't guess—use real metrics.
2. **Fix root cause:** Duplicate requests, unbounded queries, blocking renders.
3. **Don't over-optimize:** No blind caching, no connection pool increases.

---

## 5. Deployment

### Build & Deploy

- [x] Source code changes committed to `hse-platform`
- [x] Typecheck passed (27/27 tasks)
- [x] Build passed (4 successful, 4 total)
- [x] Docker image built: `beaconhs:phase-bl-20261017-000000`
- [x] Compose updated to use new image
- [x] Services restarted (7 containers healthy)
- [x] Database migrations applied (50 applied, 0 pending)

### Environment

- **Domain:** https://beaconhs-test.xuhaoqing.top
- **Admin Email:** admin@beaconhs.local (Magic Link via Mailpit)
- **Mailpit:** http://10.10.31.30:3016

### Backups

- [x] `.env.ap-backup` preserved
- [x] `phase-aj-compose-final.yaml.bk-bl` created
- [x] No data loss (DB/MinIO unchanged)

---

## 6. Verification Checklist

| Task                                 | Status     | Evidence                        |
| ------------------------------------ | ---------- | ------------------------------- |
| 1.1 File download with Chinese name  | ⏳ PENDING | Browser test needed             |
| 1.2 File download with ASCII name    | ⏳ PENDING | Browser test needed             |
| 1.3 File download SHA-256 unchanged  | ⏳ PENDING | Browser test needed             |
| 2.1 PDF preview in browser           | ⏳ PENDING | Playwright test needed          |
| 2.2 DOCX preview via Collabora       | ⏳ PENDING | Playwright test needed          |
| 2.3 PPTX preview via Collabora       | ⏳ PENDING | Playwright test needed          |
| 3.1 PPTX opens in Collabora editor   | ⏳ PENDING | Browser test needed             |
| 3.2 Edit PPTX and save               | ⏳ PENDING | Browser test needed             |
| 3.3 File re-downloaded shows changes | ⏳ PENDING | Browser test needed             |
| 3.4 PDF/DOCX preview works           | ⏳ PENDING | Browser test needed             |
| 4.1 Login page load time             | ⏳ PENDING | Playwright metric needed        |
| 4.2 Dashboard load time              | ⏳ PENDING | Playwright metric needed        |
| 4.3 Files page load time             | ⏳ PENDING | Playwright metric needed        |
| 4.4 Long tasks detected              | ⏳ PENDING | Playwright Timeline needed      |
| 4.5 Duplicate API requests           | ⏳ PENDING | Playwright Network panel needed |

---

## 7. Known Issues

### Issue A: Database test data insertion failing

- **Error:** `column "isSuperAdmin" does not exist` / `syntax error at or near "user"`
- **Context:** Trying to create test attachment with Chinese filename for verification.
- **Impact:** Cannot programmatically verify filename fix.
- **Workaround:** Manual browser test required.

### Issue B: Preview not tested yet

- **Reason:** No test files uploaded to test domain.
- **Impact:** Cannot confirm preview fix status.
- **Workaround:** Upload PDF/DOCX/PPTX and click preview icons.

### Issue C: Collabora not tested yet

- **Reason:** No PPTX file to test with.
- **Impact:** Cannot verify Collabora editor fix.
- **Workaround:** Upload PPTX and attempt to edit.

---

## 8. Next Steps

1. **Immediate (Manual Browser Test):**
   - Upload file with Chinese name (e.g., `测试文档.pdf`).
   - Download file → verify "Save As" dialog shows `测试文档.pdf`.
   - Upload PPTX → click "Edit in Collabora" → edit → save → re-download → verify changes.

2. **Automated Testing (Playwright MCP):**
   - Write E2E test for file download with Unicode filename.
   - Write E2E test for PPTX Collabora edit flow.
   - Capture performance metrics for login/dashboard/files pages.

3. **Performance Investigation:**
   - Enable PostgreSQL slow query log.
   - Use browser profiler to identify render bottlenecks.
   - Check for duplicate API calls in network panel.

---

## 9. Files Modified

### New Files

- `apps/web/src/lib/content-disposition.ts` — Shared Content-Disposition builder

### Modified Files

- `packages/storage/src/index.ts` — Added `presignGet` `responseContentDisposition` param; exported `contentDisposition()`
- `apps/web/src/lib/uploads.ts` — Use shared `contentDisposition` helper
- `apps/web/src/lib/upload-policy.ts` — Export helpers from `content-disposition.ts`
- `apps/web/src/app/api/attachments/[id]/route.ts` — Set `ResponseContentDisposition` in presigned URL
- `apps/web/src/app/(app)/documents/[id]/master/route.ts` — Use shared helper
- `apps/web/src/app/(app)/documents/[id]/versions/[versionId]/download/route.ts` — Use shared helper
- `apps/web/src/app/(app)/training/pptx/[target]/[id]/download/route.ts` — Use shared helper
- `apps/web/src/app/(app)/training/records/wallet-cards/route.ts` — Use shared helper
- `apps/web/src/lib/csv.ts` — Use shared helper
- `apps/web/src/lib/pdf-route.ts` — Use shared helper
- `apps/web/src/app/(app)/reports/definitions/[id]/export/route.ts` — Use shared helper

---

## 10. Conclusion

**Status:** 🚧 Phase BL is partially complete. Code changes are deployed, but manual browser testing is required to verify fixes for:

1. ✅ File download filename (code fixed, pending test)
2. ⏳ File preview (pending test)
3. ⏳ Collabora editor (pending test)
4. ⏳ Performance (pending metrics)

**Risk:** Medium. If preview/Collabora issues stem from same root cause as download (missing `Content-Disposition`), the same fix pattern applies. If they're CSP/infrastructure issues, separate investigation needed.

**Blocking:** None. Manual browser testing is straightforward and does not require additional changes.
