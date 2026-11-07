import { describe, expect, it } from 'vitest'
import { workOrderStatus } from '@beaconhs/db/schema'
import { MODULE_FLOW_PROFILES } from './module-profiles'

describe('equipment work-order flow profile', () => {
  it('exposes every real work-order status to status-change triggers and conditions', () => {
    // The UI filter, the database enum and the flow profile are three views of
    // one state machine. The profile previously omitted `repaired` and
    // `verified`, so a flow could not branch on two states the UI offers.
    const statusValues = MODULE_FLOW_PROFILES.equipment?.statusValues
    expect(statusValues).toBeDefined()
    expect([...(statusValues ?? [])].sort()).toEqual([...workOrderStatus.enumValues].sort())
  })
})
