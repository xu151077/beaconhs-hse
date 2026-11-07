// Bundle the database migration CLI for production `node` execution.
//
// This is a separate deploy target on purpose. The migration lives in
// @beaconhs/db and is normally run through `tsx`, a devDependency that is NOT in
// the production image. Bundling it here produces a plain `node`-executable file.
//
// The migration logic is NOT reimplemented or copied: the entry point is the
// existing source module, which runs `main()` at module scope and sets
// `process.exitCode` on failure.
//
// Credential separation is unchanged from packages/db/src/migrate.ts: this
// process reads MIGRATION_DATABASE_URL (schema owner), DATABASE_URL (ordinary
// runtime role) and SUPERADMIN_DATABASE_URL (maintenance). Only this target is
// ever given the migration credential — apps/worker does not depend on
// @beaconhs/auth and does not carry these dependencies, so nothing here widens
// the ordinary worker runtime.
//
// Mirrors the bundling strategy in apps/worker/build.mjs.
import { build } from 'esbuild'

await build({
  entryPoints: ['../../packages/db/src/migrate.ts'],
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: true,
  logLevel: 'info',
  plugins: [
    {
      name: 'externalize-npm-keep-workspace',
      setup(b) {
        // Bare specifiers (not relative/absolute). Bundle our workspace packages
        // (TS source); externalize everything else (npm + node:*).
        b.onResolve({ filter: /^[^./]/ }, (args) => {
          // An entry point has no importer. Without this guard the filter also
          // matches the entry specifier itself and esbuild fails with
          // "The entry point ... cannot be marked as external".
          if (args.importer === '') return undefined
          if (args.path.startsWith('@beaconhs/')) return undefined // bundle it
          return { path: args.path, external: true }
        })
      },
    },
  ],
})