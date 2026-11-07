import { randomUUID } from 'node:crypto'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { createSuperClient, type Database } from './client'
import { convergePersonnelAssignments } from './converge-personnel-assignments'
import {
  BUILTIN_ROLES,
  correctiveActions,
  crews,
  customerContacts,
  departments,
  documents,
  documentAcknowledgments,
  documentReviews,
  documentVersions,
  documentCategories,
  customFieldDefinitions,
  equipmentCategories,
  equipmentInspectionCriteria,
  equipmentInspectionGroups,
  equipmentInspectionSchedules,
  equipmentInspectionTypes,
  equipmentItems,
  equipmentLogEntries,
  equipmentReminders,
  equipmentTypes,
  equipmentWorkOrders,
  equipmentLocationHistory,
  complianceAudience,
  complianceObligations,
  formResponses,
  formTemplates,
  formTemplateVersions,
  incidentHoursPeriods,
  incidentInjuries,
  incidentInjuryTypeAssignments,
  incidentLostTimeEvents,
  incidentPeople,
  incidents,
  inspectionBankCriteria,
  inspectionBanks,
  inspectionRecordCriteria,
  inspectionRecords,
  inspectionTypeCriteria,
  inspectionTypeGroups,
  inspectionTypes,
  notifications,
  orgUnits,
  people,
  ppeAnnualRecords,
  ppeInspections,
  ppeIssueReports,
  ppeIssues,
  ppeItems,
  reportDefinitions,
  roles,
  tenants,
  tenantUsers,
  safeDistanceRecords,
  safeDistanceSegments,
  trades,
  users,
  trainingCourses,
  trainingRecords,
  trainingSkillAssignments,
  trainingSkillAuthorities,
  trainingSkillTypes,
  trainingAssessments,
  trainingAssessmentTypes,
  users as user,
  // People groups / titles + per-title tasks
  jobTitleTaskAcknowledgments,
  jobTitleTasks,
  personGroupMemberships,
  personGroups,
  personTitleAssignments,
  personTitles,
} from './schema'
import type { FormSchemaV1 } from './schema'
import { CANONICAL_TEMPLATES } from './canonical-templates'
import { seedWorkPermitTemplate } from './seed/work-permit-template'
import { seedPhase11EEquipment } from './seed/phase11e-equipment'
import { seedPhase11EDocumentCategories } from './seed/phase11e-document-categories'
import { seedPhase11ERegisterApps } from './seed/phase11e-register-apps'
import { seedLiftPlanTemplate } from './seed/lift-plan-template'
import { ensureBuiltinRoles } from './tenant-provisioning'
import { ensureFreezeRow } from './storage-freeze-operations'
import { seedFormPdfTemplates, seedPdfTemplates } from './seed/pdf-templates'
import { BEACON_REPORT_SEEDS } from './seed/report-definitions'
import { seedToolboxTemplate } from './seed/toolbox-template'
import { seedDocumentTypesAndCategories } from './seed/document-types-and-categories'
import {
  INCIDENT_CLASSIFICATION_SEED,
  INCIDENT_INJURY_TYPE_SEED,
  seedIncidentTaxonomy,
} from './seed/incident-taxonomy'
import { seedInspectionTypes } from './seed/inspection-types'
import { seedInspectionBanks } from './seed/inspection-banks'
import { seedPersonGroups } from './seed/person-groups'
import { seedSkillCatalogue } from './seed/skill-catalogue'
import { seedPpeTypesWithCriteria } from './seed/ppe-types'
import { seedHazidLibraries } from './seed/hazid-libraries'
import { seedTrainingAssessmentTypes } from './seed/training-assessment-types'

/**
 * Identity of the development bootstrap, in one place.
 *
 * The super-admin LOGIN and the demo TENANT are separate facts with separate
 * identities, and conflating them is what made the seed look successful against
 * a half-initialised database. Nothing else in this file may gate on either.
 */
const ADMIN_EMAIL = 'admin@beaconhs.local'
const DEMO_TENANT_SLUG = 'demo'

