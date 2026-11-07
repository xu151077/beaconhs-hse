import { describe, expect, it } from 'vitest'
import {
  isPdfUpload,
  uploadContentDisposition,
  uploadContentTypeError,
  uploadedFileHeaderError,
  uploadedFileTailError,
} from './upload-policy'

describe('upload policy', () => {
  it('blocks browser-executable content and cross-kind claims', () => {
    expect(uploadContentTypeError('image', 'image/svg+xml')).toMatch(/not allowed/)
    expect(uploadContentTypeError('image', 'text/html')).toMatch(/not allowed/)
    expect(uploadContentTypeError('signature', 'image/webp')).toMatch(/PNG or JPEG/)
    expect(uploadContentTypeError('document', 'application/pdf')).toBeNull()
  })

  it('checks magic bytes for inline-safe formats', () => {
    expect(
      uploadedFileHeaderError(
        'image',
        'image/png',
        Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      ),
    ).toBeNull()
    expect(
      uploadedFileHeaderError('image', 'image/png', new TextEncoder().encode('<html>')),
    ).toMatch(/do not match/)
    expect(
      uploadedFileHeaderError('document', 'application/pdf', new TextEncoder().encode('%PDF-1.7')),
    ).toBeNull()
  })

  it('forces active or unknown downloads to attachment disposition', () => {
    expect(uploadContentDisposition('image', 'image/png')).toBe('inline')
    expect(uploadContentDisposition('signature', 'image/png')).toBe('inline')
    expect(uploadContentDisposition('document', 'application/pdf')).toBe('inline')
    expect(uploadContentDisposition('other', 'application/octet-stream')).toBe('attachment')
  })

  it('accepts only PDFs that end in a real trailer', () => {
    const tail = (text: string) => new TextEncoder().encode(text)
    const complete =
      '%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\nxref\n0 2\n0000000000 65535 f \n' +
      'trailer\n<< /Size 2 /Root 1 0 R >>\nstartxref\n9\n%%EOF\n'

    expect(uploadedFileTailError('document', 'application/pdf', tail(complete))).toBeNull()
    // Trailing whitespace after the marker is allowed by the format.
    expect(uploadedFileTailError('document', 'application/pdf', tail(`${complete}\n`))).toBeNull()
    expect(isPdfUpload('application/pdf')).toBe(true)
    expect(isPdfUpload('application/pdf; charset=binary')).toBe(true)
    // Only PDFs are checked; every other kind keeps its header-only validation.
    expect(uploadedFileTailError('document', 'text/plain', tail('no trailer here'))).toBeNull()
  })

  it('rejects a PDF that is truncated, empty, or not a PDF at all', () => {
    const tail = (text: string) => new TextEncoder().encode(text)

    // The Phase BQ fixture shape: a PDF header followed by 256 MiB of one byte.
    expect(
      uploadedFileTailError('document', 'application/pdf', tail('%PDF-1.7\nAAAAAAAAAAAA')),
    ).toMatch(/incomplete or damaged/)
    expect(uploadedFileTailError('document', 'application/pdf', tail(''))).toMatch(
      /incomplete or damaged/,
    )
    // A marker pair split the wrong way is still not a usable trailer.
    expect(uploadedFileTailError('document', 'application/pdf', tail('startxref\n9'))).toMatch(
      /incomplete or damaged/,
    )
    expect(uploadedFileTailError('document', 'application/pdf', tail('%%EOF\n'))).toMatch(
      /incomplete or damaged/,
    )
    // startxref that appears only after the end marker does not count.
    expect(
      uploadedFileTailError('document', 'application/pdf', tail('%%EOF\nstartxref\n2\n')),
    ).toMatch(/incomplete or damaged/)
  })
})
