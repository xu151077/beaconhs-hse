import { describe, expect, it } from 'vitest'
import {
  DOCX_MIME_TYPE,
  MAX_OFFICE_SOURCE_BYTES,
  PPTX_MIME_TYPE,
  XLSX_MIME_TYPE,
} from '@beaconhs/office/limits'
import { documentMasterMetadataError, nextDocumentMajorVersion } from './document-authoring-policy'

const VALID = {
  kind: 'document',
  contentType: DOCX_MIME_TYPE,
  sizeBytes: MAX_OFFICE_SOURCE_BYTES,
  filename: 'Safety plan.DOCX',
}

describe('document authoring policy', () => {
  it('accepts a DOCX at the shared conversion ceiling', () => {
    expect(documentMasterMetadataError(VALID)).toBeNull()
  })

  it.each([
    { contentType: PPTX_MIME_TYPE, filename: 'Toolbox talk.pptx' },
    { contentType: XLSX_MIME_TYPE, filename: 'Inspection register.XLSX' },
  ])('accepts PowerPoint and Excel masters', (override) => {
    expect(documentMasterMetadataError({ ...VALID, ...override })).toBeNull()
  })

  it.each([
    { ...VALID, kind: 'other' },
    { ...VALID, contentType: 'application/msword' },
    { ...VALID, filename: 'Safety plan.doc' },
    // The extension and the declared type must agree: Collabora picks the
    // editor from the name, so a mislabelled file would open the wrong app.
    { ...VALID, contentType: PPTX_MIME_TYPE, filename: 'Safety plan.docx' },
    { ...VALID, contentType: XLSX_MIME_TYPE, filename: 'Safety plan.xls' },
  ])('rejects a file that is not a supported Office master', (metadata) => {
    expect(documentMasterMetadataError(metadata)).toMatch(/Office file/)
  })

  it.each([
    { ...VALID, sizeBytes: 0 },
    { ...VALID, sizeBytes: MAX_OFFICE_SOURCE_BYTES + 1 },
    { ...VALID, sizeBytes: Number.NaN },
  ])('rejects an invalid or oversized master', (metadata) => {
    expect(documentMasterMetadataError(metadata)).toMatch(/100 MB/)
  })

  it('allocates native publications after imported decimal history', () => {
    expect(nextDocumentMajorVersion(null)).toBe(1)
    expect(nextDocumentMajorVersion(2)).toBe(3)
    expect(nextDocumentMajorVersion(1.1)).toBe(2)
    expect(nextDocumentMajorVersion(1.9)).toBe(2)
    expect(nextDocumentMajorVersion(2.1)).toBe(3)
  })

  it('refuses to allocate from corrupt version values', () => {
    expect(() => nextDocumentMajorVersion(Number.NaN)).toThrow(/invalid/)
    expect(() => nextDocumentMajorVersion(-1)).toThrow(/invalid/)
  })
})