async function main() {
  const { db, sql: pg } = createSuperClient()
  console.log('▶ Seeding…')

  await db.transaction(async (tx) => {
    // --- Super-admin ----------------------------------------------------
    // Provisioned INDEPENDENTLY of the tenant bootstrap below. Its existence
    // must never gate tenant data: a database holding the super-admin but no
    // demo tenant is exactly the partially-initialised state that the previous
    // `return` here made permanent — the seed exited 0, printed "Seed
    // complete", and left no tenant, roles, people, org units or job titles.
    const [insertedAdmin] = await tx
      .insert(user)
      .values({
        id: randomUUID(),
        email: ADMIN_EMAIL,
        name: 'Super Admin',
        emailVerified: true,
        isSuperAdmin: true,
      })
      .onConflictDoNothing()
      .returning()

    // Re-read on conflict so the summary line below can always name the login.
    const admin =
      insertedAdmin ?? (await tx.select().from(user).where(eq(user.email, ADMIN_EMAIL)).limit(1))[0]
    if (!admin) throw new Error('Failed to provision the super-admin')

    // --- Demo tenant: the convergence guard -------------------------------
    // Everything from here to the end of this transaction is FIRST-RUN ONLY. It
    // contains unguarded inserts whose safety rests entirely on the unique keys
    // of the tables they target — `tenants_slug_ux`, `roles_tenant_key_ux`,
    // `departments_tenant_normalized_name_ux`, `people_tenant_employee_no_ux`,
    // `org_units_tenant_code_ux`, `person_titles_tenant_normalized_name_ux` — and
    // they are reachable ONLY when the demo tenant is absent. So the guard
    // belongs on the TENANT, never on the super-admin. Re-running against a
    // seeded database skips them here and therefore cannot raise a unique
    // violation.
    const [existingDemo] = await tx
      .select({ id: tenants.id, name: tenants.name })
      .from(tenants)
      .where(eq(tenants.slug, DEMO_TENANT_SLUG))
      .limit(1)

    if (existingDemo) {
      // Storage writes fail closed unless this row exists. Keep a seeded database
      // usable after upgrades that predate the storage-freeze gate.
      await ensureFreezeRow(tx as unknown as Database, existingDemo.id)
      console.log(`  · demo tenant "${DEMO_TENANT_SLUG}" already exists, skipping tenant bootstrap`)
      console.log(`  · super-admin: ${admin.email}`)
      return
    }

    // --- Demo tenant ----------------------------------------------------
    const [tenant] = await tx
      .insert(tenants)
      .values({
        slug: DEMO_TENANT_SLUG,
        name: 'Acme Industrial',
        // English stays the default: nobody's language changes underneath them.
        // zh is ENABLED but not default, so it is selectable at /account while
        // every first-run user still lands in English. Migration 0045 must be
        // applied before this runs — the CHECK constraint is what makes 'zh'
        // writable at all.
        defaultLanguage: 'en',
        enabledLanguages: ['en', 'zh'],
        branding: { primaryColor: '#0f766e' },
        riskMatrix: {
          axes: {
            severity: { values: ['Trivial', 'Minor', 'Moderate', 'Major', 'Catastrophic'] },
            likelihood: { values: ['Rare', 'Unlikely', 'Possible', 'Likely', 'Almost certain'] },
          },
          cells: build5x5(),
        },
      })
      .returning()
    if (!tenant) throw new Error('Failed to create tenant')
    await ensureFreezeRow(tx as unknown as Database, tenant.id)

    const [membership] = await tx
      .insert(tenantUsers)
      .values({
        tenantId: tenant.id,
        userId: admin.id,
        status: 'active',
        joinedAt: new Date(),
        displayName: 'Super Admin',
      })
      .returning()
    if (!membership) throw new Error('Failed to create membership')

    // The demo tenant's built-in roles come from the SAME function tenant
    // provisioning uses. This loop used to live here with a bare `insert` whose only
    // protection against `roles_tenant_key_ux` was the early return above; keeping a
    // second copy would be exactly the duplicate implementation the repository rules
    // forbid, and the two would drift. See `ensureBuiltinRoles`.
    await ensureBuiltinRoles(tx as unknown as Database, tenant.id)

    // --- Org hierarchy --------------------------------------------------
    const customer = await insertOrgUnit(tx, tenant.id, null, 'customer', 'Acme Refinery')
    const project = await insertOrgUnit(tx, tenant.id, customer.id, 'project', 'Turnaround 2026')
    const siteA = await insertOrgUnit(tx, tenant.id, project.id, 'site', 'Site A — Tank Farm', {
      lat: 43.6532,
      lng: -79.3832,
      geofenceMeters: 250,
    })
    const siteB = await insertOrgUnit(tx, tenant.id, project.id, 'site', 'Site B — Cracker Unit', {
      lat: 43.6629,
      lng: -79.3957,
      geofenceMeters: 250,
    })

    // --- Departments + Trades + Crews ----------------------------------
    const [fieldOps] = await tx
      .insert(departments)
      .values({ tenantId: tenant.id, name: 'Field Operations' })
      .returning()
    const [office] = await tx
      .insert(departments)
      .values({ tenantId: tenant.id, name: 'Office' })
      .returning()

    const [carp] = await tx
      .insert(trades)
      .values({ tenantId: tenant.id, name: 'Carpenter' })
      .returning()
    const [elec] = await tx
      .insert(trades)
      .values({ tenantId: tenant.id, name: 'Electrician' })
      .returning()
    const [weld] = await tx
      .insert(trades)
      .values({ tenantId: tenant.id, name: 'Welder' })
      .returning()
    const [supervisorTrade] = await tx
      .insert(trades)
      .values({ tenantId: tenant.id, name: 'Supervisor' })
      .returning()

    const [crewAlpha] = await tx
      .insert(crews)
      .values({ tenantId: tenant.id, name: 'Crew Alpha' })
      .returning()
    const [crewBravo] = await tx
      .insert(crews)
      .values({ tenantId: tenant.id, name: 'Crew Bravo' })
      .returning()

    // --- People ---------------------------------------------------------
    const peopleData = [
      {
        firstName: 'John',
        lastName: 'Anderson',
        formalName: 'John D. Anderson',
        employeeNo: 'E001',
        tradeId: supervisorTrade!.id,
        crewId: crewAlpha!.id,
        dept: fieldOps!.id,
        email: 'janderson@acme.example',
        phone: '+1-647-555-0101',
        emergencyContactName: 'Mary Anderson',
        emergencyContactPhone: '+1-647-555-9001',
        notes: 'Lead supervisor for Tank Farm operations. 15 years on site.',
      },
      {
        firstName: 'Sarah',
        lastName: 'Bell',
        formalName: 'Sarah J. Bell',
        employeeNo: 'E002',
        tradeId: carp!.id,
        crewId: crewAlpha!.id,
        dept: fieldOps!.id,
        email: 'sbell@acme.example',
        phone: '+1-647-555-0102',
        emergencyContactName: 'Tom Bell',
        emergencyContactPhone: '+1-647-555-9002',
      },
      {
        firstName: 'Marcus',
        lastName: 'Chen',
        formalName: 'Marcus K. Chen',
        employeeNo: 'E003',
        tradeId: elec!.id,
        crewId: crewAlpha!.id,
        dept: fieldOps!.id,
        email: 'mchen@acme.example',
        phone: '+1-647-555-0103',
        emergencyContactName: 'Lisa Chen',
        emergencyContactPhone: '+1-647-555-9003',
      },
      {
        firstName: 'Priya',
        lastName: 'Desai',
        formalName: 'Priya N. Desai',
        employeeNo: 'E004',
        tradeId: weld!.id,
        crewId: crewAlpha!.id,
        dept: fieldOps!.id,
        email: 'pdesai@acme.example',
        phone: '+1-647-555-0104',
        emergencyContactName: 'Arjun Desai',
        emergencyContactPhone: '+1-647-555-9004',
      },
      {
        firstName: 'Tom',
        lastName: 'Eaton',
        formalName: 'Thomas Eaton',
        employeeNo: 'E005',
        tradeId: supervisorTrade!.id,
        crewId: crewBravo!.id,
        dept: fieldOps!.id,
        email: 'teaton@acme.example',
        phone: '+1-647-555-0105',
        emergencyContactName: 'Jane Eaton',
        emergencyContactPhone: '+1-647-555-9005',
      },
      {
        firstName: 'Maya',
        lastName: 'Foster',
        employeeNo: 'E006',
        tradeId: carp!.id,
        crewId: crewBravo!.id,
        dept: fieldOps!.id,
      },
      {
        firstName: 'Daniel',
        lastName: 'Gonzales',
        employeeNo: 'E007',
        tradeId: elec!.id,
        crewId: crewBravo!.id,
        dept: fieldOps!.id,
      },
      {
        firstName: 'Aisha',
        lastName: 'Hamid',
        employeeNo: 'E008',
        tradeId: weld!.id,
        crewId: crewBravo!.id,
        dept: fieldOps!.id,
      },
      {
        firstName: 'Linda',
        lastName: 'Iverson',
        employeeNo: 'E009',
        tradeId: null,
        crewId: null,
        dept: office!.id,
      },
      {
        firstName: 'Robert',
        lastName: 'Jensen',
        employeeNo: 'E010',
        tradeId: null,
        crewId: null,
        dept: office!.id,
      },
    ]

    const insertedPeople = await Promise.all(
      peopleData.map(async (p) => {
        const [row] = await tx
          .insert(people)
          .values({
            tenantId: tenant.id,
            firstName: p.firstName,
            lastName: p.lastName,
            formalName: (p as any).formalName ?? null,
            employeeNo: p.employeeNo,
            departmentId: p.dept,
            tradeId: p.tradeId,
            crewId: p.crewId,
            hireDate: '2023-01-15',
            status: 'active',
            email: (p as any).email ?? null,
            phone: (p as any).phone ?? null,
            emergencyContactName: (p as any).emergencyContactName ?? null,
            emergencyContactPhone: (p as any).emergencyContactPhone ?? null,
            notes: (p as any).notes ?? null,
          })
          .returning()
        return row!
      }),
    )
    const [john, sarah, marcus, priya, tom] = insertedPeople

    // --- Personnel placement ---------------------------------------------
    // Nothing seeded `people_assignments`, so the compliance audience and identity
    // resolvers resolved to zero people for a freshly seeded tenant.
    // The placement is derived from data the fixture already has rather than
    // invented: Crew Alpha works Site A (Tank Farm) and Crew Bravo works Site B
    // (Cracker Unit). E001's own note — "Lead supervisor for Tank Farm
    // operations" — agrees, so the mapping is corroborated, not arbitrary.
    //
    // Office staff (E009, E010) are deliberately left unplaced. They have no
    // crew, so the seeded rows exercise the real unplaced path that the
    // audience and identity resolvers have to handle, instead of only test
    // fixtures exercising it.
    const siteForCrew = new Map<string, string>([
      [crewAlpha!.id, siteA.id],
      [crewBravo!.id, siteB.id],
    ])
    const placements = insertedPeople
      .map((row) => {
        const orgUnitId = row.crewId ? siteForCrew.get(row.crewId) : undefined
        return orgUnitId && row.employeeNo ? { employeeNo: row.employeeNo, orgUnitId } : null
      })
      .filter((x): x is { employeeNo: string; orgUnitId: string } => x !== null)

    // The two verification foreman accounts. They are created outside this seed
    // (they carry hand-picked stable UUIDs), so their employee records are
    // only added when the accounts are actually present — `people.user_id` is a
    // foreign key, and inventing a row for a missing user would fail the seed.
    // Their role scope already names Site A / Site B; that access scope is NOT
    // what places them, it is what the placement is checked against.
    const verificationForemen = [
      { userId: 'verif-foreman-a', employeeNo: 'E011', firstName: 'Frank', lastName: 'Ortiz' },
      { userId: 'verif-foreman-b', employeeNo: 'E012', firstName: 'Grace', lastName: 'Oyelaran' },
    ]
    const existingUsers = await tx
      .select({ id: users.id })
      .from(users)
      .where(
        inArray(
          users.id,
          verificationForemen.map((f) => f.userId),
        ),
      )
    const presentUserIds = new Set(existingUsers.map((u) => u.id))
    const foremanRecords = verificationForemen
      .filter((f) => presentUserIds.has(f.userId))
      .map((f) => ({
        employeeNo: f.employeeNo,
        firstName: f.firstName,
        lastName: f.lastName,
        userId: f.userId,
        crewId: f.userId === 'verif-foreman-a' ? crewAlpha!.id : crewBravo!.id,
        tradeId: supervisorTrade!.id,
        dept: fieldOps!.id,
      }))

    const convergence = await convergePersonnelAssignments(tx, tenant.id, {
      records: foremanRecords,
      placements: [
        ...placements,
        { employeeNo: 'E011', orgUnitId: siteA.id },
        { employeeNo: 'E012', orgUnitId: siteB.id },
      ],
    })
    console.log(
      `  · personnel placement: ${placements.length + 2} desired, ` +
        `${convergence.assignmentsCreated.length} inserted, ` +
        `${convergence.skipped.existingAssignments} already present, ` +
        `${convergence.peopleCreated.length} people created, ` +
        `${convergence.linksCreated.length} user links filled`,
    )

    // --- Training courses + records -------------------------------------
    const courseDefs = [
      {
        code: 'WHMIS',
        name: 'WHMIS 2015',
        deliveryType: 'self_paced' as const,
        valid: 36,
        description:
          'Workplace Hazardous Materials Information System — federally mandated chemical hazard training.',
      },
      {
        code: 'H2S',
        name: 'H2S Alive',
        deliveryType: 'classroom' as const,
        valid: 36,
        description:
          'Hydrogen sulfide hazard recognition + SCBA familiarisation (ENFORM standard).',
      },
      {
        code: 'FALL',
        name: 'Fall Protection',
        deliveryType: 'classroom' as const,
        valid: 36,
        description: 'Proper use of harness, lanyard, anchor points, rescue planning.',
      },
      {
        code: 'CSE',
        name: 'Confined Space Entry',
        deliveryType: 'classroom' as const,
        valid: 12,
        description: 'Permit-required confined space awareness for entrants/attendants.',
      },
      {
        code: 'FA',
        name: 'Standard First Aid',
        deliveryType: 'classroom' as const,
        valid: 36,
        description: 'Canadian Red Cross 16-hour SFA + CPR-C certification.',
      },
    ]
    const courses = await Promise.all(
      courseDefs.map(async (c) => {
        const [row] = await tx
          .insert(trainingCourses)
          .values({
            tenantId: tenant.id,
            code: c.code,
            name: c.name,
            description: c.description,
            deliveryType: c.deliveryType,
            validForMonths: c.valid,
            durationMinutes: 60,
          })
          .returning()
        return row!
      }),
    )

    const today = new Date()
    const dayMs = 24 * 3600 * 1000
    for (const p of insertedPeople) {
      const issue = isoDate(new Date(today.getTime() - 365 * dayMs))
      const expires = isoDate(new Date(today.getTime() + 700 * dayMs))
      await tx.insert(trainingRecords).values({
        tenantId: tenant.id,
        personId: p.id,
        courseId: courses[0]!.id,
        source: 'self_paced',
        completedOn: issue,
        expiresOn: expires,
        certificateType: 'auto',
        grade: 92,
        instructor: 'Online module',
      })
    }
    // Sarah's Fall Protection expires in 24 days
    await tx.insert(trainingRecords).values({
      tenantId: tenant.id,
      personId: sarah!.id,
      courseId: courses[2]!.id,
      source: 'class',
      completedOn: isoDate(new Date(today.getTime() - 1070 * dayMs)),
      expiresOn: isoDate(new Date(today.getTime() + 24 * dayMs)),
      certificateType: 'auto',
      instructor: 'L. Iverson',
      grade: 88,
      details: 'In-person session at Site A muster point.',
    })
    // Marcus' H2S expired 6 days ago
    await tx.insert(trainingRecords).values({
      tenantId: tenant.id,
      personId: marcus!.id,
      courseId: courses[1]!.id,
      source: 'class',
      completedOn: isoDate(new Date(today.getTime() - 1100 * dayMs)),
      expiresOn: isoDate(new Date(today.getTime() - 6 * dayMs)),
      certificateType: 'auto',
      instructor: 'ENFORM',
      grade: 84,
    })
    // First aid for HSE Coordinator (current)
    await tx.insert(trainingRecords).values({
      tenantId: tenant.id,
      personId: insertedPeople[8]!.id,
      courseId: courses[4]!.id,
      source: 'class',
      completedOn: isoDate(new Date(today.getTime() - 60 * dayMs)),
      expiresOn: isoDate(new Date(today.getTime() + (3 * 365 - 60) * dayMs)),
      certificateType: 'auto',
      instructor: 'Canadian Red Cross',
      grade: 96,
    })

    // --- Equipment + PPE -----------------------------------------------
    const [toolCategory, vehicleCategory] = await tx
      .insert(equipmentCategories)
      .values([
        { tenantId: tenant.id, name: 'Tools', slug: 'tools' },
        { tenantId: tenant.id, name: 'Vehicles', slug: 'vehicles' },
      ])
      .returning()
    const [tools] = await tx
      .insert(equipmentTypes)
      .values({ tenantId: tenant.id, name: 'Hand Tools', categoryId: toolCategory!.id })
      .returning()
    const [vehicles] = await tx
      .insert(equipmentTypes)
      .values({ tenantId: tenant.id, name: 'Light Vehicle', categoryId: vehicleCategory!.id })
      .returning()

    const equipmentIds: string[] = []
    for (let i = 1; i <= 8; i++) {
      const isTool = i <= 5
      const [eq] = await tx
        .insert(equipmentItems)
        .values({
          tenantId: tenant.id,
          typeId: isTool ? tools!.id : vehicles!.id,
          categoryId: isTool ? toolCategory!.id : vehicleCategory!.id,
          assetTag: `AT-${String(i).padStart(4, '0')}`,
          name: isTool ? `Cordless Drill #${i}` : `Pickup Truck #${i - 5}`,
          serialNumber: isTool ? `DRL-${1000 + i}` : `VIN-1HGBH${10000 + i}`,
          manufacturer: isTool ? 'DeWalt' : 'Ford',
          model: isTool ? null : 'F-150',
          modelYear: isTool ? null : 2023,
          qrToken: `bhs-eq-${randomUUID()}`,
          status: 'in_service',
          currentSiteOrgUnitId: i % 2 === 0 ? siteA.id : siteB.id,
          currentHolderPersonId: isTool ? insertedPeople[i % insertedPeople.length]!.id : null,
          purchaseDate: '2024-03-15',
          purchasePrice: isTool ? null : '58500.00',
          ownership: 'owned',
          licensePlate: isTool ? null : `ABC-100${i - 5}`,
          warrantyExpiresOn: '2027-03-15',
          requiresPreUseInspection: isTool ? true : true,
          lastPreUseInspectionAt: new Date(today.getTime() - 2 * dayMs),
        })
        .returning()
      equipmentIds.push(eq!.id)

      // Vehicles carry a recurring annual-inspection schedule (the calendar
      // side now lives in equipment_inspection_schedules, not on the item).
      if (!isTool) {
        await tx.insert(equipmentInspectionSchedules).values({
          tenantId: tenant.id,
          equipmentItemId: eq!.id,
          label: 'Annual inspection',
          intervalValue: 1,
          intervalUnit: 'year',
          lastCompletedOn: isoDate(new Date(today.getTime() - 120 * dayMs)),
          nextDueOn: isoDate(new Date(today.getTime() + 240 * dayMs)),
          isActive: true,
        })
      }

      // Add a little location history
      await tx.insert(equipmentLocationHistory).values({
        tenantId: tenant.id,
        itemId: eq!.id,
        siteOrgUnitId: i % 2 === 0 ? siteA.id : siteB.id,
        holderPersonId: isTool ? insertedPeople[i % insertedPeople.length]!.id : null,
        recordedAt: new Date(today.getTime() - 7 * dayMs),
        note: 'Issued from yard',
      })
      await tx.insert(equipmentLocationHistory).values({
        tenantId: tenant.id,
        itemId: eq!.id,
        siteOrgUnitId: i % 2 === 0 ? siteB.id : siteA.id,
        recordedAt: new Date(today.getTime() - 30 * dayMs),
        note: 'Transferred',
      })
    }
    // A work order on the first pickup truck
    await tx.insert(equipmentWorkOrders).values({
      tenantId: tenant.id,
      itemId: equipmentIds[5]!,
      reference: 'WO-2026-0001',
      status: 'in_progress',
      summary: 'Replace front-left tire',
      description: 'Sidewall puncture noticed during pre-trip inspection.',
      openedAt: new Date(today.getTime() - 1 * dayMs),
    })
    await tx.insert(equipmentWorkOrders).values({
      tenantId: tenant.id,
      itemId: equipmentIds[5]!,
      reference: 'WO-2026-0002',
      status: 'closed',
      summary: 'Annual safety inspection',
      description: 'Provincial annual inspection completed; certificate filed.',
      openedAt: new Date(today.getTime() - 120 * dayMs),
      closedAt: new Date(today.getTime() - 118 * dayMs),
    })
    // Ad-hoc maintenance reminders on the first pickup truck: one overdue,
    // one upcoming with a repeat cadence.
    await tx.insert(equipmentReminders).values([
      {
        tenantId: tenant.id,
        equipmentItemId: equipmentIds[5]!,
        title: 'Check roof membrane',
        dueOn: isoDate(new Date(today.getTime() - 10 * dayMs)),
        createdByTenantUserId: membership.id,
      },
      {
        tenantId: tenant.id,
        equipmentItemId: equipmentIds[5]!,
        title: 'Rotate tires',
        dueOn: isoDate(new Date(today.getTime() + 20 * dayMs)),
        repeatIntervalValue: 6,
        repeatIntervalUnit: 'month',
        createdByTenantUserId: membership.id,
      },
    ])

    // Canonical PPE types + criteria — uses the dedicated seed helper so
    // both the schema relationships and the audit story stay consistent.
    const seededPpeTypes = await seedPpeTypesWithCriteria(tx, tenant.id)
    const harness = seededPpeTypes.find((t) => t.name === 'Full-body harness')!
    const harnessIds: string[] = []
    for (let i = 1; i <= 6; i++) {
      const [item] = await tx
        .insert(ppeItems)
        .values({
          tenantId: tenant.id,
          typeId: harness.id,
          serialNumber: `HARN-${i}`,
          size: i % 2 === 0 ? 'L' : 'M',
          status: i <= 3 ? 'issued' : 'in_stock',
          currentHolderPersonId: i <= 3 ? insertedPeople[i - 1]!.id : null,
          purchaseDate: '2024-01-10',
          expiresOn: '2029-01-10',
          lastInspectionOn: isoDate(new Date(today.getTime() - 14 * dayMs)),
          nextInspectionDue: isoDate(new Date(today.getTime() + 16 * dayMs)),
          lastAnnualInspectionOn: isoDate(new Date(today.getTime() - 200 * dayMs)),
          nextAnnualInspectionDue: isoDate(new Date(today.getTime() + 165 * dayMs)),
        })
        .returning()
      harnessIds.push(item!.id)

      // Inspection history (3 pre-use, 1 annual per item)
      for (let n = 0; n < 3; n++) {
        await tx.insert(ppeInspections).values({
          tenantId: tenant.id,
          itemId: item!.id,
          kind: 'pre_use',
          result: 'pass',
          inspectedOn: isoDate(new Date(today.getTime() - (14 + n * 14) * dayMs)),
          nextDueOn: isoDate(new Date(today.getTime() - (14 + n * 14) * dayMs + 30 * dayMs)),
          inspectedByTenantUserId: membership.id,
        })
      }
      await tx.insert(ppeInspections).values({
        tenantId: tenant.id,
        itemId: item!.id,
        kind: 'annual',
        result: 'pass',
        inspectedOn: isoDate(new Date(today.getTime() - 200 * dayMs)),
        nextDueOn: isoDate(new Date(today.getTime() + 165 * dayMs)),
        inspectedByTenantUserId: membership.id,
        notes: 'Annual inspection by certified competent person.',
      })

      // For items 1-3 (issued), add the issuance receipt
      if (i <= 3) {
        await tx.insert(ppeIssues).values({
          tenantId: tenant.id,
          itemId: item!.id,
          personId: insertedPeople[i - 1]!.id,
          action: 'issue',
          quantity: 1,
          issuedByTenantUserId: membership.id,
          occurredAt: new Date(today.getTime() - 30 * dayMs),
          note: 'Initial issue at site induction.',
        })
      }
    }
    // An open issue report against harness #2
    await tx.insert(ppeIssueReports).values({
      tenantId: tenant.id,
      itemId: harnessIds[1]!,
      reportedByTenantUserId: membership.id,
      description: 'Frayed webbing noticed on leg strap. Removed from service pending inspection.',
      status: 'open',
    })

    // Annual third-party recertification records — drives /ppe/[id]?tab=annual.
    for (const harnessId of harnessIds) {
      const inspectedOn = isoDate(new Date(today.getTime() - 200 * dayMs))
      await tx
        .insert(ppeAnnualRecords)
        .values({
          tenantId: tenant.id,
          itemId: harnessId,
          year: String(new Date(inspectedOn).getFullYear()),
          inspectedOn,
          nextDueOn: isoDate(new Date(today.getTime() + 165 * dayMs)),
          inspectorName: 'Joe Rigger',
          inspectorCompany: 'Acme Riggers Ltd',
          result: 'pass',
          notes: 'Annual third-party certification — webbing, hardware, and stitching inspected.',
        })
        .onConflictDoNothing()
    }

    // --- Form template (daily toolbox talk) -----------------------------
    const [tmpl] = await tx
      .insert(formTemplates)
      .values({
        tenantId: tenant.id,
        key: 'daily-toolbox-talk',
        name: 'Daily Toolbox Talk',
        category: 'toolbox_talk',
        description: 'Pre-shift hazard discussion + attendance sign-in.',
        status: 'published',
        createdBy: admin.id,
      })
      .returning()
    const toolboxSchema: FormSchemaV1 = {
      schemaVersion: 1,
      title: { en: 'Daily Toolbox Talk' },
      sections: [
        {
          id: 'crew',
          title: { en: 'Crew & Site' },
          fields: [
            { id: 'site', type: 'site_picker', label: { en: 'Site' }, required: true },
            { id: 'foreman', type: 'person_picker', label: { en: 'Foreman' }, required: true },
            { id: 'attendees', type: 'person_picker', label: { en: 'Attendees' }, required: true },
          ],
        },
        {
          id: 'topics',
          title: { en: 'Topics Covered' },
          repeating: true,
          fields: [
            { id: 'topic', type: 'text', label: { en: 'Topic' }, required: true },
            { id: 'discussion', type: 'long_text', label: { en: 'Discussion notes' } },
          ],
        },
        {
          id: 'signoff',
          title: { en: 'Sign-off' },
          fields: [
            {
              id: 'incidentsDiscussed',
              type: 'yes_no_comment',
              label: { en: 'Were recent incidents reviewed?' },
              required: true,
            },
            {
              id: 'signature',
              type: 'signature',
              label: { en: 'Foreman signature' },
              required: true,
            },
          ],
        },
      ],
      workflow: {
        steps: [
          {
            key: 'submit',
            title: { en: 'Submit' },
            assignee: { type: 'expression', expr: '$submitter' },
          },
        ],
      },
    }
    const [tv1] = await tx
      .insert(formTemplateVersions)
      .values({
        tenantId: tenant.id,
        templateId: tmpl!.id,
        version: 1,
        schema: toolboxSchema,
        publishedAt: new Date(),
        publishedBy: admin.id,
        changelog: 'Initial version',
      })
      .returning()
    const [toolboxObligation] = await tx
      .insert(complianceObligations)
      .values({
        tenantId: tenant.id,
        sourceModule: 'form',
        subjectKind: 'per_person',
        title: 'Daily toolbox talk',
        status: 'active',
        targetRef: { formTemplateId: tmpl!.id },
        recurrence: { kind: 'cron', cron: '0 7 * * 1-5' },
        recurrenceKind: 'cron',
        createdByTenantUserId: membership.id,
      })
      .returning({ id: complianceObligations.id })
    await tx.insert(complianceAudience).values({
      tenantId: tenant.id,
      obligationId: toolboxObligation!.id,
      kind: 'role',
      entityKey: 'foreman',
    })

    // Sample form responses
    for (let i = 0; i < 4; i++) {
      await tx.insert(formResponses).values({
        tenantId: tenant.id,
        templateId: tmpl!.id,
        templateVersionId: tv1!.id,
        status: i === 0 ? 'submitted' : i === 1 ? 'submitted' : i === 2 ? 'in_progress' : 'closed',
        siteOrgUnitId: i % 2 === 0 ? siteA.id : siteB.id,
        submittedBy: membership.id,
        submittedAt: i < 3 ? new Date(today.getTime() - i * dayMs) : new Date(),
        data: {
          foreman: john!.id,
          attendees: insertedPeople.slice(1, 4).map((p) => p.id),
          topics: [
            {
              topic: 'Pinch points around tank manways',
              discussion: 'Always use spotters when handling >50lb lids.',
            },
            {
              topic: 'Heat stress',
              discussion: 'Mandatory 15-min water breaks every hour above 28°C.',
            },
          ],
          incidentsDiscussed: { answer: 'yes', comment: 'Reviewed near-miss INC-2026-0001.' },
        },
      })
    }

    // --- Incidents (rich) ----------------------------------------------
    await tx.insert(incidents).values({
      tenantId: tenant.id,
      reference: 'INC-2026-0001',
      type: 'near_miss',
      severity: 'no_injury',
      status: 'closed',
      title: 'Hand tool dropped from scaffold',
      description:
        '8" wrench fell from level-2 scaffold into a barricaded area below pump P-103. No personnel in the drop zone — caught by toe-boards.',
      occurredAt: new Date(today.getTime() - 14 * dayMs),
      reportedAt: new Date(today.getTime() - 14 * dayMs + 2 * 3600 * 1000),
      siteOrgUnitId: siteA.id,
      location: 'P-103 pump bay, north scaffold level 2',
      weather: '17°C, light wind',
      departmentId: fieldOps!.id,
      supervisorPersonId: john!.id,
      witnesses: 'M. Foster, D. Gonzales',
      ppeWorn: 'Hard hat, safety glasses, gloves, fall arrest',
      eventsLeadingUp:
        'Working at height removing valve packing. Tool was set down on scaffold deck instead of being tethered. A gust knocked it through the toe-board gap.',
      immediateActionTaken:
        'Work stopped. Area inspected. Toe-board gap shimmed. Tool tethering tailgate held immediately after.',
      actualSeverity: 1,
      potentialSeverity: 4,
      rootCause: 'Tool not tethered when set down on scaffold deck.',
      contributingFactors: ['Inadequate toe-board height', 'No tool-tethering policy enforcement'],
      assignedInvestigatorTenantUserId: membership.id,
      inProgress: false,
      locked: true,
      closedAt: new Date(today.getTime() - 10 * dayMs),
      closedByTenantUserId: membership.id,
    })

    const [inc2] = await tx
      .insert(incidents)
      .values({
        tenantId: tenant.id,
        reference: 'INC-2026-0002',
        type: 'injury',
        severity: 'first_aid_only',
        status: 'closed',
        title: 'Cut on right hand while opening crate',
        description:
          'Box cutter slipped while opening valve crate. Small laceration to right thumb, treated on site.',
        occurredAt: new Date(today.getTime() - 9 * dayMs),
        siteOrgUnitId: siteA.id,
        location: 'Materials lay-down yard',
        supervisorPersonId: john!.id,
        ppeWorn: 'Cut-resistant gloves (level 3)',
        firstAidGiven: true,
        firstAidProvider: 'L. Iverson (HSE Coordinator)',
        actualSeverity: 2,
        potentialSeverity: 2,
        rootCause:
          'Box cutter blade fully extended, no proper cut-resistant glove rating for this task.',
        inProgress: false,
        locked: true,
        closedAt: new Date(today.getTime() - 6 * dayMs),
      })
      .returning()
    await tx.insert(incidentInjuries).values({
      tenantId: tenant.id,
      incidentId: inc2!.id,
      personId: sarah!.id,
      personName: 'Sarah Bell',
      bodyParts: ['Right hand', 'Thumb'],
      injuryResult: 'First aid only; no lost time or modified duty.',
      treatment: 'Wound cleaned, butterfly bandage applied, advised follow-up if redness develops.',
      treatedAtFacility: 'On-site first aid station',
      workedHoursPriorTo: 4,
    })
    await tx.insert(incidentPeople).values({
      tenantId: tenant.id,
      incidentId: inc2!.id,
      personId: sarah!.id,
      role: 'involved',
    })

    const [inc3] = await tx
      .insert(incidents)
      .values({
        tenantId: tenant.id,
        reference: 'INC-2026-0003',
        type: 'injury',
        severity: 'medical_aid',
        status: 'under_investigation',
        title: 'Slip on wet floor in mechanical room',
        description:
          'Worker slipped after a hose was left dripping at the access point. Treated at walk-in clinic, x-rays clear.',
        occurredAt: new Date(today.getTime() - 3 * dayMs),
        siteOrgUnitId: siteB.id,
        location: 'Mechanical Room 2A, near east entrance',
        supervisorPersonId: tom!.id,
        witnesses: 'Marcus Chen',
        externalPeopleInvolved: 'None',
        eventsLeadingUp:
          "Cleaning crew finished pressure-washing equipment and coiled the hose without draining it. Wet patch wasn't flagged with a cone.",
        immediateActionTaken:
          'Area mopped, cones placed, hose drained, worker driven to MedExpress clinic.',
        ppeWorn: 'Safety boots (SRC slip-resistant), high-vis vest, hard hat',
        actualSeverity: 3,
        potentialSeverity: 3,
        criticalInjury: false,
        ministryOfLabourNotified: false,
        emsCalled: false,
        firstAidGiven: true,
        firstAidProvider: 'L. Iverson',
        medicalAttentionReceived: true,
        hospitalName: 'MedExpress Walk-In Clinic',
        treatedInCity: 'Toronto',
        transportation: 'Private vehicle (supervisor drove)',
        modifiedDuty: true,
        modifiedDutyFirstDay: isoDate(new Date(today.getTime() - 2 * dayMs)),
        modifiedDutyDays: 3,
        externallyReportable: false,
        rootCause:
          'Procedure for hose handling at clean-up did not require draining/coning. Cleaning subcontractor not briefed on site policy.',
        contributingFactors: ['Subcontractor onboarding gap', 'No signage placement standard'],
        inProgress: true,
        locked: false,
        assignedInvestigatorTenantUserId: membership.id,
      })
      .returning()
    await tx.insert(incidentInjuries).values({
      tenantId: tenant.id,
      incidentId: inc3!.id,
      personId: priya!.id,
      personName: 'Priya Desai',
      bodyParts: ['Lower back', 'Left wrist'],
      injuryResult: 'X-rays clear; three days of modified duty assigned.',
      treatment: 'X-ray clear, anti-inflammatories prescribed, modified duty for 3 days.',
      treatedAtFacility: 'MedExpress Walk-In Clinic',
      workedHoursPriorTo: 5,
    })
    await tx.insert(incidentLostTimeEvents).values({
      tenantId: tenant.id,
      incidentId: inc3!.id,
      status: 'restricted_duty',
      validFrom: isoDate(new Date(today.getTime() - 2 * dayMs)),
      validTo: isoDate(new Date(today.getTime() + 1 * dayMs)),
      notes: 'No overhead reaching, no carrying > 5kg.',
    })
    await tx.insert(incidentPeople).values({
      tenantId: tenant.id,
      incidentId: inc3!.id,
      personId: priya!.id,
      role: 'involved',
    })

    const [inc4] = await tx
      .insert(incidents)
      .values({
        tenantId: tenant.id,
        reference: 'INC-2026-0004',
        type: 'property_damage',
        severity: 'no_injury',
        status: 'reported',
        title: 'Forklift bumped overhead conduit',
        description:
          'Forklift forks struck low-hanging electrical conduit while turning. Conduit dented; circuit isolated as a precaution.',
        occurredAt: new Date(today.getTime() - 1 * dayMs),
        siteOrgUnitId: siteB.id,
        location: 'Warehouse aisle 3',
        supervisorPersonId: tom!.id,
        immediateActionTaken:
          'Forklift parked. Electrical isolated by qualified person. Conduit photographed and tagged.',
        ppeWorn: 'Standard site PPE',
        actualSeverity: 1,
        potentialSeverity: 4,
        inProgress: true,
        locked: false,
      })
      .returning()

    // --- Corrective actions --------------------------------------------
    const caRows = [
      {
        reference: 'CA-2026-0001',
        title: 'Install drip pan + cone protocol for cleaning crew',
        severity: 'high' as const,
        status: 'in_progress' as const,
        daysToDue: 7,
        source: 'incident' as const,
        sourceEntityId: inc3!.id,
        actionTaken:
          'Drip pans ordered (ETA 3 days). Cone-placement SOP drafted; awaiting sign-off.',
        rootCause: 'Subcontractor onboarding gap.',
      },
      {
        reference: 'CA-2026-0002',
        title: 'Daily scaffold inspection during turnaround',
        severity: 'high' as const,
        status: 'open' as const,
        daysToDue: 3,
        source: 'jsha' as const,
        actionTaken: null,
        rootCause: null,
      },
      {
        reference: 'CA-2026-0003',
        title: 'Refresh slip-trip awareness in monthly toolbox',
        severity: 'low' as const,
        status: 'open' as const,
        daysToDue: 14,
        source: 'inspection' as const,
        actionTaken: null,
        rootCause: null,
      },
      {
        reference: 'CA-2026-0004',
        title: 'Replace damaged conduit section',
        severity: 'high' as const,
        status: 'pending_verification' as const,
        daysToDue: 1,
        source: 'incident' as const,
        sourceEntityId: inc4!.id,
        actionTaken:
          'Conduit section replaced by qualified electrician. Awaiting verification by site safety.',
        rootCause: 'Forklift route clearance not validated against installed services.',
      },
    ]
    for (const c of caRows) {
      await tx.insert(correctiveActions).values({
        tenantId: tenant.id,
        reference: c.reference,
        title: c.title,
        severity: c.severity,
        status: c.status,
        siteOrgUnitId: siteA.id,
        assignedOn: isoDate(new Date(today.getTime() - 5 * dayMs)),
        dueOn: isoDate(new Date(today.getTime() + c.daysToDue * dayMs)),
        source: c.source,
        sourceEntityType: c.source === 'incident' ? 'incident' : null,
        sourceEntityId: (c as any).sourceEntityId ?? null,
        actionTaken: c.actionTaken,
        rootCause: c.rootCause,
        ownerTenantUserId: membership.id,
        assignedByTenantUserId: membership.id,
      })
    }

    // --- Documents ------------------------------------------------------
    const docDefs = [
      {
        key: 'corporate-hs-policy',
        title: 'Corporate Health & Safety Policy',
        category: 'policy',
        reviewFreq: 12,
        body: '## Purpose\n\nAcme Industrial is committed to providing a safe and healthy workplace for all employees…',
      },
      {
        key: 'sds-acetone',
        title: 'SDS — Acetone',
        category: 'sds',
        reviewFreq: 36,
        body: '## Acetone — Safety Data Sheet\n\n**Hazard class:** Flammable liquid, category 2…',
      },
      {
        key: 'wah-procedure',
        title: 'Work at Height Procedure',
        category: 'procedure',
        reviewFreq: 24,
        body: '## Scope\n\nThis procedure applies to all work performed >3m above grade…',
      },
    ]
    const docCategoryRows = await tx
      .insert(documentCategories)
      .values(
        docDefs.map((definition) => ({
          tenantId: tenant.id,
          name: definition.category,
        })),
      )
      .returning({ id: documentCategories.id, name: documentCategories.name })
    const docCategoryIds = new Map(docCategoryRows.map((category) => [category.name, category.id]))
    for (const d of docDefs) {
      const [doc] = await tx
        .insert(documents)
        .values({
          tenantId: tenant.id,
          key: d.key,
          title: d.title,
          categoryId: docCategoryIds.get(d.category)!,
          status: 'published',
          reviewFrequencyMonths: d.reviewFreq,
          nextReviewOn: isoDate(new Date(today.getTime() + d.reviewFreq * 30 * dayMs - 30 * dayMs)),
          ownerTenantUserId: membership.id,
        })
        .returning()
      await tx.insert(documentVersions).values({
        tenantId: tenant.id,
        documentId: doc!.id,
        version: 1,
        textContent: d.body,
        publishedAt: new Date(today.getTime() - 200 * dayMs),
        publishedBy: admin.id,
        changelog: 'Initial release',
      })
      const [v2] = await tx
        .insert(documentVersions)
        .values({
          tenantId: tenant.id,
          documentId: doc!.id,
          version: 2,
          textContent: d.body + '\n\nRevision: updated reporting contact emails.',
          publishedAt: new Date(today.getTime() - 30 * dayMs),
          publishedBy: admin.id,
          changelog: 'Updated emergency contact roster',
        })
        .returning()
      // Some acknowledgments
      for (let i = 0; i < 5; i++) {
        await tx.insert(documentAcknowledgments).values({
          tenantId: tenant.id,
          documentId: doc!.id,
          versionId: v2!.id,
          personId: insertedPeople[i]!.id,
          acknowledgedAt: new Date(today.getTime() - (28 - i) * dayMs),
        })
      }
      // Review history
      await tx.insert(documentReviews).values({
        tenantId: tenant.id,
        documentId: doc!.id,
        documentVersionId: v2!.id,
        reviewedByTenantUserId: membership.id,
        reviewedAt: new Date(today.getTime() - 30 * dayMs),
        outcome: 'updated',
        nextReviewOn: isoDate(new Date(today.getTime() + d.reviewFreq * 30 * dayMs)),
        notes: 'Reviewed emergency contact list and updated. No structural changes needed.',
      })
    }

    // --- Customer contacts ---
    await tx.insert(customerContacts).values([
      {
        tenantId: tenant.id,
        orgUnitId: customer.id,
        name: 'Karen Whitaker',
        role: 'Site Operations Manager',
        email: 'kwhitaker@acmerefinery.com',
        phone: '+1-647-555-7001',
        isPrimary: true,
      },
      {
        tenantId: tenant.id,
        orgUnitId: customer.id,
        name: 'David Park',
        role: 'HSE Lead',
        email: 'dpark@acmerefinery.com',
        phone: '+1-647-555-7002',
      },
      {
        tenantId: tenant.id,
        orgUnitId: siteA.id,
        name: 'Marco Rossi',
        role: 'Site Foreman',
        phone: '+1-647-555-7003',
      },
    ])

    // --- Welcome notification --------------------
    await tx.insert(notifications).values({
      tenantId: tenant.id,
      userId: admin.id,
      category: 'system',
      type: 'tenant.welcome',
      title: 'Welcome to Acme Industrial',
      body: 'Sample data has been seeded. Click around — every list is paginated/sortable and every row clicks through to a real detail page.',
      linkPath: '/dashboard',
    })

    // --- Inspection Banks (shared reference seeder) --------------------
    await seedInspectionBanks(tx, tenant.id)

    // --- Training Skill Authorities + Types (shared reference seeder) --
    await seedSkillCatalogue(tx, tenant.id)
    const skillRows = await tx
      .select({ id: trainingSkillTypes.id, code: trainingSkillTypes.code })
      .from(trainingSkillTypes)
      .where(eq(trainingSkillTypes.tenantId, tenant.id))
    const skillByCode = new Map(skillRows.map((r) => [r.code, r.id]))
    const skill1Id = skillByCode.get('FORK')
    const skill2Id = skillByCode.get('CSA')
    if (skill1Id) {
      await tx.insert(trainingSkillAssignments).values([
        {
          tenantId: tenant.id,
          personId: john!.id,
          skillTypeId: skill1Id,
          grantedOn: isoDate(new Date(today.getTime() - 200 * dayMs)),
          expiresOn: isoDate(new Date(today.getTime() + 900 * dayMs)),
          grantedByTenantUserId: membership.id,
        },
        {
          tenantId: tenant.id,
          personId: tom!.id,
          skillTypeId: skill1Id,
          grantedOn: isoDate(new Date(today.getTime() - 100 * dayMs)),
          expiresOn: isoDate(new Date(today.getTime() + 1000 * dayMs)),
          grantedByTenantUserId: membership.id,
        },
      ])
    }
    if (skill2Id) {
      await tx.insert(trainingSkillAssignments).values({
        tenantId: tenant.id,
        personId: john!.id,
        skillTypeId: skill2Id,
        grantedOn: isoDate(new Date(today.getTime() - 340 * dayMs)),
        expiresOn: isoDate(new Date(today.getTime() + 25 * dayMs)),
        grantedByTenantUserId: membership.id,
        notes: 'Expires soon — schedule recertification.',
      })
    }

    // --- Inspection types (3 sample types reusing the seeded banks) -----
    await seedInspectionTypes(tx, tenant.id)

    // --- Lift Plan + Toolbox Talk form templates (built-in; surfaced as
    //     pinned forms in the sidebar rather than native modules) ---------
    await seedLiftPlanTemplate(tx, tenant.id)
    await seedToolboxTemplate(tx, tenant.id)

    // --- Inspection records (5 sample records against the seeded types) -
    await seedInspectionRecords(tx, tenant.id)

    // --- Equipment categories + sample log entries ----------------------
    await seedEquipmentCategoriesAndLogs(tx, tenant.id)

    // --- Atmospheric gas-detector pilot (custom fields + Calibration type) ---
    await seedAtmosphericGasDetectorPilot(tx, tenant.id)

    // --- HazID / JSHA library (hazards, sets, tasks, assessment types) --
    await seedHazidLibraries(tx, tenant.id)

    // --- Training assessment type templates ----------------------------
    await seedTrainingAssessmentTypes(tx, tenant.id)

    // --- Training assessment attempts (5 sample completed quizzes) ------
    await seedTrainingAssessmentAttempts(tx, tenant.id)

    // --- Safe Distance sample records (electrical / drone / vehicle) ---
    await seedSafeDistanceRecords(tx, tenant.id)

    // --- Incident demo records (taxonomy comes from the shared module) ---
    await seedIncidentDemoData(tx, tenant.id)

    // --- People groups + titles + job-description tasks ----
    await seedPeopleGroupsAndTitles(tx, tenant.id)

    console.log(`  · tenant: ${tenant.name} (${tenant.slug})`)
    console.log(`  · super-admin: ${admin.email}`)
    console.log(
      `  · seeded: ${insertedPeople.length} people, ${courses.length} courses, 4 incidents (1 rich), ${caRows.length} CAs, ${docDefs.length} documents w/ versions+acks, 8 equipment, 6 harnesses w/ inspections, 5 toolbox talks`,
    )
    console.log(`  · sign in via Magic link (Mailpit: http://localhost:8025)`)
  })

  // Every report is an ordinary tenant-owned AppKit definition. Seed identity
  // is insert-only so re-running the seed restores missing defaults without
  // overwriting a tenant's edits.
  await db.transaction(async (tx) => {
    const all = await tx.select({ id: tenants.id }).from(tenants)
    for (const tenant of all) {
      await tx
        .insert(reportDefinitions)
        .values(
          BEACON_REPORT_SEEDS.map((definition) => ({
            tenantId: tenant.id,
            seedKey: definition.seedKey,
            slug: definition.slug,
            name: definition.name,
            description: definition.description,
            category: definition.category,
            query: definition.query,
            layout: definition.layout,
            state: definition.state,
            tags: definition.tags ?? [],
          })),
        )
        .onConflictDoNothing()
    }
  })

  // Canonical templates (JSHA / Toolbox Talk / Lift Plan / WAH Rescue) ----
  // These are seeded for the first tenant only — every other tenant clones
  // them on demand from the /apps/templates/new gallery.
  await seedCanonicalTemplates(db)

  // Documentation lookups — types + hierarchical categories. Idempotent and
  // scoped to the first tenant.
  await db.transaction(async (tx) => {
    const [first] = await tx
      .select({ id: tenants.id })
      .from(tenants)
      .orderBy(tenants.createdAt)
      .limit(1)
    if (!first) return
    await seedDocumentTypesAndCategories(tx as any, first.id)
  })

  // PDF document templates — refresh the seeded per-module print defaults and
  // generate a default document per published Builder app that has none, for
  // EVERY tenant on every run (upserts; tenant-authored templates and chosen
  // defaults are never touched; deletions are respected).
  await db.transaction(async (tx) => {
    const all = await tx.select({ id: tenants.id }).from(tenants)
    for (const t of all) {
      await seedPdfTemplates(tx as any, t.id)
      await seedFormPdfTemplates(tx as any, t.id)
    }
  })

  // Work Permit — a built-in Builder App in its own `work_permit` category,
  // carrying the approval gate and validity-window flow that make it a
  // permit-to-work rather than a plain form. No native module, table or
  // permission of its own.
  //
  // Runs for EVERY tenant on EVERY run, like the PDF templates above, NOT inside
  // the first-run-only demo bootstrap: a seeded database must still receive the
  // permit when it is added after that bootstrap already ran. `ensureTemplate`
  // returns the existing row for a `key` that is already there, so this is
  // add-only and idempotent and never overwrites a tenant's edits.
  await db.transaction(async (tx) => {
    const all = await tx.select({ id: tenants.id }).from(tenants)
    for (const t of all) {
      await seedWorkPermitTemplate(tx as never, t.id)
    }
  })

  // Phase 11-E — Fire / Environment / Calibration / Statutory Register.
  //
  // Seed DATA ONLY, inside the same per-tenant-every-run stage as the permit
  // above and NOT inside the first-run-only demo bootstrap. Every row lands in a
  // table the platform already owns: no new table, enum, migration, permission,
  // RoleScope variant or nav module is introduced. Calibration and Fire are
  // equipment categories/types plus equipment inspection types and criteria;
  // Environment and Statutory are two register-kind Builder Apps.
  await db.transaction(async (tx) => {
    const all = await tx.select({ id: tenants.id }).from(tenants)
    for (const t of all) {
      await seedPhase11EEquipment(tx as never, t.id)
      await seedPhase11EDocumentCategories(tx as never, t.id)
      await seedPhase11ERegisterApps(tx as never, t.id)
    }
  })

  // Reference-counter reconciliation.
  //
  // `nextReference` mints `PREFIX-YYYY-NNNN` from `reference_counters`, and its
  // own comment records why it replaced `SELECT count(*) + 1`: that scheme
  // "raced" (two concurrent creates read one count) and "drifted" (a deleted
  // record lowered the count, so a number was reused). The counter is therefore
  // the single source of truth for the next number, and a duplicate reference is
  // a real defect — these strings are how an incident, corrective action or work
  // order is identified to a user in a list, a PDF, a print sheet and an email.
  //
  // This seed writes references as LITERALS (`CA-2026-0001`, `INC-2026-0001`,
  // `WO-2026-0001`, …) in exactly the format `nextReference` mints, but it never
  // advanced the counter. The counter therefore still read 0 after seeding, so
  // the first few records a user created through the UI or the API were handed
  // `CA-2026-0001` and `CA-2026-0002` again, colliding with seeded rows that
  // already held those numbers.
  //
  // One statement raises every counter to at least the highest reference already
  // present for that entity and year. `GREATEST` makes it raise-only, so it never
  // rewinds a counter, and the whole stage is idempotent and safe on every seed.
  // Each UNION branch matches the exact shape `nextReference` mints, so a
  // free-text reference can never be misread as a sequence number.
  await db.transaction(async (tx) => {
    const all = await tx.select({ id: tenants.id }).from(tenants)
    for (const t of all) {
      await tx.execute(sql`
        INSERT INTO reference_counters (tenant_id, entity, period, seq, created_at, updated_at)
        SELECT
          ${t.id}::uuid,
          parsed.entity,
          substring(parsed.reference from '^[A-Z]+-([0-9]{4})-'),
          GREATEST(
            0,
            COALESCE(MAX(NULLIF(substring(parsed.reference from '-([0-9]+)$'), '')::bigint), 0)
          ),
          now(),
          now()
        FROM (
          SELECT 'incident'::text AS entity, i.reference AS reference
            FROM incidents i
           WHERE i.tenant_id = ${t.id}::uuid AND i.reference ~ '^INC-[0-9]{4}-[0-9]+$'
          UNION ALL
          SELECT 'corrective_action', c.reference
            FROM corrective_actions c
           WHERE c.tenant_id = ${t.id}::uuid AND c.reference ~ '^CA-[0-9]{4}-[0-9]+$'
          UNION ALL
          SELECT 'inspection', r.reference
            FROM inspection_records r
           WHERE r.tenant_id = ${t.id}::uuid AND r.reference ~ '^INS-[0-9]{4}-[0-9]+$'
          UNION ALL
          SELECT 'equipment_inspection', r.reference
            FROM equipment_inspection_records r
           WHERE r.tenant_id = ${t.id}::uuid AND r.reference ~ '^EQI-[0-9]{4}-[0-9]+$'
          UNION ALL
          SELECT 'work_order', w.reference
            FROM equipment_work_orders w
           WHERE w.tenant_id = ${t.id}::uuid AND w.reference ~ '^WO-[0-9]{4}-[0-9]+$'
          UNION ALL
          SELECT 'hazid', h.reference
            FROM hazid_assessments h
           WHERE h.tenant_id = ${t.id}::uuid AND h.reference ~ '^HAZ-[0-9]{4}-[0-9]+$'
          UNION ALL
          SELECT 'journal', j.reference
            FROM journal_entries j
           WHERE j.tenant_id = ${t.id}::uuid AND j.reference ~ '^JRN-[0-9]{4}-[0-9]+$'
          UNION ALL
          SELECT 'safe_distance', sd.reference
            FROM safe_distance_records sd
           WHERE sd.tenant_id = ${t.id}::uuid AND sd.reference ~ '^SD-[0-9]{4}-[0-9]+$'
        ) parsed
        GROUP BY parsed.entity, substring(parsed.reference from '^[A-Z]+-([0-9]{4})-')
        ON CONFLICT (tenant_id, entity, period) DO UPDATE
          SET seq = GREATEST(reference_counters.seq, EXCLUDED.seq),
              updated_at = now()
      `)
    }
  })

  // Completeness assertion. Everything above is best-effort per stage, so this
  // is the one place that can tell the truth about the run as a whole.
  //
  // A tenant is not usable until its built-in roles exist — without them no
  // membership can be granted a permission and nobody can sign in with a role —
  // so a demo tenant carrying none of `BUILTIN_ROLES` is a half-initialised
  // database, not a seeded one. The first-run-only bootstrap above cannot repair
  // that state (the tenant exists, so it is correctly skipped), so the seed
  // reports the gap loudly and names the remedy instead of printing
  // "Seed complete" over it.
  const [demoAfter] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.slug, DEMO_TENANT_SLUG))
    .limit(1)
  if (!demoAfter) {
    throw new Error(
      `Seed finished without the "${DEMO_TENANT_SLUG}" tenant — refusing to report success`,
    )
  }

  const seededRoles = await db
    .select({ key: roles.key })
    .from(roles)
    .where(and(eq(roles.tenantId, demoAfter.id), inArray(roles.key, Object.keys(BUILTIN_ROLES))))
  const missingRoles = Object.keys(BUILTIN_ROLES).filter(
    (key) => !seededRoles.some((r) => r.key === key),
  )
  if (missingRoles.length > 0) {
    throw new Error(
      `Tenant "${DEMO_TENANT_SLUG}" exists but is missing built-in roles ` +
        `(${missingRoles.join(', ')}). The demo bootstrap is first-run only and cannot ` +
        `repair this state. Drop the database (or the docker volume) and re-run ` +
        `"pnpm db:migrate && pnpm db:seed".`,
    )
  }

  await pg.end()
  console.log('✔ Seed complete')
}

