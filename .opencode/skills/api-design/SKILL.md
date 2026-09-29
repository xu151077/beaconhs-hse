---
name: API Design
description: Design and review BeaconHS server actions, route handlers and the public REST API consistently. Use when adding or changing an endpoint, a server action, a public API route, or an API-key surface.
---

# API Design

BeaconHS has three server surfaces. They have different contracts and this
skill keeps them consistent.

## When to use

- Adding or changing a Next.js route handler or a server action.
- Extending the public REST API under `apps/web/src/app/api/v1/`.
- Exposing a new entity to API keys.
- Changing request validation, pagination, filtering, or error shapes.

## The three surfaces

| Surface | Location | Caller | Auth |
|---|---|---|---|
| Server actions | `apps/web/src/app/(app)/**/_actions.ts` | the app's own UI | session + `assertCan` |
| Route handlers | `apps/web/src/app/api/**/route.ts` | internal + integrations | varies — prove it |
| Public REST API | `apps/web/src/app/api/v1/` | external systems | API key |

Do not mix their conventions. A server action is not an HTTP endpoint and should
not be shaped like one.

## Server action rules

- Start with `requireRequestContext()` for the context and the tenant-bound
  `ctx.db(...)`.
- Guard with `assertCan(ctx, '<exact.permission>')` at the top of **every**
  mutation, before reading anything.
- Validate input with the existing Zod/shared schema. Do not hand-roll checks
  and do not trust a hidden field or a client-supplied `tenantId`.
- Tenant identity comes from `ctx.tenantId`, never from a parameter.
- Write an audit record with `recordAudit` for anything that changes state a
  user would later ask about.
- `revalidatePath` the affected routes.
- Return a typed result. Prefer `{ ok: true, ... }` / `{ ok: false, error }`
  over throwing for expected validation failures; reserve throws for
  `assertCan` and genuine faults.

## Route handler rules

- Export `const dynamic = 'force-dynamic'` for anything tenant- or
  auth-dependent.
- Authenticate explicitly. An unauthenticated handler must have a comment saying
  exactly why it is public.
- Re-derive tenant context server-side. A tenant id in the URL, query, or header
  is untrusted input.
- Validate and coerce every input before it reaches Drizzle.
- Stream or paginate. Never return an unbounded table.
- Audit exports (`AGENTS.md`): CSV/PDF routes must call `recordAudit` and
  respect tenant context.

## Public API (`/api/v1`)

- Entity permissions are mapped in
  `apps/web/src/lib/api/permissions.ts`. Keys are validated against
  `PERMISSION_CATALOGUE`, so a key not in the catalogue is unusable.
- Read mappings are all `.read.all` (`READ_PERMISSION_BY_CATEGORY`), which
  means an API key that can read a category can read **every** record in it
  across the tenant. State that consequence explicitly when granting one.
- API keys carry `permissions` and `builderTemplateIds` only —
  **no scope column**. Do not pretend an API key can be project-scoped.
- Follow the existing CRUD shape in `apps/web/src/lib/api/write.ts` so
  idempotency (`api_idempotency_keys`) and error envelopes stay consistent.

## Conventions

- Validate at the boundary; trust nothing inside.
- Prefer `ctx.db(...)` so RLS applies. Root `db` needs an explicit, deliberate
  scope (`withSuperAdmin` / `withTenant` / scoped transaction).
- Type every input and output. `strict` plus `noUncheckedIndexedAccess` is on.
- Keep resource nouns plural and ids opaque.

## Known issue to report, not silently fix

`POST /api/v1` currently returns 500 with
`No public API read permission mapped for entity category "compliance"`. This is
in an unmodified upstream file. It is a pre-existing defect — surface it, do not
quietly patch it as part of unrelated work.

## Forbidden

- Never accept `tenantId`, `roleId`, or permission values from the request body
  as authority.
- Never expose an entity in `/api/v1` without a `READ_PERMISSION_BY_CATEGORY`
  mapping.
- Never return an unpaginated list from a route handler.
- Never log a presigned URL, token, or PII in an error path.
- Never add a parallel REST surface outside `/api/v1` for the same resource.

## Completion criteria

- Auth and permission for the surface are stated and implemented.
- Tenant identity is derived server-side only.
- Inputs are schema-validated at the boundary.
- Mutations audit and revalidate.
- Lists paginate.
- Responses are typed, and errors follow the existing envelope.
