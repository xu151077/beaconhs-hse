// Person groups — the standard cross-cutting groupings (committee, first aid,
// fire wardens, confined-space entrants).
//
// Pure per-tenant reference data: the group definitions only, no memberships.
// Membership is a business decision per tenant and lives in the demo seed.
//
// Extracted from `seed.ts`'s `seedPeopleGroupsAndTitles`, which couples the
// definitions to demo memberships and bails out entirely when titles already
// exist — leaving a hand-provisioned tenant with no groups at all. Tenant
// provisioning and the backfill both call this one implementation.

import type { SeedTx } from './types'
import { and, eq } from 'drizzle-orm'
import { personGroups } from '../schema'

const PERSON_GROUP_SEEDS = [
  {
    name: 'JHSC Members',
    description: 'Joint Health & Safety Committee members for monthly inspections + meetings.',
    color: '#0f766e',
  },
  {
    name: 'First Aid Responders',
    description: 'Workers certified to provide on-site first aid (SFA-CPR-C minimum).',
    color: '#dc2626',
  },
  {
    name: 'Fire Wardens',
    description: 'Designated muster-point leaders during evacuation drills.',
    color: '#ea580c',
  },
  {
    name: 'Confined-Space Entrants',
    description: 'Cleared for permit-required confined-space entry duties.',
    color: '#7c3aed',
  },
] as const

/**
 * Insert the standard person groups for a tenant.
 * Idempotent by (tenant, group name): existing groups — renamed or edited by
 * the administrator — are left exactly as found.
 */
export async function seedPersonGroups(tx: SeedTx, tenantId: string): Promise<void> {
  for (const group of PERSON_GROUP_SEEDS) {
    const [already] = await tx
      .select({ id: personGroups.id })
      .from(personGroups)
      .where(and(eq(personGroups.tenantId, tenantId), eq(personGroups.name, group.name)))
      .limit(1)
    if (already) continue
    await tx.insert(personGroups).values({ tenantId, ...group })
  }
}
