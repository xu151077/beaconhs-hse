#!/usr/bin/env node
/**
 * Trusted source-origin verification (EA-56 Step C).
 *
 * WHY THIS EXISTS
 *
 * A build can be told any 40-hex value and will happily stamp it into the image
 * (EA-53 T7). Worse, the build and the post-build assertion both compare the
 * artefact against the same caller-supplied value, so together they still cannot
 * detect a foreign revision (EA-55 T5a). Origin has to be established from a
 * SECOND, INDEPENDENT source before the build runs.
 *
 * CONTRACT
 *
 *   expected  = what the workflow believes the commit is
 *               ($GITHUB_SHA — set by the platform, not by the caller)
 *   actual    = what the checked-out working tree actually is
 *               (`git rev-parse HEAD` in the build context)
 *
 *   PASS only when they are equal AND the checkout is clean AND the trigger is
 *   one whose SHA semantics are known.
 *
 * Everything else fails closed. There is no "assume" branch.
 *
 * Exit codes
 *   0  origin verified
 *   1  origin rejected (mismatch, dirty tree, missing/unverifiable input)
 *   2  usage error
 *   3  environment cannot be inspected (git missing, not a repo) — fail closed
 *
 * Usage
 *   node verify-source-origin.mjs --expect <sha> [--event <name>] \
 *        [--ref <ref>] [--cwd <dir>] [--json]
 *   node verify-source-origin.mjs --json     (reads the environment)
 *
 * Environment fallbacks (only when the flag is absent):
 *   GITHUB_SHA, GITHUB_EVENT_NAME, GITHUB_REF
 */
import { execFileSync } from 'node:child_process'
import process from 'node:process'

const SHA_RE = /^[0-9a-f]{40}$/

/**
 * Trigger semantics. This is the part that must not be guessed:
 *
 *   push              → GITHUB_SHA is the commit that was pushed. Trustworthy.
 *   workflow_dispatch → GITHUB_SHA is the commit the ref pointed at when the run
 *                       was created. Trustworthy for a protected ref.
 *   pull_request      → GITHUB_SHA is the ephemeral MERGE commit, which does not
 *                       exist on any branch. It is NOT the PR head and NOT the
 *                       base. A release built from it cannot be traced, so it is
 *                       refused outright rather than silently accepted.
 *   anything else     → unknown semantics, refuse.
 */
const SUPPORTED_EVENTS = new Set(['push', 'workflow_dispatch'])
const EXPLICITLY_UNSUPPORTED = new Set(['pull_request', 'pull_request_target', 'merge_group'])

function parseArgs(argv) {
  // `undefined` means "flag absent" (env fallback applies); a flag present
  // with an empty value stays empty. Conflating the two let the GitHub
  // Actions runtime's own GITHUB_SHA/GITHUB_EVENT_NAME leak into a caller's
  // explicit `--expect ''`, which broke the origin check's CLI contract (and
  // its tests) inside CI while looking correct on a bare shell.
  const out = {
    expect: undefined,
    event: undefined,
    ref: undefined,
    cwd: process.cwd(),
    json: false,
    requireClean: true,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--expect') out.expect = argv[++i] ?? ''
    else if (a === '--event') out.event = argv[++i] ?? ''
    else if (a === '--ref') out.ref = argv[++i] ?? ''
    else if (a === '--cwd') out.cwd = argv[++i] ?? process.cwd()
    else if (a === '--allow-dirty') out.requireClean = false
    else if (a === '--json') out.json = true
    else if (a === '--help' || a === '-h') {
      console.log(
        'usage: verify-source-origin.mjs --expect <sha> [--event <name>] [--ref <ref>] ' +
          '[--cwd <dir>] [--allow-dirty] [--json]',
      )
      process.exit(0)
    } else {
      console.error(`verify-source-origin: unknown argument ${a}`)
      process.exit(2)
    }
  }
  return out
}

