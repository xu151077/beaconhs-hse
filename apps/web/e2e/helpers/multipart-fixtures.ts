/**
 * Phase BQ — generate and hash a ≥256 MiB PDF fixture for multipart upload tests.
 *
 * The fixture is a structurally valid PDF with a 256 MiB embedded file stream.
 * A real trailer (`xref`, `startxref`, `%%EOF`) is mandatory: finalisation
 * rejects a PDF whose tail window carries no trailer, so a header plus padding
 * can never reach the stored-object assertion. Keeping the payload inside an
 * unreferenced `/EmbeddedFile` stream lets the PDF stay valid without asking
 * pdf.js to parse 256 MiB of page content.
 *
 * The file is stored at /tmp/opencode/bq-multipart-fixture.pdf.
 * The client-side SHA-256 hash is exported for verification in the E2E spec.
 */

import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'

const FIXTURE_PATH = '/tmp/opencode/bq-multipart-fixture.pdf'
const FIXTURE_SIZE = 256 * 1024 * 1024 // exactly the multipart threshold
const FIXTURE_HASH = '2874c2f8b60ac92b715d4a27a1d429f64302e56dd30a0eb74cce29ff5e4dd646'

// Generate the fixture once
let generated = false
let fixtureBuffer: Buffer | null = null

/** One xref entry is exactly 20 bytes, including its two-byte line ending. */
function xrefEntry(offset: number): string {
  return `${String(offset).padStart(10, '0')} 00000 n \n`
}

function generateFixture(): Buffer {
  if (generated) return fixtureBuffer!

  const header = Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'binary')
  const objects: Buffer[] = []
  const offsets: number[] = []
  let offset = header.length

  const addObject = (number: number, body: string): void => {
    offsets[number] = offset
    const object = Buffer.from(`${number} 0 obj\n${body}\nendobj\n`, 'latin1')
    objects.push(object)
    offset += object.length
  }

  addObject(1, '<< /Type /Catalog /Pages 2 0 R >>')
  addObject(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>')
  addObject(
    3,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 4 0 R >>',
  )
  addObject(4, '<< /Length 5 >>\nstream\nBT ET\nendstream')

  // Object 5 is the payload. Its stream length is computed so the finished file
  // is exactly FIXTURE_SIZE bytes. Nothing references it, so a viewer never has
  // to decompress or parse it.
  const object5Prefix = Buffer.from('5 0 obj\n<< /Type /EmbeddedFile /Length ', 'latin1')
  const object5StreamOpen = Buffer.from(' >>\nstream\n', 'latin1')
  const object5Suffix = Buffer.from('\nendstream\nendobj\n', 'latin1')
  const xrefHeader = Buffer.from('xref\n0 6\n0000000000 65535 f \n', 'latin1')
  const entriesLength = 5 * 20
  const trailerPrefix = Buffer.from('trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n', 'latin1')
  // startxref points at the xref keyword; its numeric width is fixed by the
  // size of the file, so reserve 10 digits plus the final newline and %%EOF.
  const trailerSuffix = Buffer.from('\n%%EOF\n', 'latin1')
  const fixedWithoutPayload =
    header.length +
    objects.reduce((total, object) => total + object.length, 0) +
    object5Prefix.length +
    10 + // payload length digits, zero-padded below
    object5StreamOpen.length +
    object5Suffix.length +
    xrefHeader.length +
    entriesLength +
    trailerPrefix.length +
    10 +
    trailerSuffix.length

  const payloadLength = FIXTURE_SIZE - fixedWithoutPayload
  if (payloadLength < 1) throw new Error('fixture layout exceeds the target size')

  const payload = Buffer.alloc(payloadLength, 0x42)
  const object5 = Buffer.concat([
    object5Prefix,
    Buffer.from(String(payloadLength).padStart(10, '0'), 'latin1'),
    object5StreamOpen,
    payload,
    object5Suffix,
  ])
  offsets[5] = offset

  const xrefOffset = offset + object5.length
  const xref = Buffer.from(
    xrefHeader.toString('latin1') +
      offsets
        .slice(1)
        .map((entry) => xrefEntry(entry))
        .join(''),
    'latin1',
  )
  const startxref = `${String(xrefOffset).padStart(10, '0')}`
  const trailer = Buffer.from(
    trailerPrefix.toString('latin1') + startxref + trailerSuffix.toString('latin1'),
    'latin1',
  )

  const file = Buffer.concat([header, ...objects, object5, xref, trailer])
  if (file.length !== FIXTURE_SIZE) {
    throw new Error(`fixture is ${file.length} bytes, expected ${FIXTURE_SIZE}`)
  }

  fixtureBuffer = file
  writeFileSync(FIXTURE_PATH, file, { flag: 'w' })
  generated = true
  return file
}

export function getFixturePath(): string {
  return FIXTURE_PATH
}

export function getFixtureHash(): string {
  return FIXTURE_HASH
}

export function computeFixtureHash(buffer?: Buffer): string {
  const buf = buffer ?? generateFixture()
  return createHash('sha256').update(buf).digest('hex')
}

export function getFixtureSize(): number {
  return FIXTURE_SIZE
}
