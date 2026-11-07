#!/usr/bin/env node
/**
 * EA-56 — build identity and deployment gate tests.
 *
 * Covers the stages that must each be able to stop a release on their own:
 *   turbo declaration → build identity assertion → publication ordering →
 *   pre-deploy gate → post-deploy digest reconciliation.
 *
 * Source-origin checks live in verify-source-origin.test.mjs (EA56-T1..T8).
 *
 * Every test here is offline. Docker-dependent tests use an image built from
 * `FROM scratch`, so no registry and no layer pull is involved. Tests that need
 * a registry-backed end-to-end run are covered by the isolated evidence bundle,
 * not here.
 *
 * Run: node --test scripts/ci/build-identity-gate.test.mjs
 */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const CI_DIR = fileURLToPath(new URL('.', import.meta.url))
const ROOT = fileURLToPath(new URL('../..', import.meta.url))

const VERIFY_BUILD = join(CI_DIR, 'verify-build-identity.mjs')
const VERIFY_IMAGE = join(CI_DIR, 'verify-image-identity.mjs')
const GATE = join(CI_DIR, 'deployment-gate.mjs')
const PROMOTE = join(CI_DIR, 'promote-verified-image.sh')
const RECONCILE = join(CI_DIR, 'reconcile-running-digest.sh')

const REVISION = '5'.repeat(40)
const INDEX_DIGEST = `sha256:${'1'.repeat(64)}`
const MANIFEST_DIGEST = `sha256:${'2'.repeat(64)}`
const CONFIG_DIGEST = `sha256:${'3'.repeat(64)}`
const ATTESTATION_DIGEST = `sha256:${'4'.repeat(64)}`

const scratchDirs = []
function scratch(prefix) {
  const dir = mkdtempSync(join(tmpdir(), `ea56-${prefix}-`))
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

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', ...opts })
}

/** Run the build-identity verifier against a dist dir holding a config. */
function verifyBuild(config, expect = REVISION) {
  const dir = scratch('dist')
  if (config !== null)
    writeFileSync(join(dir, 'required-server-files.json'), JSON.stringify(config))
  const res = run('node', [VERIFY_BUILD, '--dist', dir, '--expect', expect, '--json'])
  let json = null
  try {
    json = JSON.parse(res.stdout)
  } catch {
    json = null
  }
  return { code: res.status, json, stdout: res.stdout, stderr: res.stderr }
}

function baseCandidate(overrides = {}) {
  return {
    deployment_id: 'ea56-test-1',
    deployment_environment: 'test',
    source_revision: REVISION,
    externally_sourced_revision: true,
    oci_index_digest: INDEX_DIGEST,
    target_platform: 'linux/amd64',
    oci_index: {
      digest: INDEX_DIGEST,
      manifests: [
        {
          digest: MANIFEST_DIGEST,
          mediaType: 'application/vnd.oci.image.manifest.v1+json',
          platform: { os: 'linux', architecture: 'amd64' },
        },
        {
          digest: ATTESTATION_DIGEST,
          mediaType: 'application/vnd.oci.image.manifest.v1+json',
          platform: { os: 'unknown', architecture: 'unknown' },
          attestation: true,
          subject: MANIFEST_DIGEST,
        },
      ],
    },
    platform_manifest_digest: MANIFEST_DIGEST,
    platform_manifest: { digest: MANIFEST_DIGEST, config: { digest: CONFIG_DIGEST }, layers: 3 },
    image_config_digest: CONFIG_DIGEST,
    embedded_source_revision: REVISION,
    provenance: {
      subject_digest: MANIFEST_DIGEST,
      source_revision: REVISION,
      source_revision_field: 'build-arg:DEPLOYMENT_VERSION',
      completeness: { request: true, resolvedDependencies: false },
    },
    policy: { require_signature: false, require_sbom: false },
    ...overrides,
  }
}

function runGate(candidate) {
  const dir = scratch('gate')
  const file = join(dir, 'candidate.json')
  writeFileSync(file, JSON.stringify(candidate))
  const res = run('node', [GATE, '--input', file, '--json'])
  let json = null
  try {
    json = JSON.parse(res.stdout)
  } catch {
    json = null
  }
  return { code: res.status, json, stdout: res.stdout, stderr: res.stderr }
}

function failedChecks(json) {
  const checks = json?.checks
  if (Array.isArray(checks)) return checks.filter((c) => c.status === 'FAIL').map((c) => c.id)
  // verify-build-identity.mjs reports checks as a plain id → boolean map.
  return Object.entries(checks ?? {})
    .filter(([, ok]) => ok === false)
    .map(([id]) => id)
}

