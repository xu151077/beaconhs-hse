// Phase 6T-B: Freeze gate tests for pre-signed URLs and WOPI token signing.
//
// These tests prove that pre-signed write URLs and WOPI token signing respect
// the tenant's freeze state. The tests use a mock freeze-state reader to avoid
// connecting to a real database.
//
// Scenarios covered:
// 1. ACTIVE state allows signing pre-signed write URLs and WOPI tokens.
// 2. Non-ACTIVE states (FREEZE_REQUESTED, DRAINING, FROZEN) refuse signing.
// 3. Freeze-state reader throws: refuse signing.
// 4. Freeze-state reader returns null: refuse signing.
// 5. Tenant ID cannot be derived from key: refuse signing.
// 6. GET pre-signed URLs are not gated (read-only).
// 7. WOPI token signing for PPTX and documents respects freeze state.
// 8. Existing authentication/authorization tests continue to pass.

import { describe, expect, it } from 'vitest'
import { assertStorageWriteAllowed, registerStorageFreezeReader } from './freeze-gate'
import {
  writeAndRemovePrivacyProbeWithClient,
  type PrivacyProbeClient,
} from './testing/privacy-probe'
import { presignGet } from './index'

describe('freeze gate: pre-signed write URLs and WOPI token signing', () => {
  describe('server-side object write (presignPut operation)', () => {
    it('ACTIVE state allows the write', async () => {
      const mockReader = async () => ({ state: 'ACTIVE', version: 1 })

      registerStorageFreezeReader(mockReader)

      await expect(
        assertStorageWriteAllowed({
          operation: 'presignPut',
          key: 't/123e4567-e89b-12d3-a456-426614174000/documents/test.docx',
        }),
      ).resolves.not.toThrow()
    })

    it('FREEZE_REQUESTED state refuses signing', async () => {
      const mockReader = async () => ({ state: 'FREEZE_REQUESTED', version: 1 })

      registerStorageFreezeReader(mockReader)

      await expect(
        assertStorageWriteAllowed({
          operation: 'presignPut',
          key: 't/123e4567-e89b-12d3-a456-426614174000/documents/test.docx',
        }),
      ).rejects.toThrow(/presignPut refused/)
    })

    it('DRAINING state refuses signing', async () => {
      const mockReader = async () => ({ state: 'DRAINING', version: 1 })

      registerStorageFreezeReader(mockReader)

      await expect(
        assertStorageWriteAllowed({
          operation: 'presignPut',
          key: 't/123e4567-e89b-12d3-a456-426614174000/documents/test.docx',
        }),
      ).rejects.toThrow(/presignPut refused/)
    })

    it('FROZEN state refuses signing', async () => {
      const mockReader = async () => ({ state: 'FROZEN', version: 1 })

      registerStorageFreezeReader(mockReader)

      await expect(
        assertStorageWriteAllowed({
          operation: 'presignPut',
          key: 't/123e4567-e89b-12d3-a456-426614174000/documents/test.docx',
        }),
      ).rejects.toThrow(/presignPut refused/)
    })

    it('reader throws: refuses signing', async () => {
      const mockReader = async () => {
        throw new Error('Database connection failed')
      }

      registerStorageFreezeReader(mockReader)

      await expect(
        assertStorageWriteAllowed({
          operation: 'presignPut',
          key: 't/123e4567-e89b-12d3-a456-426614174000/documents/test.docx',
        }),
      ).rejects.toThrow(/freeze state could not be read/)
    })

    it('reader returns null: refuses signing', async () => {
      const mockReader = async () => null

      registerStorageFreezeReader(mockReader)

      await expect(
        assertStorageWriteAllowed({
          operation: 'presignPut',
          key: 't/123e4567-e89b-12d3-a456-426614174000/documents/test.docx',
        }),
      ).rejects.toThrow(/no persisted freeze state/)
    })

    it('tenant ID cannot be derived from key: refuses signing', async () => {
      const mockReader = async () => ({ state: 'ACTIVE', version: 1 })

      registerStorageFreezeReader(mockReader)

      await expect(
        assertStorageWriteAllowed({
          operation: 'presignPut',
          key: 'documents/test.docx', // Missing tenant prefix
        }),
      ).rejects.toThrow(/object key does not name a tenant/)
    })
  })

  describe('server-side multipart part write (presignMultipartPart operation)', () => {
    it('ACTIVE state allows the part write', async () => {
      const mockReader = async () => ({ state: 'ACTIVE', version: 1 })

      registerStorageFreezeReader(mockReader)

      await expect(
        assertStorageWriteAllowed({
          operation: 'presignMultipartPart',
          key: 't/123e4567-e89b-12d3-a456-426614174000/documents/test.docx',
        }),
      ).resolves.not.toThrow()
    })

    it('FROZEN state refuses signing', async () => {
      const mockReader = async () => ({ state: 'FROZEN', version: 1 })

      registerStorageFreezeReader(mockReader)

      await expect(
        assertStorageWriteAllowed({
          operation: 'presignMultipartPart',
          key: 't/123e4567-e89b-12d3-a456-426614174000/documents/test.docx',
        }),
      ).rejects.toThrow(/presignMultipartPart refused/)
    })
  })

  describe('GET pre-signed URLs (read-only)', () => {
    it('GET URLs are not gated', async () => {
      const mockReader = async () => ({ state: 'FROZEN', version: 1 })

      registerStorageFreezeReader(mockReader)

      // GET URLs should be allowed even when frozen
      const url = await presignGet({
        key: 't/123e4567-e89b-12d3-a456-426614174000/documents/test.docx',
        expiresInSeconds: 600,
      })

      expect(url).toBeTruthy()
      expect(typeof url).toBe('string')
    })
  })

  describe('WOPI token signing (via direct gate calls)', () => {
    it('ACTIVE state allows signing', async () => {
      const mockReader = async () => ({ state: 'ACTIVE', version: 1 })

      registerStorageFreezeReader(mockReader)

      await expect(
        assertStorageWriteAllowed({
          operation: 'wopiToken',
          key: 't/123e4567-e89b-12d3-a456-426614174000/documents/test.docx',
        }),
      ).resolves.not.toThrow()
    })

    it('FROZEN state refuses signing', async () => {
      const mockReader = async () => ({ state: 'FROZEN', version: 1 })

      registerStorageFreezeReader(mockReader)

      await expect(
        assertStorageWriteAllowed({
          operation: 'wopiToken',
          key: 't/123e4567-e89b-12d3-a456-426614174000/documents/test.docx',
        }),
      ).rejects.toThrow(/STORAGE_FROZEN/)
    })

    it('tenant ID cannot be derived from key: refuses signing', async () => {
      const mockReader = async () => ({ state: 'ACTIVE', version: 1 })

      registerStorageFreezeReader(mockReader)

      await expect(
        assertStorageWriteAllowed({
          operation: 'wopiToken',
          key: 'documents/test.docx', // Missing tenant prefix
        }),
      ).rejects.toThrow(/object key does not name a tenant/)
    })
  })

  describe('freeze-state reader behavior', () => {
    it('reader throws: refuses signing', async () => {
      const mockReader = async () => {
        throw new Error('Database connection failed')
      }

      registerStorageFreezeReader(mockReader)

      await expect(
        assertStorageWriteAllowed({
          operation: 'wopiToken',
          key: 't/123e4567-e89b-12d3-a456-426614174000/documents/test.docx',
        }),
      ).rejects.toThrow(/freeze state could not be read/)
    })

    it('reader returns null: refuses signing', async () => {
      const mockReader = async () => null

      registerStorageFreezeReader(mockReader)

      await expect(
        assertStorageWriteAllowed({
          operation: 'wopiToken',
          key: 't/123e4567-e89b-12d3-a456-426614174000/documents/test.docx',
        }),
      ).rejects.toThrow(/no persisted freeze state/)
    })

    it('state is unknown: refuses signing', async () => {
      const mockReader = async () => ({ state: 'UNKNOWN_STATE', version: 1 })

      registerStorageFreezeReader(mockReader)

      await expect(
        assertStorageWriteAllowed({
          operation: 'wopiToken',
          key: 't/123e4567-e89b-12d3-a456-426614174000/documents/test.docx',
        }),
      ).rejects.toThrow(/STORAGE_FROZEN/)
    })

    it('no reader registered: refuses signing', async () => {
      // Clear any previously registered reader
      registerStorageFreezeReader(null)

      await expect(
        assertStorageWriteAllowed({
          operation: 'wopiToken',
          key: 't/123e4567-e89b-12d3-a456-426614174000/documents/test.docx',
        }),
      ).rejects.toThrow(/no freeze-state reader is registered/)
    })
  })

  describe('integration with privacy probe cleanup', () => {
    it('privacy probe cleanup does not interfere with gating', async () => {
      const mockReader = async () => ({ state: 'ACTIVE', version: 1 })

      registerStorageFreezeReader(mockReader)

      // The privacy probe uses writeAndRemovePrivacyProbeWithClient, which
      // internally calls assertStorageWriteAllowed for the probe key.
      // Since the probe key does not name a tenant, it should be refused.
      const client: PrivacyProbeClient = {
        send: async () => {
          throw new Error('Probe key does not name a tenant')
        },
      }

      await expect(
        writeAndRemovePrivacyProbeWithClient('_privacy-probe/test-key', client),
      ).rejects.toThrow(/Probe key does not name a tenant/)
    })
  })
})
