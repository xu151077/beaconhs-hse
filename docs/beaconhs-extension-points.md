# BeaconHS — Extension Points

> **Status:** read-only audit snapshot. **Audited:** 2026-09-29 · **Commit:** `70da27c4`
> Companion to [beaconhs-architecture.md](./beaconhs-architecture.md) (Part 2 covers structure
> and layering).

## 摘要（中文执行摘要）

**核心结论：BeaconHS 没有插件系统。** 官方已在 `0002_drop_retired_plugin_tables.sql` 中删除
全部插件表，`docs/IMPLEMENTATION_PLAN.md:579-586` 记录了这一决策，`plugins/` 目录只剩
`.gitkeep`。任何"写插件"的方案都不成立。

**真正可用的扩展接缝只有三个：**

| 接缝                        | 能力                                                            | 是否需要改代码             |
| --------------------------- | --------------------------------------------------------------- | -------------------------- |
| **Builder 表单引擎**        | 39 种字段、6 种触发器、13 种动作、评分、条件逻辑                | **否**                     |
| **Compliance 引擎**         | 11 种来源模块、8 种受众类型、5 种复发模式，按租户配置           | **仅新增来源模块时需要**   |
| **`packages/integrations`** | 9 个触发器、5 个目标（HTTP/SQL/Slack/Sheets/Email）             | **新增服务时仅加一个条目** |
| **`packages/sync`**         | 5 个入站连接器（CSV / Database / HTTP-JSON / NetSuite / Nango） | **新增连接器时需要**       |

**最重要的一条工程决策建议：新增原生模块成本约 37 个注册点，而用 Builder 表单实现接近 0。**
仓库自己就做过这个示范 —— 原生的 Lift Plans 和 Toolbox Talks 模块被删除，改成表单模板
重新交付（`lib/nav/registry.ts:99-102` 明确写"intentionally gone — both are form templates
now"）。HSE 二次开发应优先用表单与合规配置，只在表单单薄可支撑时才建原生模块。

**一个需要注意的约束：自定义字段（custom fields）的实体枚举是封闭的 4 值**
（`equipment | ppe | person | location`）。新模块想支持自定义字段，需要改枚举 + 加一个
switch 分支 + 加一个配置项，不是零成本。

---

# 1. Plugin system — **RETIRED. Does not exist.**

This is a definitive negative, established from four independent directions:

| Evidence                               | Location                                                                                                                                                                                                          |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The directory is empty**             | `plugins/.gitkeep` is the only entry                                                                                                                                                                              |
| The workspace glob is dead             | `pnpm-workspace.yaml:5` `- 'plugins/*'` matches nothing                                                                                                                                                           |
| **The tables were dropped**            | `packages/db/drizzle/0002_drop_retired_plugin_tables.sql:1-14` — `DROP TABLE IF EXISTS "plugin_events" / "plugin_runs" / "tenant_plugin_secrets" / "tenant_plugins" / "plugins" CASCADE` plus orphaned enum types |
| **The journal entry survives**         | `drizzle/meta/_journal.json:23` `"tag": "0002_drop_retired_plugin_tables"`                                                                                                                                        |
| A guard test pins it                   | `packages/db/src/production-cutover-integrity.test.ts:54, 102`                                                                                                                                                    |
| **The product decision is documented** | `docs/IMPLEMENTATION_PLAN.md:579-586`                                                                                                                                                                             |

`docs/IMPLEMENTATION_PLAN.md:579-586` records the reasoning:

> "**Current launch decision: BeaconHS does not ship a plugin runtime or plugin SDK.** The
> earlier plugin plan was consolidated into two production integration systems: `packages/sync`
> … `packages/integrations` … Plugin-era packages, tables, routes, and compatibility
> redirects are **retired**."

`docs/QUICKSTART.md:80` repeats it: _"The old plugin system is retired; use …"_

**No plugin tables, no plugin worker, no plugin cron, no `/admin/plugins` route, no plugin nav
entry, and no plugin permissions exist.** The remaining 130+ grep hits for "plugin" are
unrelated: `better-auth/plugins`, `next-intl/plugin`, `tailwind.config.ts:14`, `remarkPlugins`,
and `pnpm-lock.yaml`.

> **Stale documentation (AGENTS.md rule 7 violation):** `README.md:139` still says the Admin hub
> includes "a plugin registry." That surface no longer exists.

## 1.1 What replaces plugins

Two production integration systems, plus the form engine:

| System                  | Direction    | Purpose                                                              |
| ----------------------- | ------------ | -------------------------------------------------------------------- |
| `packages/integrations` | **Outbound** | Tenant-configured trigger → mapping → destination automations        |
| `packages/sync`         | **Inbound**  | Pull external records in with an identity crosswalk and a run ledger |
| Builder forms           | Both         | Model an entire process without code                                 |

---

# 2. The native-module registration checklist

Reverse-engineered by tracing the `journals` module across the whole repository. This is the
single most important section of this document: **it is the true cost of a native module.**

Grepping `'journals'` / `"journals"` produces 24 hits across 14 files, plus the schema, seed,
and page files. The complete surface:

