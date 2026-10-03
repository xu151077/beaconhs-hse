// Phase 11-E (C. Environment / D. Statutory Register) — two register-kind
// Builder Apps.
//
// Both are ordinary `form_templates` rows in their own category, created through
// the SAME `ensureTemplate` helper Phase 11-C introduced for the Work Permit.
// That reuse is the point: there is no environmental or statutory module, no
// table, no permission, no RoleScope variant, no nav entry and no bespoke
// lifecycle. A register entry IS a `form_responses` row, so it inherits:
//
//   · site scope from `form_responses.site_org_unit_id` (written by the record
//     Location control), filtered by the existing `forms.response.read.*`
//     ladder and `moduleScopeWhere`;
//   · tenant scope from RLS on `form_responses`;
//   · attachments from the Builder's own photo/file controls;
//   · audit from every existing response mutation;
//   · reporting from `data_sources` projections and the report studio.
//
// Why a Builder App and not a table: the audit found the only genuinely missing
// primitive was a generic *monitoring* record, and the instruction forbids
// creating one. A `register`-kind app is the platform's existing answer — "an
// append-and-browse tabular log. Add a row per entry."
//
// Neither app carries a flow graph. A lifecycle would mean a second workflow
// system; these are logs, not state machines. Expiry for the statutory register
// comes from the EXISTING compliance mechanism (`compliance_recurrence_kind =
// 'expiry'`) rather than a bespoke timer.

import type { FormSchemaV1 } from '@beaconhs/forms-core'
import { ensureTemplate, type DrizzleTx } from './hazard-assessment-app-templates'

export const ENVIRONMENT_MONITORING_CATEGORY = 'environment_monitoring'
export const ENVIRONMENT_MONITORING_APP_KEY = 'environmental-monitoring-log'

export const STATUTORY_REGISTER_CATEGORY = 'statutory_register'
export const STATUTORY_REGISTER_APP_KEY = 'statutory-compliance-register'

const opt = (value: string, label: string) => ({ value, label: { en: label } })

// Only field types that already exist in the Builder registry. No new field type.
const MONITORING_CATEGORY_OPTIONS = [
  opt('air', 'Air emissions'),
  opt('water', 'Water / effluent'),
  opt('waste', 'Waste'),
  opt('noise', 'Noise'),
  opt('soil', 'Soil and groundwater'),
  opt('spill', 'Spill / release'),
]

const MONITORING_RESULT_OPTIONS = [
  opt('within_limits', 'Within limits'),
  opt('exceeded', 'Limit exceeded'),
  opt('not_taken', 'Not taken'),
  opt('investigation_required', 'Investigation required'),
]

export const ENVIRONMENT_MONITORING_SCHEMA: FormSchemaV1 = {
  schemaVersion: 1,
  title: { en: 'Environmental Monitoring Log' },
  description: {
    en: 'One row per monitoring visit or sample: what was measured, where, the reading, the limit, and the outcome. Add a corrective action from any entry that exceeds a limit.',
  },
  sections: [
    {
      id: 'monitoring_entry',
      title: { en: 'Monitoring entry' },
      fields: [
        {
          id: 'monitoring_datetime',
          type: 'datetime',
          label: { en: 'Monitoring date and time' },
          required: true,
        },
        {
          // Records the Site on the response itself, which is the column the
          // site-scoped read ladder filters on — not just a payload value.
          id: 'site',
          type: 'site_picker',
          label: { en: 'Site' },
          required: true,
        },
        {
          id: 'monitoring_category',
          type: 'select',
          label: { en: 'Monitoring category' },
          required: true,
          validation: { options: MONITORING_CATEGORY_OPTIONS },
        },
        {
          id: 'parameter',
          type: 'text',
          label: { en: 'Parameter measured' },
          required: true,
          helpText: { en: 'For example pH, particulate, VOC, effluent TSS, dB(A).' },
        },
        {
          id: 'reading_value',
          type: 'number',
          label: { en: 'Reading' },
          required: true,
        },
        {
          id: 'reading_unit',
          type: 'text',
          label: { en: 'Unit' },
          required: true,
          helpText: { en: 'For example mg/L, ppm, dB(A), pH units.' },
        },
        {
          id: 'limit_value',
          type: 'number',
          label: { en: 'Permitted limit' },
          helpText: { en: 'Leave blank where no numeric limit applies.' },
        },
        {
          id: 'result',
          type: 'select',
          label: { en: 'Result' },
          required: true,
          validation: { options: MONITORING_RESULT_OPTIONS },
        },
        {
          id: 'monitored_by',
          type: 'person_picker',
          label: { en: 'Monitored by' },
          required: true,
        },
        {
          id: 'evidence',
          type: 'photo',
          label: { en: 'Evidence' },
          helpText: {
            en: 'Attach the lab report, instrument reading photo or chain-of-custody sheet.',
          },
        },
        {
          id: 'notes',
          type: 'long_text',
          label: { en: 'Notes' },
        },
      ],
    },
  ],
  workflow: {
    steps: [
      {
        key: 'log',
        title: { en: 'Log entry' },
        assignee: { type: 'expression', expr: '$submitter' },
      },
    ],
  },
}

