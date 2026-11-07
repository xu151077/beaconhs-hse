# Phase 6U-B3-CU — Server Action key security evaluation

Date: 2026-10-19  
Repository: `/home/test/projects/beaconhs-hse`  
Branch/HEAD: `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`  
Next.js version: `16.3.5`

## 1. Build-time observation

The production Dockerfile mounts `next_server_actions_key` as a BuildKit secret and sets `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` only for the build command. Phase CT confirmed that the key is not present as an image environment variable or in image history, but it is embedded by Next.js in `server-reference-manifest.json` / `.js` as `encryptionKey`.

## 2. Runtime override test

A production image built with a disposable build-time key was run with a different runtime `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`. The image manifest key and runtime key were confirmed to differ (different SHA-256 fingerprints). A real Server Action (magic-link sign-in) succeeded with the runtime key, proving that Next.js 16.3.5 resolves the runtime environment value before the build-time manifest value.

Conclusion: runtime injection can replace the build-time key for Server Action decryption.

## 3. Option comparison

### Option A — retain build-time key

- Treat the image as a sensitive artifact.
- Restrict registry pull permissions and audit pulls.
- Control image access and rotation.
- Simpler operationally, but every image contains key material.

### Option B — runtime injection

- Build with a disposable, non-production key.
- Inject the production key through the runtime environment.
- All replicas must share the same runtime key.
- Key rotation changes the decryption key; already-rendered action references may fail until clients refresh.
- Requires validation of restart and rolling-deployment behavior.

## 4. Assessment

Option B is technically viable on Next.js 16.3.5. The production key does not need to be present at build time. However, the literal criterion “no key material anywhere in the image” remains unmet because Next.js still generates and embeds a build-time key in the manifest. That embedded key is disposable when Option B is used, but it is still key material.

## 5. Recommendation

Use Option B for the production key, with a controlled runtime secret and identical key across all replicas. Retain Option A-style registry controls for the disposable build-time key unless the manifest key is removed by a future Next.js/build change. Do not modify production secrets, push candidate images, or deploy phase-aj as part of this evaluation.