| #   | Registration point           | File                                                                                 | Journals entry                                                                                                                                              |
| --- | ---------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **DB schema**                | `packages/db/src/schema/journals.ts`                                                 | `journal_entries`, `journal_entry_photos`, `journal_entry_tags`, `journal_tags`, `journal_analysis_runs`                                                    |
| 2   | **Schema barrel**            | `packages/db/src/schema/index.ts:53`                                                 | `export * from './journals'` (order matters — FK imports)                                                                                                   |
| 3   | **RLS list**                 | `packages/db/src/rls.ts:245-249`                                                     | 5 table names. **Test-enforced** — see §5                                                                                                                   |
| 4   | **Migration**                | `packages/db/drizzle/00NN_*.sql` + `meta/_journal.json`                              | DDL via `pnpm db:generate`                                                                                                                                  |
| 5   | **Permission catalogue**     | `packages/db/src/schema/iam.ts:155`                                                  | `journals.read.all/site/self`, `journals.create`, `journals.update.own`, `journals.submit`, `journals.assign`                                               |
| 5b  | Permission labels            | `apps/web/src/lib/permissions-meta.ts:10, 95-101`                                    | group + 7 labels                                                                                                                                            |
| 5c  | Built-in role grants         | `packages/db/src/schema/iam.ts:301`                                                  | grants into worker/foreman/safety_manager/tenant_admin                                                                                                      |
| 6   | **Nav registry**             | `apps/web/src/lib/nav/registry.ts:140`                                               | `{key, href, label, iconKey, group}`                                                                                                                        |
| 6b  | Nav group order              | `apps/web/src/lib/nav/registry.ts:63-71`                                             | only if a new group                                                                                                                                         |
| 6c  | Nav i18n key                 | `apps/web/src/lib/nav/registry.ts:36-60`                                             | `NAV_MODULE_MESSAGE_KEYS.journals`                                                                                                                          |
| 6d  | Sidebar icon                 | `apps/web/src/components/sidebar-nav.tsx:56+`                                        | `journal: NotebookPen`                                                                                                                                      |
| 6e  | Back-nav noun                | `apps/web/src/lib/back-nav.ts:48-79`                                                 | `['/journals','journals']`                                                                                                                                  |
| 7   | **Module-admin registry**    | `apps/web/src/lib/module-admin/registry.ts:47-78`                                    | `{moduleKey,label,href,managePath,iconKey,permission,tabs,sections}` — drives the Manage hub, `/admin` rollup, sub-nav, and the `requireModuleManage` guard |
| 8   | **Flows — profile**          | `apps/web/src/lib/flows/module-profiles.ts:9-50`                                     | `MODULE_FLOW_PROFILES.journals` — triggers, actions, statusValues, fields, collections                                                                      |
| 9   | **Flows — adapter**          | `apps/web/src/lib/flows/adapters/journals.ts:27`                                     | `createJournalFlowAdapter`                                                                                                                                  |
| 10  | **Flows — registry**         | `apps/web/src/lib/flows/registry.ts:30-46`                                           | 15 entries; also gates `canManageSubjectGates`                                                                                                              |
| 11  | Flows UI page                | `app/(app)/journals/flows/page.tsx:11`                                               | `<ModuleFlowsPage moduleKey="journals" />`                                                                                                                  |
| 12  | PDF template target          | `apps/web/src/lib/module-pdf.ts:39-55`                                               | enforced by `module-pdf-targets.test.ts`                                                                                                                    |
| 13  | PDF route                    | `app/(app)/journals/[id]/pdf/route.ts:39`                                            | `renderModulePdfResponse(ctx, {...})`                                                                                                                       |
| 14  | Seeded PDF template          | `packages/db/src/seed/pdf-templates.ts:894`                                          | `subjectKey: 'journals'`                                                                                                                                    |
| 15  | **Export hub**               | `app/(app)/admin/export/_entities.ts:353-388`                                        | `{key,label,csvHref,sourceHref,groupLabel,permissionAny,sensitivity,defaultScope,rowLimit,defaultSort,filters,sortOptions,columns}`                         |
| 16  | CSV route                    | `app/(app)/journals/export.csv/route.ts:64`                                          | `csvFilename('journals')`                                                                                                                                   |
| 17  | **Global search**            | `app/api/search/route.ts:171-197, 313-340` + `components/global-search.tsx`          | one `SearchGroup` type + query + count + mapping                                                                                                            |
| 18  | **Reports entity**           | `packages/reports/src/entities.ts`                                                   | entity + columns → drives `/api/v1/journals`, Insights, the report builder                                                                                  |
| 19  | **Reporting view**           | `packages/db/src/views.ts` `REPORT_VIEWS_SQL`                                        | `CREATE OR REPLACE VIEW report_journals …` — **append-only columns**                                                                                        |
| 20  | Built-in report seeds        | `packages/db/src/seed/report-definitions.ts:81`                                      | optional; 32 entries                                                                                                                                        |
| 21  | **Integrations trigger**     | `packages/integrations/src/triggers/registry.ts:170-190`                             | `{key:'journal_entry.submitted', module, fields:[…]}`                                                                                                       |
| 22  | **Compliance source module** | `packages/db/src/schema/compliance.ts:38-52`                                         | `'journal'`; evaluator in `packages/compliance/src/evaluate.ts`                                                                                             |
| 23  | **Domain event types**       | `packages/db/src/schema/domain-events.ts:24-89` + `packages/events/src/index.ts:147` | a `DomainNotificationEvent` variant + a `switch` case                                                                                                       |
| 24  | Notification audience        | `packages/events/src/recipients.ts:22`                                               | a category in `DEFAULT_ROLES_BY_CATEGORY`                                                                                                                   |
| 25  | Reference counter            | `apps/web/src/lib/reference.ts:9-28`                                                 | `journal: 'JRN'` + the `ReferenceEntity` union                                                                                                              |
| 26  | **Manual article**           | `apps/web/src/lib/manual/content/frontline.ts:11`                                    | `slug: 'journals'` + a group entry                                                                                                                          |
| 27  | **Walkthrough**              | `apps/web/src/lib/walkthroughs/registry.ts:86-113`                                   | `{id, startPath, defaultEnabled, defaultAutoStart, steps}`                                                                                                  |
| 28  | Sub-nav                      | `app/(app)/journals/_sub-nav.tsx`                                                    | `<ModuleNav moduleKey="journals" active="…" />`                                                                                                             |
| 29  | Picker options               | `app/api/picker-options/route.ts` + `apps/web/src/lib/picker-options.ts`             | add the entity kind                                                                                                                                         |
| 30  | Data sources                 | `app/(app)/admin/data-sources/_usage.ts`                                             | usage map, so retirement is blocked safely                                                                                                                  |
| 31  | Custom fields                | `apps/web/src/lib/custom-fields/config.ts`                                           | only if the entity supports them — see §6                                                                                                                   |
| 32  | Dashboard widgets            | `app/(app)/dashboard/_widget-registry.ts`                                            | optional                                                                                                                                                    |
| 33  | **i18n**                     | `packages/i18n/src/messages/{en,fr,es}.json`                                         | **all 3 locales**; enforced by `i18n-coverage.test.ts`                                                                                                      |
| 34  | Feed / activity              | `app/(app)/feed/_data.ts`                                                            | cross-module timeline entry                                                                                                                                 |
| 35  | Public API                   | `apps/web/src/lib/api/{permissions,write,records}.ts`                                | usually free — derived from `REPORT_ENTITIES`                                                                                                               |
| 36  | **Tests**                    | co-located `*.test.ts` + `packages/db/src/*-relational-integrity.test.ts`            | ~29 relational-integrity test files exist                                                                                                                   |
| 37  | Docs                         | `README.md`, `AGENTS.md`                                                             | —                                                                                                                                                           |