const REQUIREMENT_STATUS_OPTIONS = [
  opt('compliant', 'Compliant'),
  opt('action_required', 'Action required'),
  opt('not_applicable', 'Not applicable'),
  opt('superseded', 'Superseded'),
]

export const STATUTORY_REGISTER_SCHEMA: FormSchemaV1 = {
  schemaVersion: 1,
  title: { en: 'Statutory Compliance Register' },
  description: {
    en: 'One row per statutory or regulatory requirement that applies to this site: what the law requires, who owns it, when it applies, and when it must be reviewed or renewed.',
  },
  sections: [
    {
      id: 'register_entry',
      title: { en: 'Register entry' },
      fields: [
        {
          id: 'site',
          type: 'site_picker',
          label: { en: 'Site' },
          required: true,
        },
        {
          id: 'requirement',
          type: 'long_text',
          label: { en: 'Requirement / legal item' },
          required: true,
          helpText: {
            en: 'What the law or permit requires, in plain words. Name the clause where you can.',
          },
        },
        {
          id: 'instrument',
          type: 'text',
          label: { en: 'Permit, licence or instrument reference' },
          required: true,
        },
        {
          id: 'issuing_authority',
          type: 'text',
          label: { en: 'Issuing authority' },
          required: true,
        },
        {
          id: 'responsible_person',
          type: 'person_picker',
          label: { en: 'Responsible person' },
          required: true,
        },
        {
          id: 'applicable_on',
          type: 'date',
          label: { en: 'Applicable from' },
          required: true,
        },
        {
          id: 'review_or_expiry_on',
          type: 'date',
          label: { en: 'Review / expiry date' },
          required: true,
          helpText: {
            en: 'When the obligation must be renewed or re-verified. Drives the compliance reminder.',
          },
        },
        {
          id: 'status',
          type: 'select',
          label: { en: 'Status' },
          required: true,
          defaultValue: { kind: 'literal', value: 'compliant' },
          validation: { options: REQUIREMENT_STATUS_OPTIONS },
        },
        {
          id: 'evidence_document',
          type: 'file',
          label: { en: 'Evidence' },
          helpText: {
            en: 'Attach the certificate, permit copy or inspection report that evidences compliance.',
          },
        },
        {
          id: 'notes',
          type: 'long_text',
          label: { en: 'Notes' },
        },
      ],
    },
  ],
  workflow: {
    steps: [
      {
        key: 'entry',
        title: { en: 'Register entry' },
        assignee: { type: 'expression', expr: '$submitter' },
      },
    ],
  },
}

/**
 * Seed both register apps for one tenant.
 *
 * Runs for EVERY tenant on EVERY seed, beside the PDF and Work Permit stages and
 * NOT inside the first-run-only demo bootstrap. `ensureTemplate` returns the
 * existing row for a `key` that is already present, so a second run adds nothing
 * and never overwrites a tenant's edits to the schema.
 */
export async function seedPhase11ERegisterApps(
  tx: DrizzleTx,
  tenantId: string,
): Promise<{ environmentTemplateId: string; statutoryTemplateId: string }> {
  const environment = await ensureTemplate(tx, {
    tenantId,
    key: ENVIRONMENT_MONITORING_APP_KEY,
    name: 'Environmental Monitoring Log',
    description:
      'One row per monitoring visit or sample: what was measured, where, the reading, the limit, and the outcome.',
    schema: ENVIRONMENT_MONITORING_SCHEMA,
    category: ENVIRONMENT_MONITORING_CATEGORY,
    kind: 'register',
    // `NavIcon` resolves ICONS[key] ?? Gauge, so an unknown key would silently
    // render a gauge. Both keys below exist in the ICONS map.
    iconKey: 'gauge',
    changelog: 'Built-in Environmental Monitoring Log v1',
  })
  const statutory = await ensureTemplate(tx, {
    tenantId,
    key: STATUTORY_REGISTER_APP_KEY,
    name: 'Statutory Compliance Register',
    description:
      'One row per statutory or regulatory requirement that applies to a site, with a responsible person and a review or expiry date.',
    schema: STATUTORY_REGISTER_SCHEMA,
    category: STATUTORY_REGISTER_CATEGORY,
    kind: 'register',
    iconKey: 'scroll',
    changelog: 'Built-in Statutory Compliance Register v1',
  })
  return { environmentTemplateId: environment.id, statutoryTemplateId: statutory.id }
}
