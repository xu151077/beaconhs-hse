#!/usr/bin/env node
/**
 * EA-58 — deployment control hardening tests.
 *
 * Covers the four authorized fixes:
 *   1. Gate 5 is binding on every deployment path, including the Dokploy
 *      compose path that cannot expose running services;
 *   2. a failed `docker service ls` query is reported as a query failure, not as
 *      an empty fleet (EA58-F4);
 *   3. the image-identity wrapper checks the verifier's contract — exit status,
 *      output shape and verdict — instead of the exit status alone (EA58-F2);
 *   4. the source-origin step no longer receives an unused token (EA58-F1).
 *
 * Every test is offline. Swarm behaviour comes from a `docker` stub on PATH;
 * the Gate 5 tests execute the `run:` block extracted from the shipped workflow,
 * so what is exercised is the code that will run in CI, not a paraphrase of it.
 *
 * Run: node --test scripts/ci/deploy-control-hardening.test.mjs
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { interpretVerifierResult } from './verify-image-identity.mjs'

const CI_DIR = fileURLToPath(new URL('.', import.meta.url))
const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const WORKFLOW = join(ROOT, '.github/workflows/deploy-dev.yml')
const RECONCILE = join(CI_DIR, 'reconcile-running-digest.sh')

const EXPECTED_DIGEST = `sha256:${'3'.repeat(64)}`
const OTHER_DIGEST = `sha256:${'7'.repeat(64)}`

const scratchDirs = []
function scratch(prefix) {
  const dir = mkdtempSync(join(tmpdir(), `ea58-${prefix}-`))
  scratchDirs.push(dir)
  return dir
}
process.on('exit', () => {
  for (const dir of scratchDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
})

// ---------------------------------------------------------------------------
// Workflow extraction — test the shipped block, not a copy of it
// ---------------------------------------------------------------------------

const STEP_INDENT = 6
const BODY_INDENT = 10

/**
 * Extract the `run:` script of a named step from deploy-dev.yml.
 * Throws when the step or its block scalar cannot be found, so a rename cannot
 * silently turn these tests into no-ops.
 */
function stepScript(stepName) {
  const lines = readFileSync(WORKFLOW, 'utf8').split('\n')
  const start = lines.findIndex((line) => line.trim() === `- name: ${stepName}`)
  assert.notEqual(start, -1, `step "${stepName}" must exist in deploy-dev.yml`)

  let runIndex = -1
  for (let i = start + 1; i < lines.length; i += 1) {
    if (new RegExp(`^ {${STEP_INDENT}}- `).test(lines[i])) break
    if (lines[i].trim() === 'run: |') {
      runIndex = i
      break
    }
  }
  assert.notEqual(runIndex, -1, `step "${stepName}" must have a block-scalar run`)

  const body = []
  for (let i = runIndex + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.trim() === '') {
      body.push('')
      continue
    }
    if (lines[i].length - lines[i].trimStart().length < BODY_INDENT) break
    body.push(line.slice(BODY_INDENT))
  }
  return body.join('\n').trimEnd()
}

/** The full YAML text of a named step, from its `- name:` to the next step. */
function stepText(stepName) {
  const lines = readFileSync(WORKFLOW, 'utf8').split('\n')
  const start = lines.findIndex((line) => line.trim() === `- name: ${stepName}`)
  assert.notEqual(start, -1, `step "${stepName}" must exist in deploy-dev.yml`)
  const out = [lines[start]]
  for (let i = start + 1; i < lines.length; i += 1) {
    if (new RegExp(`^ {${STEP_INDENT}}- `).test(lines[i])) break
    if (new RegExp(`^ {0,${STEP_INDENT - 2}}\\S`).test(lines[i])) break
    out.push(lines[i])
  }
  return out.join('\n')
}

function deployJobSteps() {
  const text = readFileSync(WORKFLOW, 'utf8')
  const deployJob = text.slice(text.indexOf('\n  deploy:'))
  return [...deployJob.matchAll(/^ {6}- name: (.+)$/gm)].map((m) => m[1].trim())
}

// ---------------------------------------------------------------------------
// Swarm stub
// ---------------------------------------------------------------------------

/**
 * Install a `docker` stub on PATH.
 *
 *   STUB_SERVICES         newline-separated names returned by `service ls`
 *   STUB_IMAGE            value returned by `service inspect` (or a map file)
 *   STUB_LS_FAIL          "1" → `service ls` exits 1 after writing a diagnostic
 *   STUB_INSPECT_FAIL     "1" → `service inspect` exits 1
 *   STUB_PS_FAIL          "1" → `service ps` exits 1
 *   STUB_REPLICAS_<SVC>   replica count returned for a Replicated-spec query
 *                         (<SVC> upper-cased, `-` → `_`)
 *   STUB_UPDATE_<SVC>     UpdateStatus.State returned for an UpdateStatus query
 *   STUB_PS_<SVC>         `service ps` rows, "<current>|<desired>|<image>" per line
 */
