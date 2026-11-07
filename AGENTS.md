# AGENTS.md

## Mission

BeaconHS is a pre-launch, multi-tenant Health, Safety & Environment platform for
industrial construction. Treat the repository as a greenfield production system
headed for a hard cutover, not as a prototype. Agents should leave the app more
coherent than they found it.

## Non-Negotiable Engineering Rules

1. All code is to be clean cutover -> leave no legacy code. The app has not launched yet, so do not preserve old paths, compatibility shims, deprecated APIs, or duplicate flows unless the user explicitly asks for a temporary migration step.
2. All features shipped should be complete production-grade code, no stubs, placeholders, mock implementations, TODO-driven behavior, fake data paths, or "wire it later" branches.
3. If you see a bug or issue when doing something, stop and fix it even if unrelated. If it is too large to fix safely in the current pass, clearly flag it before continuing.
4. Ensure that before you build something new, there is no duplicate thing already built. Search first, inspect nearby modules, and reuse the existing system where it fits.
5. Always unify existing systems and abstract shared behavior when it reduces real duplication or reconciles competing implementations.
6. No dead code, duplicate implementations, abandoned files, unused exports, stale routes, or shadow systems. Always immediately flag and clean up dead or duplicate code.
7. Keep the in-app user guide truthful. Whenever you add, change, remove, or rename a user-facing feature, route, button, or flow, update the matching manual article(s) in `apps/web/src/lib/manual/content/*` (and add a new article for a new module) in the same change. If the change moves or renames anything a guided tour points at, update the walkthrough steps in `apps/web/src/lib/walkthroughs/registry.ts` too. See "In-app user guide & walkthroughs" below.
8. ALWAYS ensure CI is green before you consider work done — never push code that fails a gate. Before committing/pushing, run the full CI gate set locally and make every one pass: `pnpm format:check`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm deadcode:check`, and `pnpm build`. Formatting (`prettier`), linting, typecheck, and tests are non-negotiable — a red pipeline blocks the hard cutover. If you push and CI goes red, drop everything and fix it immediately in a follow-up commit. Do not disable, `--no-verify`, skip, or `eslint-disable`/`ts-ignore` your way around a failing gate to make it pass; fix the underlying issue. Capture each gate's own exit code (don't pipe to `tail` and read `$?`).

## Quick Start

- Use the `shell` tool for all Linux command execution. There is no `bash` tool.
- Runtime: Node 24 LTS (`.nvmrc`), pnpm 10.30.3, Docker.
- Install: `corepack enable` then `pnpm install`.
- Env: copy `.env.example` to `.env`.
- Local infra: `docker compose --profile local-db up -d` starts Postgres on 5433, Redis on 6380, MinIO on 9000/9001, and Mailpit on 8025.
- DB setup: `pnpm db:migrate` then `pnpm db:seed`.
- Dev app: `pnpm dev` starts the web app, worker, and scheduler through Turbo.
- App: `http://localhost:3000`.
- Mailpit: `http://localhost:8025`.
- Seeded super-admin: `admin@beaconhs.local`; use the Magic link tab and open the link from Mailpit.

Useful launchers also live in `scripts/launchers/`.

## Validation Commands

- Full build: `pnpm build`.
- Full typecheck: `pnpm typecheck`.
- Full lint: `pnpm lint`.
- Full tests: `pnpm test`.
- Format check: `pnpm format:check`.
- Dead code: `pnpm deadcode:check` (knip — unused files, exports, and types). Deleting
  the last consumer of a component fails this gate, so remove the component too.
- Targeted package checks: `pnpm --filter @beaconhs/web typecheck`, `pnpm --filter @beaconhs/forms-core test`, etc.
- Database: `pnpm db:generate`, `pnpm db:migrate`, `pnpm db:seed`, `pnpm db:studio`.

Run the narrowest meaningful checks while iterating, then broaden when touching
shared packages, database schema, auth, tenant scoping, workers, or UI primitives.

CI runs `format:check`, `typecheck`, `lint`, `test`, `deadcode:check`, and `build`
on every push to `main`. Before you commit and push, run all of them locally and confirm each
passes — CI must stay green (see Non-Negotiable rule 8). A common miss is
formatting: always run `pnpm format:check` (or `pnpm exec prettier --write` on the
files you touched) before pushing, since editors and codegen frequently leave
Prettier violations that fail CI.

