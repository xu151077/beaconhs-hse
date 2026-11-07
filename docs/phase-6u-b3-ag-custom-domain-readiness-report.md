# Phase AG — Custom Domain & Production Readiness Report

Repository: `/home/test/projects/beaconhs-hse`  
Branch: `hse-platform`  
HEAD: `51a899b7aac0a942da327222a3eed355fca9798a`  
Start worktree: 94 tracked modifications / 137 untracked entries  
End worktree: 102 tracked modifications / 141 untracked entries

## Scope and worktree protection

No reset, clean, restore, stage, commit, or push was used. No production or C2
resources were accessed. No `.env` values, credentials, tokens, or signed URLs
are included here.

## Configuration dependency matrix

| Consumer                         | Configuration source                                            | Runtime/build              | Regression evidence                                   |
| -------------------------------- | --------------------------------------------------------------- | -------------------------- | ----------------------------------------------------- |
| Web email/QR/kiosk/report links  | `PUBLIC_APP_URL` → `APP_URL` → legacy `NEXT_PUBLIC_APP_URL`     | runtime                    | `apps/web/src/lib/app-base-url.test.ts`               |
| Worker email/digest/report links | same resolution order                                           | runtime                    | worker typecheck/tests                                |
| Event and integration links      | `PUBLIC_APP_URL` → `APP_URL` → legacy `NEXT_PUBLIC_APP_URL`     | runtime                    | events/integrations tests and typecheck               |
| Better Auth base URL             | `BETTER_AUTH_URL` only                                          | runtime; security boundary | `packages/auth/src/public-url.test.ts`, 77 auth tests |
| Better Auth origin/CSRF trust    | `BETTER_AUTH_TRUSTED_ORIGINS`                                   | runtime                    | existing auth trusted-origin tests                    |
| Browser presigned S3 URLs        | `R2_ENDPOINT` (public origin)                                   | runtime                    | storage endpoint-routing tests                        |
| Server-side S3 I/O               | `R2_INTERNAL_ENDPOINT` (private origin)                         | runtime                    | storage endpoint-routing tests                        |
| Storage path/signature safety    | both endpoints, origin-only validation                          | runtime                    | storage endpoint-routing tests                        |
| CSP storage/Collabora sources    | `R2_ENDPOINT`, `COLLABORA_URL`                                  | runtime                    | security-header/header tests                          |
| WOPI postMessage origin          | `appBaseUrl()`                                                  | runtime                    | WOPI route typecheck/build                            |
| Collabora editor                 | `COLLABORA_URL`                                                 | runtime                    | no production runtime run                             |
| Collabora callback base          | `COLLABORA_WOPI_URL` (necessary container-to-app address)       | runtime                    | no production runtime run                             |
| Next dev HMR extra hosts         | `DEV_ALLOWED_ORIGINS`                                           | build-time only            | config audit                                          |
| Deployment public origin         | `APP_URL`, exported as `PUBLIC_APP_URL` by deployment templates | restart                    | compose/workflow audit                                |

The previous fixed deployment hostname was removed from
`apps/web/next.config.ts`; dev-only extra hosts now come from
`DEV_ALLOWED_ORIGINS`.

## Public-origin contract

`PUBLIC_APP_URL` is the authoritative browser/link origin. It is validated as an
origin-only HTTP(S) URL and rejects credentials, queries, fragments, and path
prefixes. `APP_URL` remains a compatibility alias for existing deployments.
`NEXT_PUBLIC_APP_URL` is only a legacy build-time fallback and is not required
for runtime links.

Better Auth intentionally remains separate: `BETTER_AUTH_URL` is its
CSRF/authentication security origin. Link-generation variables never widen its
trusted-origin boundary. A deployment changing its domain must update both the
public origin and the Better Auth URL (the deployment workflow keeps them
aligned).

## Storage internal versus public endpoints

The existing split is preserved and made explicit:

- `R2_INTERNAL_ENDPOINT=http://minio:9000` — private server-side S3 I/O.
- `R2_ENDPOINT=https://app.example.com` — browser-facing presigned URLs.
- Both must be origin-only HTTP(S) URLs; a `/storage` prefix is rejected.
- MinIO bucket keys remain root path-style (`/bucket/t/<tenant>/...`).
- `forcePathStyle` remains enabled, so signatures are host/path compatible with
  the reverse proxy.
- The existing endpoint-routing test proves `putObject`, `getObject`,
  `headObject`, and `deleteObject` use the internal origin while presigned PUTs
  and part URLs use the public origin.

