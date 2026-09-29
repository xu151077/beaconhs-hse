---
name: Release Readiness
description: Final gate check before a change is considered done — tests, migration, security, permissions, docs, build, deployment and rollback. Use before declaring work complete, before committing, and before opening a PR.
---

# Release Readiness

The final pass. This skill answers one question: **may this be called done?**

## When to use

- Before declaring any task complete.
- Before committing or opening a PR.
- Before deploying or migrating.
- When asked "is this ready to ship?"

## The six CI gates

All six must pass. Capture each gate's own exit code — do not pipe to `tail` and
read `$?`, which reports `tail`'s status.

```sh
pnpm format:check    # 1
pnpm typecheck       # 2
pnpm lint            # 3
pnpm test            # 4
pnpm deadcode:check  # 5
pnpm build           # 6
```

Narrow first while iterating (`pnpm --filter @beaconhs/db test`), then run all
six. Broaden early when touching shared packages, schema, auth, tenant scoping,
workers, or UI primitives.

**A red gate blocks the release.** Never make a gate green by disabling it — no
`eslint-disable`, no `ts-ignore`, no skipping a test, no `--no-verify`. Project
permissions deny these. Fix the cause.

## Checklist

### Tests
- [ ] `pnpm test` passes across all packages.
- [ ] New behaviour has tests proportional to its risk.
- [ ] Tests were confirmed to fail when the change is reverted.

### Migration
- [ ] If the schema changed: migration applied and verified.
- [ ] New tenant tables are in `TENANT_SCOPED_TABLES`.
- [ ] Migration is idempotent where the existing style allows.
- [ ] No destructive statement without explicit approval.
- [ ] Rollback path stated, or its absence stated explicitly.

### Security
- [ ] Permissions enforced on the **action**, not only the page.
- [ ] Tenant identity derived server-side.
- [ ] No secret, presigned URL, or PII logged.
- [ ] No RLS bypass or `withSuperAdmin` added in a request path.
- [ ] Uploads and capability URLs re-check permission at issue time.

### Permissions
- [ ] New keys are in `PERMISSION_CATALOGUE` and granted to the right roles.
- [ ] Nav entries carry `requiredPermission` where a gate is intended.
- [ ] Visibility tier and scope behaviour verified, not assumed.
- [ ] Manual articles explain the permission to a non-technical user.

### Documentation
- [ ] Manual article added or updated for every user-facing change.
- [ ] Walkthrough steps updated if a `data-walkthrough` target moved.
- [ ] `docs/project-development-state.md` reflects the new state.
- [ ] `path:line` citations verified by reading the lines.

### Build and deploy
- [ ] `pnpm build` passes.
- [ ] `pnpm deadcode:check` passes — no unused files, exports, or types.
- [ ] `docker-compose.yml` still byte-identical to `HEAD` unless a change was
      explicitly requested:
      ```sh
      git diff --quiet HEAD -- docker-compose.yml && echo IDENTICAL || echo CHANGED
      ```
- [ ] Environment variables the change needs are documented (by **name**).

### Rollback
- [ ] How to undo this is written down.
- [ ] Data changes are reversible, or their irreversibility is stated.

## Definition of Done

Work is done when, and only when:

1. All six gates pass.
2. The requested behaviour works — verified, not assumed.
3. Permissions, audit, revalidation and tenant isolation are in place.
4. Manual and docs are truthful.
5. No dead code, duplicate implementation, or stale route was introduced.
6. Known risks and remaining work are stated plainly.
7. `docs/project-development-state.md` is current.

If any item cannot be verified, say **why**. "I could not run this because…"
is an acceptable answer. Silently skipping a gate is not.

## Forbidden

- Never report a gate as passing without its own exit code.
- Never declare done with a known blocker unmentioned.
- Never ship a migration whose rollback was never considered.
- Never push, tag, or deploy without explicit user approval.
- Never weaken a gate to get a green result.

## Completion criteria

- All six gates run, each with its own captured exit code.
- Every checklist item answered yes, no, or not-applicable — no silent blanks.
- Anything unverifiable is named with the reason.
- A final verdict: **ready**, **ready with stated caveats**, or **not ready**.
