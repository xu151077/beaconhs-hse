import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { attachmentUrl, validateAttachmentCapability } from './attachment-url'

/**
 * Historical v1 capability for the same id, recomputed with the local fallback
 * secret the module uses outside production. The v2 namespace must reject it:
 * every persisted v1 link has to die on the v2 rollout.
 */
function v1Capability(attachmentId: string): string {
  const configured = process.env.ATTACHMENT_CAPABILITY_SECRET
  const secret =
    configured && configured.length >= 32
      ? configured
      : 'beaconhs-local-attachment-capability-secret'
  return createHmac('sha256', secret).update(`attachment:v1:${attachmentId}`).digest('base64url')
}

describe('attachmentUrl', () => {
  it('returns the stable authenticated attachment route', () => {
    const id = '10000000-0000-4000-8000-000000000001'
    const url = attachmentUrl(id)
    expect(url).toMatch(
      /^\/api\/attachments\/10000000-0000-4000-8000-000000000001\?cap=[A-Za-z0-9_-]{43}$/,
    )
    expect(
      validateAttachmentCapability(id, new URL(url, 'http://localhost').searchParams.get('cap')!),
    ).toBe(true)
    expect(validateAttachmentCapability(id, '')).toBe(false)
    expect(validateAttachmentCapability(id, 'A'.repeat(43))).toBe(false)
    expect(
      validateAttachmentCapability(
        '20000000-0000-4000-8000-000000000002',
        new URL(url, 'http://localhost').searchParams.get('cap')!,
      ),
    ).toBe(false)
  })

  it('rejects historical v1 capabilities even for the matching attachment', () => {
    const id = '10000000-0000-4000-8000-000000000001'
    const minted = attachmentUrl(id)
    const currentCap = new URL(minted, 'http://localhost').searchParams.get('cap')!
    const historicalCap = v1Capability(id)
    expect(historicalCap).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(historicalCap).not.toBe(currentCap)
    expect(validateAttachmentCapability(id, historicalCap)).toBe(false)
  })
})