function dockerEnv(env) {
  const bin = scratch('bin')
  const stub = join(bin, 'docker')
  writeFileSync(
    stub,
    [
      '#!/usr/bin/env bash',
      'if [ "$1" = "service" ] && [ "$2" = "ls" ]; then',
      '  if [ "${STUB_LS_FAIL:-0}" = "1" ]; then',
      '    echo "docker: Error response from daemon: connection refused" >&2',
      '    exit 1',
      '  fi',
      '  printf "%b\\n" "${STUB_SERVICES:-}"',
      '  exit 0',
      'fi',
      'if [ "$1" = "service" ] && [ "$2" = "inspect" ]; then',
      '  if [ "${STUB_INSPECT_FAIL:-0}" = "1" ]; then',
      '    echo "docker: Error response from daemon: no such service" >&2',
      '    exit 1',
      '  fi',
      '  shift 2',
      '  service=""; fmt=""; pending=0',
      '  for arg in "$@"; do',
      '    case "$arg" in',
      '      --format) pending=1 ;;',
      '      --format=*) fmt="${arg#--format=}" ;;',
      '      --*) ;;',
      '      *) if [ "$pending" = "1" ]; then fmt="$arg"; pending=0; elif [ -z "$service" ]; then service="$arg"; fi ;;',
      '    esac',
      '  done',
      '  if [ -n "$fmt" ]; then',
      '    case "$fmt" in',
      '      *Replicated*)',
      "        key=\"STUB_REPLICAS_$(printf '%s' \"$service\" | tr '[:lower:]-' '[:upper:]_')\"",
      '        printf "%s\\n" "${!key:-}"',
      '        exit 0',
      '        ;;',
      '      *UpdateStatus*)',
      "        key=\"STUB_UPDATE_$(printf '%s' \"$service\" | tr '[:lower:]-' '[:upper:]_')\"",
      '        printf "%s\\n" "${!key:-}"',
      '        exit 0',
      '        ;;',
      '    esac',
      '  fi',
      '  if [ -n "${STUB_IMAGE_FILE:-}" ]; then',
      '    grep -F "$service=" "$STUB_IMAGE_FILE" | head -1 | cut -d= -f2-',
      '    exit 0',
      '  fi',
      '  printf "%s\\n" "${STUB_IMAGE:-}"',
      '  exit 0',
      'fi',
      'if [ "$1" = "service" ] && [ "$2" = "ps" ]; then',
      '  if [ "${STUB_PS_FAIL:-0}" = "1" ]; then',
      '    echo "docker: Error response from daemon: ps refused" >&2',
      '    exit 1',
      '  fi',
      '  shift 2',
      '  service=""',
      '  for arg in "$@"; do case "$arg" in --*) ;; *) service="$arg"; break ;; esac; done',
      "  key=\"STUB_PS_$(printf '%s' \"$service\" | tr '[:lower:]-' '[:upper:]_')\"",
      '  printf "%s\\n" "${!key:-}"',
      '  exit 0',
      'fi',
      'if [ "$1" = "rm" ]; then exit 0; fi',
      'exit 1',
      '',
    ].join('\n'),
  )
  chmodSync(stub, 0o755)
  const merged = { ...process.env, ...env, PATH: `${bin}:${process.env.PATH}` }
  delete merged.STUB_IMAGE_FILE
  if (env.STUB_IMAGE_FILE) merged.STUB_IMAGE_FILE = env.STUB_IMAGE_FILE
  return merged
}

/**
 * Write the roster the workflow itself generates for `beaconhs-dev` at
 * WRITER_REPLICAS=1, so tests exercise the same input shape CI will.
 * `overrides` maps "role.key" → value for per-case variation.
 */
function writeRoster(roleOverrides = {}) {
  const file = join(scratch('roster'), 'gate5.roster')
  const roles = [
    ['web', 1, 'true'],
    ['worker', 1, 'true'],
    ['scheduler', 1, 'false'],
    ['storage-init', 1, 'false'],
  ]
  const lines = [
    'stack=beaconhs-dev',
    'source=deploy/dokploy-dev.compose.yaml + deploy env (WRITER_REPLICAS=1)',
    `digest=${EXPECTED_DIGEST}`,
  ]
  for (const [role, replicas, running] of roles) {
    lines.push(
      `${role}.replicas=${roleOverrides[`${role}.replicas`] ?? replicas}`,
      `${role}.running=${roleOverrides[`${role}.running`] ?? running}`,
    )
  }
  writeFileSync(file, lines.join('\n') + '\n')
  return file
}

