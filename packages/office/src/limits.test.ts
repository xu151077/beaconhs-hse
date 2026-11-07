import { describe, expect, it } from 'vitest'
import {
  DOCX_MIME_TYPE,
  MAX_OFFICE_SOURCE_BYTES,
  MAX_PPTX_FILE_BYTES,
  PPTX_MIME_TYPE,
  XLSX_MIME_TYPE,
  officeCeilingFor,
  officeSourceExtension,
  officeSourceMimeFromFilename,
} from './limits'

describe('office conversion contract', () => {
  it('keeps media-specific producer and converter ceilings explicit', () => {
    expect(MAX_OFFICE_SOURCE_BYTES).toBe(100 * 1024 * 1024)
    expect(MAX_PPTX_FILE_BYTES).toBe(1024 * 1024 * 1024)
  })

  it('uses the canonical OOXML media types', () => {
    expect(DOCX_MIME_TYPE).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    )
    expect(PPTX_MIME_TYPE).toBe(
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    )
  })
})

describe('office source helpers', () => {
  it('maps each office MIME to its extension', () => {
    expect(officeSourceExtension(DOCX_MIME_TYPE)).toBe('docx')
    expect(officeSourceExtension(PPTX_MIME_TYPE)).toBe('pptx')
    expect(officeSourceExtension(XLSX_MIME_TYPE)).toBe('xlsx')
    expect(officeSourceExtension('application/pdf')).toBeNull()
  })

  it('recognises an extension only when it agrees with the type', () => {
    expect(officeSourceMimeFromFilename('Plan.DOCX')).toBe(DOCX_MIME_TYPE)
    expect(officeSourceMimeFromFilename('deck.pptx')).toBe(PPTX_MIME_TYPE)
    expect(officeSourceMimeFromFilename('book.xlsx')).toBe(XLSX_MIME_TYPE)
    expect(officeSourceMimeFromFilename('archive.zip')).toBeNull()
    expect(officeSourceMimeFromFilename('no-extension')).toBeNull()
  })

  it('caps document masters at the shared ceiling for all three types', () => {
    expect(officeCeilingFor(DOCX_MIME_TYPE, 'document')).toBe(MAX_OFFICE_SOURCE_BYTES)
    expect(officeCeilingFor(PPTX_MIME_TYPE, 'document')).toBe(MAX_OFFICE_SOURCE_BYTES)
    expect(officeCeilingFor(XLSX_MIME_TYPE, 'document')).toBe(MAX_OFFICE_SOURCE_BYTES)
  })

  it('keeps the larger ceiling for training PPTX decks only', () => {
    expect(officeCeilingFor(PPTX_MIME_TYPE, 'training')).toBe(MAX_PPTX_FILE_BYTES)
    expect(officeCeilingFor(XLSX_MIME_TYPE, 'training')).toBe(MAX_OFFICE_SOURCE_BYTES)
    expect(officeCeilingFor('application/pdf', 'training')).toBeNull()
  })
})