/**
 * Idempotently insert the canonical form templates in `CANONICAL_TEMPLATES`
 * (currently the Working at Heights Rescue Plan) for the FIRST tenant in the
 * database. JSHA, Lift Plan and Toolbox Talk are deliberately not canonical
 * because they have native modules or per-tenant built-in seeders.
 *
 * Safe to re-run: uses ON CONFLICT (tenant_id, key) DO NOTHING for templates,
 * and version 1 is inserted only when the template was actually new.
 *
 * Re-export of CANONICAL_TEMPLATES means the same shape is consumed by the
 * "Start from template" gallery at /apps/templates/new (the gallery clones
 * each template into the user's own tenant on click).
 */
async function seedCanonicalTemplates(
  db: ReturnType<typeof createSuperClient>['db'],
): Promise<void> {
  await db.transaction(async (tx) => {
    // Pick the first tenant (by createdAt). If there is none, skip — this is
    // a fresh DB with no tenants.
    const [first] = await tx
      .select({ id: tenants.id, name: tenants.name, slug: tenants.slug })
      .from(tenants)
      .orderBy(tenants.createdAt)
      .limit(1)
    if (!first) {
      console.log('  · seedCanonicalTemplates: no tenants found, skipping')
      return
    }

    // Find a super-admin user to attribute the `created_by` field, if available.
    const [superAdmin] = await tx
      .select({ id: user.id })
      .from(user)
      .where(eq(user.isSuperAdmin, true))
      .limit(1)
    const createdBy = superAdmin?.id ?? null

    let inserted = 0
    let skipped = 0
    for (const canonical of CANONICAL_TEMPLATES) {
      // Insert the template shell. ON CONFLICT (tenant_id, key) DO NOTHING — if
      // an admin already cloned + renamed one, we don't fight them.
      const inserts = await tx
        .insert(formTemplates)
        .values({
          tenantId: first.id,
          key: canonical.key,
          name: canonical.name,
          category: canonical.category,
          description: canonical.description,
          status: 'published',
          moduleBinding: canonical.moduleBinding,
          createdBy,
        })
        .onConflictDoNothing({ target: [formTemplates.tenantId, formTemplates.key] })
        .returning({ id: formTemplates.id })

      const tmpl = inserts[0]
      if (!tmpl) {
        skipped += 1
        continue
      }

      await tx.insert(formTemplateVersions).values({
        tenantId: first.id,
        templateId: tmpl.id,
        version: 1,
        schema: canonical.schema as FormSchemaV1,
        publishedAt: new Date(),
        publishedBy: createdBy,
        changelog: 'Canonical template v1',
      })
      inserted += 1
    }
    console.log(
      `  · canonical templates: ${inserted} inserted, ${skipped} already present (tenant: ${first.slug ?? first.id})`,
    )
  })
}

