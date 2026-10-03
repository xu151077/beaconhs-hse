// The Work Permit Builder App — a permit-to-work expressed entirely with the
// existing form-builder substrate.
//
// There is deliberately NO `work_permits` table. A permit needs a type, a
// requester, a site, a description, hazards, controls and an approved validity
// window; BeaconHS already stores all of that on a `form_responses` record, and
// the window is already modelled by the monitored-session timer. So a permit is
// a published Builder App in the `work_permit` category whose flow is:
//
//   on_submit ─→ GATE (safety manager approves / rejects)
//                    │ approve
//                    ▼
//              start_monitored_session ─→ expectedEndAt = now + validity
//
// and the per-minute worker scan closes the session once that window passes.
// Reject ends the branch at the gate. Nothing here adds a permission, a
// RoleScope variant, a table or an authorization rule — the permit is visible to
// exactly who the existing `forms.response.read.*` tiers and
// `form_responses.site_org_unit_id` already allow.
//
// Permitted work types are a `select` field's options, not a database enum:
// adding a type is a Builder edit, which is the point of the Builder.

import type { AutomationGraph, FormSchemaV1 } from '@beaconhs/forms-core'
import { WORK_PERMIT_APP_KEY, WORK_PERMIT_CATEGORY } from '../work-permit'
import { ensureTemplate, type DrizzleTx } from './hazard-assessment-app-templates'

const opt = (value: string, label: string) => ({ value, label: { en: label } })

const PERMIT_TYPE_OPTIONS = [
  opt('hot_work', 'Hot work'),
  opt('confined_space', 'Confined space'),
  opt('work_at_height', 'Work at height'),
  opt('excavation', 'Excavation'),
  opt('lifting', 'Lifting'),
  opt('electrical', 'Electrical'),
  opt('general', 'General work'),
]

const HAZARD_OPTIONS = [
  opt('fire', 'Fire / hot surfaces'),
  opt('explosion', 'Explosive atmosphere'),
  opt('toxic_gas', 'Toxic gas / vapour'),
  opt('oxygen_deficiency', 'Oxygen deficiency'),
  opt('suspended_load', 'Suspended load'),
  opt('fall', 'Fall from height'),
  opt('struck_by', 'Struck by plant'),
  opt('electricity', 'Live electrical'),
  opt('confined', 'Restricted access / entrapment'),
  opt('noise_dust', 'Noise / dust exposure'),
]

const CONTROL_OPTIONS = [
  opt('permit_displayed', 'Permit displayed at worksite'),
  opt('barricade', 'Barricades / exclusion zone'),
  opt('isolation', 'Energy isolated and locked'),
  opt('gas_test', 'Atmospheric testing in place'),
  opt('ventilation', 'Ventilation running'),
  opt('fire_watch', 'Fire watch assigned'),
  opt('rescue_plan', 'Rescue plan briefed'),
  opt('ppe', 'PPE specified and worn'),
  opt('toolbox', 'Toolbox talk delivered'),
  opt('exclusion', 'Area excluded from other trades'),
]

// Validity is asked for in MINUTES because that is the unit the existing
// `start_monitored_session` action counts in (`durationFieldKey`). Expressed in
// hours it would read as hours while the flow wrote minutes — a silent factor-of-
// 60 bug in a safety window. 480 = one shift.
const PERMIT_VALIDITY_MINUTES_DEFAULT = 480