**Explicitly NOT required** (worth stating, because it is unusual): no per-module package, no
route manifest file, no per-module `index.ts` (Next.js file routing handles it), no DI container,
no tRPC router, no plugin registration file.

## 2.1 Cost estimate

| Module type       | Registration points                       | Rough effort  |
| ----------------- | ----------------------------------------- | ------------- |
| **Builder form**  | ~0–3 (pin to nav, write a manual article) | hours         |
| **Native module** | **~37**                                   | days to weeks |

The decisive evidence that the form path is the intended one: the repository **deleted** the
native Lift Plans and Toolbox Talks modules and re-shipped them as seeded templates.
`apps/web/src/lib/nav/registry.ts:99-102` states it:

> "intentionally gone — both are form templates now, surfaced as pinned forms by the resolver
> (auto-pinned by key in resolve.ts)"

Pinned at `lib/nav/resolve.ts:39-40` (`'lift-plan'`, `'toolbox-talk'`). Seeds live in
`packages/db/src/seed/lift-plan-template.ts`, `toolbox-template.ts`,
`hazard-assessment-app-templates.ts`.

---

# 3. The Builder form engine — `packages/forms-core`

30 files, **no DB dependency** (deps: `@beaconhs/i18n`, `isomorphic-dompurify`, `zod`).
14 test files.

## 3.1 Field types — 39 total

`packages/forms-core/src/field-types.ts:33-418`, grouped by `category`:

| Category        | Types                                                                                                                |
| --------------- | -------------------------------------------------------------------------------------------------------------------- |
| `standard` (14) | text, long_text, number, slider, date, datetime, time, gps, email, phone, url, rich_text, address, qr_scanner, table |
| `choice` (5)    | radio, checkbox_group, select, multi_select, ranking, matrix                                                         |
| `scoring` (4)   | pass_fail_na, rating, yes_no_comment, traffic_light, risk_matrix                                                     |
| `picker` (6)    | person_picker, multi_person_picker, customer_picker, site_picker, **project_picker**, area_picker                    |
| `media` (5)     | photo, file, video, audio, sketch (Excalidraw)                                                                       |
| `identity` (2)  | signature, typed_attestation                                                                                         |
| `computed` (2)  | formula, risk_matrix                                                                                                 |
| `data` (3)      | lookup, data_table, metric (bound to `data_sources`)                                                                 |
| `display` (3)   | heading, paragraph, divider                                                                                          |

Note `project_picker` — forms can reference projects even though there is no `projects` table
(they bind to `org_units` with `level='project'`).

## 3.2 What a form can do

Conditional `show-when` rules, per-field validation, defaults, formula evaluation, compliance
scoring with auto-flagging, multi-step workflows, participants/attendees, **monitored (timed)
sessions**, photo analysis, PDF/email templating, and a visual flow canvas.

## 3.3 Flow triggers and actions

`packages/forms-core/src/flow-subjects.ts`:

- **Triggers** (6): `on_submit`, `on_field_value`, `status_change`, `scheduled`,
  `session_overdue`, `manual`
- **Actions** (13): `send_email`, `create_capa`, `create_incident`, `notify_role`, `set_field`,
  `flag_non_compliant`, `webhook`, `create_response`, `analyze_photos`,
  `start_monitored_session`, `change_status`, `duplicate_record`, `export_pdf`
- **Module hooks** (7): `on_create`, `on_sign`, `on_lock`, `on_unlock`, `on_submit`,
  `on_delete`, `status_change` — declared in `lib/flows/module-profiles.ts` (8 profiles:
  journals, hazid, incidents, inspections, training, equipment, ppe, documents) and served by
  15 adapters in `lib/flows/registry.ts:30-46`.
- `completionTrigger` exists to stop "email a blank JSA on create"
  (`module-profiles.ts:9-12`; `hazid` uses `completionTrigger: 'on_submit'`).
- Approvals: `flow_gates` + `lib/flows/gate-actions.ts` + `resume-flow-gate.ts`.

> **This is the closest thing to a lifecycle hook system.** There is **no generic
> before/after interceptor registry**; the Flow engine is the opt-in equivalent.

## 3.4 Pinning a form as a module

`tenant_nav_configs.config` (`schema/tenant-nav.ts:26-66`) supports three item kinds:
`module` (a registry key), `form` (a pinned Builder template), and `link` (an arbitrary URL).
Resolved by `lib/nav/resolve.ts`. So a tenant can surface a form in the sidebar **with no
code at all**.