async function insertOrgUnit(
  tx: any,
  tenantId: string,
  parentId: string | null,
  level: 'customer' | 'project' | 'site' | 'area',
  name: string,
  extras: { lat?: number; lng?: number; geofenceMeters?: number } = {},
): Promise<{ id: string }> {
  const [row] = await tx
    .insert(orgUnits)
    .values({ tenantId, parentId, level, name, ...extras })
    .returning()
  return row
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function build5x5() {
  const cells: Record<string, { score: number; label: string; color: string }> = {}
  const labels = ['Low', 'Low', 'Medium', 'High', 'Extreme']
  const colors = ['#22c55e', '#86efac', '#eab308', '#f97316', '#dc2626']
  for (let s = 0; s < 5; s++) {
    for (let l = 0; l < 5; l++) {
      const score = (s + 1) * (l + 1)
      const tier = score <= 4 ? 0 : score <= 8 ? 1 : score <= 12 ? 2 : score <= 19 ? 3 : 4
      cells[`${s}:${l}`] = { score, label: labels[tier]!, color: colors[tier]! }
    }
  }
  return cells
}

/**
 * Sample equipment categories and one recent log entry per seeded item.
 * Idempotent — every insert uses
 * `onConflictDoNothing` or pre-checks for existing rows so re-running the
 * seed never duplicates.
 */
async function seedEquipmentCategoriesAndLogs(tx: any, tenantId: string): Promise<void> {
  // --- Categories ----------------------------------------------------
  const categoryDefs = [
    { slug: 'vehicles', name: 'Vehicles', description: 'Trucks, vans, pickups', sortOrder: 1 },
    { slug: 'tools', name: 'Tools', description: 'Hand and power tools', sortOrder: 2 },
    { slug: 'lifts', name: 'Lifts', description: 'Aerial lifts, scissor lifts', sortOrder: 3 },
  ]
  for (const c of categoryDefs) {
    await tx
      .insert(equipmentCategories)
      .values({
        tenantId,
        name: c.name,
        slug: c.slug,
        description: c.description,
        sortOrder: c.sortOrder,
      })
      .onConflictDoNothing({ target: [equipmentCategories.tenantId, equipmentCategories.slug] })
  }

  // --- One sample log entry per item (idempotent) ---------------------
  const items = await tx
    .select({ id: equipmentItems.id, name: equipmentItems.name })
    .from(equipmentItems)
    .where(eq(equipmentItems.tenantId, tenantId))
    .limit(5)
  const dayMs = 24 * 60 * 60 * 1000
  let logsCreated = 0
  for (const item of items) {
    const [existing] = await tx
      .select({ id: equipmentLogEntries.id })
      .from(equipmentLogEntries)
      .where(eq(equipmentLogEntries.equipmentItemId, item.id))
      .limit(1)
    if (existing) continue
    await tx.insert(equipmentLogEntries).values({
      tenantId,
      equipmentItemId: item.id,
      entryDate: new Date(Date.now() - 14 * dayMs).toISOString().slice(0, 10),
      kind: 'note',
      title: 'Receipt + inspection notes',
      details: 'Initial intake — checked condition, attached receipt, tagged with QR.',
    })
    logsCreated += 1
  }

  console.log(`  · equipment categories + ${logsCreated} sample log entries`)
}

/**
 * Atmospheric gas-detector pilot — the worked example of the custom-field
 * system replacing the legacy `AtmosphericEquipment` flag + sensor columns.
 * Idempotently seeds, for the tenant:
 *   1. a "Portable Gas Detector" equipment type;
 *   2. a subtype-scoped custom-field group on that type (detector model, the
 *      active sensor channels, calibration dates, bump-test interval) — values
 *      live on each item's metadata.custom;
 *   3. a "Calibration" equipment inspection type (quarterly) whose criteria are
 *      the per-channel response checks, so calibration HISTORY is tracked by the
 *      existing inspection engine (due dates / pass-fail / WO spawn) rather than
 *      a bespoke atmospheric table; and
 *   4. one sample detector item with custom values filled in.
 * Skipped cleanly when the type already exists.
 */
export async function seedAtmosphericGasDetectorPilot(tx: any, tenantId: string): Promise<void> {
  const TYPE_NAME = 'Portable Gas Detector'
  const existingType = await tx
    .select({ id: equipmentTypes.id })
    .from(equipmentTypes)
    .where(and(eq(equipmentTypes.tenantId, tenantId), eq(equipmentTypes.name, TYPE_NAME)))
    .limit(1)
  if (existingType.length > 0) {
    console.log('  · atmospheric gas-detector pilot: already seeded, skipping')
    return
  }

  // 1. Equipment type.
  const [gasType] = await tx
    .insert(equipmentTypes)
    .values({
      tenantId,
      name: TYPE_NAME,
      category: 'safety',
      description: 'Portable multi-gas atmospheric monitor (confined-space entry, hot work).',
    })
    .returning({ id: equipmentTypes.id })
  if (!gasType) return

  // 2. Subtype-scoped custom fields (the gas-detector configuration).
  const fields = [
    {
      key: 'detector_model',
      label: 'Detector model',
      fieldType: 'text',
      config: null,
      required: true,
    },
    {
      key: 'sensor_channels',
      label: 'Active sensor channels',
      fieldType: 'multi_select',
      config: {
        options: [
          { value: 'o2', label: 'O₂ (Oxygen)' },
          { value: 'lel', label: 'LEL (Combustibles)' },
          { value: 'h2s', label: 'H₂S (Hydrogen sulfide)' },
          { value: 'co', label: 'CO (Carbon monoxide)' },
        ],
      },
      required: true,
    },
    {
      key: 'last_calibration_on',
      label: 'Last calibration',
      fieldType: 'date',
      config: null,
      required: false,
    },
    {
      key: 'calibration_due_on',
      label: 'Calibration due',
      fieldType: 'date',
      config: null,
      required: false,
    },
    {
      key: 'bump_test_interval_days',
      label: 'Bump-test interval',
      fieldType: 'number',
      config: { unit: 'days', min: 1, max: 365 },
      required: false,
    },
  ] as const

  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]!
    await tx.insert(customFieldDefinitions).values({
      tenantId,
      entityKind: 'equipment',
      subtypeId: gasType.id,
      key: f.key,
      label: f.label,
      fieldType: f.fieldType,
      config: f.config ?? null,
      required: f.required,
      groupLabel: 'Gas detector',
      sortOrder: i,
      isActive: true,
    })
  }

  // 3. "Calibration" inspection type + per-channel criteria.
  const [calType] = await tx
    .insert(equipmentInspectionTypes)
    .values({
      tenantId,
      appliesToTypeId: gasType.id,
      name: 'Calibration',
      description:
        'Quarterly calibration against certified test gas. A failed channel forces a work order.',
      intervalValue: 3,
      intervalUnit: 'month',
      allowPassAll: false,
      failsSpawnWorkOrders: true,
      isActive: true,
    })
    .returning({ id: equipmentInspectionTypes.id })

  if (calType) {
    const [channelGroup] = await tx
      .insert(equipmentInspectionGroups)
      .values({
        tenantId,
        inspectionTypeId: calType.id,
        sequence: 0,
        label: 'Sensor channels',
        description: 'Response of each active channel to certified test gas.',
      })
      .returning({ id: equipmentInspectionGroups.id })

    const criteria = [
      { question: 'O₂ reads 20.9% ± 0.5 on fresh air', kind: 'pass_fail' as const, critical: true },
      {
        question: 'LEL channel responds within ±5% of test gas',
        kind: 'pass_fail' as const,
        critical: true,
      },
      {
        question: 'H₂S channel responds within ±10% of test gas',
        kind: 'pass_fail' as const,
        critical: true,
      },
      {
        question: 'CO channel responds within ±10% of test gas',
        kind: 'pass_fail' as const,
        critical: true,
      },
      {
        question: 'Bump-test record saved to the unit',
        kind: 'pass_fail' as const,
        critical: false,
      },
    ]
    for (let i = 0; i < criteria.length; i++) {
      const c = criteria[i]!
      await tx.insert(equipmentInspectionCriteria).values({
        tenantId,
        inspectionTypeId: calType.id,
        groupId: channelGroup?.id ?? null,
        sequence: i,
        question: c.question,
        kind: c.kind,
        severity: c.critical ? 'critical' : 'medium',
        requiresPhoto: false,
        requiresComment: false,
        isRequired: true,
        isCritical: c.critical,
      })
    }
  }

  // 4. One sample detector item with custom values populated.
  const [gdItem] = await tx
    .insert(equipmentItems)
    .values({
      tenantId,
      typeId: gasType.id,
      assetTag: 'GD-001',
      serialNumber: 'BW-GA-0001',
      name: 'Gas Detector GD-001',
      qrToken: `bhs-eq-${randomUUID()}`,
      status: 'in_service',
      metadata: {
        custom: {
          detector_model: 'BW MicroClip XL',
          sensor_channels: ['o2', 'lel', 'h2s', 'co'],
          last_calibration_on: '2026-05-01',
          calibration_due_on: '2026-08-01',
          bump_test_interval_days: 1,
        },
      },
    })
    .onConflictDoNothing()
    .returning({ id: equipmentItems.id })

  // Recurring quarterly calibration cadence for the sample unit (only when the
  // item insert actually landed — onConflictDoNothing returns no row on skip).
  if (gdItem) {
    await tx.insert(equipmentInspectionSchedules).values({
      tenantId,
      equipmentItemId: gdItem.id,
      inspectionTypeId: calType?.id ?? null,
      label: null,
      intervalValue: 3,
      intervalUnit: 'month',
      nextDueOn: isoDate(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)),
      isActive: true,
    })
  }

  console.log(
    '  · atmospheric gas-detector pilot (type + custom fields + Calibration inspection + sample item)',
  )
}

