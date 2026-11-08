import { readFileSync, readdirSync } from 'node:fs'
import { getTableConfig } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import * as schema from './schema'
import {
  ATTACHMENT_TENANT_REFERENCES,
  attachmentTenantConstraintName,
} from './attachment-integrity'

const drizzleFolder = new URL('../drizzle/', import.meta.url)
const metaFolder = new URL('../drizzle/meta/', import.meta.url)
const dropMigrationSql = readFileSync(
  new URL('0055_drop_redundant_single_col_fks.sql', drizzleFolder),
  'utf8',
)

type TableConfig = ReturnType<typeof getTableConfig>

function allTableConfigs(): TableConfig[] {
  const byName = new Map<string, TableConfig>()
  for (const value of Object.values(schema)) {
    if (!value || typeof value !== 'object') continue
    try {
      const config = getTableConfig(value as Parameters<typeof getTableConfig>[0])
      if (config.name && config.columns.length > 0) byName.set(config.name, config)
    } catch {
      // enums, relations, and type-only exports are not tables
    }
  }
  return [...byName.values()]
}

function foreignKeySignatures(table: TableConfig): Map<string, string> {
  return new Map(
    table.foreignKeys.map((foreignKey) => {
      const reference = foreignKey.reference()
      const parent = getTableConfig(reference.foreignTable).name
      const localColumns = reference.columns.map((column) => column.name).join(',')
      const parentColumns = reference.foreignColumns.map((column) => column.name).join(',')
      return [
        `${table.name}.${localColumns}->${parent}.${parentColumns}`,
        foreignKey.onDelete ?? 'no action',
      ]
    }),
  )
}

function snapshotForeignKeyNames(): Set<string> {
  const snapshot = JSON.parse(readFileSync(new URL('0055_snapshot.json', metaFolder), 'utf8')) as {
    tables: Record<string, { foreignKeys?: Record<string, { name: string }> }>
  }
  const names = new Set<string>()
  for (const table of Object.values(snapshot.tables)) {
    for (const foreignKey of Object.values(table.foreignKeys ?? {})) {
      names.add(foreignKey.name)
    }
  }
  return names
}

function committedSqlText(): string {
  return readdirSync(drizzleFolder)
    .filter((name) => name.endsWith('.sql'))
    .map((name) => readFileSync(new URL(name, drizzleFolder), 'utf8'))
    .join('\n')
}

/**
 * The nine single-column CASCADE keys dropped by 0055. Each one is subsumed by
 * the composite tenant key in `twin`: same CASCADE behaviour, and the composite
 * additionally pins tenant ownership. Historical 0000_init/0003 artifacts that
 * no snapshot ever recorded.
 */
const droppedSingleColumnFks = [
  {
    name: 'ai_conversation_shares_conversation_id_ai_conversations_id_fk',
    table: 'ai_conversation_shares',
    twin: 'ai_conversation_shares.tenant_id,conversation_id->ai_conversations.tenant_id,id',
  },
  {
    name: 'ai_conversation_shares_target_role_id_roles_id_fk',
    table: 'ai_conversation_shares',
    twin: 'ai_conversation_shares.tenant_id,target_role_id->roles.tenant_id,id',
  },
  {
    name: 'ai_conversation_shares_target_user_id_user_id_fk',
    table: 'ai_conversation_shares',
    twin: 'ai_conversation_shares.tenant_id,target_user_id->tenant_users.tenant_id,user_id',
  },
  {
    name: 'ai_messages_conversation_id_ai_conversations_id_fk',
    table: 'ai_messages',
    twin: 'ai_messages.tenant_id,conversation_id->ai_conversations.tenant_id,id',
  },
  {
    name: 'report_runs_schedule_id_report_schedules_id_fk',
    table: 'report_runs',
    twin: 'report_runs.tenant_id,schedule_id->report_schedules.tenant_id,id',
  },
  {
    name: 'role_assignments_role_id_roles_id_fk',
    table: 'role_assignments',
    twin: 'role_assignments.tenant_id,role_id->roles.tenant_id,id',
  },
  {
    name: 'role_assignments_tenant_user_id_tenant_users_id_fk',
    table: 'role_assignments',
    twin: 'role_assignments.tenant_id,tenant_user_id->tenant_users.tenant_id,id',
  },
  {
    name: 'role_dashboard_layouts_role_id_roles_id_fk',
    table: 'role_dashboard_layouts',
    twin: 'role_dashboard_layouts.tenant_id,role_id->roles.tenant_id,id',
  },
  {
    name: 'user_permission_overrides_tenant_user_id_tenant_users_id_fk',
    table: 'user_permission_overrides',
    twin: 'user_permission_overrides.tenant_id,tenant_user_id->tenant_users.tenant_id,id',
  },
] as const