// ---------------------------------------------------------------------------
// EA56-T9 — turbo must pass DEPLOYMENT_VERSION under strict filtering
// ---------------------------------------------------------------------------

test('EA56-T9 turbo declares DEPLOYMENT_VERSION in strict globalEnv', () => {
  const turbo = JSON.parse(readFileSync(join(ROOT, 'turbo.json'), 'utf8'))

  assert.ok(Array.isArray(turbo.globalEnv), 'globalEnv must be an array')
  assert.ok(
    turbo.globalEnv.includes('DEPLOYMENT_VERSION'),
    'DEPLOYMENT_VERSION must be declared in globalEnv or the strict filter strips it from `next build`',
  )

  // Strict filtering must never be widened to make identity work.
  assert.notEqual(turbo.envMode, 'loose', 'envMode must not be "loose"')
  for (const [name, task] of Object.entries(turbo.tasks ?? {})) {
    assert.notEqual(task.envMode, 'loose', `task "${name}" must not set envMode: "loose"`)
  }

  // The build must not rely on APP_VERSION or BUILD_ID for identity.
  assert.ok(
    !turbo.globalEnv.includes('APP_VERSION') ||
      turbo.tasks?.build?.env?.includes('APP_VERSION') !== true,
    'identity must not be sourced from the runtime APP_VERSION',
  )
})

test('EA56-T9b the image build receives the revision and rejects a non-revision', () => {
  const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8')
  assert.match(dockerfile, /^ARG DEPLOYMENT_VERSION$/m, 'build must accept DEPLOYMENT_VERSION')
  assert.match(
    dockerfile,
    /ENV DEPLOYMENT_VERSION=\$\{DEPLOYMENT_VERSION\}/,
    'the build argument must reach the build environment as DEPLOYMENT_VERSION',
  )
  assert.match(
    dockerfile,
    /grep -Eq '\^\[0-9a-f\]\{40\}\$'/,
    'the Dockerfile must refuse a value that is not a 40-hex revision',
  )
})

// ---------------------------------------------------------------------------
// EA56-T10..T14 — post-build identity assertion
// ---------------------------------------------------------------------------

test('EA56-T10 a build artefact with no identity variable fails the assertion', () => {
  const r = verifyBuild({ config: {} })
  assert.equal(r.code, 1)
  assert.equal(r.json.verdict, 'FAIL')
  assert.ok(failedChecks(r.json).includes('identity_present'))
})

test('EA56-T11 an artefact identity that differs from the revision fails', () => {
  const r = verifyBuild({ config: { deploymentId: 'a'.repeat(40) } })
  assert.equal(r.code, 1)
  assert.ok(failedChecks(r.json).includes('matches_expected'))
})

test('EA56-T12 a missing artefact fails instead of being treated as absent-but-ok', () => {
  const r = verifyBuild(null)
  assert.equal(r.code, 1)
  assert.ok(failedChecks(r.json).includes('build_output_present'))
})

test('EA56-T13 BUILD_ID is never accepted as a source revision', () => {
  // The value Next actually writes when DEPLOYMENT_VERSION is missing.
  const r = verifyBuild({ config: { deploymentId: 'build-TfctsWXpff2fKS' } })
  assert.equal(r.code, 1)
  const failed = failedChecks(r.json)
  assert.ok(failed.includes('not_a_build_id'), `got ${failed.join(',')}`)
  assert.ok(failed.includes('identity_well_formed'))
})

test('EA56-T14 changing the runtime APP_VERSION does not change the image identity', () => {
  const before = verifyBuild({ config: { deploymentId: REVISION } })
  assert.equal(before.code, 0)

  // The verifier must read only the embedded build identity. A runtime-only
  // version variable is not part of the artefact and cannot rescue or alter it.
  const res = run(
    'node',
    [VERIFY_BUILD, '--dist', scratch('dist'), '--expect', REVISION, '--json'],
    { env: { ...process.env, APP_VERSION: 'b'.repeat(40), BUILD_ID: 'build-other' } },
  )
  assert.equal(res.status, 1, 'APP_VERSION must not substitute for a missing identity')
})

// ---------------------------------------------------------------------------
// EA56-T16..T18 — an unexecuted, failing or unparseable assertion cannot publish
// ---------------------------------------------------------------------------

