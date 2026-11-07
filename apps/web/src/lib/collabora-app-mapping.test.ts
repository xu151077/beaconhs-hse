import { describe, expect, it } from 'vitest'
import { DOCX_MIME_TYPE, PPTX_MIME_TYPE, XLSX_MIME_TYPE } from '@beaconhs/office/limits'
import { collaboraAppForMime } from './collabora'

describe('collabora app mapping', () => {
  it('maps each document master type to its editor', () => {
    expect(collaboraAppForMime(DOCX_MIME_TYPE)).toBe('text')
    expect(collaboraAppForMime(PPTX_MIME_TYPE)).toBe('presentation')
    expect(collaboraAppForMime(XLSX_MIME_TYPE)).toBe('spreadsheet')
  })

  it('treats anything else as a writer document instead of refusing to open', () => {
    expect(collaboraAppForMime('application/octet-stream')).toBe('text')
  })
})
