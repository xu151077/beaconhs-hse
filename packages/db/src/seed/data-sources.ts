// Starter data sources — the lookup substrate Builder apps bind to.
//
// Pure per-tenant reference data:
//   - two `reference` sources whose rows mirror the tenant's own org structure
//     (sites/areas) and company register (contractors), so cascading dropdowns
//     and lookup auto-fill work before anyone authors a row by hand;
//   - two `responses` sources bound to the built-in Work Permit and Lift Plan
//     apps, so KPIs/charts over real submissions work out of the box.
//
// Idempotent by (tenant, key): existing sources — renamed, edited or deleted —
// are left exactly as found. Reference rows are only inserted when the source
// is new, so a curator's edits are never overwritten.

import type { SeedTx } from './types'
import { and, eq } from 'drizzle-orm'
import { companies, dataSourceRows, dataSources, formTemplates, orgUnits } from '../schema'

type SourceSeed = {
  key: string
  name: string
  description: string
  kind: 'reference' | 'responses'
  columns: Array<{ key: string; label: string; type: 'text' | 'number' | 'date' | 'boolean' }>
  templateKey?: string
  buildRows?: (tx: SeedTx, tenantId: string) => Promise<Array<Record<string, unknown>>>
}

const SITES: SourceSeed = {
  key: 'starter-sites',
  name: 'Sites & areas',
  description: 'Organisation units, for cascading site/area dropdowns.',
  kind: 'reference',
  columns: [
    { key: 'name', label: 'Name', type: 'text' },
    { key: 'level', label: 'Level', type: 'text' },
  ],
  buildRows: async (tx, tenantId) => {
    const units = await tx
      .select({ name: orgUnits.name, level: orgUnits.level })
      .from(orgUnits)
      .where(eq(orgUnits.tenantId, tenantId))
      .orderBy(orgUnits.name)
    return units.map((u) => ({ name: u.name, level: u.level }))
  },
}

const CONTRACTORS: SourceSeed = {
  key: 'starter-contractors',
  name: 'Contractors',
  description: 'Company register, for contractor dropdowns.',
  kind: 'reference',
  columns: [
    { key: 'name', label: 'Company', type: 'text' },
    { key: 'type', label: 'Type', type: 'text' },
  ],
  buildRows: async (tx, tenantId) => {
    const rows = await tx
      .select({ name: companies.name, companyType: companies.type })
      .from(companies)
      .where(eq(companies.tenantId, tenantId))
      .orderBy(companies.name)
    return rows.map((c) => ({ name: c.name, type: c.companyType ?? '' }))
  },
}

const WORK_PERMIT_RESPONSES: SourceSeed = {
  key: 'starter-work-permit-responses',
  name: 'Work Permit submissions',
  description: 'Live rows from submitted Work Permit responses.',
  kind: 'responses',
  columns: [
    { key: 'title', label: 'Title', type: 'text' },
    { key: 'status', label: 'Status', type: 'text' },
    { key: 'submitted_at', label: 'Submitted', type: 'date' },
  ],
  templateKey: 'work-permit',
}

const LIFT_PLAN_RESPONSES: SourceSeed = {
  key: 'starter-lift-plan-responses',
  name: 'Lift Plan submissions',
  description: 'Live rows from submitted Lift Plan responses.',
  kind: 'responses',
  columns: [
    { key: 'title', label: 'Title', type: 'text' },
    { key: 'status', label: 'Status', type: 'text' },
    { key: 'submitted_at', label: 'Submitted', type: 'date' },
  ],
  templateKey: 'lift-plan',
}

const SEEDS: SourceSeed[] = [SITES, CONTRACTORS, WORK_PERMIT_RESPONSES, LIFT_PLAN_RESPONSES]

/** Insert the starter data sources for a tenant. Idempotent by key. */
export async function seedDataSources(tx: SeedTx, tenantId: string): Promise<void> {
  for (const seed of SEEDS) {
    const [already] = await tx
      .select({ id: dataSources.id })
      .from(dataSources)
      .where(and(eq(dataSources.tenantId, tenantId), eq(dataSources.key, seed.key)))
      .limit(1)
    if (already) continue

    let config: Record<string, unknown> = {}
    if (seed.kind === 'responses' && seed.templateKey) {
      const [template] = await tx
        .select({ id: formTemplates.id })
        .from(formTemplates)
        .where(and(eq(formTemplates.tenantId, tenantId), eq(formTemplates.key, seed.templateKey)))
        .limit(1)
      // Without the built-in app there is no response stream to bind to; the
      // source would be an empty shell, so skip it for this tenant.
      if (!template) continue
      config = { templateId: template.id, statuses: ['submitted', 'closed'] }
    }

    const [created] = await tx
      .insert(dataSources)
      .values({
        tenantId,
        key: seed.key,
        name: seed.name,
        description: seed.description,
        kind: seed.kind,
        columns: seed.columns,
        config,
      })
      .returning()
    if (!created || !seed.buildRows) continue

    const rows = await seed.buildRows(tx, tenantId)
    if (rows.length === 0) continue
    await tx.insert(dataSourceRows).values(
      rows.map((row, index) => ({
        tenantId,
        dataSourceId: created.id,
        data: row,
        position: index,
      })),
    )
  }
}