## Repo Map

- `apps/web`: Next.js 16 App Router app. UI, route handlers, server actions,
  authenticated app shell, public login/kiosk/verification pages.
- `apps/worker`: BullMQ worker and scheduler for PDFs, email, notifications,
  scheduled reports, compliance scans, plugin cron work, and imports.
- `packages/db`: Drizzle schema, migrations, RLS policy installer, seed data,
  canonical templates, DB client helpers.
- `packages/tenant`: request context, tenant-scoped DB executor, permission and
  scope helpers.
- `packages/auth`: Better-Auth server/client configuration.
- `packages/forms-core`: form schema, field registry, validation, formula,
  conditional logic, scoring, automation primitives.
- `packages/forms-pdf`: server-side PDF rendering helpers.
- `packages/ui`: shared React components and styling primitives.
- `packages/compliance`: unified compliance evaluation/materialization.
- `packages/reports`: built-in reports, custom query/run/filter/cadence logic.
- `packages/jobs`: BullMQ queue definitions and Redis connection.
- `packages/events`: module event fan-out into notifications/jobs.
- `packages/storage`: S3-compatible storage client for MinIO/R2.
- `packages/appkit-feedback`: in-app product issue reporter engine
  (PII-safe GitHub filing). Host UI lives in the web app.
- `packages/ai`, `packages/audit`, `packages/emails`, `packages/sync`,
  `packages/integrations`: supporting platform packages.
- `packages/etl`: optional company-specific package in authorized local
  checkouts only. It is Git-ignored and excluded from the public workspace and
  lockfile; install and run it independently.
- `docs/QUICKSTART.md`: local setup details.
- `docs/IMPLEMENTATION_PLAN.md`: product history and implementation context;
  verify against current code before trusting old status notes.

## Architecture Rules

- This is a pnpm/Turbo workspace. Prefer workspace packages over local copies.
- Use TypeScript strictly. The base config enables `strict`,
  `noUncheckedIndexedAccess`, `noImplicitOverride`, and related checks.
- Use Drizzle for database access. Do not add ad hoc SQL unless it is the right
  tool for a migration, policy, or query Drizzle cannot express cleanly.
- Tenant-scoped app data must run through `ctx.db(...)` from
  `requireRequestContext()` / `getRequestContext()` so Postgres RLS is applied.
- Only use root `db` with an explicit `withSuperAdmin`, `withTenant`, or
  transaction that sets the needed RLS config, and only when that scope is
  intentional.
- Every tenant table needs `tenant_id`, RLS coverage in `TENANT_SCOPED_TABLES`,
  and an idempotent migration path.
- Use schema helpers in `packages/db/src/schema/_helpers.ts` for IDs,
  timestamps, soft deletes, tenant FKs, and typed JSON conventions.
- Server mutations should check permissions with `assertCan`, write audit
  records with `recordAudit`, and revalidate affected paths.
- Keep module-specific business logic near its module until there is a proven
  shared abstraction. When multiple modules do the same thing, unify them in a
  package or shared component.
- Prefer existing queue/event/storage/report/compliance/form primitives over
  inventing new parallel systems.

## Web App Conventions

- Authenticated pages live under `apps/web/src/app/(app)`.
- Public pages live outside that group: `login`, `kiosk`, `verify`, API auth
  routes, manifest, etc.
- The authenticated layout forces dynamic rendering, resolves tenant context,
  gets unread notifications, resolves sidebar navigation, and renders
  `AppShell`.
- Navigation comes from `apps/web/src/lib/nav/registry.ts` plus tenant saved
  overrides. Add modules there instead of hardcoding sidebar entries.
- Use the existing page shells from `apps/web/src/components/page-layout.tsx`:
  `PageContainer`, `ListPageLayout`, `DetailPageLayout`, and `WizardLayout`.
- Use `@beaconhs/ui` for buttons, inputs, cards, tables, badges, drawers,
  popovers, rich text, uploaders, signatures, skeletons, and page headers.
