#!/usr/bin/env node
/**
 * EA-53 — independent build-identity verifier.
 *
 * Reads a built Next.js output directory and asserts that it carries a valid
 * embedded source revision. Deliberately implemented as a separate process so it
 * cannot rely on the builder's own state: it only reads files.
 *
 * Usage:
 *   node verify-build-identity.mjs --dist <dir> --expect <40-hex>
 *   node verify-build-identity.mjs --dist <dir>            (format check only)
 *
 * Exit codes:
 *   0  identity present, well-formed, and (when --expect is given) equal
 *   1  identity missing, malformed, or mismatched
 *   2  usage / IO error
 *
 * It never consults BUILD_ID or APP_VERSION: both are explicitly rejected as
 * identity sources (see --reject-build-id below).
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const SHA_RE = /^[0-9a-f]{40}$/

function parseArgs(argv) {
  const out = { dist: '', expect: '', json: false }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--dist') out.dist = argv[++i] ?? ''
    else if (a === '--expect') out.expect = argv[++i] ?? ''
    else if (a === '--json') out.json = true
    else if (a === '--help' || a === '-h') {
      console.log('usage: verify-build-identity.mjs --dist <dir> [--expect <40-hex>] [--json]')
      process.exit(0)
    } else {
      console.error(`unknown argument: ${a}`)
      process.exit(2)
    }
  }
  if (!out.dist) {
    console.error('--dist is required')
    process.exit(2)
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const result = {
  dist: args.dist,
  expected: args.expect || null,
  embedded: null,
  checks: {},
  verdict: 'FAIL',
  reason: '',
}

try {
  const serverFiles = join(args.dist, 'required-server-files.json')
  if (!existsSync(serverFiles)) {
    result.reason = 'required-server-files.json absent: no build output to verify'
    result.checks.build_output_present = false
  } else {
    result.checks.build_output_present = true
    const doc = JSON.parse(readFileSync(serverFiles, 'utf8'))
    const id = doc?.config?.deploymentId
    result.embedded = id === undefined ? null : id

    // 1. presence
    result.checks.identity_present = id !== undefined && id !== null && id !== ''
    // 2. format — a 40-hex git SHA, never a build id, never a version string
    result.checks.identity_well_formed = typeof id === 'string' && SHA_RE.test(id)
    // 3. not a BUILD_ID masquerading as identity
    result.checks.not_a_build_id =
      typeof id === 'string' ? !/^build-[A-Za-z0-9_-]+$/.test(id) : true
    // 4. optional equality with the expected revision
    if (args.expect) {
      result.checks.matches_expected = id === args.expect
    }

    const failed = Object.entries(result.checks)
      .filter(([, v]) => v === false)
      .map(([k]) => k)

    if (failed.length === 0) {
      result.verdict = 'PASS'
      result.reason = 'identity present, well-formed, and consistent'
    } else {
      result.reason = `failed checks: ${failed.join(', ')}`
    }
  }
} catch (err) {
  result.reason = `verifier error: ${err.message}`
  if (args.json) console.log(JSON.stringify(result, null, 2))
  else {
    console.error(`VERIFY FAIL — ${result.reason}`)
  }
  process.exit(2)
}

if (args.json) {
  console.log(JSON.stringify(result, null, 2))
} else {
  console.log(`dist:     ${result.dist}`)
  console.log(`embedded: ${result.embedded === null ? '<absent>' : result.embedded}`)
  if (args.expect) console.log(`expected: ${args.expect}`)
  for (const [k, v] of Object.entries(result.checks)) {
    console.log(`  ${v ? 'ok  ' : 'FAIL'} ${k}`)
  }
  console.log(`VERIFY ${result.verdict}${result.reason ? ` — ${result.reason}` : ''}`)
}

process.exit(result.verdict === 'PASS' ? 0 : 1)
