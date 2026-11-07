/**
 * The exact user-facing copy for a frozen workspace — the ONLY home for these
 * strings, and deliberately dependency-free so it is safe in a browser bundle.
 *
 * Why this is separate from `storage-freeze-refusal.ts`: that module imports the
 * `@beaconhs/storage` root to recognise the refusal, and the root's module body
 * validates the server-only S3 endpoint configuration (`R2_INTERNAL_ENDPOINT`)
 * at import time, throwing when it is absent. In a client bundle every
 * `process.env.X` that is not `NEXT_PUBLIC_*` is `undefined`, so the validation
 * always fired and took the whole page down with the React error boundary. The
 * copy has no server dependency, so keeping it here lets `collabora-embed.tsx`
 * render the frozen panel in the browser while the predicate stays server-side.
 *
 * Shared source strings rather than per-component literals so one sentence
 * reaches every surface and resolves through the same translated catalogue
 * entry.
 */
export const STORAGE_FROZEN_TITLE = 'This workspace is frozen'

export const STORAGE_FROZEN_DETAIL =
  'A platform administrator is working on file storage. Adding or changing files is paused until it finishes.'

export const STORAGE_FROZEN_ACTION =
  'This workspace is frozen, so files cannot be added or changed until a platform administrator finishes work on file storage.'