/** Environment for a converged four-service fleet (plus non-gated services). */
function convergedFleetEnv(overrides = {}) {
  const image = overrides.image ?? `ghcr.io/braedonsaunders/beaconhs@${EXPECTED_DIGEST}`
  // The stub uses an image map, because minio and collabora never run the
  // gated image in a real deployment — they are pinned upstream images.
  const imageFile = join(scratch('images'), 'fleet.txt')
  writeFileSync(
    imageFile,
    [
      `beaconhs-dev_web=${image}`,
      `beaconhs-dev_worker=${image}`,
      `beaconhs-dev_scheduler=${image}`,
      `beaconhs-dev_storage-init=${image}`,
      'beaconhs-dev_minio=minio/minio@sha256:b187417eee0a495ed45ff0e2d5f0c9810ae35705319c0d2fb46dd93e4ac1501c',
      'beaconhs-dev_collabora=collabora/code:26.04.2.1.1@sha256:df33af88c59e26b7335ea98d91e65f1edf13f33369ce6115941b8d59d3409cb5',
      '',
    ].join('\n'),
  )
  return {
    STUB_SERVICES: [
      'beaconhs-dev_web',
      'beaconhs-dev_worker',
      'beaconhs-dev_scheduler',
      'beaconhs-dev_storage-init',
      'beaconhs-dev_minio',
      'beaconhs-dev_collabora',
      '',
    ].join('\n'),
    STUB_IMAGE_FILE: imageFile,
    STUB_REPLICAS_BEACONHS_DEV_WEB: '1',
    STUB_REPLICAS_BEACONHS_DEV_WORKER: '1',
    STUB_PS_BEACONHS_DEV_WEB: `Running|Running|${image}`,
    STUB_PS_BEACONHS_DEV_WORKER: `Running|Running|${image}`,
    STUB_PS_BEACONHS_DEV_SCHEDULER: `Complete (exit 0)|Shutdown|${image}`,
    STUB_PS_BEACONHS_DEV_STORAGE_INIT: `Complete (exit 0)|Shutdown|${image}`,
    ...overrides.env,
  }
}

function runReconcile(env, stack = 'beaconhs-dev', digest = EXPECTED_DIGEST, roster) {
  return spawnSync('bash', [RECONCILE, stack, digest, roster ?? writeRoster()], {
    encoding: 'utf8',
    cwd: ROOT,
    env: dockerEnv(env),
  })
}

/** Execute the shipped Gate 5 workflow block under a given deployment mode. */
function runGate5(env, mode = 'api') {
  const script = stepScript('Reconcile the running image digest')
  return spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    cwd: ROOT,
    env: dockerEnv({
      DOKPLOY_DEPLOY_MODE: mode,
      DOKPLOY_TARGET_STACK: 'beaconhs-dev',
      IMAGE_DIGEST: EXPECTED_DIGEST,
      // The step's own env block sets this in the workflow; the harness applies
      // it here because the extracted `run:` body is executed without YAML env.
      WRITER_REPLICAS: '1',
      ...env,
    }),
  })
}

// ---------------------------------------------------------------------------
// Fix 1 — Gate 5 is binding on every deployment path
// ---------------------------------------------------------------------------

test('EA58-T1 the Gate 5 step is not gated on the deployment mode', () => {
  const text = stepText('Reconcile the running image digest')
  assert.doesNotMatch(
    text,
    /DOKPLOY_DEPLOY_MODE\s*!=\s*'direct'/,
    'the step must not special-case one deployment path',
  )
  assert.doesNotMatch(text, /DOKPLOY_DEPLOY_MODE\s*==\s*'direct'/)
  assert.match(text, /reconcile-running-digest\.sh/, 'the step must call the reconciler')
})

test('EA58-T2 the unverified path cannot exit zero', () => {
  const script = stepScript('Reconcile the running image digest')
  assert.doesNotMatch(script, /exit\s+0/, 'no branch of Gate 5 may report success by fiat')
  assert.match(script, /exit\s+1/, 'a failed reconciliation must fail the step')
  // EA-60: the step must build the completeness roster and hand it to the
  // reconciler; a gate without a roster cannot detect a missing service.
  assert.match(script, /roster=/, 'the step must generate the roster file')
  assert.match(
    script,
    /reconcile-running-digest\.sh.*\$roster/,
    'the roster must be passed to the reconciler',
  )
})

