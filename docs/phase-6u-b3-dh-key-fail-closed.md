# Phase 6U-B3-DH — Server Action key fail-closed boundary

Date: 2026-10-19  
Repository: `/home/test/projects/beaconhs-hse`  
Branch/HEAD: `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`

## 1. The real call path

| Layer    | Behaviour                                                                                                                                                                                                | Evidence                                                                                 |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Build    | The key is injected only for the build command through a required BuildKit secret mount.                                                                                                                 | `Dockerfile:36-42`; `deploy-dev.yml:78`                                                  |
| Image    | Next.js embeds the build key in `server-reference-manifest.json`.                                                                                                                                        | `next/dist/server/app-render/manifests-singleton.js:275`; verified in the Phase CT image |
| Runtime  | `process.env.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY                                                                                                                                                          |                                                                                          | serverActionsManifest.encryptionKey` | `next/dist/server/app-render/encryption-utils.js:73-86` |
| Import   | `atob(value)` → `crypto.subtle.importKey('raw', …, 'AES-GCM', …)`                                                                                                                                        | `encryption-utils.js:78-90`                                                              |
| Contract | "base64-encoded value with a valid AES key length (16, 24, or 32 bytes)"; "The key is embedded in the build output and used automatically at runtime"; "all instances must use the same encryption key". | `next/dist/docs/01-app/02-guides/self-hosting.md:191-203`                                |

## 2. The project's configuration contract

Deployment evidence decides which states are faults:

- `deploy/dokploy-dev.compose.yaml` (the deployed web service) does **not** set the runtime variable; the build injects the same secret, so the embedded build-time key is the effective key.
- `deploy/local-production.compose.yaml:90` requires the runtime variable and states it must equal the build-time key.
- The deployed phase stacks carry no runtime variable (read-only check).

Therefore:

- **Missing runtime key is a legitimate state** — Next.js uses the build-time key, which the build refuses to omit. Failing closed here would break the deployed stacks, so it is not treated as an error.
- **A present but invalid runtime key is a real fault** — it silently overrides the valid build-time key, and the framework then cannot import it, so every Server Action carrying bound arguments breaks at request time, long after the instance started and reported itself healthy.

## 3. The fix

`apps/web/src/lib/server-action-key.ts` (new) classifies the runtime override as `valid`, `missing`, or `invalid`, using exactly the framework's requirement (base64 → 16/24/32 raw bytes). `assertServerActionKeyUsable` throws for the invalid state; the message names the variable and the expected format and never contains the value or a derivative of it.

`apps/web/src/app/api/health/ready/route.ts` (modified) calls that assertion first. An invalid override makes readiness answer **503** and keeps the instance out of the load balancer, and the rejection is logged server-side without the value.

No Next.js internal file was modified and no new key mechanism was introduced.

## 4. Tests

- `apps/web/src/lib/server-action-key.test.ts` (new) — 8 tests: classification, format validation, error-message hygiene, and a WebCrypto reproduction of the framework's own key import showing that the rejected values really cannot be imported.
- `apps/web/src/app/api/health/ready/route.test.ts` (modified) — 5 tests, including the new invalid-override refusal and the valid/absent-override acceptance.

`pnpm --filter @beaconhs/web exec vitest run src/lib/server-action-key.test.ts src/app/api/health/ready/route.test.ts` → **13 passed, exit 0**.

## 5. Status

Status: **PASS** for the invalid-override fail-closed path. **PARTIAL** for cross-instance consistency, which the framework does not expose (see the negative-test report).
