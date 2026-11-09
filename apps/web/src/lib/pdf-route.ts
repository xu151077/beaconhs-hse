import { NextResponse } from 'next/server'
import {
  renderPdfOnDemand,
  type OnDemandPdfJobData,
  type RenderedPdfArtifact,
} from '@beaconhs/jobs'
import { deleteObject, getObject } from '@beaconhs/storage'

function safePdfFilename(filename: string | null | undefined): string {
  const safe = (filename || 'download.pdf').replace(/["\r\n]/g, '_')
  return safe.toLowerCase().endsWith('.pdf') ? safe : `${safe}.pdf`
}

function errorStatus(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error)
  if (/not found/i.test(message)) return 404
  if (/timeout|timed out/i.test(message)) return 504
  return 500
}

function errorMessage(): string {
  // Worker/render errors are logged server-side. The client only needs to know
  // that rendering failed, not the internal exception text.
  return 'PDF render failed'
}

export function pdfBufferResponse(pdf: Buffer, filename: string): Response {
  const originalFilename = filename || 'document.pdf'
  const sanitizedFilename =
    originalFilename
      .replace(/["\r\n]/g, '_')
      .replace(/^[^a-zA-Z0-9]/, '_')
      .substring(0, 200) || 'document.pdf'
  const encodedFilename = encodeURIComponent(originalFilename)
  return new Response(new Uint8Array(pdf), {
    headers: {
      'Cache-Control': 'no-store',
      'Content-Disposition': `inline; filename="${sanitizedFilename}"; filename*=utf-8''${encodedFilename}`,
      'Content-Length': String(pdf.length),
      'Content-Type': 'application/pdf',
    },
  })
}

export async function storedPdfArtifactResponse(
  artifact: Pick<RenderedPdfArtifact, 'r2Key' | 'filename'>,
): Promise<Response> {
  const pdf = await getObject({ key: artifact.r2Key })
  return pdfBufferResponse(pdf, artifact.filename)
}

export async function renderOnDemandPdfResponse(data: OnDemandPdfJobData): Promise<Response> {
  let artifact: RenderedPdfArtifact
  try {
    artifact = await renderPdfOnDemand(data, { timeoutMs: 90_000 })
  } catch (error) {
    console.error('[pdf] on-demand render failed', error)
    return NextResponse.json({ error: errorMessage() }, { status: errorStatus(error) })
  }

  try {
    const pdf = await getObject({ key: artifact.r2Key })
    try {
      await deleteObject({ key: artifact.r2Key })
    } catch (deleteError) {
      console.warn(
        `[pdf] transient rendered artifact could not be deleted: ${artifact.r2Key}`,
        deleteError,
      )
    }
    return pdfBufferResponse(pdf, artifact.filename)
  } catch (error) {
    console.error(`[pdf] rendered artifact could not be read: ${artifact.r2Key}`, error)
    return NextResponse.json(
      { error: 'Rendered PDF could not be read from storage' },
      { status: 502 },
    )
  }
}