/**
 * The residual database-only foreign keys that remain intentionally SQL-only
 * after 0055: 67 partial `ON DELETE SET NULL (col)` keys (Drizzle cannot emit
 * the partial form, and tenant_id is NOT NULL so a full SET NULL would be
 * wrong) plus the 6 attachment composite CASCADE keys owned by
 * ATTACHMENT_TENANT_REFERENCES. Every name below is created by a committed
 * migration (so fresh installs get them too) and none is recorded in the
 * snapshot chain. If this allowlist ever needs to grow, that is a deliberate
 * design decision and must be reviewed here, not discovered by audit.
 */
const sqlOnlyForeignKeys = [
  'att_tenant_attachment_upload_reservations_attachmen_66ef871a',
  'att_tenant_ca_complete_steps_signature_attachment_i_7ac91220',
  'att_tenant_ca_photos_attachment_id_8d52d64f',
  'att_tenant_document_acknowledgments_signature_attac_8d4dd74c',
  'att_tenant_document_versions_content_attachment_id_fbe2121a',
  'att_tenant_document_versions_docx_attachment_id_b9205573',
  'att_tenant_document_versions_pdf_attachment_id_d0ab2091',
  'att_tenant_documents_source_attachment_id_ffee7c97',
  'att_tenant_equipment_inspection_record_attachments__500ac65b',
  'att_tenant_equipment_items_manual_attachment_id_7d1906f3',
  'att_tenant_equipment_items_photo_attachment_id_f21b0693',
  'att_tenant_equipment_log_entries_attachment_id_d6cf86b1',
  'att_tenant_flow_gates_signature_attachment_id_7b0208cb',
  'att_tenant_form_response_steps_signature_attachment_c9af0c56',
  'att_tenant_form_responses_pdf_attachment_id_77a27d75',
  'att_tenant_hazid_assessment_photos_attachment_id_e68dd69c',
  'att_tenant_hazid_assessment_signatures_signature_at_3d4c2f1b',
  'att_tenant_hazid_hazards_photo_attachment_id_4fc40ddc',
  'att_tenant_incident_attachments_attachment_id_c4235b2a',
  'att_tenant_inspection_record_attachments_attachment_b7a018cc',
  'att_tenant_inspection_records_customer_signature_at_26e23f62',
  'att_tenant_journal_entry_photos_attachment_id_320c6565',
  'att_tenant_people_photo_attachment_id_0d0df239',
  'att_tenant_people_signature_attachment_id_b1274863',
  'att_tenant_person_files_attachment_id_0e1a4b40',
  'att_tenant_ppe_annual_records_certificate_attachmen_da29f9c3',
  'att_tenant_ppe_issues_receipt_signature_attachment__ac3db527',
  'att_tenant_report_runs_pdf_attachment_id_306d4627',
  'att_tenant_training_class_attendees_signature_attac_b66d1fc9',
  'att_tenant_training_content_items_attachment_id_687a36fa',
  'att_tenant_training_content_items_source_attachment_13fe424a',
  'att_tenant_training_course_files_attachment_id_9d69a56d',
  'att_tenant_training_lesson_progress_evaluation_sign_36ccded4',
  'att_tenant_training_lessons_attachment_id_cdc65bf9',
  'att_tenant_training_lessons_source_attachment_id_efa446df',
  'att_tenant_training_records_certificate_attachment__0ad1cd4e',
  'att_tenant_training_skill_assignment_files_attachme_ad294ddf',
  'att_tenant_training_skill_assignments_evidence_atta_02d0c204',
  'document_acks_tenant_session_fk',
  'document_categories_tenant_parent_fk',
  'equipment_inspection_criteria_tenant_group_fk',
  'equipment_inspection_record_criteria_tenant_work_order_fk',
  'equipment_inspection_records_tenant_inspection_type_fk',
  'equipment_inspection_records_tenant_inspector_person_fk',
  'equipment_inspection_records_tenant_work_order_fk',
  'equipment_inspection_types_tenant_applies_to_type_fk',
  'equipment_items_tenant_category_fk',
  'equipment_items_tenant_pre_use_inspection_type_fk',
  'equipment_reminders_tenant_assigned_to_fk',
  'equipment_station_settings_tenant_default_org_unit_fk',
  'equipment_types_tenant_category_fk',
  'hazid_assessment_app_responses_tenant_template_type_app_fk',
  'hazid_assessment_hazards_tenant_hazard_fk',
  'hazid_assessment_questions_tenant_source_type_question_fk',
  'hazid_assessment_signatures_tenant_person_fk',
  'hazid_assessment_tasks_tenant_task_fk',
  'hazid_assessment_types_tenant_default_hazard_set_fk',
  'hazid_assessments_tenant_assessment_type_fk',
  'hazid_assessments_tenant_project_org_unit_fk',
  'hazid_assessments_tenant_reported_by_user_fk',
  'hazid_assessments_tenant_site_org_unit_fk',
  'hazid_assessments_tenant_supervisor_person_fk',
  'hazid_assessments_tenant_supervisor_user_fk',
  'hazid_hazards_tenant_hazard_type_fk',
  'incident_classifications_tenant_created_by_fk',
  'incident_events_tenant_recorded_by_fk',
  'incident_hours_periods_tenant_entered_by_fk',
  'incident_hours_periods_tenant_site_fk',
  'incident_injury_types_tenant_created_by_fk',
  'incident_preventative_steps_tenant_owner_fk',
  'incidents_tenant_classification_fk',
  'incidents_tenant_source_response_fk',
  'truck_log_entries_tenant_source_connection_fk',
] as const