test('EA58-T3 Gate 5 is the final deploy step, so nothing downstream can claim success', () => {
  const steps = deployJobSteps()
  assert.equal(
    steps.at(-1),
    'Reconcile the running image digest',
    'a step after Gate 5 could declare success on an unverified deployment',
  )
})

test('EA58-T4 Gate 5 is not marked non-blocking', () => {
  assert.doesNotMatch(stepText('Reconcile the running image digest'), /continue-on-error/)
})

// ---------------------------------------------------------------------------
// Fix 1 — the six required compose-path behaviours, end to end
// ---------------------------------------------------------------------------

test('EA58-T5 compose path that exposes no running service FAILS', () => {
  const res = runGate5({ STUB_SERVICES: '' })
  assert.equal(res.status, 1, `expected failure, got ${res.status}: ${res.stdout}${res.stderr}`)
  assert.match(res.stderr, /Gate 5 could not prove/)
  assert.match(res.stderr, /not a verified release/)
})

test('EA58-T6 compose path that exposes a matching digest PASSES', () => {
  const res = runGate5(convergedFleetEnv())
  assert.equal(res.status, 0, `${res.stdout}${res.stderr}`)
  assert.match(res.stdout, /Gate 5 PASS/)
})

test('EA58-T7 compose path that exposes a different digest FAILS', () => {
  const res = runGate5(
    convergedFleetEnv({
      image: `ghcr.io/braedonsaunders/beaconhs@${OTHER_DIGEST}`,
    }),
  )
  assert.equal(res.status, 1)
  assert.match(
    res.stderr,
    /do not hold against the roster|runs ghcr\.io\/braedonsaunders\/beaconhs@/,
  )
})

test('EA58-T8 a query failure FAILS and is not reported as an empty fleet', () => {
  const res = runGate5(convergedFleetEnv({ env: { STUB_LS_FAIL: '1' } }))
  assert.equal(res.status, 1)
  assert.match(res.stderr, /could not list services/)
  assert.match(res.stderr, /query failed/)
  assert.doesNotMatch(
    res.stderr,
    /matched no running BeaconHS service/,
    'a query failure must not be described as an empty fleet',
  )
})

test('EA58-T9 readiness success cannot rescue an unverifiable digest', () => {
  const res = runGate5({ STUB_SERVICES: '', READINESS_OK: '1', APP_VERSION: 'a'.repeat(40) })
  assert.equal(res.status, 1, 'a readiness 200 is not evidence of image identity')
})

test('EA58-T10 Gate 5 failure means the run is not a verified release', () => {
  // The step is last (T3) and exits non-zero (T5/T7/T8), so the job conclusion
  // is failure. Assert both halves of that chain together.
  const steps = deployJobSteps()
  assert.equal(steps.at(-1), 'Reconcile the running image digest')
  const res = runGate5({ STUB_SERVICES: '' })
  assert.notEqual(res.status, 0)
})

// ---------------------------------------------------------------------------
// Fix 2 (EA58-F4) — query failure vs empty result
// ---------------------------------------------------------------------------

test('EA58-T11 reconcile: a matching fleet passes (control)', () => {
  const res = runReconcile(convergedFleetEnv())
  assert.equal(res.status, 0, res.stderr)
  assert.match(res.stdout, /all 4 rostered service\(s\) match the roster and run/)
})

test('EA58-T12 reconcile: empty output is an empty fleet, reported as such', () => {
  const res = runReconcile({ STUB_SERVICES: '' })
  assert.equal(res.status, 1)
  assert.match(res.stderr, /the instance set is not proven complete|matched no running/)
  assert.doesNotMatch(res.stderr, /could not list services/)
})

test('EA58-T13 reconcile: a failed query is reported as a query failure', () => {
  const res = runReconcile({ STUB_LS_FAIL: '1' })
  assert.equal(res.status, 1)
  assert.match(res.stderr, /could not list services/)
  assert.match(res.stderr, /query failed/)
  assert.match(res.stderr, /connection refused/, 'the docker diagnostic must survive')
  assert.doesNotMatch(res.stderr, /instance set is not proven complete/)
})

test('EA58-T14 reconcile: services present but none is a BeaconHS service', () => {
  const res = runReconcile({ STUB_SERVICES: 'beaconhs-dev_db\nbeaconhs-dev_cache\n' })
  assert.equal(res.status, 1)
  assert.match(res.stderr, /not in stack 'beaconhs-dev'/)
  assert.match(res.stderr, /instance set is not proven complete/)
})

