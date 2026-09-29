---
name: HSE Domain
description: BeaconHS HSE domain model and the canonical Finding/Risk/Action/Verification loop. Use when designing or changing any HSE record lifecycle, when deciding if something is a Builder form or a native module, or when a change risks creating a parallel lifecycle.
---

# HSE Domain

BeaconHS records HSE events well. It does not yet manage their **resolution**.
This skill governs any change to that gap.

## When to use

- Adding or changing any HSE record type (incident, finding, hazard, risk,
  action, verification, certificate, inspection).
- Deciding whether a request is a Builder form or a native module.
- Any change that could create a second lifecycle for the same concept.

## The target loop

Every HSE "something is wrong" flow should be able to express:

```
discover → classify → rate risk → assign measure → assign owner
        → correct → verify → close
```

## What exists today (verified)

| Concept | Status | Evidence |
|---|---|---|
| `corrective_actions` | **The only complete lifecycle** — owner, due, verification, notification | `packages/db/src/schema/corrective-actions.ts:56-182` |
| `findings` table | **Does not exist** | grep over `packages/db/src/schema` + `packages/db/drizzle` returns 0 |
| `hazards` as findings | **Does not exist** — only library + per-assessment rows | `hazid-libraries.ts:58`, `hazid-assessments.ts:183` |
| `risks` register | **Does not exist** — only 4 nullable ints per hazard row | `hazid-assessments.ts:198-204` |
| Parallel partial lifecycles | **8 of them** | see `docs/hse-development-baseline.md` §6 |

`hazid_assessment_hazards` has **no** owner, assignee, due date, status,
review date, or corrective-action link. A risk row therefore cannot be tracked.

## Classification vocabulary

Use only these four. Do not invent a fifth, and do not rank modules.

- **PRESERVE** — correct as-is; do not touch.
- **EXTEND** — add capability to the existing native module.
- **ADAPT** — keep the concept, change the data model to match existing patterns.
- **NEW** — a genuinely new model, justified below.

## Builder vs native decision

**Builder first.** The form engine already has 46 field types, 6 triggers, 13
actions, `flow_gates` for human approval, and a report studio. Use a Builder App
for: RAMS/JSA/SWMS documents, custom checklists, permit-to-work, toolbox talks,
any form-shaped workflow.

A native module is justified **only** when the feature needs one or more of:
a complex state machine, a dedicated API, a dedicated permission, transactional
cross-model writes, a performance requirement, or an authoritative queryable
record.

If you choose NEW, state which of those applies. "It would be cleaner" is not a
reason.

Current approved NEW set (do not expand without an ADR): `findings`, `risks`,
plus the `machinery_certificates` table.

## Module boundaries

- A **finding** is "we observed something that needs fixing".
- A **risk** is a rated, owned, reviewable exposure — with or without an
  observation behind it.
- An **action** is assigned work with an owner and a due date.
- **Verification** is a distinct, attributable sign-off by someone other than the
  person who did the work.
- A **certificate** is an externally-issued credential with an expiry.

Do not collapse these. Each has different lifecycle semantics, and merging them is
how the current 8-way duplication arose.

## What to read first

- `docs/hse-development-baseline.md` — the verified analysis and the plan.
- `docs/hse-gap-analysis.md` — the original gap register.
- `docs/beaconhs-capability-matrix.md` — per-module capability verdicts.
- `packages/db/src/schema/corrective-actions.ts` — the reference lifecycle.

## Forbidden

- Do not add a table named `findings`, `hazards`, or `risks` before Phase 3/4 of
  the plan in `docs/hse-development-baseline.md` §17.
- Do not add a second owner/due-date/verification vocabulary to a module that can
  instead link to `corrective_actions`.
- Do not store a computed risk score. Scores are derived at render
  (`apps/web/src/components/risk-matrix.tsx:120-123`); persist the inputs.
- Do not add RAMS/SWMS/Bowtie as a native model — Builder covers those.
- Do not give a Builder form's `risk_matrix` value the illusion of being
  reportable; it lives in form-response JSONB and is invisible to reports.

## Completion criteria

- The change is classified PRESERVE / EXTEND / ADAPT / NEW.
- If NEW, the specific justification is written down.
- No new parallel lifecycle was introduced; existing lifecycles link to
  `corrective_actions` where that is the correct sink.
- The plan phase in `docs/hse-development-baseline.md` §17 is respected.
- `docs/project-development-state.md` is updated.
