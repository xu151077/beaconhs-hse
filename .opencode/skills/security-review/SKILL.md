---
name: Security Review
description: Review a change for authentication, authorization, tenant isolation, RLS, IDOR, file access, capability URLs, secrets and logging. Use for any change touching auth, routes, uploads, storage, permissions or data access.
---

# Security Review

Read-only review of a change or a subsystem for security defects. Reports
findings; it does not fix them.

## When to use

- A change touches authentication, sessions, roles, permissions or scopes.
- A change adds or modifies a route handler, server action, or public API.
- A change touches uploads, attachments, presigned URLs, or `packages/storage`.
- A change adds a table, migration, or RLS policy.
- A change reads, writes, or logs anything sensitive.

## Scope

### Authentication
- Does the entry point require a real session? Pages under
  `apps/web/src/app/(app)/` are authenticated by the layout; anything outside
  must authenticate itself.
- Public routes (`/login`, `/kiosk`, `/verify/*`, API auth) must each prove why
  they are public.
- Better-Auth tables are global, not tenant-scoped. Confirm no assumption of RLS.

### Authorization
- Every mutation calls `assertCan(...)` (or `assertCanManageModule`) with the
  **specific** permission it needs — not a broader one that happens to pass.
- Every list/detail read goes through `moduleScopeWhere` or
  `recordVisibilityWhere` (`apps/web/src/lib/visibility.ts`).
- Guard pages with `requireModuleManage`, actions with `assertCanManageModule`.
  A page guard alone does not protect the action.

### Tenant isolation (RLS)
- All tenant data reads through `ctx.db(...)`, never bare root `db`.
- If root `db` is used, it must be `withSuperAdmin`, `withTenant`, or a
  transaction that sets the RLS config — and that scope must be intentional.
- Prove it, don't assume:

```sh
docker compose --profile local-db exec postgres \
  psql -U beaconhs_super -d beaconhs -tAc \
  "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relforcerowsecurity;"
```

187 tables carry `FORCE ROW LEVEL SECURITY` on the current baseline. A new
tenant table that does not is a defect.

### Project scope
- `RoleScope` has six variants and **none** of them is project/org-unit
  (`packages/db/src/schema/iam.ts:49-55`).
- Visibility has exactly three tiers — `all` / `site` / `self`
  (`apps/web/src/lib/visibility.ts:106,114-118`).
- So "this user may only see project X" is **not expressible** today. If a
  change implies it, that is a finding, not something to patch locally with an
  ad hoc filter.

### IDOR
For every record fetched by id, confirm the read is also *scoped*, not just
permission-checked. A permission gate plus an unscoped
`.where(eq(table.id, params.id))` is an IDOR.

### File access
- Attachments and objects are reached through the storage abstraction in
  `packages/storage`, not a raw bucket client.
- Presigned URL issuance must re-check permission at issue time; the URL itself
  is a bearer capability.
- `x-amz-meta-*` and `x-amz-tagging` must survive the round trip. They do on
  MinIO; they do **not** on SeaweedFS (see
  `docs/beaconhs-seaweedfs-verification.md`).
- Check upload size limits, content-type handling, and filename sanitisation.

### Capability URLs
`/verify/[token]` and `/verify/person/[token]` are unauthenticated by design.
Confirm each:

- resolves from an unguessable, single-use or revocable token,
- leaks no more than holder name, credential, status and expiry,
- is rate-limited or otherwise not enumerable,
- does not expose another tenant's data.

### Secrets
- Never read, print, copy or commit a real secret. Project permissions deny
  reading `*.env`, `*.env.*`, `secrets/**`, `credentials/**`, `*.pem`, `*.key`,
  `.ssh/**`.
- Reference secrets by **name** (`R2_SECRET_ACCESS_KEY`), never by value.
- `.env.example` is safe to read and must stay value-free.
- If a secret was committed, that is a finding — report it, do not quietly fix.

### Logging
- No secret, token, presigned URL, or full PII in logs or error messages.
- PII in BeaconHS includes emergency contacts, date of birth, termination
  dates, and medical/injury detail on incidents.

## What to read first

- `packages/tenant/src/index.ts` — `RequestContext`, `can()`, `assertCan()`,
  `readTierCovers()`.
- `apps/web/src/lib/visibility.ts` — record-level visibility.
- `apps/web/src/lib/auth.ts` — request context resolution.
- `packages/db/src/rls.ts` — tenant-scoped table registry.
- `docs/hse-development-baseline.md` §12 — the project-scope analysis.

## Known defects (report, do not re-fix)

- `nav/registry.ts:185` references `equipment.read.self`, which is not in
  `PERMISSION_CATALOGUE`.
- `nav/registry.ts:172` — the `people` nav entry has **no** permission gate.
- Project-level scoping is not expressible.

## Forbidden

- Never weaken a check to make a flow work.
- Never add `SECURITY DEFINER`, an RLS bypass, or a `withSuperAdmin` in request
  path code without flagging it as a deliberate decision.
- Never disable `pnpm lint`, `typecheck`, or the RLS coverage test.
- Never treat "the user is logged in" as authorization.

## Completion criteria

Findings are reported as: severity, `path:line`, what an attacker can do, and the
minimal fix direction. Each finding states whether it is **new**, **pre-existing
and known**, or **pre-existing and newly discovered**. Silent findings are not
reported findings.