/**
 * Idempotently insert 3 sample pressure-test safe-distance records — covering
 * each governing method (NASA, ASME, Lloyd's) — for the given tenant. Skips if
 * any reference matching 'SD-SEED-%' already exists, so re-seeds are safe.
 *
 * Result columns are precomputed from the pipe segments + test pressure using
 * the same formulas as the app's `_lib.ts` (see tools/safe-distance). The SEED
 * prefix keeps these obviously distinct from real records (SD-YYYY-NNNN).
 */
export async function seedSafeDistanceRecords(tx: any, tenantId: string): Promise<void> {
  const existing = await tx
    .select({ reference: safeDistanceRecords.reference })
    .from(safeDistanceRecords)
    .where(
      sql`${safeDistanceRecords.tenantId} = ${tenantId} AND ${safeDistanceRecords.reference} LIKE 'SD-SEED-%'`,
    )
  if (existing.length > 0) {
    console.log(`  · safe distance: ${existing.length} sample already present, skipping`)
    return
  }

  const siteRow = await tx
    .select({ id: orgUnits.id })
    .from(orgUnits)
    .where(sql`${orgUnits.tenantId} = ${tenantId} AND ${orgUnits.level} = 'site'`)
    .limit(1)
  const siteId = siteRow[0]?.id ?? null

  const supervisorRow = await tx
    .select({ id: tenantUsers.id })
    .from(tenantUsers)
    .where(sql`${tenantUsers.tenantId} = ${tenantId} AND ${tenantUsers.status} = 'active'`)
    .limit(1)
  const supervisorId = supervisorRow[0]?.id ?? null

  const operatorRow = await tx
    .select({ id: people.id })
    .from(people)
    .where(sql`${people.tenantId} = ${tenantId} AND ${people.status} = 'active'`)
    .limit(1)
  const operatorId = operatorRow[0]?.id ?? null

  const now = new Date()
  const dayMs = 24 * 60 * 60 * 1000
  const samples = [
    {
      offset: 1,
      reference: 'SD-SEED-1',
      name: 'North header — 6" line',
      method: 'nasa' as const,
      unit: 'imperial' as const,
      testPressure: '150',
      description: 'Hydro/pneumatic proof of the 6" north header run prior to tie-in.',
      totalVolume: '3.9270',
      resultNasa: '23.6653',
      resultAsme: '98.4252',
      resultLloyds: '10.1488',
      segments: [
        {
          name: 'Header run',
          unit: 'inch' as const,
          length: '240',
          diameter: '6',
          volM3: '0.111199997',
        },
      ],
      notes: 'Exclusion zone set to the NASA-Glenn figure. Bleed-down valve manned throughout.',
    },
    {
      offset: 4,
      reference: 'SD-SEED-2',
      name: 'Compressor skid manifold',
      method: 'asme' as const,
      unit: 'metric' as const,
      testPressure: '50',
      description: 'High-pressure pneumatic test of the compressor skid manifold.',
      totalVolume: '0.8482',
      resultNasa: '32.1848',
      resultAsme: '30.0000',
      resultLloyds: '10.9628',
      segments: [
        {
          name: 'Manifold',
          unit: 'm' as const,
          length: '12',
          diameter: '0.3',
          volM3: '0.848230016',
        },
      ],
      notes:
        'ASME PCC-2 governs. Hard barricade to 30 m, no personnel inside during pressurisation.',
    },
    {
      offset: 9,
      reference: 'SD-SEED-3',
      name: 'Test loop — 8" + 4"',
      method: 'lloyds' as const,
      unit: 'imperial' as const,
      testPressure: '300',
      description: 'Combined loop: 8" main plus a 4" branch.',
      totalVolume: '11.3447',
      resultNasa: '51.6803',
      resultAsme: '98.4252',
      resultLloyds: '18.7792',
      segments: [
        {
          name: '8" main',
          unit: 'inch' as const,
          length: '360',
          diameter: '8',
          volM3: '0.296533324',
        },
        {
          name: '4" branch',
          unit: 'inch' as const,
          length: '120',
          diameter: '4',
          volM3: '0.024711110',
        },
      ],
      notes: "Lloyd's Register figure adopted as the governing stand-off for this loop.",
    },
  ]

  let inserted = 0
  for (const s of samples) {
    const [rec] = await tx
      .insert(safeDistanceRecords)
      .values({
        tenantId,
        reference: s.reference,
        name: s.name,
        method: s.method,
        unit: s.unit,
        testPressure: s.testPressure,
        description: s.description,
        siteOrgUnitId: siteId,
        supervisorTenantUserId: supervisorId,
        operatorPersonId: operatorId,
        totalVolume: s.totalVolume,
        resultNasa: s.resultNasa,
        resultAsme: s.resultAsme,
        resultLloyds: s.resultLloyds,
        occurredAt: new Date(now.getTime() - s.offset * dayMs),
        notes: s.notes,
        attachmentIds: [],
      })
      .returning({ id: safeDistanceRecords.id })
    if (rec?.id) {
      await tx.insert(safeDistanceSegments).values(
        s.segments.map((seg, i) => ({
          tenantId,
          recordId: rec.id,
          name: seg.name,
          unit: seg.unit,
          lengthValue: seg.length,
          internalDiameter: seg.diameter,
          volumeM3: seg.volM3,
          sortOrder: i,
        })),
      )
    }
    inserted++
  }

  console.log(`  · safe distance: ${inserted} sample records seeded`)
}

