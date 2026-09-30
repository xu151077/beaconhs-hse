import type { KnipConfig } from 'knip'

const config: KnipConfig = {
  $schema: 'https://unpkg.com/knip@5/schema.json',
  workspaces: {
    '.': {
      entry: ['deploy/collabora-branding.js'],
    },
    'apps/web': {
      entry: [
        'public/sw.js',
        'scripts/backfill-credential-outputs.ts',
        'scripts/cleanup-rassaun-credential-designs.ts',
        'scripts/backfill-private-attachment-urls.ts',
        'scripts/backfill-signatures-to-storage.ts',
        'scripts/backfill-tenant-storage-keys.ts',
        'scripts/generate-brand-icons.mjs',
        'scripts/materialize-compliance.ts',
        'scripts/normalize-ppe-inspection-notes.ts',
        // Phase A: proves people_assignments semantics against the live database, then
        // rolls the transaction back. A verification tool, not an app entry point.
        'scripts/phase-a-assignment-verification.mjs',
        // Personnel placement convergence. Idempotent and additive: inserts the
        // employee records, user links and people_assignments rows that 15B-2's
        // fail-closed Project Scope depends on. A data-repair tool, not an entry point.
        'scripts/personnel-placement-repair.ts',
        'scripts/project-scope-verification.ts',
        // Resolves the REAL foreman contexts against the repaired database, rolling
        // back the synthetic validity windows. Read-only. A verification tool.
        'scripts/project-scope-live-verification.ts',
        'scripts/restore-equipment-preuse-links.ts',
        'scripts/restore-ppe-custody-from-legacy.ts',
        'scripts/restore-ppe-serial-numbers.ts',
      ],
    },
    'apps/worker': {
      entry: ['src/health.ts', 'src/storage-init.ts', 'src/scripts/convert-documents-to-letter.ts'],
      // Bundled @beaconhs/forms-pdf keeps `qrcode` external; the worker image
      // must still resolve it at runtime.
      ignoreDependencies: ['qrcode'],
    },
    'packages/db': {
      entry: [
        'src/scripts/reseed-lift-plan.ts',
        'src/scripts/import-legacy-passwords.ts',
        'src/scripts/backfill-document-book-pins.ts',
      ],
    },
    'packages/sync': {
      ignoreDependencies: ['mssql'],
    },
  },
}

export default config