function git(args, cwd) {
  try {
    return {
      ok: true,
      out: execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim(),
    }
  } catch (err) {
    return { ok: false, out: '', err: (err.stderr ?? err.message ?? '').toString().trim() }
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2))

  // Env fallbacks apply only when the flag was truly absent (see parseArgs).
  // A caller passing `--expect ''` means "no revision, fail closed" — the
  // runtime's own GITHUB_SHA must never refill it.
  const expect = args.expect ?? process.env.GITHUB_SHA ?? ''
  const event = args.event ?? process.env.GITHUB_EVENT_NAME ?? ''
  const ref = args.ref ?? process.env.GITHUB_REF ?? ''

  const checks = []
  const add = (id, ok, reason, extra = {}) =>
    checks.push({ id, status: ok ? 'PASS' : 'FAIL', reason, ...extra })

  // --- 1. the expected value must exist and be well formed -------------------
  add(
    'expected.present',
    Boolean(expect),
    expect ? 'expected revision supplied' : 'no expected revision',
  )
  if (!SHA_RE.test(expect)) {
    add(
      'expected.format',
      false,
      `expected revision '${expect || '<empty>'}' is not 40 lowercase hex`,
    )
  } else {
    add('expected.format', true, 'expected revision is 40 lowercase hex')
  }

  // --- 2. the trigger must be one whose SHA semantics are known --------------
  if (!event) {
    add('event.present', false, 'no trigger event supplied: SHA semantics cannot be established')
  } else if (EXPLICITLY_UNSUPPORTED.has(event)) {
    add(
      'event.supported',
      false,
      `event '${event}' produces a synthetic merge commit; a release cannot be traced to it, ` +
        'so this build is refused rather than silently accepted',
    )
  } else if (!SUPPORTED_EVENTS.has(event)) {
    add('event.supported', false, `event '${event}' has no defined SHA semantics here`)
  } else {
    add('event.supported', true, `event '${event}' has a defined SHA semantics`)
  }

  // --- 3. the ref check is delegated to the workflow for deploy, but a release
  //        build without a ref is unauditable, so at least record it ----------
  if (ref) add('ref.recorded', true, `ref '${ref}'`)
  else add('ref.recorded', false, 'no ref supplied: the source context is unauditable')

  // --- 4. the actual checkout -----------------------------------------------
  const head = git(['rev-parse', 'HEAD'], args.cwd)
  if (!head.ok) {
    add('checkout.readable', false, `cannot read git HEAD in '${args.cwd}': ${head.err}`)
  } else {
    add('checkout.readable', true, `HEAD=${head.out}`, { observed: head.out })
    add(
      'checkout.matches_expected',
      head.out === expect,
      head.out === expect
        ? 'checked-out HEAD equals the expected revision'
        : `checked-out HEAD ${head.out} does not match the expected ${expect}`,
      { observed: head.out, expected: expect },
    )

    // shallow clones make history-dependent reasoning unsafe
    const shallow = git(['rev-parse', '--is-shallow-repository'], args.cwd)
    const isShallow = shallow.ok && shallow.out === 'true'
    add(
      'checkout.not_shallow',
      !isShallow,
      isShallow
        ? 'shallow clone: provenance reasoning over history is unsafe for a release build'
        : 'full clone',
    )

    // a dirty tree means the bytes under test are not the commit under test
    const status = git(['status', '--porcelain', '--untracked-files=no'], args.cwd)
    if (!status.ok) {
      add('checkout.status_readable', false, `cannot read working tree status: ${status.err}`)
    } else {
      const dirty = status.out !== ''
      const ok = args.requireClean ? !dirty : true
      add(
        'checkout.clean',
        ok,
        dirty
          ? args.requireClean
            ? `working tree has uncommitted tracked changes; the built bytes would not be ${expect}`
            : 'working tree is dirty but --allow-dirty permits it (identity NOT guaranteed)'
          : 'working tree clean',
      )
    }
  }

  const failed = checks.filter((c) => c.status === 'FAIL')
  const verdict = failed.length === 0 ? 'PASS' : 'FAIL'
  const result = {
    verifier: 'verify-source-origin/1.0.0',
    verdict,
    expected: expect || null,
    event: event || null,
    ref: ref || null,
    cwd: args.cwd,
    checks,
    reason:
      verdict === 'PASS'
        ? 'source revision independently verified against the checked-out tree'
        : `rejected: ${failed.map((c) => c.id).join(', ')}`,
  }

  if (args.json) console.log(JSON.stringify(result, null, 2))
  else {
    console.log(`source-origin: ${verdict}`)
    console.log(`reason: ${result.reason}`)
    for (const c of checks) console.log(`  [${c.status}] ${c.id} — ${c.reason}`)
  }

  process.exit(verdict === 'PASS' ? 0 : 1)
}

main()
