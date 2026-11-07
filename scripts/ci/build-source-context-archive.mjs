// EA-66D.3.1 — build the source context archive for the image build.
//
// The archive mirrors what a Docker build context would contain: the working
// tree with the `.dockerignore` rules applied. It is the INPUT to
// scripts/build-local-image-with-key-gate.sh, which computes the
// source-derived deployment id from it.
//
// It is deliberately NOT a `git archive`: the deployment is built from the
// WORKING TREE, and the working tree carries the user's uncommitted changes
// that the deployment must contain.
//
// The rules are read from `.dockerignore` so the archive and the build context
// cannot drift apart.
//
// Usage: node scripts/ci/build-source-context-archive.mjs <output.tar.zst>

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(new URL('../..', import.meta.url).pathname)
const OUTPUT = resolve(process.argv[2] ?? join(ROOT, 'docs/evidence/ea66d3-1/source-context.tar.zst'))

/** Parse `.dockerignore` into the patterns Docker would apply. */
function dockerignorePatterns() {
  return readFileSync(join(ROOT, '.dockerignore'), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
}

const patterns = dockerignorePatterns()

/** Build the exclusion list for tar from the dockerignore rules. */
function tarExcludes() {
  const excludes = []
  for (const pattern of patterns) {
    if (pattern.startsWith('!')) continue
    // `**/x` and `x` both mean "anywhere" for dockerignore purposes.
    const cleaned = pattern.replace(/^\*\*/, '').replace(/^\//, '')
    excludes.push(`--exclude=./${cleaned}`)
    excludes.push(`--exclude=./**/${cleaned}`)
  }
  // The environment files and the local secrets must never enter the context.
  excludes.push('--exclude=./.env')
  excludes.push('--exclude=./.env.*')
  excludes.push('--exclude=./.env.example')
  excludes.push('--exclude=./.env.orig')
  excludes.push('--exclude=./.env.prod-verify')
  excludes.push('--exclude=./.git')
  excludes.push('--exclude=./**/node_modules')
  excludes.push('--exclude=./**/.turbo')
  excludes.push('--exclude=./**/dist')
  excludes.push('--exclude=./**/.next')
  excludes.push('--exclude=./**/*.log')
  excludes.push('--exclude=./docs/evidence')
  excludes.push('--exclude=./docs/migration')
  excludes.push('--exclude=./.opencode')
  excludes.push('--exclude=./.playwright-mcp')
  excludes.push('--exclude=./.tmp-*')
  excludes.push('--exclude=./playwright-report')
  excludes.push('--exclude=./test-results')
  excludes.push('--exclude=./coverage')
  return excludes
}

mkdirSync(join(ROOT, 'docs/evidence/ea66d3-1'), { recursive: true })

const scratch = mkdtempSync(join(tmpdir(), 'beaconhs-context-'))
try {
  const listPath = join(scratch, 'list.txt')
  execFileSync(
    'tar',
    [
      '--zstd',
      '-cf',
      OUTPUT,
      ...tarExcludes(),
      '-C',
      ROOT,
      '.',
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  )
  execFileSync('tar', ['--zstd', '-tf', OUTPUT], { stdio: ['ignore', 'inherit', 'inherit'] })

  const listing = execFileSync('tar', ['--zstd', '-tf', OUTPUT], { encoding: 'utf8' })
  const entries = listing.split('\n').filter(Boolean)
  writeFileSync(join(ROOT, 'docs/evidence/ea66d3-1/source-context.list'), listing)

  const sha = createHash('sha256').update(readFileSync(OUTPUT)).digest('hex')
  const size = readFileSync(OUTPUT).byteLength

  console.log(`archive:  ${OUTPUT}`)
  console.log(`entries:  ${entries.length}`)
  console.log(`bytes:    ${size}`)
  console.log(`sha256:   ${sha}`)

  // The archive must not carry a secret, a VCS directory or a dependency tree.
  const forbidden = entries.filter(
    (entry) =>
      /(^|\/)\.env(\.|$)/.test(entry) ||
      /(^|\/)\.git(\/|$)/.test(entry) ||
      /(^|\/)node_modules(\/|$)/.test(entry),
  )
  if (forbidden.length > 0) {
    console.error(`FORBIDDEN ENTRIES: ${forbidden.slice(0, 10).join(', ')}`)
    process.exitCode = 1
  } else {
    console.log('forbidden entries: none')
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