function deployWorkflowSteps() {
  // Parse only the ordering that matters, without a YAML dependency: the step
  // names are unique and their relative position is the guarantee.
  const text = readFileSync(join(ROOT, '.github/workflows/deploy-dev.yml'), 'utf8')
  return text
}

test('EA56-T16 the assertion step exists and runs before publication', () => {
  const text = deployWorkflowSteps()
  const origin = text.indexOf('Verify the source revision matches the checkout')
  const build = text.indexOf('id: build-image')
  const assertion = text.indexOf('Assert the built image carries the verified revision')
  const promote = text.indexOf('Promote the verified digest to its release tag')

  assert.ok(origin > 0, 'the origin check step must exist')
  assert.ok(build > 0, 'the build step must exist')
  assert.ok(assertion > 0, 'the post-build assertion step must exist')
  assert.ok(promote > 0, 'the publication step must exist')

  // Ordering is the control: origin → build → assert → publish.
  assert.ok(origin < build, 'source origin must be verified before the build runs')
  assert.ok(build < assertion, 'the assertion must run after the build')
  assert.ok(
    assertion < promote,
    'the identity assertion must run BEFORE publication, or a bad image is already published',
  )
})

test('EA56-T17 no required gate step may be made non-blocking', () => {
  const text = deployWorkflowSteps()
  assert.ok(
    !/^\s*continue-on-error:\s*true\s*$/m.test(text),
    'continue-on-error: true would let a failing identity gate continue to publication',
  )
})

test('EA56-T18 the gate runs before migrations and before any rollout', () => {
  const text = deployWorkflowSteps()
  const gate = text.indexOf('Gate the candidate image before deployment')
  const migrations = text.indexOf('Run database migrations')
  const rollout = text.indexOf('Roll the immutable image directly on Swarm')

  assert.ok(gate > 0, 'the pre-deploy gate step must exist')
  assert.ok(migrations > 0 && rollout > 0)
  assert.ok(gate < migrations, 'the gate must run before migrations')
  assert.ok(gate < rollout, 'the gate must run before the image is rolled out')
})

test('EA56-T18b the build publishes to a staging tag, not the deployable tag', () => {
  const text = deployWorkflowSteps()
  const buildBlock = text.slice(
    text.indexOf('id: build-image'),
    text.indexOf('Assert the built image'),
  )
  assert.match(
    buildBlock,
    /tags:\s*\$\{\{\s*env\.IMAGE_NAME\s*\}\}:staging-\$\{\{\s*github\.sha\s*\}\}/,
    'the build must push a staging tag so publication can be gated',
  )
  assert.ok(
    !/push:\s*false/.test(buildBlock),
    'the build must push: `--load` would discard the provenance attestation',
  )
})

// ---------------------------------------------------------------------------
// EA56-T19..T21, T24 — pre-deploy gate
// ---------------------------------------------------------------------------

test('EA56-T19 index digest that does not match the candidate is refused', () => {
  const candidate = baseCandidate()
  candidate.oci_index = { ...candidate.oci_index, digest: `sha256:${'9'.repeat(64)}` }
  const r = runGate(candidate)
  assert.equal(r.code, 1)
  assert.ok(failedChecks(r.json).includes('G1.index_digest_matches_candidate'))
})

test('EA56-T20 a manifest whose config digest does not link to the image is refused', () => {
  const candidate = baseCandidate()
  candidate.platform_manifest = {
    ...candidate.platform_manifest,
    config: { digest: `sha256:${'8'.repeat(64)}` },
  }
  const r = runGate(candidate)
  assert.equal(r.code, 1)
  assert.ok(failedChecks(r.json).includes('G1.config_digest_matches_manifest'))
})

test('EA56-T21 missing provenance is refused, not bypassed', () => {
  const candidate = baseCandidate()
  delete candidate.provenance
  const r = runGate(candidate)
  assert.equal(r.code, 1)
  assert.ok(failedChecks(r.json).includes('G3.provenance_present'))
})

test('EA56-T21b provenance that does not bind the source revision is refused', () => {
  const candidate = baseCandidate()
  candidate.provenance = { ...candidate.provenance, source_revision: 'c'.repeat(40) }
  const r = runGate(candidate)
  assert.equal(r.code, 1)
  assert.ok(failedChecks(r.json).includes('G3.provenance_revision_matches_source'))
})

