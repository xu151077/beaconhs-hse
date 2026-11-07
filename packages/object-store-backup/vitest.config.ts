import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The corpus includes a 300 MiB object that is streamed through the fake S3
    // server several times per test. 5 s is far below what that takes.
    testTimeout: 180_000,
    hookTimeout: 60_000,
  },
})
