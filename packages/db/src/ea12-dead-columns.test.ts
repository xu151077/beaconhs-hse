import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { getTableColumns } from 'drizzle-orm'
import { equipmentInspectionRecords } from './schema/equipment-inspection-records'
import { trainingEnrollments } from './schema/training-lms'

// D3: three columns had no reader; the only references were two write-only
// enrollment assignments that were removed with the columns. Removing them is a
// schema change, so the regression test pins both halves: the Drizzle tables
// must not declare them again, and the drop migration must remain in the journal
// chain that upgrades an existing database.

const dropMigration = readFileSync(
  new URL('../drizzle/0051_ea12_drop_dead_columns.sql', import.meta.url),
  'utf8',
)

describe('EA-12 dead-column removal', () => {
  it('removes the dead columns from the runtime schema', () => {
    expect(Object.keys(getTableColumns(trainingEnrollments))).not.toContain('dueOn')
    expect(Object.keys(getTableColumns(trainingEnrollments))).not.toContain('expiresOn')
    expect(Object.keys(getTableColumns(equipmentInspectionRecords))).not.toContain('certificate')
  })

  it('keeps the forward migration that drops them', () => {
    expect(dropMigration).toContain('ALTER TABLE "training_enrollments" DROP COLUMN "due_on";')
    expect(dropMigration).toContain('ALTER TABLE "training_enrollments" DROP COLUMN "expires_on";')
    expect(dropMigration).toContain(
      'ALTER TABLE "equipment_inspection_records" DROP COLUMN "certificate";',
    )
  })
})