## Environment variables (placeholders only)

```dotenv
PUBLIC_APP_URL=https://app.example.com
APP_URL=https://app.example.com
BETTER_AUTH_URL=https://app.example.com
BETTER_AUTH_TRUSTED_ORIGINS=https://app.example.com
R2_ENDPOINT=https://app.example.com
R2_INTERNAL_ENDPOINT=http://minio:9000
COLLABORA_URL=https://app.example.com
COLLABORA_WOPI_URL=https://app.example.com
DEV_ALLOWED_ORIGINS=app.example.com
```

`COLLABORA_WOPI_URL` is retained because Collabora may reach the app through a
container network address even when the browser uses the public domain.
`NEXT_PUBLIC_APP_URL` remains supported only for old deployments; it is not the
runtime authority.

## Domain-change tests

Two independent domains were exercised without hardcoding either as a default:

- `https://hse.example.test`
- `https://beacon.example.test`

Verified:

- web links follow the configured origin at call time;
- Better Auth remains on its explicit security origin; the browser client now prefers the live page origin over a stale build-time `NEXT_PUBLIC_APP_URL` fallback;
- runtime changes do not require rebuilding the application process;
- invalid origins fail clearly;
- conflicting public origins fail clearly;
- storage endpoint path prefixes fail clearly.

## Tunnel and route assumptions

Deployment templates keep the Cloudflare Tunnel as the sole public entrypoint.
The application owns the root public route; Collabora routes `/browser`, `/cool`,
and `/hosting` must be matched before the application catch-all. S3 traffic must
remain at the root path-style bucket route and must not be rewritten to a
`/storage` prefix. No live tunnel or DNS was modified.

## Production-readiness matrix

| Area                                        | Status                                      | Evidence / gap                                                             |
| ------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------- |
| Migration 0050 and clean DB reproducibility | PASS                                        | disposable DB: 50 applied, 0 pending; second run idempotent                |
| Deployment migration procedure              | PASS (local procedure) / UNKNOWN production | `pnpm db:migrate` completed locally; deploy execution not run              |
| Backup and restore                          | NOT RUN                                     | no isolated restore drill executed                                         |
| R2/IAM permissions and public signing       | UNKNOWN                                     | local MinIO routing passed; production credentials/permissions unavailable |
| Lifecycle configuration/execution           | UNKNOWN                                     | code/config audited; production lifecycle evidence unavailable             |
| Network / Cloudflare Tunnel                 | UNKNOWN                                     | templates audited; live tunnel not accessed                                |
| Collabora/WOPI runtime                      | NOT RUN                                     | local container exists but no production/custom-domain runtime proof       |
| Production alert delivery                   | NOT RUN                                     | isolated receiver only; production channels deliberately disconnected      |
| Custom-domain runtime behavior              | PASS (unit/runtime config)                  | two-domain and validation tests pass                                       |
| Browser custom-domain session               | NOT RUN                                     | no live tunnel/DNS or production domain access                             |

## Commands and results

- `pnpm --filter @beaconhs/web test`: PASS, 234 files / 2015 tests
- `pnpm --filter @beaconhs/web typecheck`: PASS, exit 0
- `pnpm --filter @beaconhs/web build`: PASS, exit 0 (rerun after client change)
- `pnpm --filter @beaconhs/auth test`: PASS, 78 tests
- `pnpm --filter @beaconhs/auth typecheck`: PASS
- `pnpm --filter @beaconhs/storage test`: PASS, 148 tests
- `pnpm --filter @beaconhs/storage typecheck`: PASS
- `pnpm --filter @beaconhs/events test`: PASS, 34 tests
- `pnpm --filter @beaconhs/integrations test`: PASS, 5 tests
- `pnpm --filter @beaconhs/worker test`: PASS, 103 tests
- `pnpm --filter @beaconhs/worker typecheck`: PASS
- targeted web ESLint: PASS, exit 0
- `pnpm deadcode:check`: PASS

## Remaining G2 blockers

Production R2/IAM, lifecycle, tunnel, Collabora/WOPI, backup/restore, and alert
evidence are not available. No source change can substitute for that evidence.

G2 remains **BLOCKED**.

## Ending worktree

- Branch: `hse-platform`
- HEAD: `51a899b7aac0a942da327222a3eed355fca9798a`
- No commits or pushes.
- End HEAD verified unchanged: `51a899b7aac0a942da327222a3eed355fca9798a`.
