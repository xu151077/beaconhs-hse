#!/usr/bin/env node
/**
 * Verify the build identity embedded in a *built image* (EA-56 Step B, CI form).
 *
 * The EA-53 verifier reads a directory. In CI the artefact is an image, and the
 * image in the registry is what will actually run — so the assertion must read
 * the image, not a local build tree.
 *
 * This wrapper contains no identity logic of its own: it extracts the one file
 * that carries the identity and delegates every identity decision to
 * `verify-build-identity.mjs`. What it does own is the verifier **contract** —
 * the exit status, the output shape and the verdict are checked together, so a
 * verifier that exits 0 while reporting a failure cannot promote an image
 * (EA58-F2).
 *
 * Usage
 *   node verify-image-identity.mjs --image <repo@sha256:...|tag> --expect <40-hex> \
 *        [--path /app/apps/web/.next/required-server-files.json] [--json]
 *
 * Exit codes
 *   0  verified: extraction succeeded, the verifier exited 0, its output was
 *      well-formed, its verdict was PASS, and no check reported a failure
 *   1  identity missing / malformed / mismatched, or the verifier's output did
 *      not satisfy the contract above
 *   2  usage error
 *   3  could not extract the artefact from the image (fail closed)
 *   4  neither docker nor the verifier is usable (fail closed)
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const DEFAULT_PATH = '/app/apps/web/.next/required-server-files.json'
const VERIFIER = new URL('./verify-build-identity.mjs', import.meta.url).pathname

/**
 * Decide the wrapper's outcome from the verifier's contract.
 *
 * The verifier's exit code is necessary but not sufficient: a build of the
 * verifier that exits 0 while reporting FAIL must not be able to promote an
 * image. Any of the following is a failure:
 *
 *   - a non-zero exit status, whatever the output says;
 *   - output that is not a single JSON object;
 *   - a missing, empty or non-string `verdict`;
 *   - a `verdict` other than the exact success token `PASS`;
 *   - a PASS with no check map, or a PASS with a check reported as `false`.
 *
 * Never a substring test: `verdict` must equal `PASS`, not contain it.
 *
 * @param {{ ok: boolean, out: string }} verify result of running the verifier
 * @returns {{ exitCode: number, verifierVerdict?: string, reason: string,
 *             checks?: Record<string, unknown>, embedded?: unknown }}
 */
export function interpretVerifierResult(verify) {
  const fail = (reason, parsed) => ({
    exitCode: 1,
    verifierVerdict: typeof parsed?.verdict === 'string' ? parsed.verdict : undefined,
    reason,
    checks: parsed?.checks,
    embedded: parsed?.embedded,
  })

  // 1. The process must have succeeded before its output can mean anything.
  if (!verify.ok) return fail('verifier exited non-zero: treating as failure')

  // 2. The output must be exactly one JSON object.
  let parsed
  try {
    parsed = JSON.parse(verify.out)
  } catch {
    return fail('verifier output was not parseable JSON: treating as failure')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return fail('verifier output was not a JSON object: treating as failure')
  }

  // 3. The verdict must be present and must be the exact success token.
  if (typeof parsed.verdict !== 'string' || parsed.verdict === '') {
    return fail('verifier output carried no verdict: treating as failure', parsed)
  }
  if (parsed.verdict !== 'PASS') {
    return fail(parsed.reason || `verifier verdict was ${parsed.verdict}`, parsed)
  }

  // 4. A PASS must be internally consistent: a check map, with nothing failed.
  if (
    parsed.checks === null ||
    typeof parsed.checks !== 'object' ||
    Array.isArray(parsed.checks)
  ) {
    return fail('verifier reported PASS without a check map: treating as failure', parsed)
  }
  const failed = Object.entries(parsed.checks)
    .filter(([, v]) => v === false)
    .map(([k]) => k)
  if (failed.length > 0) {
    return fail(`verifier reported PASS but these checks failed: ${failed.join(', ')}`, parsed)
  }

  return {
    exitCode: 0,
    verifierVerdict: parsed.verdict,
    reason: typeof parsed.reason === 'string' ? parsed.reason : '',
    checks: parsed.checks,
    embedded: parsed.embedded,
  }
}

