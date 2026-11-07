import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RequestContext } from '@beaconhs/tenant'
import { createCorrectiveActionForFailedPpeInspection } from './_lib'

const mocks = vi.hoisted(() => ({
  recordDomainEvent: vi.fn(async () => 'event-1'),
  moduleFlowCommand: vi.fn(() => ({ moduleKey: 'corrective-actions' })),
  correctiveActionCreatedEvent: vi.fn(() => ({ type: 'corrective_action.created' })),
  recordAuditInTransaction: vi.fn(async () => undefined),
  materializeEvidenceTargetObligations: vi.fn(async () => undefined),
  nextReference: vi.fn(async () => 'CA-2026-0001'),
}))

vi.mock('@beaconhs/events', () => ({
  recordDomainEvent: mocks.recordDomainEvent,
  moduleFlowCommand: mocks.moduleFlowCommand,
}))
vi.mock('@beaconhs/integrations', () => ({
  correctiveActionCreatedEvent: mocks.correctiveActionCreatedEvent,
}))
vi.mock('@beaconhs/compliance', () => ({
  materializeEvidenceTargetObligations: mocks.materializeEvidenceTargetObligations,
}))
vi.mock('@/lib/audit', () => ({
  recordAuditInTransaction: mocks.recordAuditInTransaction,
}))
vi.mock('@/lib/reference', () => ({ nextReference: mocks.nextReference }))

const CA_ID = '1a000000-0000-4000-8000-0000000000ca'
const INSPECTION_ID = '1a000000-0000-4000-8000-0000000000in'
const ITEM_ID = '1a000000-0000-4000-8000-0000000000it'
const TENANT_ID = '1a000000-0000-4000-8000-0000000000te'

function context(): RequestContext {
  return {
    tenantId: TENANT_ID,
    userId: 'user-1',
    membership: { id: 'membership-1' },
  } as unknown as RequestContext
}

function transaction() {
  const returning = vi.fn(async () => [
    {
      id: CA_ID,
      reference: 'CA-2026-0001',
      title: 'Replace damaged harness',
      status: 'open',
      severity: 'high',
      source: 'inspection',
      dueOn: '2026-10-25',
      assignedOn: '2026-10-22',
    },
  ])
  const values = vi.fn(() => ({ returning }))
  const insert = vi.fn(() => ({ values }))
  return { tx: { insert } as never, insert, values, returning }
}

describe('PPE failed-inspection corrective action', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('queues the corrective_action.created domain event that drives notification and integration fan-out', async () => {
    const { tx, values } = transaction()

    await expect(
      createCorrectiveActionForFailedPpeInspection(tx, context(), {
        inspectionId: INSPECTION_ID,
        itemId: ITEM_ID,
        title: 'Replace damaged harness',
        description: 'Harness webbing is cut.',
        severity: 'high',
        siteOrgUnitId: null,
      }),
    ).resolves.toBe(CA_ID)

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        reference: 'CA-2026-0001',
        sourceEntityType: 'ppe_inspection',
        sourceEntityId: INSPECTION_ID,
      }),
    )
    expect(mocks.recordDomainEvent).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        tenantId: TENANT_ID,
        eventType: 'corrective_action.created',
        subjectId: CA_ID,
        dedupKey: `corrective_action.created:${CA_ID}`,
        payload: expect.objectContaining({
          notification: { kind: 'corrective_action_assigned', caId: CA_ID },
          integration: { type: 'corrective_action.created' },
          web: { moduleKey: 'corrective-actions' },
        }),
      }),
    )
    expect(mocks.correctiveActionCreatedEvent).toHaveBeenCalledWith(
      TENANT_ID,
      expect.objectContaining({ id: CA_ID, reference: 'CA-2026-0001', dueOn: '2026-10-25' }),
    )
  })
})
