import { createNoOpInFlightWriteTracker, registerInFlightWriteTracker } from './freeze-gate'

// Default all storage tests to a non-tracking, always-succeeding tracker. Tests
// that need to assert "tracker absent => refuse" register null explicitly.
registerInFlightWriteTracker(createNoOpInFlightWriteTracker())

import { createNoOpStorageWriteArmIssuer, registerStorageWriteArmIssuer } from './write-arms'

// Default all storage tests to a no-op arm issuer so presign helpers can run in a
// standalone process. Tests that must assert "issuer absent => refuse" register null.
registerStorageWriteArmIssuer(createNoOpStorageWriteArmIssuer())