/**
 * DEMO incident data. The taxonomy itself is created by the shared
 * `seedIncidentTaxonomy` in `./seed/incident-taxonomy` — the same function tenant
 * provisioning calls — so the classification and injury-type sets have one source of
 * truth and a production tenant gets the same catalogue the demo does.
 *
 * What stays here, and deliberately does NOT move into that module:
 *   - injury types assigned to the demo injuries, keyed on hard-coded references;
 *   - hours-worked windows with figures invented for a fictional crew;
 *   - `classification_id` back-filled onto the demo incidents.
 *
 * Those are demo business records. Provisioning must never write them: fabricated
 * hours would silently become a production tenant's TRIR denominator, and the
 * back-fill would mutate incidents that provisioning has no business touching.
 */
async function seedIncidentDemoData(tx: any, tenantId: string): Promise<void> {
  const taxonomy = await seedIncidentTaxonomy(tx, tenantId)
  const { classificationsByName, injuryTypesByName } = taxonomy

  const seededInjuries = await tx
    .select({ id: incidentInjuries.id, reference: incidents.reference })
    .from(incidentInjuries)
    .innerJoin(
      incidents,
      and(
        eq(incidents.tenantId, incidentInjuries.tenantId),
        eq(incidents.id, incidentInjuries.incidentId),
      ),
    )
    .where(eq(incidentInjuries.tenantId, tenantId))
  const typeNamesByReference: Record<string, string[]> = {
    'INC-2026-0002': ['Laceration'],
    'INC-2026-0003': ['Strain / sprain', 'Contusion / bruise'],
  }
  let injuryTypeAssignmentsSeeded = 0
  for (const injury of seededInjuries) {
    const typeNames = typeNamesByReference[injury.reference] ?? []
    const injuryTypeIds = typeNames
      .map((name) => injuryTypesByName.get(name))
      .filter((id): id is string => Boolean(id))
    if (injuryTypeIds.length === 0) continue
    await tx.insert(incidentInjuryTypeAssignments).values(
      injuryTypeIds.map((injuryTypeId) => ({
        tenantId,
        injuryId: injury.id,
        injuryTypeId,
      })),
    )
    injuryTypeAssignmentsSeeded += injuryTypeIds.length
  }

  // Hours-worked windows — last 3 months (tenant-wide).  Numbers are
  // realistic for a ~40-person field-ops crew.
  const today = new Date()
  for (let m = 1; m <= 3; m++) {
    const monthStart = new Date(today.getFullYear(), today.getMonth() - m, 1)
    const monthEnd = new Date(today.getFullYear(), today.getMonth() - m + 1, 0)
    const label = monthStart.toLocaleString('en-US', { month: 'long', year: 'numeric' })
    // Slight per-month variance to make the rate chart visibly interesting.
    const hours = (6400 + m * 250).toFixed(2)
    const headcount = 40 + (m % 2)
    await tx.insert(incidentHoursPeriods).values({
      tenantId,
      siteOrgUnitId: null,
      periodStart: monthStart.toISOString().slice(0, 10),
      periodEnd: monthEnd.toISOString().slice(0, 10),
      periodLabel: label,
      totalHours: hours,
      employeeCount: headcount,
      notes: 'Tenant-wide rollup (auto-seeded).',
    })
  }

  // Back-fill classification_id on the seeded incidents so the frequency /
  // DART / OSHA-log reports render right out of the gate.
  const seededIncidents = await tx
    .select({ id: incidents.id, reference: incidents.reference, type: incidents.type })
    .from(incidents)
    .where(eq(incidents.tenantId, tenantId))
  const mapByType: Record<string, string | undefined> = {
    injury: classificationsByName.get('Injury'),
    illness: classificationsByName.get('Illness'),
    near_miss: classificationsByName.get('Near miss'),
    property_damage: classificationsByName.get('Property damage'),
    environmental: classificationsByName.get('Environmental'),
  }
  for (const inc of seededIncidents) {
    const cId = mapByType[inc.type as keyof typeof mapByType]
    if (!cId) continue
    await tx.update(incidents).set({ classificationId: cId }).where(eq(incidents.id, inc.id))
  }

  console.log(
    `  · incident taxonomy: ${INCIDENT_CLASSIFICATION_SEED.length} classifications, ` +
      `${INCIDENT_INJURY_TYPE_SEED.length} injury types, ` +
      `${injuryTypeAssignmentsSeeded} injury-type assignments, ` +
      `3 hours-worked windows, ${seededIncidents.length} incidents back-filled ` +
      `(${taxonomy.inserted.classifications} classifications + ` +
      `${taxonomy.inserted.injuryTypes} injury types inserted)`,
  )
}