test('EA56-T21c an unsigned image is not reported as a complete identity chain', () => {
  const r = runGate(baseCandidate())
  assert.equal(r.code, 0, 'current policy does not demand a signature')
  const chain = r.json.checks.find((c) => c.id === 'G4.identity_chain_complete')
  assert.notEqual(chain.status, 'PASS', 'the chain must never be reported as complete')
  assert.equal(chain.status, 'PARTIAL')
  assert.match(chain.reason, /INCOMPLETE by policy/)
})

test('EA56-T21d a policy that demands a signature is not satisfied by silence', () => {
  const candidate = baseCandidate()
  candidate.policy = { require_signature: true, require_sbom: false }
  const r = runGate(candidate)
  assert.equal(r.code, 1)
  assert.ok(failedChecks(r.json).includes('G3.signature_present'))
})

test('EA56-T24 an unreadable candidate is a tool failure, not a pass', () => {
  const res = run('node', [GATE, '--input', join(scratch('missing'), 'nope.json'), '--json'])
  assert.notEqual(res.status, 0)
  assert.notEqual(res.status, null, 'the gate must exit, not crash without a code')
})

test('EA56-T24b a broken image reference is refused by the assembler', () => {
  const args = [
    join(CI_DIR, 'assemble-gate-candidate.mjs'),
    '--image',
    'ghcr.io/example/beaconhs:latest',
    '--expect-revision',
    REVISION,
    '--policy',
    '{"require_signature":false}',
    '--out',
    join(scratch('out'), 'c.json'),
  ]
  const res = run('node', args)
  assert.equal(res.status, 3, 'a tag is not a digest and must not be accepted')
})

// ---------------------------------------------------------------------------
// EA56-T22..T23 — post-deploy digest reconciliation
// ---------------------------------------------------------------------------

/**
 * Install a `docker` stub on PATH. `service ls` and `service inspect` answer
 * from env vars so the reconciliation logic can be exercised without a swarm.
 */
function withDockerStub(env) {
  const bin = scratch('bin')
  const stub = join(bin, 'docker')
  writeFileSync(
    stub,
    [
      '#!/usr/bin/env bash',
      'if [ "$1" = "service" ] && [ "$2" = "ls" ]; then',
      '  printf "%b\\n" "${STUB_SERVICES:-}"',
      '  exit 0',
      'fi',
      'if [ "$1" = "service" ] && [ "$2" = "inspect" ]; then',
      '  if [ "${STUB_INSPECT_FAIL:-0}" = "1" ]; then exit 1; fi',
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
      '  if [ "${STUB_PS_FAIL:-0}" = "1" ]; then exit 1; fi',
      '  shift 2',
      '  service=""',
      '  for arg in "$@"; do case "$arg" in --*) ;; *) service="$arg"; break ;; esac; done',
      "  key=\"STUB_PS_$(printf '%s' \"$service\" | tr '[:lower:]-' '[:upper:]_')\"",
      '  printf "%s\\n" "${!key:-}"',
      '  exit 0',
      'fi',
      'exit 1',
      '',
    ].join('\n'),
  )
  chmodSync(stub, 0o755)
  return { ...process.env, ...env, PATH: `${bin}:${process.env.PATH}` }
}

/**
 * Write the roster the deployment is defined to run (stack 'beaconhs' at one
 * replica per role). Derived from the deployment definition, never the fleet.
 */
function writeRoster(digest = CONFIG_DIGEST) {
  const file = join(scratch('roster'), 'gate5.roster')
  writeFileSync(
    file,
    [
      'stack=beaconhs',
      'source=deploy/dokploy-dev.compose.yaml + deploy env (WRITER_REPLICAS=1)',
      `digest=${digest}`,
      'web.replicas=1',
      'web.running=true',
      'worker.replicas=1',
      'worker.running=true',
      'scheduler.replicas=1',
      'scheduler.running=false',
      'storage-init.replicas=1',
      'storage-init.running=false',
      '',
    ].join('\n'),
  )
  return file
}

function reconcile(env, stack = 'beaconhs', digest = CONFIG_DIGEST, roster) {
  return run('bash', [RECONCILE, stack, digest, roster ?? writeRoster(digest)], {
    env: withDockerStub(env),
  })
}

