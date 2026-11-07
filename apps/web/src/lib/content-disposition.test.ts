import { describe, expect, it } from 'vitest'
import { contentDisposition } from './content-disposition'

// The two parameters browsers read, in priority order. A regression here means a
// download is saved under a sanitized storage key instead of the document's name.
function plainParam(header: string): string {
  return header.split('filename="')[1]!.split('"')[0]!
}

function extendedParam(header: string): string {
  return header.split("filename*=UTF-8''")[1]!
}

describe('contentDisposition', () => {
  it('keeps an ASCII filename verbatim in both parameters', () => {
    expect(contentDisposition('attachment', 'report.pdf', 'document.pdf')).toBe(
      'attachment; filename="report.pdf"; filename*=UTF-8\'\'report.pdf',
    )
  })

  it('gives a Chinese name an ASCII fallback and the exact Unicode name', () => {
    const header = contentDisposition('attachment', '测试文档.docx', 'document.docx')
    expect(header).toBe(
      'attachment; filename="_.docx"; filename*=UTF-8\'\'%E6%B5%8B%E8%AF%95%E6%96%87%E6%A1%A3.docx',
    )
    // RFC 6266 requires the whole header to be ASCII: raw UTF-8 in the plain
    // parameter is what this test used to catch.
    expect(header).toMatch(/^[\x20-\x7E]+$/)
    expect(decodeURIComponent(extendedParam(header))).toBe('测试文档.docx')
  })

  it('never leaves a quote, backslash or control character in the plain parameter', () => {
    const header = contentDisposition('inline', 'a"b\\c\r\n.pdf', 'fallback.pdf')
    expect(plainParam(header)).not.toMatch(/["\\\r\n]/)
    expect(plainParam(header)).toBe('a_b_c_.pdf')
  })

  it('percent-encodes the RFC 5987 exclusions that encodeURIComponent leaves alone', () => {
    const header = contentDisposition('attachment', "o'brien's (draft)*!.pdf", 'fallback.pdf')
    expect(extendedParam(header)).toBe('o%27brien%27s%20%28draft%29%2A%21.pdf')
    expect(decodeURIComponent(extendedParam(header))).toBe("o'brien's (draft)*!.pdf")
  })

  it('falls back when the name has no meaningful ASCII left', () => {
    expect(plainParam(contentDisposition('attachment', '中文', 'document.docx'))).toBe(
      'document.docx',
    )
  })

  it('uses the fallback for an empty name', () => {
    expect(contentDisposition('attachment', '', 'document.docx')).toBe(
      'attachment; filename="document.docx"; filename*=UTF-8\'\'document.docx',
    )
  })

  it('trims surrounding whitespace out of the stored name', () => {
    expect(contentDisposition('attachment', '  policy 2026.pdf  ', 'document.pdf')).toBe(
      'attachment; filename="policy 2026.pdf"; filename*=UTF-8\'\'policy%202026.pdf',
    )
  })
})