/**
 * Seed the People taxonomy tables — groups, titles + their job-description task
 * lists. Includes some sample memberships and acknowledgement records so the UI
 * has data to render on first boot.
 *
 * Idempotent guard: skips entirely if any `person_titles` rows already exist
 * for the tenant.
 */
export async function seedPeopleGroupsAndTitles(tx: any, tenantId: string): Promise<void> {
  const [existing] = await tx
    .select({ id: personTitles.id })
    .from(personTitles)
    .where(eq(personTitles.tenantId, tenantId))
    .limit(1)
  if (existing) {
    console.log('  · people taxonomy already seeded, skipping')
    return
  }
  // Pull existing people so we can attach memberships
  const peopleRows = await tx
    .select({
      id: people.id,
      firstName: people.firstName,
      lastName: people.lastName,
    })
    .from(people)
    .where(eq(people.tenantId, tenantId))
  if (peopleRows.length === 0) {
    console.log('  · no people in tenant — skipping people taxonomy seed')
    return
  }
  const findByName = (last: string) => peopleRows.find((p: any) => p.lastName === last)

  // --- Groups (4) ----------------------------------------------------------
  // The definitions come from the shared reference seeder; memberships stay
  // demo-only and are distributed below.
  await seedPersonGroups(tx, tenantId)
  const insertedGroups = await tx
    .select()
    .from(personGroups)
    .where(eq(personGroups.tenantId, tenantId))

  // Distribute groups among the first ~half of the workforce
  const groupMembershipRows: { tenantId: string; groupId: string; personId: string }[] = []
  for (const [idx, g] of insertedGroups.entries()) {
    const slice = peopleRows.filter(
      (_: any, i: number) =>
        i % insertedGroups.length === idx % insertedGroups.length || i < 3 + idx,
    )
    for (const p of slice.slice(0, 4)) {
      groupMembershipRows.push({ tenantId, groupId: g.id, personId: p.id })
    }
  }
  if (groupMembershipRows.length > 0) {
    await tx.insert(personGroupMemberships).values(groupMembershipRows).onConflictDoNothing()
  }

  // --- Titles (6) ---------------------------------------------------------
  const titleSeed = [
    {
      name: 'Carpenter',
      description: 'Performs rough and finish carpentry on structural and form-work assemblies.',
      responsibilities:
        '• Lay out, fabricate and install wood or metal stud framing\n• Construct concrete forms and falsework\n• Install doors, windows, trim and hardware\n• Maintain hand and power tools in safe condition',
      education:
        'Inter-provincial Red Seal Carpenter ticket preferred. Minimum: completed carpentry apprenticeship year 3.',
      experience: 'Minimum 3 years on commercial / industrial sites.',
    },
    {
      name: 'Welder',
      description: 'Performs structural, pipe and fabrication welding to project specifications.',
      responsibilities:
        '• Read and interpret welding procedure specifications (WPS)\n• Perform SMAW / GMAW / GTAW welds in all positions\n• Verify fit-up and joint preparation\n• Conduct visual weld inspection and rework as required',
      education: 'CWB-certified welder ticket required. WHMIS + Fall Protection current.',
      experience:
        'Minimum 5 years pressure / structural welding. CWB qualification continuity required.',
    },
    {
      name: 'Foreman',
      description: 'Front-line supervisor responsible for crew productivity, safety and quality.',
      responsibilities:
        '• Plan daily work and assign tasks within scope\n• Conduct toolbox talks and pre-job hazard assessments\n• Enforce site safety rules and PPE compliance\n• Report incidents and near-misses immediately',
      education:
        'Trade ticket in crew discipline + Supervisor Health & Safety Awareness (Ontario MoL).',
      experience: 'Minimum 8 years on tools + 2 years supervisory experience.',
    },
    {
      name: 'Apprentice',
      description: 'Learner under journey-person supervision. Performs work as directed.',
      responsibilities:
        '• Assist journey-person in all assigned tasks\n• Maintain apprenticeship logbook\n• Attend scheduled trade school sessions\n• Ask for guidance — never improvise on unfamiliar tasks',
      education: 'Registered apprentice with provincial trades authority.',
      experience: 'No minimum — pairs with experienced mentor at all times.',
    },
    {
      name: 'Project Manager',
      description: 'End-to-end ownership of project schedule, budget and safety performance.',
      responsibilities:
        '• Build and maintain the master project schedule\n• Manage cost-to-complete and forecast variances\n• Lead client communication and change-order process\n• Chair monthly safety steering committee',
      education: 'Engineering or Construction Management degree. PMP certification preferred.',
      experience: 'Minimum 10 years construction industry, 5 years as PM on >$5M projects.',
    },
    {
      name: 'Safety Officer',
      description: 'Owns the site safety program. Reports independently to senior management.',
      responsibilities:
        '• Conduct daily site walks and document findings\n• Investigate incidents and near-misses\n• Maintain training matrix and PPE registers\n• Liaise with regulators and host clients on compliance matters',
      education: 'CRSP / NCSO designation. Standard First Aid + CPR-C current.',
      experience: 'Minimum 5 years dedicated safety role on industrial construction sites.',
    },
  ] as const

  const insertedTitles = await tx
    .insert(personTitles)
    .values(titleSeed.map((t) => ({ tenantId, ...t })))
    .returning()
  const titleByName = new Map<string, any>(insertedTitles.map((t: any) => [t.name as string, t]))

  // Assign primary titles to specific seed people (matching their jobTitle text)
  const titleAssignmentRows: {
    tenantId: string
    titleId: string
    personId: string
    isPrimary: boolean
  }[] = []
  const heuristicMap: Record<string, string> = {
    Anderson: 'Foreman', // Site Supervisor → closest match
    Bell: 'Carpenter',
    Chen: 'Carpenter',
    Desai: 'Welder',
    Eaton: 'Foreman',
    Foster: 'Apprentice',
    Gonzales: 'Apprentice',
    Hamid: 'Welder',
    Iverson: 'Safety Officer',
    Jensen: 'Project Manager',
  }
  for (const [last, titleName] of Object.entries(heuristicMap)) {
    const person = findByName(last)
    const title = titleByName.get(titleName)
    if (person && title) {
      titleAssignmentRows.push({
        tenantId,
        titleId: title.id,
        personId: person.id,
        isPrimary: true,
      })
    }
  }
  if (titleAssignmentRows.length > 0) {
    await tx.insert(personTitleAssignments).values(titleAssignmentRows).onConflictDoNothing()
  }

  // --- Per-title task lists -----------------------------------------------
  const tasksByTitle: Record<string, { task: string; description?: string }[]> = {
    Carpenter: [
      {
        task: 'Inspect personal hand tools before each shift',
        description: 'Check handles, edges, guards, electrical leads.',
      },
      {
        task: 'Wear appropriate PPE for the task at hand',
        description: 'Minimum: hard hat, glasses, gloves, CSA boots.',
      },
      { task: 'Perform daily harness inspection before fall-arrest work' },
      { task: 'Maintain housekeeping in active work area at all times' },
      { task: 'Report all incidents, injuries and near-misses to foreman' },
    ],
    Welder: [
      { task: 'Verify WPS is current and matches the joint specification' },
      { task: 'Inspect welding leads, ground clamps, and regulators each shift' },
      {
        task: 'Conduct fire watch for required time after hot work',
        description: 'Minimum 30 minutes post-weld in non-confined areas.',
      },
      { task: 'Wear full leathers, FR clothing, and shaded helmet during arc work' },
      { task: 'Perform visual inspection of each completed weld before moving on' },
    ],
    Foreman: [
      {
        task: 'Lead daily toolbox talk and document attendance',
        description: "Cover the JSHA for the day's work.",
      },
      { task: 'Verify all workers have required training before assigning task' },
      { task: 'Perform pre-job hazard assessment with crew' },
      { task: 'Stop unsafe work immediately and escalate to safety officer' },
      { task: 'Conduct end-of-day site walk and document any incomplete work' },
    ],
    Apprentice: [
      { task: 'Maintain apprenticeship logbook daily' },
      { task: 'Work only under direct journey-person supervision' },
      { task: 'Ask for clarification on any unfamiliar task before starting' },
      { task: 'Attend all scheduled trade-school sessions' },
    ],
    'Project Manager': [
      { task: 'Maintain master project schedule and review weekly with client' },
      { task: 'Approve all change orders before execution' },
      { task: 'Chair monthly safety steering committee meeting' },
      { task: 'Review monthly cost forecast vs. budget' },
      { task: 'Sign off on all sub-contractor pre-qualifications' },
    ],
    'Safety Officer': [
      { task: 'Conduct daily site safety walk and log findings' },
      { task: 'Investigate every incident and near-miss within 24 hours' },
      { task: 'Maintain training matrix and notify supervisors of expiring certs' },
      { task: 'Audit PPE issue register weekly' },
      { task: 'Liaise with regulator on any reportable event' },
      { task: 'Lead monthly emergency-response drill' },
    ],
  }

  const taskRows: {
    tenantId: string
    titleId: string
    task: string
    description?: string | null
    entityOrder: number
  }[] = []
  for (const [titleName, tasks] of Object.entries(tasksByTitle)) {
    const title = titleByName.get(titleName)
    if (!title) continue
    for (const [i, t] of tasks.entries()) {
      taskRows.push({
        tenantId,
        titleId: title.id,
        task: t.task,
        description: t.description ?? null,
        entityOrder: i + 1,
      })
    }
  }
  const insertedTasks = await tx.insert(jobTitleTasks).values(taskRows).returning()

  // --- Sample acknowledgements -------------------------------------------
  // Have each assigned person acknowledge the first task of their title to
  // give the matrix view some data on first boot.
  const ackRows: {
    tenantId: string
    taskId: string
    personId: string
  }[] = []
  for (const a of titleAssignmentRows) {
    const firstTask = insertedTasks.find((t: any) => t.titleId === a.titleId && t.entityOrder === 1)
    if (firstTask) {
      ackRows.push({ tenantId, taskId: firstTask.id, personId: a.personId })
    }
  }
  if (ackRows.length > 0) {
    await tx.insert(jobTitleTaskAcknowledgments).values(ackRows).onConflictDoNothing()
  }

  // --- Refresh denormalised caches on `people` ---------------------------
  await tx.execute(sql`
    UPDATE people
    SET group_ids = COALESCE((
      SELECT jsonb_agg(group_id ORDER BY group_id)
      FROM person_group_memberships
      WHERE person_id = people.id AND tenant_id = ${tenantId}
    ), '[]'::jsonb),
    title_ids = COALESCE((
      SELECT jsonb_agg(title_id ORDER BY title_id)
      FROM person_title_assignments
      WHERE person_id = people.id AND tenant_id = ${tenantId}
    ), '[]'::jsonb)
    WHERE tenant_id = ${tenantId}
  `)

  console.log(
    `  · people taxonomy: ${insertedGroups.length} groups (${groupMembershipRows.length} memberships), ${insertedTitles.length} titles (${titleAssignmentRows.length} primary assignments, ${insertedTasks.length} job-description tasks, ${ackRows.length} sample acknowledgements)`,
  )
}