test('EA58-T15 reconcile: a partial match fails', () => {
  const res = runReconcile(
    convergedFleetEnv({
      image: `ghcr.io/braedonsaunders/beaconhs@${OTHER_DIGEST}`,
    }),
  )
  assert.equal(res.status, 1, res.stdout)
  assert.match(res.stderr, /check\(s\) do not hold against the roster/)
})

test('EA58-T16 reconcile: an uninspectable service fails', () => {
  const res = runReconcile(convergedFleetEnv({ env: { STUB_INSPECT_FAIL: '1' } }))
  assert.equal(res.status, 1)
  // With a total inspect failure both rostered and unrostered services are
  // unverifiable; the gate must name inspect failures and never pass.
  assert.match(res.stderr, /cannot inspect/)
  assert.doesNotMatch(res.stdout, /Gate 5 PASS/)
})

test('EA58-T17 reconcile: readiness is not an input, so it cannot change the verdict', () => {
  const res = runReconcile(
    convergedFleetEnv({
      image: `ghcr.io/braedonsaunders/beaconhs@${OTHER_DIGEST}`,
      env: { READINESS_OK: '1' },
    }),
  )
  assert.equal(res.status, 1)
})

test('EA58-T18 reconcile: a tag, not a digest, does not satisfy the gate', () => {
  const res = runReconcile(
    convergedFleetEnv({
      image: 'ghcr.io/braedonsaunders/beaconhs:latest',
      env: {},
    }),
  )
  assert.equal(res.status, 1)
  // A tag carries no digest, so the comparator can never equal the expected one.
  assert.match(res.stderr, /runs ghcr\.io\/braedonsaunders\/beaconhs:latest/)
})

test('EA58-T19 reconcile: a non-canonical expected digest is refused as a usage error', () => {
  const res = runReconcile({ STUB_SERVICES: 'beaconhs-dev_web\n' }, 'beaconhs-dev', 'not-a-digest')
  assert.equal(res.status, 2)
})

// ---------------------------------------------------------------------------
// Fix 3 (EA58-F2) — the verifier contract
// ---------------------------------------------------------------------------

const PASS_OUTPUT = JSON.stringify({
  verdict: 'PASS',
  reason: 'identity present, well-formed, and consistent',
  checks: { build_output_present: true, identity_present: true, matches_expected: true },
  embedded: '5'.repeat(40),
})

test('EA58-T20 contract: exit 0 + PASS + clean checks is accepted (control)', () => {
  const decision = interpretVerifierResult({ ok: true, out: PASS_OUTPUT })
  assert.equal(decision.exitCode, 0)
  assert.equal(decision.verifierVerdict, 'PASS')
})

test('EA58-T21 contract: exit 0 + verdict FAIL is rejected', () => {
  const decision = interpretVerifierResult({
    ok: true,
    out: JSON.stringify({
      verdict: 'FAIL',
      reason: 'mismatch',
      checks: { matches_expected: false },
    }),
  })
  assert.equal(decision.exitCode, 1)
  assert.equal(decision.verifierVerdict, 'FAIL')
})

test('EA58-T22 contract: exit 0 + verdict PARTIAL is rejected', () => {
  const decision = interpretVerifierResult({
    ok: true,
    out: JSON.stringify({ verdict: 'PARTIAL', checks: {} }),
  })
  assert.equal(decision.exitCode, 1)
})

test('EA58-T23 contract: exit 0 + missing verdict is rejected', () => {
  const decision = interpretVerifierResult({
    ok: true,
    out: JSON.stringify({ reason: 'no verdict here', checks: { a: true } }),
  })
  assert.equal(decision.exitCode, 1)
  assert.match(decision.reason, /no verdict/)
})

test('EA58-T24 contract: exit 0 + empty-string verdict is rejected', () => {
  const decision = interpretVerifierResult({
    ok: true,
    out: JSON.stringify({ verdict: '', checks: {} }),
  })
  assert.equal(decision.exitCode, 1)
})

test('EA58-T25 contract: invalid JSON is rejected', () => {
  const decision = interpretVerifierResult({ ok: true, out: 'VERIFY PASS — not json' })
  assert.equal(decision.exitCode, 1)
  assert.match(decision.reason, /not parseable JSON/)
})

test('EA58-T26 contract: a non-object JSON document is rejected', () => {
  const array = interpretVerifierResult({ ok: true, out: '[]' })
  assert.equal(array.exitCode, 1)
  const scalar = interpretVerifierResult({ ok: true, out: '"PASS"' })
  assert.equal(scalar.exitCode, 1)
})

