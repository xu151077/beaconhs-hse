/**
 * Shared office-file ceilings for upload, editing, and background conversion.
 */
/**
 * Document masters (Word, PowerPoint or Excel) share one conversion ceiling
 * everywhere: upload, WOPI save, and version render must agree, or a file the
 * editor accepted becomes unpublishable. Training decks are the only larger
 * case, and only for PowerPoint (see `officeCeilingFor`).
 */
export const MAX_OFFICE_SOURCE_BYTES = 100 * 1024 * 1024
export const MAX_PPTX_FILE_BYTES = 1024 * 1024 * 1024

/** Which office ceiling a save belongs to. */
export type OfficeCeilingScope = 'document' | 'training'

/**
 * The byte ceiling for one office save. Document masters — all three types —
 * get the shared document ceiling; training decks (PowerPoint only) keep the
 * larger deck ceiling. One helper so the limit cannot drift per call site.
 */
export function officeCeilingFor(contentType: string, scope: OfficeCeilingScope): number | null {
  if (!isOfficeSourceMime(contentType)) return null
  if (scope === 'training' && contentType === PPTX_MIME_TYPE) return MAX_PPTX_FILE_BYTES
  return MAX_OFFICE_SOURCE_BYTES
}

export const DOCX_MIME_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

export const PPTX_MIME_TYPE =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation'

export const XLSX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

/**
 * The office formats a document working master may use.
 *
 * They are all converted to PDF by the same worker and rendered by the same
 * Collabora family, so the document module treats them as one source class
 * instead of three parallel flows.
 */
export const OFFICE_SOURCE_MIME_TYPES = [DOCX_MIME_TYPE, PPTX_MIME_TYPE, XLSX_MIME_TYPE] as const

export type OfficeSourceMime = (typeof OFFICE_SOURCE_MIME_TYPES)[number]

const MIME_EXTENSION: Record<OfficeSourceMime, 'docx' | 'pptx' | 'xlsx'> = {
  [DOCX_MIME_TYPE]: 'docx',
  [PPTX_MIME_TYPE]: 'pptx',
  [XLSX_MIME_TYPE]: 'xlsx',
}

const EXTENSION_MIME: Record<string, OfficeSourceMime> = {
  docx: DOCX_MIME_TYPE,
  pptx: PPTX_MIME_TYPE,
  xlsx: XLSX_MIME_TYPE,
}

export function isOfficeSourceMime(value: string): value is OfficeSourceMime {
  return (OFFICE_SOURCE_MIME_TYPES as readonly string[]).includes(value)
}

/** The extension LibreOffice needs to pick the right import filter. */
export function officeSourceExtension(mime: string): 'docx' | 'pptx' | 'xlsx' | null {
  return isOfficeSourceMime(mime) ? MIME_EXTENSION[mime] : null
}

/** The MIME implied by a filename extension, or null when it is not office. */
export function officeSourceMimeFromFilename(filename: string): OfficeSourceMime | null {
  const match = /\.([a-z0-9]+)$/i.exec(filename.trim())
  if (!match) return null
  return EXTENSION_MIME[match[1]!.toLowerCase()] ?? null
}