// Inspection records — 5 sample legacy-style inspections against the seeded
// inspection types, each with criterion responses (mix of pass/fail/N-A).
export async function seedInspectionRecords(tx: any, tenantId: string): Promise<void> {
  const existing = await tx
    .select({ id: inspectionRecords.id })
    .from(inspectionRecords)
    .where(
      sql`${inspectionRecords.tenantId} = ${tenantId} AND ${inspectionRecords.reference} LIKE 'INS-SEED-%'`,
    )
  if (existing.length > 0) {
    console.log(`  · inspection records: ${existing.length} already present, skipping`)
    return
  }
  const types = await tx
    .select({ id: inspectionTypes.id, name: inspectionTypes.name })
    .from(inspectionTypes)
    .where(sql`${inspectionTypes.tenantId} = ${tenantId}`)
  if (types.length === 0) {
    console.log('  · inspection records: no types in tenant, skipping')
    return
  }
  const siteRow = await tx
    .select({ id: orgUnits.id })
    .from(orgUnits)
    .where(sql`${orgUnits.tenantId} = ${tenantId} AND ${orgUnits.level} = 'site'`)
    .limit(1)
  const siteId = siteRow[0]?.id ?? null
  const inspectorRow = await tx
    .select({ id: tenantUsers.id })
    .from(tenantUsers)
    .where(sql`${tenantUsers.tenantId} = ${tenantId}`)
    .limit(1)
  const inspectorId = inspectorRow[0]?.id ?? null
  // Pull criteria for each type so we can write responses
  const today = new Date()
  const DAY_MS = 24 * 60 * 60 * 1000
  let created = 0
  for (let i = 0; i < 5; i++) {
    const type = types[i % types.length]
    const occurredAt = new Date(today.getTime() - i * DAY_MS * 3)
    const ref = `INS-SEED-${String(i + 1).padStart(4, '0')}`
    const [rec] = await tx
      .insert(inspectionRecords)
      .values({
        tenantId,
        reference: ref,
        typeId: type.id,
        status: i < 2 ? 'submitted' : i === 2 ? 'in_progress' : 'closed',
        locked: i >= 3,
        occurredAt,
        siteOrgUnitId: siteId,
        inspectorTenantUserId: inspectorId,
        notes: i === 4 ? 'Routine quarterly inspection — no issues found.' : null,
        submittedAt: i < 2 ? occurredAt : null,
        closedAt: i >= 3 ? occurredAt : null,
      })
      .returning({ id: inspectionRecords.id })
    if (!rec) continue
    created++
    // Pull the type's own criteria (with their group label + response config),
    // in group then criterion order.
    const criteria = await tx
      .select({
        id: inspectionTypeCriteria.id,
        text: inspectionTypeCriteria.text,
        responseType: inspectionTypeCriteria.responseType,
        choiceOptions: inspectionTypeCriteria.choiceOptions,
        requiresPhoto: inspectionTypeCriteria.requiresPhoto,
        requiresComment: inspectionTypeCriteria.requiresComment,
        groupLabel: inspectionTypeGroups.label,
      })
      .from(inspectionTypeCriteria)
      .leftJoin(inspectionTypeGroups, eq(inspectionTypeGroups.id, inspectionTypeCriteria.groupId))
      .where(eq(inspectionTypeCriteria.typeId, type.id))
      .orderBy(inspectionTypeGroups.sequence, inspectionTypeCriteria.sequence)
    if (criteria.length === 0) continue
    for (let j = 0; j < criteria.length; j++) {
      const criterion = criteria[j]!
      const answer =
        criterion.responseType === 'choice'
          ? null
          : j === 0 && i === 1
            ? 'fail'
            : j % 5 === 4
              ? 'n_a'
              : 'pass'
      const choiceAnswer =
        criterion.responseType === 'choice' ? (criterion.choiceOptions[0] ?? null) : null
      await tx.insert(inspectionRecordCriteria).values({
        tenantId,
        recordId: rec.id,
        criterionId: criterion.id,
        questionTextSnapshot: criterion.text,
        groupLabelSnapshot: criterion.groupLabel ?? null,
        responseType: criterion.responseType,
        choiceOptionsSnapshot: criterion.choiceOptions,
        requiresPhoto: criterion.requiresPhoto,
        requiresComment: criterion.requiresComment,
        sequence: j + 1,
        answer,
        choiceAnswer,
        severity: answer === 'fail' ? 'high' : null,
        nonComplianceDescription:
          answer === 'fail' ? 'Latch loose on east door; tagged out for follow-up.' : null,
      })
    }
  }
  console.log(`  · inspection records: ${created} seeded with criterion responses`)
}

// Training assessment attempts — 5 sample completed quizzes against the
// seeded assessment types, mixing pass/fail outcomes.
export async function seedTrainingAssessmentAttempts(tx: any, tenantId: string): Promise<void> {
  const existing = await tx
    .select({ id: trainingAssessments.id })
    .from(trainingAssessments)
    .where(eq(trainingAssessments.tenantId, tenantId))
  if (existing.length > 0) {
    console.log(`  · training assessment attempts: ${existing.length} already present, skipping`)
    return
  }
  const typeRows = await tx
    .select({ id: trainingAssessmentTypes.id, passingScore: trainingAssessmentTypes.passingScore })
    .from(trainingAssessmentTypes)
    .where(eq(trainingAssessmentTypes.tenantId, tenantId))
    .limit(2)
  if (typeRows.length === 0) {
    console.log('  · training assessment attempts: no types in tenant, skipping')
    return
  }
  const peopleRows = await tx
    .select({ id: people.id, firstName: people.firstName, lastName: people.lastName })
    .from(people)
    .where(eq(people.tenantId, tenantId))
    .limit(5)
  if (peopleRows.length < 3) {
    console.log('  · training assessment attempts: not enough people, skipping')
    return
  }
  const today = new Date()
  const DAY_MS = 24 * 60 * 60 * 1000
  let created = 0
  for (let i = 0; i < 5; i++) {
    const type = typeRows[i % typeRows.length]
    const person = peopleRows[i % peopleRows.length]
    const score = i === 1 ? 60 : i === 4 ? 70 : 85 + i * 2
    const passingScore = type.passingScore ?? 75
    const passed = score >= passingScore
    await tx.insert(trainingAssessments).values({
      tenantId,
      typeId: type.id,
      personId: person.id,
      passingScore,
      score,
      passed,
      status: 'submitted',
      startedAt: new Date(today.getTime() - i * DAY_MS * 2 - 30 * 60 * 1000),
      completedAt: new Date(today.getTime() - i * DAY_MS * 2),
    })
    created++
  }
  console.log(`  · training assessment attempts: ${created} seeded (mixed pass/fail)`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