function parseArgs(argv) {
  const out = { image: '', expect: '', path: DEFAULT_PATH, json: false }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--image') out.image = argv[++i] ?? ''
    else if (a === '--expect') out.expect = argv[++i] ?? ''
    else if (a === '--path') out.path = argv[++i] ?? DEFAULT_PATH
    else if (a === '--json') out.json = true
    else if (a === '--help' || a === '-h') {
      console.log(
        'usage: verify-image-identity.mjs --image <ref> --expect <40-hex> ' +
          '[--path <in-image path>] [--json]',
      )
      process.exit(0)
    } else {
      console.error(`verify-image-identity: unknown argument ${a}`)
      process.exit(2)
    }
  }
  if (!out.image || !out.expect) {
    console.error('verify-image-identity: --image and --expect are required')
    process.exit(2)
  }
  return out
}

function run(cmd, args) {
  try {
    return {
      ok: true,
      out: execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(),
      err: '',
    }
  } catch (e) {
    return {
      ok: false,
      out: (e.stdout ?? '').toString().trim(),
      err: (e.stderr ?? e.message ?? '').toString().trim(),
      code: typeof e.status === 'number' ? e.status : 4,
    }
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const result = {
    verifier: 'verify-image-identity/1.1.0',
    image: args.image,
    expect: args.expect,
    in_image_path: args.path,
    extraction: null,
    verdict: 'FAIL',
    reason: '',
  }

  const tmp = mkdtempSync(join(tmpdir(), 'ea56-img-'))
  let container = ''
  let exitCode = 1

  try {
    // 1. Materialise a container (no start) so the file can be copied out.
    const create = run('docker', ['create', '--entrypoint', '/bin/true', args.image])
    if (!create.ok) {
      result.extraction = 'failed'
      result.reason =
        `cannot create a container from '${args.image}': ${create.err || 'unknown error'} ` +
        '(the image must be present locally or pullable)'
      exitCode = 3
    } else {
      container = create.out
      const dest = join(tmp, 'required-server-files.json')
      const cp = run('docker', ['cp', `${container}:${args.path}`, dest])
      if (!cp.ok || !existsSync(dest)) {
        result.extraction = 'failed'
        result.reason =
          `cannot read '${args.path}' from the image: ${cp.err || 'file not present'} ` +
          '— an image without this artefact carries no build identity'
        exitCode = 1
      } else {
        result.extraction = 'ok'
        // 2. Delegate the identity decision to the single verifier, then check
        //    the verifier's contract rather than trusting its exit code alone.
        const verify = run('node', [VERIFIER, '--dist', tmp, '--expect', args.expect, '--json'])
        const decision = interpretVerifierResult(verify)
        result.checks = decision.checks
        result.embedded = decision.embedded
        result.reason = decision.reason
        if (decision.verifierVerdict !== undefined) {
          result.verifier_verdict = decision.verifierVerdict
        }
        exitCode = decision.exitCode
        result.verdict = exitCode === 0 ? 'PASS' : 'FAIL'
      }
    }
  } finally {
    if (container) run('docker', ['rm', '-f', container])
    try {
      rmSync(tmp, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }

  if (args.json) console.log(JSON.stringify(result, null, 2))
  else {
    console.log(`image: ${result.image}`)
    console.log(`expected: ${result.expect}`)
    console.log(`extraction: ${result.extraction ?? 'n/a'}`)
    if (result.embedded !== undefined) console.log(`embedded: ${result.embedded ?? '<absent>'}`)
    if (result.verifier_verdict !== undefined) console.log(`verifier: ${result.verifier_verdict}`)
    console.log(`VERIFY ${result.verdict} — ${result.reason}`)
  }

  process.exit(exitCode)
}

// Importable for tests: only run the CLI when executed directly.
const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  process.argv[1] !== '' &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url

if (invokedDirectly) main()