---

# 4. `packages/events` — the event contract

7 files: `index.ts`, `outbox.ts`, `recipients.ts`, `email-html.ts`, `internal-auth.ts` + 3 tests.

## 4.1 The API surface

`packages/events/src/index.ts:1-13` states the design:

> "Domain event dispatcher. The single API that domain code (server actions, scheduled workers)
> calls when something happens. It resolves the audience for an event and enqueues the in-app/push
> notification. Module email delivery belongs to Flows so it remains tenant-configurable and
> cannot be sent twice."

`EventCtx` (`:42-47`) is the minimal context both web and worker satisfy:

```ts
export type EventCtx = {
  tenantId: string | null
  userId: string
  membership?: { id: string; displayName?: string | null } | null
  db: <T>(fn: (tx: Database) => Promise<T>) => Promise<T>
}
```

## 4.2 It is a transactional outbox, not pub/sub

- Tables: `domain_event_outbox` + `domain_event_effects`
  (`packages/db/src/schema/domain-events.ts:103, 141`). Status `pending | publishing | published`,
  with three independent per-effect `*PublishedAt` stamps (`:118-121`).
- `recordDomainEvent(tx, input)` (`packages/events/src/outbox.ts:95`) **must be called inside
  the mutation's transaction** (`:94`: _"Write an event in the SAME transaction as its domain
  mutation."_). Idempotent via a unique dedup index; a dedup collision with different content throws.
- `assertDomainEventIdentity()` (`:60`) rejects corrupt or cross-tenant payloads before storage.
- Publishing happens **only** from retryable worker paths with deterministic job ids
  (`stableJobId` = sha256, `index.ts:142`).
- Web commands must run in the web runtime are replayed back over
  `/api/internal/domain-events/[id]` with `internal-auth.ts`.

Payload shape (`domain-events.ts:91-95`):

```ts
{ notification?: DomainNotificationEvent   // in-app + push
  integration?: DomainIntegrationEvent     // outbound webhook/destination
  web?: DomainWebCommand }                 // in-app side effect (flows, gates)
```

## 4.3 Registered event types — only 8

**`DomainNotificationEvent`** (`:24-38`), 4 kinds, handled in `deliverDomainNotification`
(`index.ts:147`):

| Kind                          | Notification key          | Handler        |
| ----------------------------- | ------------------------- | -------------- |
| `incident_reported`           | `incident.reported`       | `index.ts:154` |
| `incident_status_changed`     | `incident.status_changed` | `index.ts:187` |
| `corrective_action_assigned`  | `ca.assigned`             | `index.ts:224` |
| `corrective_action_completed` | `ca.completed`            | `index.ts:264` |

**`DomainWebCommand`** (`:47-89`), 4 kinds: `module_flow`, `form_submitted`,
`flow_gate_decided`, `form_status_changed`.

**Two direct emitters** that bypass the outbox (called by scanners):

- `emitComplianceTransitions()` (`index.ts:327`) — per-person self-targeted alerts + one manager
  rollup + one email, only on real status change.
- `emitEquipmentMaintenanceDue()` (`index.ts:498`) — same shape.

**Notification categories** (`recipients.ts:22-27`): `incident`, `ca`, `compliance`, `equipment`
— with the comment that _"Only NATIVE, guaranteed-to-exist sources get a built-in category…
Builder apps route their alerts through Flows."_