/** Fleet env for the EA-56 stack: gated roles on the image, others not. */
function fleetEnv(image, extra = {}) {
  const imageFile = join(scratch('images'), 'fleet.txt')
  writeFileSync(
    imageFile,
    [
      `beaconhs_web=${image}`,
      `beaconhs_worker=${image}`,
      `beaconhs_scheduler=${image}`,
      `beaconhs_storage-init=${image}`,
      'beaconhs_collabora=collabora/code:26.04.2.1.1@sha256:df33af88c59e26b7335ea98d91e65f1edf13f33369ce6115941b8d59d3409cb5',
      '',
    ].join('\n'),
  )
  return {
    STUB_SERVICES:
      'beaconhs_web\nbeaconhs_worker\nbeaconhs_scheduler\nbeaconhs_storage-init\nbeaconhs_collabora\n',
    STUB_IMAGE_FILE: imageFile,
    STUB_REPLICAS_BEACONHS_WEB: '1',
    STUB_REPLICAS_BEACONHS_WORKER: '1',
    STUB_PS_BEACONHS_WEB: `Running|Running|${image}`,
    STUB_PS_BEACONHS_WORKER: `Running|Running|${image}`,
    STUB_PS_BEACONHS_SCHEDULER: `Complete (exit 0)|Shutdown|${image}`,
    STUB_PS_BEACONHS_STORAGE_INIT: `Complete (exit 0)|Shutdown|${image}`,
    ...extra,
  }
}

test('EA56-T22 a running digest that differs from the gated digest fails', () => {
  const res = reconcile(fleetEnv(`ghcr.io/example/beaconhs@sha256:${'7'.repeat(64)}`))
  assert.equal(res.status, 1)
  assert.match(res.stderr, /do not hold against the roster|runs ghcr\.io\/example\/beaconhs@/)
})

test('EA56-T23 readiness cannot rescue a digest mismatch', () => {
  // The reconciliation reads the service spec only; readiness is not an input.
  // A 200 from /api/health/ready therefore cannot change the verdict.
  const res = reconcile(
    fleetEnv(`ghcr.io/example/beaconhs@sha256:${'7'.repeat(64)}`, { READINESS_OK: '1' }),
  )
  assert.equal(res.status, 1)
})

test('EA56-T22b a fleet running the gated digest passes', () => {
  const res = reconcile(fleetEnv(`ghcr.io/example/beaconhs@${CONFIG_DIGEST}`))
  assert.equal(res.status, 0)
  assert.match(res.stdout, /all 4 rostered service\(s\) match the roster and run/)
})

test('EA56-T22c an empty fleet is a failure, not a vacuous pass', () => {
  const res = reconcile({ STUB_SERVICES: '' })
  assert.equal(res.status, 1)
  assert.match(res.stderr, /returned no service|instance set is not proven complete/)
})

test('EA56-T22d an uninspectable service is a failure', () => {
  const res = reconcile(
    fleetEnv(`ghcr.io/example/beaconhs@${CONFIG_DIGEST}`, { STUB_INSPECT_FAIL: '1' }),
  )
  assert.equal(res.status, 1)
  assert.doesNotMatch(res.stdout, /PASS/)
})

// ---------------------------------------------------------------------------
// EA56-T25 — publication only follows a verified digest
// ---------------------------------------------------------------------------

function promote(env, digest = INDEX_DIGEST) {
  const bin = scratch('bin')
  const stub = join(bin, 'docker')
  const log = join(bin, 'calls.log')
  writeFileSync(
    stub,
    [
      '#!/usr/bin/env bash',
      'printf "%s\\n" "$*" >> "$STUB_LOG"',
      'if [ "$1" = "buildx" ] && [ "$2" = "imagetools" ] && [ "$3" = "create" ]; then exit 0; fi',
      'if [ "$1" = "buildx" ] && [ "$2" = "imagetools" ] && [ "$3" = "inspect" ]; then',
      '  printf "Name:      %s\\n" "$4"',
      '  printf "Digest:    %s\\n" "${STUB_REPORTED_DIGEST:-}"',
      '  exit 0',
      'fi',
      'exit 1',
      '',
    ].join('\n'),
  )
  chmodSync(stub, 0o755)
  const res = run(
    'bash',
    [PROMOTE, 'ghcr.io/example/beaconhs', digest, 'ghcr.io/example/beaconhs:release'],
    {
      env: {
        ...process.env,
        ...env,
        PATH: `${bin}:${process.env.PATH}`,
        STUB_LOG: log,
      },
    },
  )
  return { ...res, calls: existsSync(log) ? readFileSync(log, 'utf8') : '' }
}

test('EA56-T25 promotion preserves the asserted digest', () => {
  const r = promote({ STUB_REPORTED_DIGEST: INDEX_DIGEST })
  assert.equal(r.status, 0)
  assert.match(r.stdout, new RegExp(INDEX_DIGEST))
  assert.match(r.calls, /imagetools create/)
})

