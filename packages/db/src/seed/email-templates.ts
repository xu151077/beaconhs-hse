// Starter email templates — a small, generic library every tenant can use
// from day one without authoring HTML in the builder.
//
// Pure per-tenant reference data. Each template is record-agnostic
// (recordSubjectType = null), so the merge fields are the generic
// reference/title pair every flow send can resolve. Templates are seeded
// inactive-safe: they carry no tenant-specific wording and no operational
// commitments, and the administrator can edit or delete any of them.
//
// Idempotent by (tenant, key): existing templates — edited or deleted — are
// left exactly as found.

import type { SeedTx } from './types'
import { and, eq } from 'drizzle-orm'
import { emailTemplates } from '../schema'

type EmailTemplateSeed = {
  key: string
  name: string
  description: string
  category: 'general' | 'notification' | 'reminder' | 'approval' | 'digest' | 'marketing'
  subject: string
  body: string
}

const page = (title: string, body: string) => `<!doctype html>
<html><body style="margin:0;padding:0;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:24px 12px">
<tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #e4e4e7;border-radius:8px;padding:32px 28px">
<tr><td><h1 style="margin:0 0 8px;font-size:20px;color:#18181b">${title}</h1>
${body}
<p style="margin:24px 0 0;font-size:13px;color:#71717a">BeaconHS</p>
</td></tr></table>
</td></tr></table>
</body></html>`

const GENERIC_FIELDS = [
  { key: 'reference', label: 'Reference' },
  { key: 'title', label: 'Title' },
] as const

const TEMPLATES: EmailTemplateSeed[] = [
  {
    key: 'starter-welcome',
    name: 'Welcome',
    description: 'A short welcome message for a new workspace member.',
    category: 'general',
    subject: 'Welcome to BeaconHS',
    body: page(
      'Welcome aboard',
      '<p style="margin:0;font-size:15px;color:#3f3f46">Your workspace is ready. Open the app and start with the dashboard to see what needs attention today.</p>',
    ),
  },
  {
    key: 'starter-reminder',
    name: 'Reminder',
    description: 'A polite reminder that something still needs action.',
    category: 'reminder',
    subject: 'Reminder: {{title}}',
    body: page(
      'Action needed',
      '<p style="margin:0;font-size:15px;color:#3f3f46">This is a reminder about <strong>{{title}}</strong> (reference <strong>{{reference}}</strong>). Please review it when you have a moment.</p>',
    ),
  },
  {
    key: 'starter-approval',
    name: 'Approval request',
    description: 'Asks a reviewer to approve or reject a record.',
    category: 'approval',
    subject: 'Approval requested: {{title}}',
    body: page(
      'Approval requested',
      '<p style="margin:0;font-size:15px;color:#3f3f46">Please review <strong>{{title}}</strong> (reference <strong>{{reference}}</strong>) and approve it or send it back with a note.</p>',
    ),
  },
  {
    key: 'starter-digest',
    name: 'Daily digest',
    description: 'A short summary of what changed today.',
    category: 'digest',
    subject: 'Today in BeaconHS',
    body: page(
      'Today in BeaconHS',
      '<p style="margin:0;font-size:15px;color:#3f3f46">Here is a quick summary of what happened today. Open the app for the full list.</p>',
    ),
  },
]

/** Insert the starter email templates for a tenant. Idempotent by key. */
export async function seedEmailTemplates(tx: SeedTx, tenantId: string): Promise<void> {
  for (const template of TEMPLATES) {
    const [already] = await tx
      .select({ id: emailTemplates.id })
      .from(emailTemplates)
      .where(and(eq(emailTemplates.tenantId, tenantId), eq(emailTemplates.key, template.key)))
      .limit(1)
    if (already) continue

    await tx.insert(emailTemplates).values({
      tenantId,
      key: template.key,
      name: template.name,
      description: template.description,
      category: template.category,
      recordSubjectType: null,
      recordSubjectKey: null,
      subjectTemplate: template.subject,
      sourceHtml: template.body,
      compiledHtml: template.body,
      mergeFields: [...GENERIC_FIELDS],
      isActive: true,
    })
  }
}
