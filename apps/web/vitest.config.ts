import { defineConfig } from 'vitest/config'

// Lets route-level tests import application modules through the `@/*`
// tsconfig paths, exactly as Next.js resolves them at runtime (Vite reads
// apps/web/tsconfig.json natively). Without this, any test importing a route
// that itself uses `@/` fails to resolve.
//
// `test.include` mirrors Vitest's default test patterns scoped to this
// package's two test locations. It must stay explicit: knip derives test
// entry points from the vitest config, and an include-less config makes it
// treat every test file as unused.
export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    include: ['src/**/*.{test,spec}.ts', 'src/**/*.{test,spec}.tsx', 'scripts/**/*.{test,spec}.ts'],
  },
})
