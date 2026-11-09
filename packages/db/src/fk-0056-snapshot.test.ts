import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const metaFolder = new URL('../drizzle/meta/', import.meta.url)
const drizzleFolder = new URL('../drizzle/', import.meta.url)

function snapshot(n: number) {
  return JSON.parse(
    readFileSync(new URL(`${String(n).padStart(4, '0')}_snapshot.json`, metaFolder), 'utf8'),
  ) as {
    tables: Record<string, { foreignKeys: Record<string, any> }>
    id: string
    prevId: string
  }
}

describe('0056 snapshot consistency (Schema ↔ SQL ↔ Snapshot)', () => {
  it('audit_log tenant FK is RESTRICT in snapshot', () => {
    const s = snapshot(56)
    const fk = s.tables['public.audit_log']!.foreignKeys['audit_log_tenant_id_tenants_id_fk']
    expect(fk!.onDelete).toBe('restrict')
    expect(fk!.onUpdate).toBe('no action')
  })
  it('ppe composite FK exists with correct columns and actions', () => {
    const s = snapshot(56)
    const fk =
      s.tables['public.ppe_inspection_attachments']!.foreignKeys[
        'att_tenant_ppe_inspection_attachments_attachment_id_3b75c366'
      ]
    expect(fk).toBeDefined()
    expect(fk.columnsFrom).toEqual(['tenant_id', 'attachment_id'])
    expect(fk.columnsTo).toEqual(['tenant_id', 'id'])
    expect(fk.tableTo).toBe('attachments')
    expect(fk.onDelete).toBe('cascade')
    expect(fk.onUpdate).toBe('no action')
  })
  it('snapshot chain points at 0055', () => {
    expect(snapshot(56).prevId).toBe(snapshot(55).id)
  })
  it('SQL and schema express the same intent', () => {
    const sql = readFileSync(
      new URL('0056_audit_log_and_fk_replay_safety.sql', drizzleFolder),
      'utf8',
    )
    expect(sql).toContain('ON DELETE RESTRICT')
    expect(sql).toContain('att_tenant_ppe_inspection_attachments_attachment_id_3b75c366')
    const audit = readFileSync(new URL('./schema/audit.ts', import.meta.url), 'utf8')
    expect(audit).toContain("onDelete: 'restrict'")
    const ppe = readFileSync(new URL('./schema/ppe.ts', import.meta.url), 'utf8')
    expect(ppe).toContain('att_tenant_ppe_inspection_attachments_attachment_id_3b75c366')
    expect(ppe).toContain('foreignColumns: [attachments.tenantId, attachments.id]')
  })
})