- Use `lucide-react` icons; keep operational UI dense, calm, and scannable.
- Styling is Tailwind with class-based dark mode via `.dark`. Preserve light and
  dark states when changing UI.
- NON-NEGOTIABLE: every table or list of records — module list pages,
  detail-page sub-tables, dashboards, cockpit work lists, admin tables —
  ships with search, relevant filters, and pagination. URL-driven via the
  shared primitives (`parseListParams`, `SearchInput`, `FilterChips`,
  `SortableTh`, `Pagination`, or the prefixed sub-table param pattern on
  multi-table pages). Never render an unbounded or unsearchable table.
- CSV/PDF/export routes should audit exports and respect tenant context.

## Data, Auth, and Permissions

- `getRequestContext()` in `apps/web/src/lib/auth.ts` is the main request entry.
  It resolves the active tenant, membership, super-admin state, permissions,
  and provides the tenant-bound DB helper.
- `RequestContext` and permission helpers live in `packages/tenant`.
- Super-admin can view tenants, but app data should still be intentionally
  tenant-bounded unless the feature is truly cross-tenant admin.
- Permissions use strings with wildcard support, e.g. `incidents.*`.
- Mutations should be explicit about the permission they require.
- Better-Auth tables are global; most BeaconHS module tables are tenant-scoped.

## Database and Migrations

- Drizzle schema files live in `packages/db/src/schema` and are re-exported from
  `packages/db/src/schema/index.ts`.
- Migrations live in `packages/db/drizzle`.
- After adding or changing tenant-scoped tables, update
  `packages/db/src/rls.ts` so RLS policies are installed.
- Keep migrations idempotent where the existing migration style allows.
- Seed data lives in `packages/db/src/seed.ts` and related seed helpers.
- Never bypass RLS to "make it work"; fix the context, schema, or policy.

## Workers and Background Jobs

- Worker entrypoints are in `apps/worker/src/index.ts` and
  `apps/worker/src/scheduler.ts`.
- Queue definitions live in `packages/jobs`; do not create one-off queue names.
- Worker handlers live under `apps/worker/src/workers`.
- Shared worker logic belongs in `apps/worker/src/lib` or a package when used by
  web and worker code.
- Jobs that mutate tenant data must establish the correct tenant/RLS context.

## Forms, Compliance, Reports, and Modules

- The form engine is central: schema and logic are in `packages/forms-core`;
  designer/filler UI lives in the web app.
- Compliance is unified through `compliance_obligations`, `compliance_audience`,
  `compliance_dispatches`, and `compliance_status`; use
  `@beaconhs/compliance` instead of per-module compliance copies.
- Reports are unified through `packages/reports` and the `/reports` web module.
- Before adding a native module, verify it cannot be a configuration of forms,
  compliance, reports, data sources, or an existing module.
- If two routes or packages solve the same product concept, consolidate them.

## In-app User Guide & Walkthroughs

- The platform ships a built-in, permission-aware user manual at `/help`,
  written in plain language for non-technical construction trades workers.
- Articles are code: `apps/web/src/lib/manual/content/*` (typed by
  `apps/web/src/lib/manual/types.ts`, assembled in
  `apps/web/src/lib/manual/registry.ts`). Visibility gates mirror the nav
  registry's permissions so people only see help for features they can open.
- The AI assistant reads the same registry via the `search_user_guide` /
  `read_user_guide` tools — a stale article means the assistant gives wrong
  instructions, not just a stale page.
- Guided tours (spotlight walkthroughs) are defined in
  `apps/web/src/lib/walkthroughs/registry.ts`; per-tenant role/auto-start
  config lives in `walkthrough_settings` and is edited at
  `/admin/walkthroughs` (with Preview). Steps target
  `data-walkthrough="..."` attributes and stable `a[href="..."]` selectors —
  keep those attributes when refactoring the components they sit on.
