import { describe, expect, it, beforeEach } from 'vitest'
import { resetIsolatedAlertReceiver, getIsolatedAlertReceiver } from './isolated-alert-receiver'
describe('ack debug', () => {
  beforeEach(() => resetIsolatedAlertReceiver())
  it('ack', async () => {
    const receiver = getIsolatedAlertReceiver()
    const ack = await receiver.acknowledge('a', 'r', 'admin@example.test')
    console.log('ACK', JSON.stringify(ack))
    expect(ack.acknowledgedBy).toBe('admin@example.test')
  })
})