test('EA58-T27 contract: exit non-zero + verdict PASS is still rejected', () => {
  const decision = interpretVerifierResult({ ok: false, out: PASS_OUTPUT })
  assert.equal(decision.exitCode, 1)
  assert.match(decision.reason, /non-zero/)
})

test('EA58-T28 contract: PASS with a failed check is rejected', () => {
  const decision = interpretVerifierResult({
    ok: true,
    out: JSON.stringify({
      verdict: 'PASS',
      checks: { identity_present: true, matches_expected: false },
    }),
  })
  assert.equal(decision.exitCode, 1)
  assert.match(decision.reason, /matches_expected/)
})

test('EA58-T29 contract: PASS without a check map is rejected', () => {
  for (const checks of [undefined, null, 'ok', []]) {
    const decision = interpretVerifierResult({
      ok: true,
      out: JSON.stringify({ verdict: 'PASS', checks }),
    })
    assert.equal(decision.exitCode, 1, `checks=${JSON.stringify(checks)} must be rejected`)
  }
})

test('EA58-T30 contract: the verdict is compared, not substring-matched', () => {
  for (const verdict of ['NOT PASS', 'PASSING', 'pass', ' PASS', 'PASS ']) {
    const decision = interpretVerifierResult({
      ok: true,
      out: JSON.stringify({ verdict, checks: {} }),
    })
    assert.equal(decision.exitCode, 1, `verdict ${JSON.stringify(verdict)} must be rejected`)
  }
})

test('EA58-T31 the module runs as a CLI when executed directly, and is inert when imported', () => {
  // Importing must not execute the CLI (T20-T30 rely on it); executing must.
  const res = spawnSync('node', [join(CI_DIR, 'verify-image-identity.mjs'), '--help'], {
    encoding: 'utf8',
  })
  assert.equal(res.status, 0, res.stderr)
  assert.match(res.stdout, /usage: verify-image-identity\.mjs/)
})

// ---------------------------------------------------------------------------
// Fix 4 (EA58-F1) — no unused token on the source-origin step
// ---------------------------------------------------------------------------