- MANDATORY: any change to user-facing UI or flows updates the affected
  manual articles and walkthrough steps in the same commit. New module =
  new article (+ tour if it's a frontline task). Removed/renamed feature =
  article and steps updated. Manual style: short sentences, numbered steps,
  bold the exact button labels, no jargon.

## Quality Bar

- Production-grade means permissions, validation, empty/loading/error states,
  audit logs, tenant isolation, persistence, revalidation, and tests or focused
  verification where the risk justifies it.
- No fake success paths. If an external service is missing, surface a real
  configuration error or graceful disabled state.
- No silent data corruption. Validate inputs with existing schemas/utilities or
  add a shared validator.
- No unreachable UI. Add navigation, permissions, and route handling together.
- No orphaned schema. UI, actions, seed/migration/RLS, and worker/report hooks
  should land as one complete change when the feature requires them.
- Keep accessibility and responsive behavior intact. The app is used in the
  field, often on tablets and small screens.

## Search First Checklist

Before implementing a new feature or helper:

- Search route names, table names, package exports, and UI labels with `rg`.
- Check `apps/web/src/components`, `packages/ui`, and nearby module folders.
- Check `packages/forms-core`, `packages/compliance`, `packages/reports`,
  `packages/events`, and `packages/jobs` for existing primitives.
- Check `packages/db/src/schema` for existing tables or JSON shapes.
- Check `apps/web/src/lib/nav/registry.ts` before adding navigation.
- If you find duplication, clean it up as part of the change instead of adding
  another layer.

## Git and Worktree Safety

- The worktree may contain user changes. Do not revert, overwrite, or
  "clean up" files you did not intentionally edit.
- Inspect `git status --short` before broad edits.
- Keep changes scoped. Avoid formatting unrelated files.
- Commit your changes atomically to local `main` as you work: make a focused,
  self-contained commit for each logical change instead of batching everything
  into one commit at the end. Stage only the files you intentionally touched
  (never sweep in unrelated working-tree changes), and keep each commit small
  and reviewable.

## Agent Handoff Notes

- When returning completed work, always end with a condensed checklist the user
  can use to check and test every change you made.
- State what you changed, what you verified, and what remains risky.
- Mention any bug you discovered and fixed while working.
- If a required verification could not run, say why.
- Keep documentation honest. If code and docs disagree, fix the stale docs or
  call out the discrepancy.

---

# HSE Second-Stage Development

These rules govern the HSE extension work. They sit below the Non-Negotiable
Engineering Rules above, and never relax them.

## The Core Constraint

**BeaconHS's native platform capabilities are the reusable asset. Do not redesign
them because a feature is more convenient your way.**

Never re-create, and never parallel:

| Concept                 | Already exists                                                         | Where                                            |
| ----------------------- | ---------------------------------------------------------------------- | ------------------------------------------------ |
| User / identity         | Better-Auth + `tenant_users`                                           | `packages/auth`, `packages/db/src/schema/iam.ts` |
| Tenant                  | `tenants` + `tenant_memberships`                                       | `packages/db/src/schema/core.ts`                 |
| Organization / location | `org_units` (levels: customer / project / site / area)                 | `packages/db/src/schema/org.ts:24`               |
| **Project**             | `org_units` where `level='project'` — there is **no** `projects` table | `packages/db/src/schema/org.ts`                  |
| Role / Permission       | `roles`, `role_assignments`, `PERMISSION_CATALOGUE` (107 keys)         | `packages/db/src/schema/iam.ts`                  |
| Object storage          | `packages/storage` + `apps/web/src/lib/uploads.ts`                     | verified E2E against MinIO                       |
| Compliance engine       | `@beaconhs/compliance`                                                 | `packages/compliance`                            |
| Report engine           | `@beaconhs/reports`                                                    | `packages/reports`                               |
| Notification bus        | `@beaconhs/events` outbox                                              | `packages/events`                                |
| Approval gates          | `flow_gates` — "the single gate store"                                 | `packages/db/src/schema/forms.ts:617-678`        |
| Form builder            | `@beaconhs/forms-core` (46 field types)                                | `packages/forms-core`                            |

Extending these is always allowed. Replacing them is not.

## Builder-First

If a capability can be delivered with the existing form builder, field registry,
workflow/flow engine, gate store, notification events, or report studio, **use
them**. Do not write a native module.

A native module is justified only by one of: a complex state machine, a dedicated
API, a dedicated permission, transactional cross-model logic, a performance
requirement, or an authoritative queryable record. Every NEW module must state
which of these applies. "It would be cleaner" is not a reason.

## The HSE Canonical Model

BeaconHS records HSE events well but does not yet manage their **resolution**.
Verified findings (`docs/hse-development-baseline.md`):

- There is **no** `findings` table and **no** `hazards` table.
- There is **no** `risks` table; risk is four nullable integers on
  `hazid_assessment_hazards` (`packages/db/src/schema/hazid-assessments.ts:198-204`).
- **Eight** partial lifecycles exist. Only `corrective_actions`
  (`packages/db/src/schema/corrective-actions.ts:56-182`) has all four of
  owner, due date, verification and notification.

### Required closed loop

Every "something needs fixing" flow should be able to express:

```
discover → classify → rate risk → assign measure → assign owner
        → correct → verify → close
```

### Vocabulary that must stay distinct

Do not collapse these. Each has different lifecycle semantics, and merging them
is how the current duplication arose.

- **Finding** — something observed that needs fixing.
- **Risk** — a rated, owned, reviewable exposure.
- **Action** — assigned work with an owner and a due date.
- **Verification** — an attributable sign-off by someone other than the doer.
- **Certificate** — an externally issued credential with an expiry.

### Rules

- **Never** add a second owner / due-date / verification vocabulary to a module
  that can instead link to `corrective_actions`.
- **Never** persist a computed risk score. Scores are derived at render
  (`apps/web/src/components/risk-matrix.tsx:120-123`); persist the inputs.
- **Never** add a Builder form's `risk_matrix` value as if it were reportable —
  it lives in form-response JSONB and is invisible to reports and compliance.
- Classify every capability **PRESERVE / EXTEND / ADAPT / NEW**. Never rank
  modules as good or bad.
- Respect the phase plan in `docs/hse-development-baseline.md` §17. Do not add
  `findings` / `risks` tables before their phases.

## Project Scope

Project-level scoping is **not expressible today**, and this is a design
constraint, not a local bug:

- `RoleScope` has six variants and **none** is project/org-unit
  (`packages/db/src/schema/iam.ts:49-55`).
- `resolveVisibilityTier` returns exactly `all` / `site` / `self`
  (`apps/web/src/lib/visibility.ts:106,114-118`).
- The scope picker hard-filters `orgUnits.level = 'site'`
  (`apps/web/src/app/(app)/admin/users/_scope-data.ts:64`).

Rules:

- **Never** hand-roll an ad-hoc project filter inside one module to simulate
  scoping. That is a shadow authorization system.
- Any change implying "user may only see project X" must go through the scoping
  work in `docs/hse-development-baseline.md` §12.
- The zero-migration precedent already exists:
  `packages/compliance/src/audience.ts:89-104` resolves "people on project X"
  via `people_assignments` plus a validity window.
- API keys have **no** scope column (`packages/db/src/schema/api-keys.ts:19-45`).
  Do not imply API-key project scoping.

## Storage Abstraction

- All object access goes through `packages/storage` and
  `apps/web/src/lib/uploads.ts` (`requestUpload`, `finalizeUpload`). Never a raw
  bucket client.
- **Never** edit `packages/storage/**`, `presignPut()`, `promoteObject()`,
  `ensureBucket()`, or the attachment finalization path without an explicit
  request.
- Presigned URL issuance must re-check permission at issue time; the URL is a
  bearer capability.
- `x-amz-meta-*` and `x-amz-tagging` must survive the round trip. They do on
  **MinIO** and do **not** on SeaweedFS
  (`docs/beaconhs-seaweedfs-verification.md`). Storage baseline: MinIO built
  from pinned archived source, `docs/beaconhs-minio-build.md`.
- Storage must stay an **abstraction**. Do not couple a module to MinIO or to any
  specific vendor.

## Testing

Run the narrowest meaningful checks while iterating, then broaden when touching
shared packages, database schema, auth, tenant scoping, workers, or UI
primitives. The repo uses two runners — use the one the package already has:
`vitest run`, or `node --import tsx --test` in `ai`, `appkit-feedback`,
`integrations` and `sync`.

There is **no** Playwright in the repo and no checked-in E2E suite. Browser
verification is done with the Playwright MCP via the `ui-e2e` skill.

Never make a gate pass by disabling it, skipping a test, adding
`eslint-disable` / `ts-ignore`, or using `--no-verify`. A gate that needs
suppressing is a gate defect — report it.

## Agent Development Workflow

Large tasks follow this sequence, and **STOP at the first failure**:

```
Analyze → Plan → Implement → Test → Review → Verify → Report
```

- Do not carry on past a failing stage hoping a later stage helps.
- Do not self-authorise a workaround. Report the failure and stop.
- Do not begin the next phase of `docs/hse-development-baseline.md` §17 without
  the previous phase's exit criterion met.

## Definition of Done

Work is done when **all** of these hold:

1. All six gates pass, each with its own captured exit code.
2. The requested behaviour is verified, not assumed.
3. Permissions, audit, revalidation and tenant isolation are in place.
4. Manual articles and `docs/project-development-state.md` are truthful.
5. No dead code, duplicate implementation, parallel lifecycle, or stale route was
   introduced.
6. Known risks and remaining work are stated plainly.
7. Anything that could not be verified is named **with the reason**.

If an item cannot be verified, say so. Silently skipping a gate is not an option.

## Defect Register

Open defects are recorded here; do not fix one as a side effect of unrelated
work, and do not silently work around it. Fixed entries stay with their evidence.

| ID  | Status / defect                                                                                                        |
| --- | ---------------------------------------------------------------------------------------------------------------------- |
| D1  | **FIXED (EA-12).** Nav and module-admin permission references are valid catalogue keys, pinned by regression coverage. |
| D2  | **FIXED (EA-12).** `/people` requires `people.read.all`; direct access and export are gated.                           |
| D3  | **FIXED (EA-12).** Dead columns dropped from the schema and by migration `0051_ea12_drop_dead_columns.sql`.            |
| D4  | **FIXED (EA-12).** PPE failed-inspection corrective actions now emit `corrective_action.created` and are notified.     |
| D5  | **FIXED (EA-12).** Equipment flow profile includes all real work-order statuses, including `repaired` and `verified`.  |
| D6  | **FIXED (EA-12).** Canonical-template comment now matches `CANONICAL_TEMPLATES`.                                       |

Open defects, kept for a scoped follow-up:

| ID  | Defect                                                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| D8  | 82 foreign keys exist in Postgres but not in the Drizzle snapshot chain. Systemic, pre-existing, out of scope for EA-12.                    |
| D9  | `canSeeWidget` falls through to "visible to everyone" for a widget missing from `WIDGET_PERMISSIONS`. The trap remains for the next widget. |

Environment and tooling issues also on record:

- `turbo.json` `globalEnv` omits `R2_ENDPOINT` and `ATTACHMENT_CAPABILITY_SECRET`,
  so `pnpm dev` needs `--env-mode=loose`.
- `packages/storage/src/index.ts:39-40` uses `??`, which does not fall back on an
  empty string, and `.env.example` ships empty R2 credentials.
- This host has ~3.4 GB RAM; Next.js page compiles have OOM-killed the dev
  server under parallel load.

## OpenCode Project Infrastructure

This repository carries its own agent tooling under `.opencode/`:

- `.opencode/opencode.jsonc` — V2 permissions, MCP servers, watcher ignores.
- `.opencode/skills/` — 12 project skills.
- `.opencode/agents/` — 9 project agents.

Baselines and rationale live in `docs/`:

- `docs/opencode-environment-baseline.md`
- `docs/opencode-mcp-baseline.md`
- `docs/opencode-skills-baseline.md`
- `docs/opencode-agents-baseline.md`
- `docs/opencode-permissions-baseline.md`
- `docs/opencode-lsp-baseline.md`
- `docs/opencode-plugin-baseline.md`
- `docs/opencode-tools-evaluation.md`
- `docs/project-development-state.md`

Project configuration uses the **OpenCode V2** shape: `permissions`, `shell`,
`subagent`, `plugins`, `agents`, `skills`, `mcp.servers`. Do not reintroduce V1
keys (`permission`, `bash`, `task`, singular `plugin`).
