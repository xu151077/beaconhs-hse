// Backfill the reference catalogues for tenants provisioned before the
// provisioning seeder covered them (inspection banks/types, equipment,
// person groups, skill catalogue, PDF templates, register apps, work permit).
//
// Every seeder below is idempotent and add-only: existing rows — including
// administrator edits and deletions of seeded templates — are respected, and
// re-running the command changes nothing.
//
// Run with an env file that holds SUPERADMIN_DATABASE_URL, e.g.:
//   pnpm --filter @beaconhs/db exec tsx --env-file=/path/to/runtime.env \
//     src/scripts/backfill-reference-catalogues.cli.ts [--tenant <slug>]

import { eq } from 'drizzle-orm'
import type { SeedTx } from '../seed/types'
import { createSuperClient } from '../client'
import { tenants } from '../schema'
import { seedDocumentTypesAndCategories } from '../seed/document-types-and-categories'
import { seedPpeTypesWithCriteria } from '../seed/ppe-types'
import { seedHazidLibraries } from '../seed/hazid-libraries'
import { seedTrainingAssessmentTypes } from '../seed/training-assessment-types'
import { seedIncidentTaxonomy } from '../seed/incident-taxonomy'
import { seedInspectionBanks } from '../seed/inspection-banks'
import { seedInspectionTypes } from '../seed/inspection-types'
import { seedPersonGroups } from '../seed/person-groups'
import { seedSkillCatalogue } from '../seed/skill-catalogue'
import { seedPhase11EEquipment } from '../seed/phase11e-equipment'
import { seedPhase11EDocumentCategories } from '../seed/phase11e-document-categories'
import { seedPhase11ERegisterApps } from '../seed/phase11e-register-apps'
import { seedPdfTemplates, seedFormPdfTemplates } from '../seed/pdf-templates'
import { seedWorkPermitTemplate } from '../seed/work-permit-template'
import { seedToolboxTemplate } from '../seed/toolbox-template'
import { seedPpeCriteriaBanks } from '../seed/ppe-criteria-banks'
import { seedEmailTemplates } from '../seed/email-templates'
import { seedDataSources } from '../seed/data-sources'

// `tx` is typed per seeder at the call site: the seeders declare Pick<Database, ...>
// subsets, and the transaction object satisfies all of them.
const STEPS: Array<{ name: string; run: (tx: SeedTx, tenantId: string) => Promise<unknown> }> = [
  { name: 'document types + categories', run: (tx, id) => seedDocumentTypesAndCategories(tx, id) },
  { name: 'PPE types + criteria', run: (tx, id) => seedPpeTypesWithCriteria(tx, id) },
  { name: 'HAZID libraries', run: (tx, id) => seedHazidLibraries(tx, id) },
  { name: 'training assessment types', run: (tx, id) => seedTrainingAssessmentTypes(tx, id) },
  { name: 'incident taxonomy', run: (tx, id) => seedIncidentTaxonomy(tx, id) },
  { name: 'inspection banks', run: (tx, id) => seedInspectionBanks(tx, id) },
  { name: 'inspection types', run: (tx, id) => seedInspectionTypes(tx, id) },
  { name: 'person groups', run: (tx, id) => seedPersonGroups(tx, id) },
  { name: 'skill catalogue', run: (tx, id) => seedSkillCatalogue(tx, id) },
  { name: 'equipment catalogue', run: (tx, id) => seedPhase11EEquipment(tx as never, id) },
  {
    name: 'phase 11E document categories',
    run: (tx, id) => seedPhase11EDocumentCategories(tx as never, id),
  },
  { name: 'phase 11E register apps', run: (tx, id) => seedPhase11ERegisterApps(tx as never, id) },
  { name: 'PDF templates', run: (tx, id) => seedPdfTemplates(tx as never, id) },
  { name: 'form PDF templates', run: (tx, id) => seedFormPdfTemplates(tx as never, id) },
  { name: 'work permit template', run: (tx, id) => seedWorkPermitTemplate(tx as never, id) },
  { name: 'toolbox template', run: (tx, id) => seedToolboxTemplate(tx as never, id) },
  { name: 'PPE criteria banks', run: (tx, id) => seedPpeCriteriaBanks(tx, id) },
  { name: 'email templates', run: (tx, id) => seedEmailTemplates(tx, id) },
  { name: 'data sources', run: (tx, id) => seedDataSources(tx, id) },
]

function argValue(flag: string): string | null {
  const index = process.argv.indexOf(flag)
  if (index === -1) return null
  const value = process.argv[index + 1]
  // `--tenant` with no value silently selecting EVERY tenant is a foot-gun
  // for a command that mutates production catalogues: refuse instead.
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a tenant slug value.`)
  }
  return value
}

async function main(): Promise<void> {
  const { db } = createSuperClient({ max: 1 })
  const slug = argValue('--tenant')
  const rows = await db
    .select({ id: tenants.id, slug: tenants.slug, name: tenants.name })
    .from(tenants)
    .where(slug ? eq(tenants.slug, slug) : undefined)
  if (rows.length === 0) {
    throw new Error(slug ? `No tenant with slug "${slug}".` : 'No tenants found.')
  }

  for (const tenant of rows) {
    process.stdout.write(`tenant ${tenant.slug ?? tenant.id} (${tenant.name})\n`)
    // One transaction per tenant: a mid-tenant failure rolls that tenant's
    // whole backfill back rather than leaving half-seeded catalogues.
    await db.transaction(async (tx) => {
      for (const step of STEPS) {
        await step.run(tx as SeedTx, tenant.id)
        process.stdout.write(`  ok  ${step.name}\n`)
      }
    })
  }
  process.stdout.write('backfill complete\n')
}

main()
  .catch((error) => {
    process.stderr.write(
      `backfill-reference-catalogues: ${error instanceof Error ? error.message : String(error)}\n`,
    )
    process.exitCode = 1
  })
  .finally(() => process.exit())