test('EA56-T25b promotion that changes the digest is refused', () => {
  const r = promote({ STUB_REPORTED_DIGEST: `sha256:${'6'.repeat(64)}` })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /promotion changed the digest/)
})

test('EA56-T25c an unusable digest never reaches the registry', () => {
  for (const bad of ['latest', 'sha256:abc', '', 'ghcr.io/x/y@sha256:' + 'z'.repeat(64)]) {
    const r = promote({ STUB_REPORTED_DIGEST: INDEX_DIGEST }, bad)
    assert.notEqual(r.status, 0, `'${bad}' must be refused`)
    assert.doesNotMatch(r.calls, /create/, `'${bad}' must be refused before any push`)
  }
})

// ---------------------------------------------------------------------------
// EA56-T25d — real image, no registry required
// ---------------------------------------------------------------------------

function hasDocker() {
  const res = run('docker', ['info', '--format', '{{.ServerVersion}}'])
  return res.status === 0
}

test(
  'EA56-T25d the assertion reads the identity out of a real image',
  { skip: !hasDocker() },
  () => {
    const context = scratch('img')
    const appDir = join(context, 'apps/web/.next')
    mkdirSync(appDir, { recursive: true })
    writeFileSync(
      join(appDir, 'required-server-files.json'),
      JSON.stringify({ config: { deploymentId: REVISION } }),
    )
    writeFileSync(join(context, 'Dockerfile'), 'FROM scratch\nCOPY apps /app/apps\n')

    const build = run('docker', [
      'build',
      '-q',
      '-t',
      'ea56-test:identity',
      '-f',
      join(context, 'Dockerfile'),
      context,
    ])
    assert.equal(build.status, 0, `docker build failed: ${build.stderr}`)

    try {
      const ok = run('node', [
        VERIFY_IMAGE,
        '--image',
        'ea56-test:identity',
        '--expect',
        REVISION,
        '--json',
      ])
      assert.equal(ok.status, 0, ok.stdout)
      assert.equal(JSON.parse(ok.stdout).verdict, 'PASS')

      const wrong = run('node', [
        VERIFY_IMAGE,
        '--image',
        'ea56-test:identity',
        '--expect',
        'a'.repeat(40),
        '--json',
      ])
      assert.equal(wrong.status, 1, 'a foreign revision must not be accepted')
    } finally {
      run('docker', ['rmi', '-f', 'ea56-test:identity'])
    }
  },
)

test('EA56-T25e an image without the artefact cannot be verified', { skip: !hasDocker() }, () => {
  const context = scratch('img-empty')
  writeFileSync(join(context, 'f.txt'), 'no identity here\n')
  writeFileSync(join(context, 'Dockerfile'), 'FROM scratch\nCOPY f.txt /app/f.txt\n')
  const build = run('docker', [
    'build',
    '-q',
    '-t',
    'ea56-test:no-identity',
    '-f',
    join(context, 'Dockerfile'),
    context,
  ])
  assert.equal(build.status, 0, `docker build failed: ${build.stderr}`)
  try {
    const res = run('node', [
      VERIFY_IMAGE,
      '--image',
      'ea56-test:no-identity',
      '--expect',
      REVISION,
      '--json',
    ])
    assert.equal(res.status, 1, 'an image with no identity must fail')
  } finally {
    run('docker', ['rmi', '-f', 'ea56-test:no-identity'])
  }
})

test('EA56-T25f a nonexistent image is a tool failure, not a pass', () => {
  const res = run('node', [
    VERIFY_IMAGE,
    '--image',
    'ea56-does-not-exist:never',
    '--expect',
    REVISION,
    '--json',
  ])
  assert.notEqual(res.status, 0)
  assert.notEqual(res.status, null)
})

// ---------------------------------------------------------------------------
// Reference check: the reused verifier must remain the single implementation
// ---------------------------------------------------------------------------

test('EA56-T27 no second build-identity implementation was added', () => {
  const candidates = execFileSync(
    'grep',
    [
      '-rl',
      '--include=*.mjs',
      '--exclude=*.test.mjs',
      'required-server-files.json',
      join(ROOT, 'scripts'),
    ],
    { encoding: 'utf8' },
  )
    .trim()
    .split('\n')
    .filter(Boolean)
  assert.deepEqual(
    candidates.sort(),
    [VERIFY_BUILD, VERIFY_IMAGE].sort(),
    'identity parsing must live only in verify-build-identity.mjs and its image wrapper',
  )
})