test('EA58-T32 the source-origin step passes no credential', () => {
  const text = stepText('Verify the source revision matches the checkout')
  assert.doesNotMatch(text, /GITHUB_TOKEN/)
  assert.doesNotMatch(text, /\$\{\{\s*secrets\./)
})

test('EA58-T33 the source-origin step still invokes the verifier with its contract', () => {
  const text = stepText('Verify the source revision matches the checkout')
  assert.match(text, /verify-source-origin\.mjs/)
  assert.match(text, /--expect/)
  assert.match(text, /--event/)
  assert.match(text, /--ref/)
})

test('EA58-T34 steps that genuinely need the token still have it', () => {
  // Removing F-1's token must not strip a token another step actually uses.
  const stale = stepText('Reject stale main-branch workflow runs')
  assert.match(stale, /GITHUB_TOKEN/, 'require-current-main.sh reads the GitHub API')
  const gate = stepText('Gate the candidate image before deployment')
  assert.match(gate, /GHCR_TOKEN/)
})

test('EA58-T35 the control order is unchanged by the fixes', () => {
  const text = readFileSync(WORKFLOW, 'utf8')
  const indexOf = (needle) => {
    const at = text.indexOf(needle)
    assert.notEqual(at, -1, `missing: ${needle}`)
    return at
  }
  const origin = indexOf('- name: Verify the source revision matches the checkout')
  const build = indexOf('docker/build-push-action@')
  const assertStep = indexOf('- name: Assert the built image carries the verified revision')
  const promote = indexOf('- name: Promote the verified digest to its release tag')
  const gate = indexOf('- name: Gate the candidate image before deployment')
  const migrations = indexOf('- name: Run database migrations')
  const reconcile = indexOf('- name: Reconcile the running image digest')
  assert.ok(origin < build, 'origin check must precede the build')
  assert.ok(build < assertStep, 'the build must precede the assertion')
  assert.ok(assertStep < promote, 'the assertion must precede publication')
  assert.ok(promote < gate, 'publication must precede the pre-deploy gate')
  assert.ok(gate < migrations, 'the gate must precede migrations')
  assert.ok(migrations < reconcile, 'migrations must precede Gate 5')
})

test('EA58-T36 this suite is executed by CI', () => {
  // A test nobody runs is not a control. Pin the wiring so it cannot be dropped.
  const ci = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8')
  assert.match(ci, /node --test scripts\/ci\/deploy-control-hardening\.test\.mjs/)
})

// ---------------------------------------------------------------------------
// EA-60 — roster completeness (F-59-1)
// ---------------------------------------------------------------------------

test('EA60-T1 a rostered service missing from the listing fails closed (EA59 S12)', () => {
  // The exact EA-59 S12 scenario: the listing returns a subset whose members
  // all match. The pre-EA-60 gate returned PASS here.
  const res = runReconcile({
    STUB_SERVICES: 'beaconhs-dev_web\nbeaconhs-dev_worker\nbeaconhs-dev_scheduler\n',
    STUB_IMAGE: `ghcr.io/braedonsaunders/beaconhs@${EXPECTED_DIGEST}`,
    STUB_REPLICAS_BEACONHS_DEV_WEB: '1',
    STUB_REPLICAS_BEACONHS_DEV_WORKER: '1',
    STUB_PS_BEACONHS_DEV_WEB: `Running|Running|ghcr.io/braedonsaunders/beaconhs@${EXPECTED_DIGEST}`,
    STUB_PS_BEACONHS_DEV_WORKER: `Running|Running|ghcr.io/braedonsaunders/beaconhs@${EXPECTED_DIGEST}`,
    STUB_PS_BEACONHS_DEV_SCHEDULER: `Complete (exit 0)|Shutdown|ghcr.io/braedonsaunders/beaconhs@${EXPECTED_DIGEST}`,
  })
  assert.equal(res.status, 1, `S12 must not pass: ${res.stdout}${res.stderr}`)
  assert.match(res.stderr, /not in stack 'beaconhs-dev'/)
  assert.match(res.stderr, /instance set is incomplete/)
  assert.doesNotMatch(res.stdout, /Gate 5 PASS/)
})

test('EA60-T2 the gate refuses to run without a roster', () => {
  const res = runReconcile(
    convergedFleetEnv(),
    'beaconhs-dev',
    EXPECTED_DIGEST,
    '/nonexistent/roster',
  )
  assert.equal(res.status, 1, 'an unrostered gate cannot detect a missing service')
  assert.match(res.stderr, /no roster file/)
  assert.doesNotMatch(res.stdout, /Gate 5 PASS/)
})

test('EA60-T3 the roster must describe the stack under reconciliation', () => {
  const roster = writeRoster()
  let text = readFileSync(roster, 'utf8').replace(/^stack=.*/m, 'stack=other-stack')
  writeFileSync(roster, text)
  const res = runReconcile(convergedFleetEnv(), 'beaconhs-dev', EXPECTED_DIGEST, roster)
  assert.equal(res.status, 2, 'a roster for another stack is a misconfiguration, not a fleet fact')
  assert.match(res.stderr, /but the gate targets/)
})

test('EA60-T4 the roster must pin the same digest the gate reconciles', () => {
  const roster = writeRoster()
  let text = readFileSync(roster, 'utf8').replace(/^digest=.*/m, `digest=${OTHER_DIGEST}`)
  writeFileSync(roster, text)
  const res = runReconcile(convergedFleetEnv(), 'beaconhs-dev', EXPECTED_DIGEST, roster)
  assert.equal(res.status, 2)
  assert.match(res.stderr, /but the gate reconciles/)
})

test('EA60-T5 roster replica counts must be integers', () => {
  const roster = writeRoster({ 'web.replicas': 'many' })
  const res = runReconcile(convergedFleetEnv(), 'beaconhs-dev', EXPECTED_DIGEST, roster)
  assert.equal(res.status, 2)
  assert.match(res.stderr, /non-negative integer/)
})

test('EA60-T6 a rostered role without .running is malformed', () => {
  const roster = writeRoster()
  let text = readFileSync(roster, 'utf8').replace(/^web\.running=.*/m, '')
  writeFileSync(roster, text)
  const res = runReconcile(convergedFleetEnv(), 'beaconhs-dev', EXPECTED_DIGEST, roster)
  assert.equal(res.status, 2)
  assert.match(res.stderr, /no \.running/)
})

test('EA60-T7 replica counts in the roster must match the deployment spec', () => {
  const roster = writeRoster({ 'web.replicas': '2' })
  const res = runReconcile(convergedFleetEnv(), 'beaconhs-dev', EXPECTED_DIGEST, roster)
  assert.equal(res.status, 1)
  assert.match(res.stderr, /does not match its own definition/)
})

test('EA60-T8 an unexpected gated service is an unmanaged instance', () => {
  const res = runReconcile({
    STUB_SERVICES:
      'beaconhs-dev_web\nbeaconhs-dev_worker\nbeaconhs-dev_scheduler\nbeaconhs-dev_storage-init\nbeaconhs-dev_sidecar\n',
    STUB_IMAGE: `ghcr.io/braedonsaunders/beaconhs@${EXPECTED_DIGEST}`,
    STUB_REPLICAS_BEACONHS_DEV_WEB: '1',
    STUB_REPLICAS_BEACONHS_DEV_WORKER: '1',
    STUB_PS_BEACONHS_DEV_WEB: `Running|Running|ghcr.io/braedonsaunders/beaconhs@${EXPECTED_DIGEST}`,
    STUB_PS_BEACONHS_DEV_WORKER: `Running|Running|ghcr.io/braedonsaunders/beaconhs@${EXPECTED_DIGEST}`,
    STUB_PS_BEACONHS_DEV_SCHEDULER: `Complete (exit 0)|Shutdown|ghcr.io/braedonsaunders/beaconhs@${EXPECTED_DIGEST}`,
    STUB_PS_BEACONHS_DEV_STORAGE_INIT: `Complete (exit 0)|Shutdown|ghcr.io/braedonsaunders/beaconhs@${EXPECTED_DIGEST}`,
  })
  // The roster defines only web/worker/scheduler/storage-init; a live
  // `_sidecar` service on the gated image is not rostered and is rejected.
  assert.equal(res.status, 1, res.stderr)
  assert.match(res.stderr, /absent from the roster/)
})

test('EA60-T9 a running task on a foreign digest fails even when the spec matches', () => {
  const res = runReconcile(
    convergedFleetEnv({
      env: {
        STUB_PS_BEACONHS_DEV_WEB: [
          `Running|Running|ghcr.io/braedonsaunders/beaconhs@${EXPECTED_DIGEST}`,
          `Running|Running|ghcr.io/braedonsaunders/beaconhs@${OTHER_DIGEST}`,
          '',
        ].join('\n'),
      },
    }),
  )
  assert.equal(res.status, 1)
  assert.match(res.stderr, /mixed fleet/)
})

test('EA60-T10 fewer live tasks than the desired replica count fails', () => {
  const res = runReconcile(
    convergedFleetEnv({
      env: { STUB_PS_BEACONHS_DEV_WEB: '' },
    }),
  )
  assert.equal(res.status, 1)
  assert.match(res.stderr, /not converged/)
})

test('EA60-T11 a failed task query cannot pass', () => {
  const res = runReconcile(convergedFleetEnv({ env: { STUB_PS_FAIL: '1' } }))
  assert.equal(res.status, 1)
  assert.match(res.stderr, /cannot read task state for beaconhs-dev_web/)
})

test('EA60-T12 a one-shot role is verified by spec + completed task, not live tasks', () => {
  // scheduler exists with zero live tasks (it finished) and one completed task
  // on the gated digest: the gate must accept it. Requiring a live task would
  // fail every successful deployment of a one-shot role.
  const res = runReconcile(
    convergedFleetEnv({
      env: {
        STUB_PS_BEACONHS_DEV_SCHEDULER: `Complete (exit 0)|Shutdown|ghcr.io/braedonsaunders/beaconhs@${EXPECTED_DIGEST}`,
      },
    }),
  )
  assert.equal(res.status, 0, res.stderr)
  assert.match(res.stdout, /beaconhs-dev_scheduler: one-shot/)
})

test('EA60-T13 a one-shot role with no completed task on the digest fails', () => {
  const res = runReconcile(
    convergedFleetEnv({
      env: {
        STUB_PS_BEACONHS_DEV_SCHEDULER: `Complete (exit 0)|Shutdown|ghcr.io/braedonsaunders/beaconhs@${OTHER_DIGEST}`,
      },
    }),
  )
  assert.equal(res.status, 1)
  assert.match(res.stderr, /no completed task on the gated digest/)
})

test('EA60-T14 the workflow generates the roster from its own values, not the fleet', () => {
  const script = stepScript('Reconcile the running image digest')
  // The roster is built from stack/digest/WRITER_REPLICAS the step already owns.
  assert.match(script, /echo "stack=\$DOKPLOY_TARGET_STACK"/)
  assert.match(script, /echo "digest=\$IMAGE_DIGEST"/)
  assert.match(script, /WRITER_REPLICAS/)
  assert.doesNotMatch(
    script,
    /docker service (ls|ps|inspect)/,
    'the roster must not be derived from a fleet query',
  )
})

test('EA60-T15 the workflow names the one-shot semantics', () => {
  const script = stepScript('Reconcile the running image digest')
  assert.match(script, /scheduler storage-init/)
  assert.match(script, /running=false/)
})

test('EA60-T16 the roster carries provenance', () => {
  const script = stepScript('Reconcile the running image digest')
  assert.match(script, /echo "source=/, 'the roster must record where its expectations come from')
})
