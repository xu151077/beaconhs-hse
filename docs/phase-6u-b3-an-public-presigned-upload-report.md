# AN — Public HTTPS Presigned Upload Endpoint Repair

**Phase:** 6U-B3-AN
**Branch:** hse-platform (commit never performed, push never performed)
**Date:** 2026-10-16

## 1. Root cause

The browser was given presigned PUT URLs built from `R2_ENDPOINT`. In the isolated AJ topology this
was configured as `http://127.0.0.1:3012`, so every `presignPut`/`presignMultipartPart` URL was signed
against a host that only exists inside the deployment's own network. A public browser tried to
connect to **its own** loopback address, so CSP (`connect-src 'self'`) rejected the request and no
upload could complete. The same env value also fed the CSP connect-src source, so storage allowed no
usable public origin.

The code-level invariant is still correct: `R2_ENDPOINT` is the browser-facing presign origin and
`R2_INTERNAL_ENDPOINT` is the server-side S3 endpoint. The failure is a deployment-misconfigured
public origin combined with no runtime guard rejecting an insecure/loopback value in non-development
mode.

Do not simply patch `R2_ENDPOINT` to a URL string: a presigned URL is bound to both the host and
the path the client uses. The web package now resolves the browser/public origin at runtime from
`R2_ENDPOINT` first and, if that value is not usable in the browser, falls back to the existing
runtime origin resolver (`PUBLIC_APP_URL`/`APP_URL`/`NEXT_PUBLIC_APP_URL`). The same logic is used in
the CSP generator so the HTTP header and the signed URL agree.

## 2. Architecture choice

- If `R2_ENDPOINT` is already a browser-reachable HTTPS (or, in development, a loopback HTTP)
  origin, use it.
- Otherwise derive the public S3 origin from the runtime application origin variables already used
  elsewhere (`PUBLIC_APP_URL`, `APP_URL`, `NEXT_PUBLIC_APP_URL`).
- `R2_INTERNAL_ENDPOINT` remains untouched and is used for all server-side S3 I/O.
- No web-domain fixed hostnames, no wildcard origins and no broad CSP `connect-src 'none'`.

## 3. Changes

- `packages/storage/src/index.ts` (`browserReachableStorageOrigin`, public endpoint resolution):
  the browser-public origin is now resolved as described above.
- `apps/web/src/proxy.ts` (`storageCspOrigin`): same resolution for the CSP `connect-src`
  allow-list; logs nothing sensitive.
- `knip.ts`: report-only guard entry (already changed in prior phase, retained).

## 4. Verification evidence

Implemented and fully gated:

| Gate / check                                                                   | Result                      |
| ------------------------------------------------------------------------------ | --------------------------- |
| `pnpm typecheck`                                                               | PASS                        |
| `pnpm format:check`                                                            | PASS                        |
| `pnpm lint`                                                                    | PASS                        |
| `pnpm deadcode:check`                                                          | PASS                        |
| `pnpm --filter @beaconhs/storage test`                                         | PASS — 15 files / 148 tests |
| `pnpm --filter @beaconhs/storage exec vitest run src/endpoint-routing.test.ts` | PASS — 22 tests             |
| `pnpm --filter @beaconhs/web typecheck`                                        | PASS                        |

### Remote browser E2E

Attempted:

- Remote application responded HTTP 200 (`GET https://beaconhs-test.xuhaoqing.top/login`).
- Playwright MCP navigated successfully (no uncaught exit/1).
- Live CSP currently reports `connect-src 'self' https://nominatim.openstreetmap.org
https://api.nango.dev` because `R2_ENDPOINT` is still set to the loopback gateway
  (`http://127.0.0.1:3012`) and is not HTTPS.
- Full browser single-file upload and multipart upload E2E: **NOT RUN**, because this change
  only repairs the public S3 origin resolution/allow-list and the AJ gateway still needs an
  additional deployment exercise before registered uploads happen from the public domain.

Local validation used loopback MinIO on port 9000 and local web on port 3000. I did not modify
production DNS, the Cloudflare Tunnel, Drill infrastructure, shared credentials, or storage
root configuration.

## 5. Scope and privacy notes

- No secrets, magic-link tokens, cookies, or passwords are printed.
- The change does not relax CSP to wildcards or float through private endpoints as a security
  permission.
- Frozen-tenant and owner-validation behaviour remains fail-closed.
- Build metadata and lock files are untouched except the code changes listed above.

## 6. G2 remainders

- AJ deployment must set `R2_ENDPOINT` to a browser-reachable HTTPS origin for static CSP to
  already be correct. With the fallback added, provided `PUBLIC_APP_URL` is configured the
  presign URLs no longer leak loopback addresses by default.
- Full signed PUT/GET validation from a true browser has not been executed against a public
  minimal endpoint in this pass because the live gateway and Cloudflare edge path were out of
  scope to revise.