const WORK_PERMIT_APP_SCHEMA: FormSchemaV1 = {
  schemaVersion: 1,
  title: { en: 'Work Permit' },
  description: {
    en: 'Permit to work: who is doing what, where, under which controls, and for how long. Approved by the safety manager, then live until the validity window ends.',
  },
  sections: [
    {
      id: 'permit_details',
      title: { en: 'Permit details' },
      step: 'request',
      fields: [
        {
          id: 'permit_type',
          type: 'select',
          label: { en: 'Permit type' },
          required: true,
          validation: { options: PERMIT_TYPE_OPTIONS },
        },
        {
          id: 'requester',
          type: 'person_picker',
          label: { en: 'Requester' },
          required: true,
        },
        {
          id: 'site',
          type: 'site_picker',
          label: { en: 'Site' },
          required: true,
        },
        {
          id: 'work_description',
          type: 'long_text',
          label: { en: 'Work description' },
          required: true,
        },
        {
          id: 'work_location',
          type: 'text',
          label: { en: 'Precise work location' },
          required: true,
          helpText: { en: 'Level, grid reference, zone or asset tag within the site above.' },
        },
      ],
    },
    {
      id: 'risk_controls',
      title: { en: 'Hazards and control measures' },
      step: 'request',
      fields: [
        {
          id: 'hazards',
          type: 'multi_select',
          label: { en: 'Hazards identified' },
          required: true,
          validation: { options: HAZARD_OPTIONS },
        },
        {
          id: 'other_hazards',
          type: 'long_text',
          label: { en: 'Other hazards' },
          helpText: { en: 'Anything the list above does not cover.' },
        },
        {
          id: 'controls',
          type: 'multi_select',
          label: { en: 'Control measures in place' },
          required: true,
          validation: { options: CONTROL_OPTIONS },
        },
        {
          id: 'control_detail',
          type: 'long_text',
          label: { en: 'How the controls are achieved' },
          required: true,
        },
      ],
    },
    {
      id: 'authorisation',
      title: { en: 'Site authorisation' },
      step: 'authorise',
      fields: [
        {
          id: 'briefed_the_crew',
          type: 'yes_no_comment',
          label: { en: 'Crew briefed on the hazards and controls?' },
          required: true,
        },
        {
          id: 'area_confined',
          type: 'yes_no_comment',
          label: { en: 'Area excluded from other trades?' },
          required: true,
        },
        {
          id: 'authoriser_notes',
          type: 'long_text',
          label: { en: 'Authoriser notes' },
          helpText: { en: 'Anything the crew must know beyond the controls above.' },
        },
      ],
    },
    {
      id: 'validity',
      title: { en: 'Validity window' },
      step: 'request',
      fields: [
        {
          id: 'requested_start',
          type: 'datetime',
          label: { en: 'Requested start' },
          required: true,
        },
        {
          // Read by the flow's `durationFieldKey`. Approval starts a monitored
          // session of exactly this length, so its window IS the permit window.
          id: 'permit_validity_minutes',
          type: 'number',
          label: { en: 'Permit validity (minutes)' },
          required: true,
          defaultValue: { kind: 'literal', value: PERMIT_VALIDITY_MINUTES_DEFAULT },
          helpText: {
            en: 'How long this permit stays valid once approved. 480 minutes is one shift.',
          },
        },
        {
          id: 'isolation_confirmed',
          type: 'yes_no_comment',
          label: { en: 'All isolations verified and locks applied?' },
          required: true,
        },
      ],
    },
  ],
  // TWO steps, and that is load-bearing rather than cosmetic.
  //
  // `FormRenderer` picks `recordLayout = readOnly || totalSteps === 1`. The record
  // layout has NO Location control at all; only the multi-step wizard layout
  // renders it, and that control is the ONLY thing that writes
  // `form_responses.site_org_unit_id`. A single-step permit would therefore carry
  // a null site, and `moduleScopeWhere` resolves `inArray(siteCol, sites)` to
  // false for null — so a Site-A foreman could not see a colleague's Site-A permit
  // either, and site scoping would silently degrade to owner-only.
  //
  // A permit-to-work genuinely has two authorisation stages — the requester
  // raises it, the site authorises it — which is also the shape of every seeded
  // HazID app (setup → … → sign-off). The step split and the scoping requirement
  // agree, so nothing here is a workaround.
  workflow: {
    steps: [
      {
        key: 'request',
        title: { en: 'Request' },
        assignee: { type: 'expression', expr: '$submitter' },
        signatureRequired: true,
      },
      {
        key: 'authorise',
        title: { en: 'Site authorisation' },
        assignee: { type: 'role', role: 'safety_manager' },
        signatureRequired: true,
      },
    ],
  },
}

// on_submit → approve gate → start the monitored session. The reject branch is
// deliberately absent: a rejected permit must NOT start a validity window, and
// the graph has no edge off a gate's `reject` handle without a target.
export const WORK_PERMIT_FLOW_GRAPH: AutomationGraph = {
  schemaVersion: 1,
  nodes: [
    {
      id: 'trg_submit',
      position: { x: 60, y: 80 },
      data: { kind: 'trigger', trigger: { trigger: 'on_submit' } },
    },
    {
      id: 'gate_approve',
      position: { x: 320, y: 80 },
      data: {
        kind: 'gate',
        gate: {
          title: 'Work permit approval',
          // `safety_manager` is a seeded tenant role. Approval authority lives on
          // the gate's assignee, not on a new permission key.
          assignee: { type: 'role', role: 'safety_manager' },
          signatureRequired: true,
        },
      },
    },
    {
      id: 'act_monitor',
      position: { x: 600, y: 80 },
      data: {
        kind: 'action',
        action: {
          action: 'start_monitored_session',
          // A permit is not polled on a fixed cadence; the interval only governs
          // the (rare) missed check-in prompt. The safety-relevant part is the
          // window, taken from the requested validity field above.
          intervalMinutes: 1440,
          graceMinutes: 0,
          durationFieldKey: 'permit_validity_minutes',
        },
      },
    },
  ],
  edges: [
    { id: 'e_submit_gate', source: 'trg_submit', target: 'gate_approve' },
    {
      id: 'e_gate_monitor',
      source: 'gate_approve',
      target: 'act_monitor',
      sourceHandle: 'approve',
    },
  ],
}

export async function seedWorkPermitTemplate(tx: DrizzleTx, tenantId: string) {
  const template = await ensureTemplate(tx, {
    tenantId,
    key: WORK_PERMIT_APP_KEY,
    name: 'Work Permit',
    description:
      'Permit to work: type, requester, site, hazards, controls and an approved validity window. Closes automatically when the window ends.',
    schema: WORK_PERMIT_APP_SCHEMA,
    category: WORK_PERMIT_CATEGORY,
    iconKey: 'clipboard-check',
    changelog: 'Built-in Work Permit app v1',
    flow: { name: 'Work permit approval', graph: WORK_PERMIT_FLOW_GRAPH },
  })
  return { workPermitTemplateId: template.id }
}
