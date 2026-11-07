import {
  MAX_OFFICE_SOURCE_BYTES,
  officeSourceExtension,
  officeSourceMimeFromFilename,
} from '@beaconhs/office/limits'

export const MAX_DOCUMENT_VERSION_NOTE_CHARS = 4_000

/** Human-readable list used by every refusal message about the master file. */
const DOCUMENT_MASTER_FORMATS = '.docx, .pptx or .xlsx'

/**
 * Allocate a new native publication as the next whole major revision.
 * Imported decimal revisions remain immutable history: publishing after 1.9
 * produces 2, never the misleading floating-point sequence 2.9.
 */
export function nextDocumentMajorVersion(latest: number | null | undefined): number {
  if (latest == null) return 1
  if (!Number.isFinite(latest) || latest < 0) {
    throw new Error('The latest document version is invalid')
  }
  return Math.floor(latest) + 1
}

export type DocumentMasterMetadata = {
  kind: string
  contentType: string
  sizeBytes: number
  filename: string
}

/**
 * The working master may be Word, PowerPoint or Excel. All three are converted
 * to the same PDF of record by the worker and edited through the matching
 * Collabora app, so the acceptance rule is one rule over one source class.
 *
 * The extension must agree with the declared MIME type: Collabora picks the
 * editor from the filename, and a `.docx` name on a spreadsheet body would
 * open the wrong app.
 */
export function documentMasterMetadataError(metadata: DocumentMasterMetadata): string | null {
  if (metadata.kind !== 'document') {
    return `The working document must be a ${DOCUMENT_MASTER_FORMATS} Office file`
  }
  const extension = officeSourceExtension(metadata.contentType)
  const filenameMime = officeSourceMimeFromFilename(metadata.filename)
  if (!extension || filenameMime !== metadata.contentType) {
    return `The working document must be a ${DOCUMENT_MASTER_FORMATS} Office file`
  }
  if (
    !Number.isSafeInteger(metadata.sizeBytes) ||
    metadata.sizeBytes <= 0 ||
    metadata.sizeBytes > MAX_OFFICE_SOURCE_BYTES
  ) {
    return 'The working document exceeds the 100 MB conversion limit'
  }
  return null
}
