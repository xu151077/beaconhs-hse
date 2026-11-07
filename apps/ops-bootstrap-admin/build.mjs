// Bundle the admin bootstrap CLI for production `node` execution.
//
// This is a separate deploy target on purpose. The CLI lives in @beaconhs/auth
// and is normally run through `tsx`, a devDependency that is NOT in the
// production image. Bundling it here produces a plain `node`-executable file.
//
// The CLI itself is NOT reimplemented or copied: the entry point is the existing
// source module, which runs `main()` at module scope and sets `process.exitCode`
// on failure. Dry-run-by-default, --apply, --password-stdin and the idempotency
// guarantees all come from that module unchanged.
//
// Runtime dependencies are supplied by THIS package's own `node_modules`, which
// `pnpm deploy --prod` materialises from the `@beaconhs/auth` closure. Keeping it
// out of apps/worker is what stops better-auth/bcryptjs/pg from leaking into the
// ordinary worker runtime.
//
// Mirrors the bundling strategy in apps/worker/build.mjs.
import { build } from 'esbuild'

await build({
  entryPoints: ['../../packages/auth/src/bootstrap-admin.cli.ts'],
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