/** Installed by 0055 to close the reverse gap (manifest named it, DB lacked it). */
const ppeInspectionAttachmentsFk = 'att_tenant_ppe_inspection_attachments_attachment_id_3b75c366'

describe('foreign key snapshot coverage (D8)', () => {
  it('drops only redundant single-column keys, each subsumed by a schema composite', () => {
    const tables = new Map(allTableConfigs().map((table) => [table.name, table]))
    const snapshotNames = snapshotForeignKeyNames()
    for (const dropped of droppedSingleColumnFks) {
      expect(dropMigrationSql, dropped.name).toContain(
        `DROP CONSTRAINT IF EXISTS "${dropped.name}"`,
      )
      expect(snapshotNames.has(dropped.name), dropped.name).toBe(false)
      expect(foreignKeySignatures(tables.get(dropped.table)!).get(dropped.twin), dropped.name).toBe(
        'cascade',
      )
    }
    expect(droppedSingleColumnFks).toHaveLength(9)
  })

  it('keeps schema and snapshot foreign-key counts in agreement', () => {
    // Together with the allowlist below this proves the database-only set is
    // exactly the pinned SQL-only keys: schema == snapshot by construction of
    // the drift guard, and the live DB is a superset of the snapshot.
    const schemaCount = allTableConfigs().reduce(
      (total, table) => total + table.foreignKeys.length,
      0,
    )
    expect(schemaCount).toBe(snapshotForeignKeyNames().size)
  })

  it('pins the intentional SQL-only residual set', () => {
    expect(sqlOnlyForeignKeys).toHaveLength(73)
    expect(new Set(sqlOnlyForeignKeys).size).toBe(sqlOnlyForeignKeys.length)
    const snapshotNames = snapshotForeignKeyNames()
    const sql = committedSqlText()
    for (const name of sqlOnlyForeignKeys) {
      expect(snapshotNames.has(name), name).toBe(false)
      expect(sql, name).toContain(name)
    }
    const manifestNames = new Set(ATTACHMENT_TENANT_REFERENCES.map(attachmentTenantConstraintName))
    for (const name of sqlOnlyForeignKeys) {
      if (name.startsWith('att_tenant_')) expect(manifestNames, name).toContain(name)
    }
  })

  it('installs the never-installed ppe_inspection_attachments tenant-attachment key', () => {
    const manifestNames = new Set(ATTACHMENT_TENANT_REFERENCES.map(attachmentTenantConstraintName))
    expect(manifestNames).toContain(ppeInspectionAttachmentsFk)
    expect(snapshotForeignKeyNames().has(ppeInspectionAttachmentsFk)).toBe(false)
    expect(dropMigrationSql).toContain(
      `ADD CONSTRAINT "${ppeInspectionAttachmentsFk}" FOREIGN KEY ("tenant_id", "attachment_id") REFERENCES "attachments" ("tenant_id", "id") ON DELETE CASCADE NOT VALID`,
    )
    expect(dropMigrationSql).toContain(`VALIDATE CONSTRAINT "${ppeInspectionAttachmentsFk}"`)
  })
})
