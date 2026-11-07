import type { KnipConfig } from 'knip'

const config: KnipConfig = {
  $schema: 'https://unpkg.com/knip@5/schema.json',
  // `docs/evidence/<phase>/raw/**` holds byte-exact snapshots of files as they
  // were when a phase ran, so a snapshot of `knip.ts` or of an audit script is
  // an archive, not a shipped entry point. The live files those snapshots were
  // taken from are still scanned normally.
  //
  // This lives at the TOP level rather than in a workspace's own `ignore`
  // because the root workspace's ignore list is deliberately restricted to the
  // operator scratch directories: `deadcode-scope-contract.test.ts` asserts
  // that, so that a real source directory can never hide from the scan by
  // being added to a workspace ignore list.
  ignore: ['docs/evidence/*/raw/**'],
  workspaces: {
    '.': {
      entry: [
        'deploy/collabora-branding.js',
        '.opencode/mcp/playwright-mcp-guard.mjs',
        // Build/deploy helper invoked by scripts/build-drill-image.sh. Knip
        // cannot see a shell caller, so name it explicitly.
        'scripts/ci/pin-compose-app-image.mjs',
        // EA-66B.1: derives the deployment id from the source archive. Invoked
        // by scripts/build-local-image-with-key-gate.sh; knip cannot see a shell
        // caller.
        'scripts/ci/source-deployment-id.mjs',
        // EA-66D.3.0: derives the first-run setup catalogue keys from their
        // source strings and writes the four message catalogues. A maintenance
        // tool invoked by hand, not by another script.
        'scripts/ea66d3-0-setup-copy.mjs',
        // EA-66D.3.1: derives the storage-gateway catalogue keys the same way.
        'scripts/ea66d3-1-storage-i18n.mjs',
        // EA-66D.3.1: builds the source context archive that
        // scripts/build-local-image-with-key-gate.sh consumes. Invoked by hand
        // and by the release runbook; knip cannot see a shell caller.
        'scripts/ci/build-source-context-archive.mjs',
      ],
      // The Server Action key handling test invokes the application's TS CLI
      // through `pnpm exec tsx`; tsx is a dependency of apps/web, not the root.
      ignoreBinaries: ['tsx'],
      // Operator scratch directories are gitignored and live outside the repo
      // tree (their script content is not shipped code; recreate the ignore
      // here when scratch dirs exist on disk again).
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
        // employee records, user links and people_assignments rows that the
        // compliance audience and identity resolvers read. A data-repair tool, not
        // an entry point.
        'scripts/personnel-placement-repair.ts',
        'scripts/restore-equipment-preuse-links.ts',
        'scripts/restore-ppe-custody-from-legacy.ts',
        'scripts/restore-ppe-serial-numbers.ts',
        // Deployment-level invariant check: proves that every web instance holds
        // the same Server Action key without handling the key itself. A CLI
        // operator tool, not an app entry point.
        'scripts/verify-server-action-key-consistency.ts',
      ],
    },
    'apps/worker': {
      entry: ['src/health.ts', 'src/storage-init.ts', 'src/scripts/convert-documents-to-letter.ts'],
      // Bundled @beaconhs/forms-pdf keeps `qrcode` external; the worker image
      // must still resolve it at runtime.
      ignoreDependencies: ['qrcode'],
    },
    'apps/ops-bootstrap-admin': {
      // Uses @beaconhs/auth workspace package; entry is the CLI module itself.
      ignoreDependencies: ['@beaconhs/auth'],
    },
    'apps/ops-migrate': {
      // Uses @beaconhs/db workspace package; entry is the CLI module itself.
      ignoreDependencies: ['@beaconhs/db'],
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
    'packages/object-store-backup': {
      // `age` is an operator-supplied system binary, exactly as it is for
      // `scripts/cluster/backup.sh`. It is deliberately NOT an npm dependency:
      // the runbook requires the operator to install and key-custody it outside the
      // dependency tree, so knip is told it is expected rather than "missing".
      ignoreBinaries: ['age'],
    },
  },
}

export default config
