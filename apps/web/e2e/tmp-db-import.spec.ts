import { test, expect } from '@playwright/test'
import {
  readFreezeState,
  applyTransition,
  ensureFreezeRow,
  bootstrapStorageFreezeGate,
} from '@beaconhs/db'
import * as storage from '@beaconhs/storage'

test('db + storage import works inside a playwright spec', async () => {
  expect(typeof readFreezeState).toBe('function')
  expect(typeof applyTransition).toBe('function')
  expect(typeof ensureFreezeRow).toBe('function')
  expect(typeof bootstrapStorageFreezeGate).toBe('function')
  expect(typeof storage.assertStorageWriteAllowed).toBe('function')
})