> Adding a notification event for a new native module is therefore: 1 enum variant + 1 handler
> case + 1 category. See [capability matrix #16](./beaconhs-capability-matrix.md#16-hse-notifications--extend).

---

# 5. Database extension — the exact 5 touch points

Worked from `packages/db/src/schema/safe-distance.ts`, a small, recently-added, fully-registered
module.

### 1. Define the table

```ts
export const safeDistanceRecords = pgTable(
  'safe_distance_records',
  {
    id: id(), // schema/_helpers.ts:8
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    reference: text('reference').notNull(),
    siteOrgUnitId: uuid('site_org_unit_id').references(() => orgUnits.id),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).defaultNow().notNull(),
    ...timestamps, // :10
    ...softDelete, // :34
  },
  (t) => ({
    tenantIdx: index('safe_distance_records_tenant_idx').on(t.tenantId),
    tenantReferenceUx: uniqueIndex('safe_distance_records_tenant_ref_ux').on(
      t.tenantId,
      t.reference,
    ),
  }),
)
```

Helpers in `schema/_helpers.ts`: `id()` `:8`, `timestamps` `:10`, `softDelete` `:34`,
`durablePublication` `:25`.

### 2. Re-export from the barrel

`packages/db/src/schema/index.ts`. **Ordering matters** — the comment at `:14-16` explains why
(FK resolution).

### 3. Register for RLS — **and this is test-enforced**

`packages/db/src/rls.ts:256-257`:

```ts
  'safe_distance_records',
  'safe_distance_segments',
```

`packages/db/src/rls.test.ts:8-19`:

```ts
it('exactly covers every Drizzle table with a tenant_id column', () => {
  const schemaTables = [
    ...new Set(
      Object.values(schema)
        .filter((v) => is(v, PgTable))
        .filter((t) => 'tenantId' in getTableColumns(t))
        .map((t) => getTableName(t)),
    ),
  ].sort()
  expect([...TENANT_SCOPED_TABLES].sort()).toEqual(schemaTables)
})
```

`rls.test.ts:21-28` additionally asserts the policy remains a single index-usable equality.
**A new tenant table that is not added to this list fails CI.** This is the single most
important invariant in the database layer.

### 4. Generate the migration

`pnpm db:generate` → `packages/db/drizzle/NNNN_<name>.sql` + a `meta/_journal.json` entry.
`pnpm db:migrate` applies it and re-installs RLS policies and reporting views idempotently.
CI runs the migration **twice** to prove idempotency (`ci.yml:90-92`).

### 5. Add integrity and relational tests

Follow the existing pattern: `packages/db/src/<domain>-relational-integrity.test.ts`
(~29 such files exist), plus `schema-ownership-preflight.test.ts` if ownership is touched.

---

# 6. Custom fields — `packages/db/src/schema/custom-fields.ts`

106 lines. One polymorphic definition table; values live in each record's existing `metadata`
jsonb under the `custom` namespace.

- **`custom_field_entity_kind` enum (`:24-29`) — a CLOSED set of 4:** `equipment`, `ppe`,
  `person`, `location`.
- **`custom_field_type` enum (`:31-43`) — 11 types:** `text, textarea, number, date, datetime,
boolean, select, multi_select, url, email, phone`.
- **`custom_field_definitions` (`:45-99`):** `entityKind`, optional `subtypeId` (equipment/PPE
  type scope, no FK), `key` (check `^[a-z][a-z0-9_]{0,62}$`), `label`, `helpText`, `fieldType`,
  `config` jsonb, `required`, `groupLabel`, `groupKey` (native section placement, e.g. `'vehicle'`,
  `'specifications'`), `sortOrder`, `isActive`, soft delete. Constraints: subtype only for
  equipment/PPE (`:87-90`); one key per (tenant, entityKind) (`:93-97`) — and definition
  deletion **atomically purges the stored values** before freeing the key.

**Logic** — `apps/web/src/lib/custom-fields/actions.ts` (868 lines):
`updateCustomFieldValueAction:377`, `saveCustomFieldDefAction:595`,
`deleteCustomFieldDefAction:801`. Choicce/numeric values are normalized on tightening
(`:172, :262`). Every write calls `recordAuditInTransaction`. Retirement is blocked when an
Insights card or report depends on the field (`findCustomFieldAnalyticsDependencies`).

**Shared types/coercion** live in `packages/forms-core/src/custom-fields.ts`
(`CUSTOM_FIELD_TYPES`, `coerceCustomFieldValue`, `isValidCustomFieldKey`, `slugifyCustomFieldKey`).

**UI** — `components/custom-fields/*`; a designer page per kind at `/equipment/custom-fields`,
`/ppe/custom-fields`, `/people/custom-fields`, `/locations/custom-fields`.

**Current consumers:** equipment, PPE, people, locations. Plus a _separate_ tenant mechanism,
`training_extra_fields` (`schema/training-extras.ts`), for training skills.

> **Cost for a new module.** Adding custom fields to a **new** module is **not** zero-code:
> one enum value + one `writeMetadataInTransaction` case
> (`lib/custom-fields/actions.ts:75-121`) + one `entityConfig` entry
> (`lib/custom-fields/config.ts`). Adding them to an **existing 4-kind entity is** zero-code
> (admin UI only).

---

# 7. Compliance engine — `packages/compliance`

The **entire public API** is 16 lines (`src/index.ts:1-16`):

```ts
export * from './audience' // resolveObligationAudience -> {personId,userId,email,roleKeys}
export * from './audience-targets' // person/trade/department/org_unit/role/group/crew
export * from './evidence' // evidence contracts per source module
export * from './evaluate' // evaluateObligation(tx, tenantId, ob, audience) -> EvalResult
export * from './identity' // stable subject keys
export * from './materialize' // write compliance_status + compliance_dispatches
export * from './schedule' // frequency/cron/expiry window math
export * from './target-lock' // target/evidence lock during edits
export * from './target-retirement'
```

Pure DB layer — depends only on `@beaconhs/db` + `drizzle-orm`; takes `tx` + `tenantId`, **never**
the web `RequestContext`.

## 7.1 Configurable per tenant without code: **YES**

| Dimension                   | Values                                                                                                                                                                 | Location                     |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `complianceSourceModule`    | **11**: inspection, document, training, form, journal, cert_requirement, equipment_inspection, ppe_inspection, job_title_signoff, corrective_action, hazard_assessment | `schema/compliance.ts:38-52` |
| `complianceSubjectKind`     | 3: `per_person \| per_record \| per_task`                                                                                                                              | `:54-58`                     |
| `complianceRecurrenceKind`  | 5: `one_time \| frequency \| cron \| expiry \| event`                                                                                                                  | `:60-66`                     |
| `ComplianceRecurrence` JSON | frequency/quantity/cron/dueOn/dueOffsetDays/dueOffsetMinutes/remindBeforeDays/compliantPercentage/reminderBuckets                                                      | `:117-128`                   |
| `complianceAudienceKind`    | 8: everyone, person, role, trade, department, org_unit, person_group, crew                                                                                             | `:68-77`                     |
| `complianceStatusValue`     | 7: pending, in_progress, completed, overdue, expiring, waived, not_applicable                                                                                          | `:85-93`                     |

Admin UI: `/compliance/obligations` (+ `aging`, `expiring`, `mine`, `by-person`).
Read paths: the web evaluates **live** on read; the worker **materializes** to
`compliance_status` (`apps/worker/src/lib/compliance-scanner.ts`, tick every minute, self-gated
per tenant by `tenant_notification_policy.scanCron` + `scanTimezone` + `scanEnabled`).

## 7.2 What needs code

- A **new source module**: one enum value + a completion adapter in
  `packages/compliance/src/evaluate.ts` (which currently dispatches 11 adapters from `:133`) +
  an evidence contract.
- A **new audience kind**: `audience-targets`.

> This is the cheapest real extension path in the codebase. A new compliance source — e.g. a
> "machinery certificate" source, which the capability matrix flags as needed
> ([#5](./beaconhs-capability-matrix.md#5-machinery-certificate--new)) — is a small, well-bounded
> change.

---

# 8. Reports — `packages/reports`

`packages/reports` owns only the **HSE entity catalogue + DB adapter**. The
definition/compiler/studio/viewer/schedule machinery comes from the external
`@braedonsaunders/appkit-reports` (`src/index.ts:1-4`).

Exports: `.`, `./document`, `./entities`, `./react`, `./server`, `./styles.css`.

## 8.1 Built-in reports — 32 seeds

`packages/db/src/seed/report-definitions.ts:81` `BEACON_REPORT_SEEDS`, one `seed(slug, name,
description, category, query, layout)` per report (lines 82–847): `incidents_weekly`,
`corrective_actions_open`, `inspections_completed_weekly`, `documents_overdue_review`,
`safety_kpi_monthly` (cross-module `summarize` over `incident_rates`), `site_safety_scorecard`,
`overdue_everything`, plus training/PPE/equipment/hazid sets. Seeded as `builtIn: true`, with a
`ReportBuiltInEditorContract` test (`apps/web/src/lib/report-built-in-editor-contract.test.ts`)
guarding editability.

## 8.2 Custom reports — two query modes

`report-definitions.ts:17-50`:

- `rows(entity, columns, { filters, groupBy, sort, sorts, limit })`
- `summarize(entity, breakouts, measures, { filters, limit })` —
  `BreakoutDef {column, bin, label}`, `MeasureDef {fn, column, label}`

Filter operators include relative dates (`'this_week'`, `'this_month'`, `'this_year'`,
`'before_now'`) and set operations (`in`).

## 8.3 Reportable entities — and the single biggest lever

`REPORT_ENTITIES` / `REPORT_ENTITY_MAP` / `BEACON_REPORT_CATALOG` in
`packages/reports/src/entities.ts:20`. Each entity's `table` is either a real base table or a
**flat reporting view** from `packages/db/src/views.ts` (`report_skill_assignments`,
`report_corrective_actions`, `report_training_records`, `report_training_matrix`,
`report_incident_rates`, `report_compliance_status`, `report_equipment_fleet`,
`report_ppe_items`, `report_vehicle_log_*`). Views read FORCE-RLS base tables, so tenant scoping
is automatic.

> **The single highest-leverage extension action in the whole codebase:** adding one row to
> `REPORT_ENTITIES` simultaneously creates a reportable dataset, publishes `/api/v1/{key}`,
> makes it available in the report builder, and makes it available in Insights. Only 12
> entities exist today, and the gap analysis
> ([#14, #15](./beaconhs-capability-matrix.md#14-hse-dashboard--extend)) identifies the
> missing ones.

**Constraint:** `CREATE OR REPLACE VIEW` cannot reorder columns, so new columns must be
**appended**; removals need a `DROP VIEW IF EXISTS` at the top of the array
(`views.ts:13-16, 40-41`).

## 8.4 Tenant-configurable without code

Create/clone/edit a report, choose entity and columns, filters, group-by, measures, sorts,
layout, export mode (`document | credential-fronts`), PDF/CSV export, wallet cards, and schedule
it (`/reports/schedules`; cadences daily/weekly/monthly/cron; BullMQ repeatables + `report_runs` +
`report_run_deliveries`).

---

# 9. `packages/integrations` — outbound automations

Barrel is 8 lines: `publishIntegrationEvent`, `dispatchOne`, `TRIGGERS` / `listTriggers` /
`getTrigger` / `sampleItem`, `DESTINATIONS` / `listDestinations` / `getDestination`,
`triggers/emit`.

**9 triggers** (`src/triggers/registry.ts:18-191`): `training.class.completed`, `incident.created`,
`incident.status_changed`, `corrective_action.created`, `corrective_action.closed`,
`form.submitted`, `hazard_assessment.created`, `journal_entry.submitted` (plus a per-field token
catalogue with `sample` values for the mapping UI and a "send a test" affordance).

**5 destinations** (`src/destinations/{http,sql,slack,sheets,email}.ts`, registry `:12-18`).
Each is config-driven (`configFields` / `secretFields` render generically) with a pure
`deliver()` and an optional `test()`. `src/destinations/registry.ts:1-3`:

> "Adding a service = one entry here"

Idempotency via `integration_export_log` + `src/idempotency.ts`. Delivery on the `outbound`
queue. Secrets encrypted per tenant in `tenant_integrations`.

Admin UI: `/admin/integrations/outbound` + the builder + run history.

---

# 10. `packages/sync` — inbound connectors

14 files. **This is inbound data sync, not offline/mobile support.**

**5 connectors**: `csv.ts`, `database.ts` (`postgres` / `mysql2` / `mssql`), `http-json.ts`,
`netsuite.ts`, `nango.ts`.

One connector contract (`CONNECTORS`, `getConnector`), canonical upsert keyed through a crosswalk
(`sync_crosswalk`), cursor persistence, a run ledger (`sync_runs`, `sync_record_changes`),
snapshot policy, and outbound-egress host allowlisting (`SYNC_DATABASE_HOST_ALLOWLIST`,
`src/egress.ts`).

Tables: `sync_connections`, `sync_crosswalk`, `sync_runs`, `sync_record_changes`.
`SYNC_ENTITIES = people, org_unit, equipment, contact` (`sync.ts:27`).
Cadence: `sync_scan` every 15 minutes plus an on-demand `sync_run` (jobId-deduped per
connection). UI at `/admin/integrations`.

> **This package also hosts the SSRF/egress guard** — `secureFetch`, `resolvePublicHost`,
> `isPublicIpAddress`, `stripHopByHopOutboundHeaders`, `validateOutboundRequestConfiguration`
> (exported at `src/index.ts:15-23`) — reused by `@beaconhs/ai`. Worth reusing rather than
> reimplementing for any new outbound HTTP integration.

> **There is no mobile app and no offline/PWA data store in this repository.** A service worker
> exists (`apps/web/public/sw.js` + `components/service-worker-registrar.tsx`, registered as a
> knip entry in `knip.ts:11`) but its scope was not verified from source.

---

# 11. i18n — `packages/i18n`

- `SUPPORTED_LOCALES = ['en','fr','es','zh']` (`src/index.ts:9`), `DEFAULT_LOCALE='en'`.
  Locales are **2-letter ISO-639-1 codes** — Chinese is `zh`, not `zh-CN`. Do not introduce a
  second naming convention: the value is persisted in three columns, each CHECK-constrained.
- Message catalogues imported statically (`src/messages/{en,fr,es,zh}.json`), typed off `en`.
  `zh` is Simplified only; `localeFromAcceptLanguage` refuses `zh-TW`/`zh-HK`/`zh-MO`/`zh-Hant` so a
  Traditional-Chinese preference is never served the wrong script (`src/index.ts:47`).
- **Resolution order (`:69-103`): user override → tenant default → platform default**, with
  `normalizeLocalePolicy` forcing the default into the enabled set and dropping stale values.
- **Locale is per-tenant** — `tenants.default_language` + `tenants.enabled_languages` (jsonb),
  with a CHECK `<@ '["en","fr","es","zh"]'` (`drizzle/0006_tenant_language_policy.sql`, widened by
  `drizzle/0045_add_zh_locale.sql`). Edited at `(app)/admin/settings/page.tsx:56-60`. Per-user
  override in `tenant_users.locale_override`, applied only if still tenant-enabled.
- Exposed on `RequestContext` as `locale`, `defaultLocale`, `enabledLocales`, `localeOverride`
  (`packages/tenant/src/index.ts:48-51`), resolved in `apps/web/src/lib/auth.ts:33-42`.
- **Hashed message keys** (`m_1f0a25de4c8df0`) + `<GeneratedText>` / `<GeneratedValue>`
  wrappers + `translateSystemCopy` for first-party strings. Coverage enforced by
  `apps/web/src/i18n/i18n-coverage.test.ts`.
- Tenant-authored multilingual content: `localizeText(value, locale, fallback, tenantDefault)`
  (`:113-128`).

> **Adding a locale is a cross-cutting change**, not a config toggle: `SUPPORTED_LOCALES`,
> `LOCALE_OPTIONS`, one JSON catalogue per locale (including its own entry in every catalogue's
> `Languages` section, since the switcher renders `Languages.<locale>` and a missing entry throws
> rather than falling back), the `Languages` label in **all** existing catalogues, and the three
> DB CHECK constraints (`tenants.default_language`, `tenants.enabled_languages`,
> `tenant_users.locale_override`). `pnpm db:generate` must be re-run to refresh the snapshot or
> `pnpm --filter @beaconhs/db check:migration-drift` fails. The `RequestContext` contract is
> unchanged. Terminology for `zh` is pinned by `docs/i18n-zh-glossary.md`.
>
> Adding a locale does **not** localise the email/PDF channels: notification and automated-email
> copy in `packages/events` and `apps/worker/src/lib` is English-only for every locale, and email
> template bodies are tenant-authored rows in `email_templates.source_html`. Reports are the
> exception — `apps/worker/src/workers/reports.ts:169` already resolves `createSystemTranslator(locale)`.

---

# 12. Analytics, Insights, AI

**`packages/analytics`** — BHQL (a Metabase-MBQL-like language): a zod AST schema
(`ast-schema.ts`), an expression parser (`expr-parser.ts`), a semantic overlay
(`semantic.ts:87`), and a visualization registry. **The SQL compiler and executor live behind
the `@beaconhs/analytics/server` subpath so a client bundle can never pull in drizzle** — a
deliberate and well-designed boundary (`src/index.ts:1-9`).

**Insights** — no package. The BHQL **types** live in `packages/db/src/schema/insights.ts`
(`BhqlQuery`, `BhqlAggFn`, `BhqlMeasure`, `BhqlTemporalUnit`, `BhqlExpr`) because the AST is
persisted as jsonb on `insight_cards.query`. Tables in `insight-dashboards.ts`:
`insight_dashboards`, `insight_cards`, `insight_dashboard_pins`. It reuses `ReportRuleGroup`
verbatim so `compileRuleGroup` is shared with reports. 9 visualization types. Access policy in
`apps/web/src/lib/analytics-access.ts`.

**`packages/ai`** — multi-provider client (Anthropic, OpenAI, Google, OpenRouter, Groq, xAI,
DeepSeek, Mistral, custom) with **per-tenant encrypted configuration**
(`apps/web/src/lib/ai-config.ts`); provider credentials are deliberately not env vars
(`.env.example:69-71`). Features: `writing.ts` (tone rewriting), `doc-chat.ts` (RAG with
`read_document` / `edit_document` / `write_document`), `extract.ts`, `vision.ts` (photo
analysis), `digest.ts`, `analysis.ts`, `structured.ts`, `builder.ts` (**generate a form template
from a prompt**), `agent.ts`.

**16 assistant tools.** 14 read-only in `apps/web/src/lib/assistant/tools.ts`: `whoami:72`,
`find_incidents:93`, `get_incident:183`, `find_corrective_actions:233`,
`get_corrective_action:303`, `find_documents:341`, `read_document:392`,
`view_document_pages:445`, `search_document:554`, `find_people:627`,
`find_training_records:683`, `list_my_open_items:757`, **`search_user_guide:839`**,
**`read_user_guide:871`**. 2 write in `tools-write.ts`: **`draft_corrective_action:46`**,
**`draft_incident:92`** (draft-only, gated by `assistant.write`; commits go through
`_commit-actions.ts` with a proposal card).

> **The last two tools are the cheapest possible HSE extension**: the AI assistant can already
> draft an incident or a corrective action. If a new HSE record type should be creatable from
> the assistant, it needs a `draft_*` tool — a small, well-contained addition.

---

# 13. Office, design studio, email render

- **`packages/office`** (8 files) — spawns LibreOffice from `SOFFICE_PATH`; PPTX/slides import,
  document-version renders, book concatenation, draft text extraction. Bridges to the browser
  editor via Collabora Online (WOPI): `app/wopi/files/[fileId]/route.ts` + `/contents/route.ts`,
  `lib/{wopi,wopi-access,collabora,docx-blank,pptx-blank}.ts`. Reconciler on tick `*/5`.
- **`packages/design-studio`** (8 files) — the shared design canvas for **printed credentials**:
  `schema.ts`, `fabric.ts` (SVG model), `html.ts`, `print.ts`, `defaults.ts`,
  `credential-outputs.ts`. Host UI at `components/design-studio/editor.tsx`. Consumers: ID badges
  (`/people/badges/design`), equipment QR labels (`/equipment/labels/design`), training
  credential/wallet cards. **Distinct** from the form designer and the template builder.
- **`packages/email-render`** (5 files) — the single keystone behind flow `send_email`, seeded
  email templates, and `/admin/email-templates`. Sanitizes authored HTML once at save time and
  HTML-escapes merge values at interpolation time (`src/index.ts:1-11`). Also backs PDF templates
  via `lib/{pdf-templates,pdf-route,module-pdf}.ts`.
- **PPE and HAZID are not packages** — they are native `app/(app)/ppe/` and
  `app/(app)/hazard-assessments/` modules, registered declaratively in
  `lib/module-admin/registry.ts:174-233, 379-431`. Both are full flow subjects and compliance
  sources.

---

# 14. Recommendation for the HSE build

Given the cost asymmetry established in §2, the ordering should be:

| Need                                                                                         | Use                                                  | Why                                                                       |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------- |
| Job-specific paperwork (lift plans, JSA, permits, toolbox talks, work-at-height checklists)  | **Builder form**                                     | ~0 registration points; the repo has already done this twice              |
| Periodic obligations with expiry and reminders (certificate renewals, statutory inspections) | **Compliance obligation**                            | 11 sources, 8 audience kinds, 5 recurrence modes, per-tenant configurable |
| Automations ("when X happens, notify Y / call Z")                                            | **Flows**, then `packages/integrations` for outbound | 6 triggers, 13 actions; 9 triggers, 5 destinations                        |
| Dashboards and ad-hoc analysis                                                               | **REPORT_ENTITIES + Insights**                       | one row unlocks reports + `/api/v1` + Insights                            |
| Attaching files and photos                                                                   | **`requestUpload` / `finalizeUpload`**               | the uploader is already shared, 20+ call sites                            |
| Inbound data (HR system, asset system)                                                       | **`packages/sync` connector**                        | 5 connectors exist; a new one is a single registry entry                  |
| A genuinely new first-class record (e.g. **Machinery Certificate**)                          | **Native module**                                    | ~37 points, but there is no alternative — see the capability matrix       |

---

# Risks & Open Questions

## Defects (documented only — nothing was changed)

| #   | Severity | Finding                                                                                                                                                                                    | Location                                               |
| --- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| 1   | Medium   | `README.md:139` advertises a "plugin registry" in the Admin hub. The plugin system was retired. Violates AGENTS.md rule 7.                                                                 | `README.md:139`                                        |
| 2   | Medium   | `pnpm-workspace.yaml:5` keeps `- 'plugins/*'` although `plugins/` holds only `.gitkeep` — dead config, per AGENTS.md rule 6.                                                               | `pnpm-workspace.yaml:5`                                |
| 3   | Medium   | `custom_field_entity_kind` is a closed 4-value enum; there is no generic path for a new entity to get custom fields.                                                                       | `schema/custom-fields.ts:24-29`                        |
| 4   | Low      | 5 `actions.ts` + 60 `_actions.ts` files define their own `{ok:false,error}` union with no shared envelope, while the REST layer has a proper `ApiError` convention.                        | `app/(app)/**/_actions.ts`                             |
| 5   | Low      | Two parallel custom-field mechanisms exist: `custom_field_definitions` (4 entity kinds) and `training_extra_fields` for training skills. A duplicate system by AGENTS.md rule 6 standards. | `schema/custom-fields.ts`, `schema/training-extras.ts` |
| 6   | Low      | The `sw.js` service worker scope could not be verified from source, so the actual offline capability is unclear.                                                                           | `apps/web/public/sw.js`                                |

## Open questions

1. **Which HSE requirements are genuinely new native records, and which are forms?** The
   capability matrix marks 16 of 17 targets as PRESERVE/EXTEND/ADAPT, so the native-module cost
   is largely avoidable. Only Machinery Certificate appears to require a new table. Confirm this
   reading before budgeting.
2. **Is the Builder acceptable to the HSE programme's users?** A form-driven approach is
   dramatically cheaper, but HSE officers often need structured, queryable records. If
   field-level structure matters, some targets classed EXTEND may need native tables.
3. **Custom fields for new entities** — worth widening `custom_field_entity_kind` up front if
   several new native modules are planned, rather than per module.
4. **Multi-tenancy of the extension** — the `packages/etl` package is excluded from the public
   workspace and git-ignored (`pnpm-workspace.yaml:4`) for customer-specific work. Confirm
   whether the HSE secondary development should follow that pattern (isolated, private package)
   or be a first-class part of the repo.

## Related documents

- [Architecture audit](./beaconhs-architecture.md) — the wider system
- [Capability matrix](./beaconhs-capability-matrix.md) — the 17 HSE targets
- [HSE gap analysis](./hse-gap-analysis.md) — what to build and in what order
