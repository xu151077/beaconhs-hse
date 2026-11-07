# Phase CG — PPTX Capability Report

Date: 2026-10-18

## 1. Product boundary

**PPTX is NOT supported for document authoring in BeaconHS.**

The document authoring system only accepts DOCX files. This is by design, not a bug.

## 2. Evidence

### Document master validation

`apps/web/src/lib/document-authoring-policy.ts`:

```typescript
export function documentMasterMetadataError(metadata: DocumentMasterMetadata): string | null {
  if (
    metadata.kind !== 'document' ||
    metadata.contentType !== DOCX_MIME_TYPE ||
    !metadata.filename.toLowerCase().endsWith('.docx')
  ) {
    return 'The working document must be a .docx Word file'
  }
  ...
}
```

### DOCX MIME type

`@beaconhs/office/limits` defines `DOCX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'`

### UI

The document creation page shows "Import Word file" and "Start blank" — both produce DOCX documents. There is no "Import PowerPoint" or PPTX option.

### WOPI route

`apps/web/src/app/wopi/files/[fileId]/contents/route.ts` handles both DOCX and PPTX MIME types for reading/writing, but this is for the training module, not documents.

## 3. Where PPTX IS supported

PPTX is supported in the **training module**:

- `apps/web/src/app/(app)/training/pptx/_actions.ts` — PPTX upload/download
- `apps/web/src/app/(app)/training/pptx/_lib.ts` — PPTX processing
- `apps/web/src/app/(app)/training/pptx/[target]/[id]/download/route.ts` — PPTX download
- `apps/web/src/app/(app)/training/_editor/slide-deck-editor.tsx` — slide deck editor

This is a separate workflow from document authoring.

## 4. Conclusion

| Capability                            | DOCX         | PPTX                              |
| ------------------------------------- | ------------ | --------------------------------- |
| Document authoring (Collabora Writer) | ✅ Supported | ❌ Not supported                  |
| Training content                      | N/A          | ✅ Supported                      |
| Upload as attachment                  | ✅ Supported | ✅ Supported (via generic upload) |
| Online editing (Collabora)            | ✅ Supported | ❌ Not supported                  |
| Download                              | ✅ Supported | ✅ Supported (as attachment)      |

PPTX is intentionally not supported for document authoring. The product uses DOCX as the canonical document format. PPTX support exists only in the training module.
