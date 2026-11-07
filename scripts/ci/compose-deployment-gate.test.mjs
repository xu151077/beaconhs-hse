#!/usr/bin/env node
/**
 * EA-63 — Compose Gate 5 fixture tests.
 * EA-64.1 — adds RestartCount, registry-port and real-inspect-sample coverage.
 *
 * Exercises scripts/ci/reconcile-compose-digest.sh against a `docker` stub.
 * Nothing here talks to a real Docker daemon, a Compose deployment or an Ubuntu
 * host: these are fixture tests and they prove the decision logic only.
 *
 * The manifest used is the shipped deploy/gate5.manifest.yaml, so the tests also
 * pin the expectation file to the compose file it describes. The real-sample
 * fixtures under docs/evidence/ea64/remediation/fixtures are minimal
 * projections of EA-64's captured `docker inspect` output.
 *
 * Run: node --test scripts/ci/compose-deployment-gate.test.mjs
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const CI_DIR = fileURLToPath(new URL('.', import.meta.url))
const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const GATE = join(CI_DIR, 'reconcile-compose-digest.sh')
const MANIFEST = join(ROOT, 'deploy/gate5.manifest.yaml')

const PROJECT = 'beaconhs-local-prod'
const IMAGE = 'ghcr.io/example/beaconhs'
const DIGEST = `sha256:${'3'.repeat(64)}`
const OTHER_DIGEST = `sha256:${'7'.repeat(64)}`
const IMAGE_ID = `sha256:${'a'.repeat(64)}`
const OTHER_IMAGE_ID = `sha256:${'b'.repeat(64)}`
const DEPLOYMENT = `${'c'.repeat(40)}-1234567890-1`
const PREVIOUS_DEPLOYMENT = `${'d'.repeat(40)}-1234567888-1`
const EXPECTED_REF = `${IMAGE}@${DIGEST}`

/** Pinned identities must match deploy/gate5.manifest.yaml exactly. */
const PINNED = {
  postgres: {
    image: 'postgres',
    digest: 'sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea',
    imageId: `sha256:${'1'.repeat(64)}`,
  },
  redis: {
    image: 'redis',
    digest: 'sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499',
    imageId: `sha256:${'2'.repeat(64)}`,
  },
  minio: {
    image: 'minio/minio',
    digest: 'sha256:b187417eee0a495ed45ff0e2d5f0c9810ae35705319c0d2fb46dd93e4ac1501c',
    imageId: `sha256:${'3'.repeat(64)}`,
  },
  collabora: {
    image: 'collabora/code',
    digest: 'sha256:4e983196eb9878f339cc506c38c21f1cc3473bca3d6de883c5de08f9c0cc3a6c',
    imageId: `sha256:${'4'.repeat(64)}`,
  },
}

function pinnedRef(role) {
  return `${PINNED[role].image}@${PINNED[role].digest}`
}

const scratchDirs = []
function scratch(prefix) {
  const dir = mkdtempSync(join(tmpdir(), `ea63-${prefix}-`))
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
// Fixture builders
// ---------------------------------------------------------------------------

let containerSeq = 0
function containerId() {
  containerSeq += 1
  return containerSeq.toString(16).padStart(64, '0')
}

/**
 * One container as `docker inspect` reports it.
 * opts: health, status, exitCode, restarts, imageId, reference, labels,
 *       deployment, startedAt, service, stateRestartCount
 *
 * RestartCount is TOP LEVEL, as real Docker reports it (EA-64 evidence). The
 * `stateRestartCount` option exists only to reproduce the old, wrong fixture
 * shape and prove the gate no longer reads it.
 */
const OMIT = '__omit__'
function container(role, opts = {}) {
  const pinned = PINNED[role]
  const labels = {
    'com.docker.compose.service': opts.service ?? role,
    'com.beaconhs.deployment': opts.deployment ?? DEPLOYMENT,
    'com.beaconhs.image-digest': opts.digestLabel ?? (pinned ? pinned.digest : DIGEST),
    'com.beaconhs.role': opts.role ?? role,
    ...(opts.labels ?? {}),
  }
  const health = opts.health === undefined ? 'healthy' : opts.health
  const state = {
    Status: opts.status ?? 'running',
    ExitCode: opts.exitCode ?? 0,
    StartedAt: opts.startedAt ?? '2026-10-30T00:00:00Z',
  }
  if (health !== null) state.Health = { Status: health }
  if (opts.stateRestartCount !== undefined) state.RestartCount = opts.stateRestartCount
  const body = {
    Id: opts.id ?? containerId(),
    Config: { Image: opts.reference ?? (pinned ? pinnedRef(role) : EXPECTED_REF), Labels: labels },
    Image: opts.imageId ?? (pinned ? pinned.imageId : IMAGE_ID),
  }
  const restarts = opts.restarts === undefined ? 0 : opts.restarts
  if (restarts !== OMIT) body.RestartCount = restarts
  body.State = state
  return body
}

function oneShot(role, opts = {}) {
  return container(role, {
    status: 'exited',
    exitCode: opts.exitCode ?? 0,
    health: null,
    ...opts,
  })
}

/** The eight services the manifest expects, all correct. */
function healthyFleet() {
  return [
    container('web'),
    container('worker'),
    oneShot('scheduler'),
    oneShot('storage-init'),
    container('postgres'),
    container('redis'),
    container('minio'),
    container('collabora', { health: null }),
  ]
}

function identityLabels(role, overrides = {}) {
  const pinned = PINNED[role]
  return {
    'com.beaconhs.deployment': overrides.deployment ?? DEPLOYMENT,
    'com.beaconhs.image-digest': overrides.digest ?? (pinned ? pinned.digest : DIGEST),
    'com.beaconhs.role': overrides.role ?? role,
  }
}

function composeConfig(overrides = {}) {
  return {
    name: overrides.name ?? PROJECT,
    services: overrides.services ?? {
      web: {
        image: EXPECTED_REF,
        labels: identityLabels('web'),
        healthcheck: { test: ['CMD', 'true'] },
      },
      worker: {
        image: EXPECTED_REF,
        labels: identityLabels('worker'),
        healthcheck: { test: ['CMD', 'true'] },
      },
      scheduler: {
        image: EXPECTED_REF,
        labels: identityLabels('scheduler'),
        restart: 'no',
      },
      'storage-init': {
        image: EXPECTED_REF,
        labels: identityLabels('storage-init'),
        restart: 'no',
      },
      postgres: {
        image: pinnedRef('postgres'),
        labels: identityLabels('postgres'),
        healthcheck: { test: ['CMD', 'true'] },
      },
      redis: {
        image: pinnedRef('redis'),
        labels: identityLabels('redis'),
        healthcheck: { test: ['CMD', 'true'] },
      },
      minio: {
        image: pinnedRef('minio'),
        labels: identityLabels('minio'),
        healthcheck: { test: ['CMD', 'true'] },
      },
      collabora: {
        image: pinnedRef('collabora'),
        labels: identityLabels('collabora'),
      },
    },
  }
}

function world(overrides = {}) {
  const containers = overrides.containers ?? healthyFleet()
  const pinnedImages = {}
  for (const [role, pinned] of Object.entries(PINNED)) {
    pinnedImages[pinnedRef(role)] = { Id: pinned.imageId, RepoDigests: [pinnedRef(role)] }
  }
  return {
    info_ok: overrides.info_ok ?? true,
    compose_version_ok: overrides.compose_version_ok ?? true,
    compose_ok: overrides.compose_ok ?? true,
    compose_config: overrides.compose_config ?? composeConfig(),
    image_fail: overrides.image_fail ?? false,
    image_fail_refs: overrides.image_fail_refs ?? [],
    image: overrides.image ?? {
      Id: IMAGE_ID,
      RepoDigests: [`${IMAGE}@${DIGEST}`],
    },
    images: {
      [EXPECTED_REF]: overrides.image ?? {
        Id: IMAGE_ID,
        RepoDigests: [`${IMAGE}@${DIGEST}`],
      },
      ...pinnedImages,
      ...(overrides.images ?? {}),
    },
    ps_fail: overrides.ps_fail ?? false,
    inspect_fail: overrides.inspect_fail ?? false,
    ps_sequence: overrides.ps_sequence ?? [containers.map((c) => c.Id)],
    inspect_sequence: overrides.inspect_sequence ?? [containers],
  }
}

const STUB = `#!/usr/bin/env bash
set -uo pipefail
W="$WORLD_FILE"
COUNTER_DIR="$COUNTER_DIR"
next_index() {
  local f="$COUNTER_DIR/$1" n=0
  [ -f "$f" ] && n="$(cat "$f")"
  printf '%s' "$((n + 1))" > "$f"
  printf '%s' "$n"
}
case "\${1:-}" in
  info)
    [ "$(jq -r '.info_ok != false' "$W")" = "true" ] && exit 0
    echo "Cannot connect to the Docker daemon" >&2
    exit 1
    ;;
  compose)
    if [ "\${2:-}" = "version" ]; then
      [ "$(jq -r '.compose_version_ok != false' "$W")" = "true" ] && exit 0
      echo "docker: 'compose' is not a docker command" >&2
      exit 1
    fi
    if [ "$(jq -r '.compose_ok != false' "$W")" != "true" ]; then
      echo "compose: invalid configuration" >&2
      exit 1
    fi
    jq -c '.compose_config' "$W"
    exit 0
    ;;
  ps)
    if [ "$(jq -r '.ps_fail == true' "$W")" = "true" ]; then
      echo "docker: error during connect" >&2
      exit 1
    fi
    i="$(next_index ps)"
    jq -r --argjson i "$i" '(.ps_sequence[$i] // .ps_sequence[-1])[]' "$W"
    exit 0
    ;;
  inspect)
    if [ "$(jq -r '.inspect_fail == true' "$W")" = "true" ]; then
      echo "docker: inspect failed" >&2
      exit 1
    fi
    i="$(next_index inspect)"
    jq -c --argjson i "$i" '(.inspect_sequence[$i] // .inspect_sequence[-1])' "$W"
    exit 0
    ;;
  image)
    ref="\${3:-}"
    if [ "$(jq -r '.image_fail == true' "$W")" = "true" ]; then
      echo "Error: No such image" >&2
      exit 1
    fi
    if [ "$(jq -r --arg ref "$ref" '(.image_fail_refs // []) | index($ref) != null' "$W")" = "true" ]; then
      echo "Error: No such image: $ref" >&2
      exit 1
    fi
    if [ "$(jq -r --arg ref "$ref" '.images[$ref] != null' "$W")" != "true" ]; then
      echo "Error: No such image: $ref" >&2
      exit 1
    fi
    jq -c --arg ref "$ref" '[.images[$ref]]' "$W"
    exit 0
    ;;
esac
exit 1
`

function installStub() {
  const dir = scratch('bin')
  writeFileSync(join(dir, 'docker'), STUB)
  chmodSync(join(dir, 'docker'), 0o755)
  return dir
}

function baseArgs(dir, overrides = {}) {
  const args = [
    '--project',
    overrides.project ?? PROJECT,
    '--image',
    overrides.image ?? IMAGE,
    '--digest',
    overrides.digest ?? DIGEST,
    '--deployment-id',
    overrides.deployment ?? DEPLOYMENT,
  ]
  if (overrides.sourceDeploymentId) {
    args.push('--source-deployment-id', overrides.sourceDeploymentId)
  }
  args.push(
    '--manifest',
    overrides.manifest ?? MANIFEST,
    '--lock',
    overrides.lock ?? join(dir, 'deploy.lock'),
    '--timeout',
    String(overrides.timeout ?? 0),
    '--poll-interval',
    String(overrides.poll ?? 0),
  )
  return args
}

function runGate(w, argsOverrides = {}) {
  const dir = scratch('run')
  const bin = installStub()
  const worldFile = join(dir, 'world.json')
  writeFileSync(worldFile, JSON.stringify(w))
  const res = spawnSync('bash', [GATE, ...baseArgs(dir, argsOverrides)], {
    encoding: 'utf8',
    cwd: ROOT,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      WORLD_FILE: worldFile,
      COUNTER_DIR: dir,
    },
  })
  return { ...res, verdict: verdictOf(res.stdout), dir }
}

function verdictOf(stdout) {
  const m = /^VERDICT: (.+)$/m.exec(stdout ?? '')
  return m ? m[1] : 'NONE'
}

function assertVerdict(res, verdict, exitCode, reasonPattern) {
  assert.equal(res.verdict, verdict, `verdict\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`)
  assert.equal(res.status, exitCode, `exit code\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`)
  if (reasonPattern) {
    assert.match(`${res.stdout}${res.stderr}`, reasonPattern)
  }
}

/** Write a manifest variant into scratch, based on the shipped file. */
function manifestVariant(mutate) {
  const text = readFileSync(MANIFEST, 'utf8')
  const dir = scratch('manifest')
  const file = join(dir, 'gate5.manifest.yaml')
  writeFileSync(file, mutate(text))
  return file
}

// ---------------------------------------------------------------------------
// 1-8: the fleet-level scenarios
// ---------------------------------------------------------------------------

test('EA63-T01 all required containers healthy and matching passes', () => {
  const res = runGate(world())
  assertVerdict(res, 'PASS', 0, /all 8 container\(s\)/)
})

test('EA63-T02 a missing required service fails', () => {
  const fleet = healthyFleet().filter(
    (c) => c.Config.Labels['com.docker.compose.service'] !== 'web',
  )
  const res = runGate(world({ containers: fleet }))
  assertVerdict(res, 'FAIL', 1, /required service 'web' has no container|did not converge/)
})

test('EA63-T03 an unregistered service fails', () => {
  const fleet = [...healthyFleet(), container('rogue')]
  const res = runGate(world({ containers: fleet }))
  assertVerdict(res, 'FAIL', 1, /unregistered service 'rogue'/)
})

test('EA63-T04 fewer containers than the manifest expects fails', () => {
  const manifest = manifestVariant((t) =>
    t.replace(/(  web:\n(?: {4}.*\n)*? {4}expected_container_count: )1/, (_m, head) => `${head}2`),
  )
  const res = runGate(world(), { manifest, timeout: 0 })
  assertVerdict(res, 'FAIL', 1, /service 'web' has 1 container\(s\), expected 2|did not converge/)
})

test('EA63-T05 more containers than the manifest expects fails', () => {
  const fleet = [...healthyFleet(), container('web')]
  const res = runGate(world({ containers: fleet }))
  assertVerdict(res, 'FAIL', 1, /service 'web' has 2 container\(s\), expected 1/)
})

test('EA63-T06 a container running a different image fails', () => {
  const fleet = healthyFleet()
  fleet[0] = container('web', { imageId: OTHER_IMAGE_ID })
  const res = runGate(world({ containers: fleet }))
  assertVerdict(res, 'FAIL', 1, /runs image 'sha256:b/)
})

test('EA63-T07 an old container from a previous deployment fails', () => {
  const fleet = healthyFleet()
  fleet[0] = container('web', { deployment: PREVIOUS_DEPLOYMENT })
  const res = runGate(world({ containers: fleet }))
  assertVerdict(res, 'FAIL', 1, /was created by deployment 'd{40}-1234567888-1'/)
})

test('EA63-T08 empty RepoDigests does not fail a complete three-way match', () => {
  const res = runGate(world({ image: { Id: IMAGE_ID, RepoDigests: [] } }))
  assertVerdict(res, 'PASS', 0)
})

// ---------------------------------------------------------------------------
// 9-14: health, restarts, one-shot, deployment identity
// ---------------------------------------------------------------------------

test('EA63-T09 an unhealthy container fails', () => {
  const fleet = healthyFleet()
  fleet[1] = container('worker', { health: 'unhealthy' })
  const res = runGate(world({ containers: fleet }))
  assertVerdict(res, 'FAIL', 1, /worker container .* health is 'unhealthy'/)
})

test('EA63-T10 a container that keeps restarting fails at the deadline', () => {
  const fleet = healthyFleet()
  fleet[0] = container('web', { status: 'restarting', restarts: 0 })
  const res = runGate(world({ containers: fleet }), { timeout: 1, poll: 0.1 })
  assertVerdict(res, 'FAIL', 1, /is 'restarting'|did not converge/)
})

test('EA63-T11 a one-shot task that exited 0 passes', () => {
  const res = runGate(world())
  assertVerdict(res, 'PASS', 0)
  assert.match(res.stdout, /VERDICT: PASS/)
})

test('EA63-T12 a one-shot task that exited non-zero fails', () => {
  const fleet = healthyFleet()
  fleet[2] = oneShot('scheduler', { exitCode: 1 })
  const res = runGate(world({ containers: fleet }))
  assertVerdict(res, 'FAIL', 1, /one-shot scheduler container .* exited 1, expected 0/)
})

test('EA63-T13 a historical successful one-shot cannot satisfy this deployment', () => {
  const fleet = healthyFleet()
  fleet[2] = oneShot('scheduler', { deployment: PREVIOUS_DEPLOYMENT })
  const res = runGate(world({ containers: fleet }))
  assertVerdict(res, 'FAIL', 1, /was created by deployment/)
})

test('EA63-T14 a different deployment ID fails', () => {
  const fleet = healthyFleet()
  fleet[3] = oneShot('storage-init', { deployment: PREVIOUS_DEPLOYMENT })
  const res = runGate(world({ containers: fleet }))
  assertVerdict(res, 'FAIL', 1, /storage-init container .* was created by deployment/)
})

// ---------------------------------------------------------------------------
// 15-20: project, queries, replacement, concurrency, timeout
// ---------------------------------------------------------------------------

test('EA63-T15 a different Compose project name is NOT VERIFIED', () => {
  const res = runGate(world({ compose_config: composeConfig({ name: 'someone-elses-project' }) }))
  assertVerdict(res, 'NOT VERIFIED', 2, /does not match --project/)
})

test('EA63-T16 a failing docker ps is NOT VERIFIED', () => {
  const res = runGate(world({ ps_fail: true }))
  assertVerdict(res, 'NOT VERIFIED', 2, /docker ps failed/)
})

test('EA63-T17 an unreachable daemon is NOT VERIFIED', () => {
  const res = runGate(world({ info_ok: false }))
  assertVerdict(res, 'NOT VERIFIED', 2, /Docker daemon is not reachable/)
})

test('EA63-T18 a container replaced during verification is NOT VERIFIED', () => {
  const first = healthyFleet()
  const second = healthyFleet()
  second[0] = { ...second[0], State: { ...second[0].State, StartedAt: '2026-10-30T00:05:00Z' } }
  const res = runGate(world({ inspect_sequence: [first, second] }))
  assertVerdict(
    res,
    'NOT VERIFIED',
    2,
    /restarted during verification|image changed during verification/,
  )
})

test('EA63-T19 a concurrent deployment holding the lock is refused', async () => {
  const dir = scratch('lock')
  const lockPath = join(dir, 'deploy.lock')
  const holder = spawn('bash', ['-c', `exec 9>>"${lockPath}"; flock -n 9; sleep 10`], {
    stdio: 'ignore',
  })
  try {
    await new Promise((resolve) => setTimeout(resolve, 300))
    const res = runGate(world(), { lock: lockPath })
    assertVerdict(res, 'FAIL', 1, /another deployment holds/)
  } finally {
    holder.kill('SIGKILL')
  }
})

test('EA63-T20 a deployment that never converges fails at the deadline', () => {
  const fleet = healthyFleet()
  fleet[0] = container('web', { status: 'created', health: 'starting' })
  const res = runGate(world({ containers: fleet }), { timeout: 1, poll: 0.1 })
  assertVerdict(res, 'FAIL', 1, /did not converge within 1s/)
})

// ---------------------------------------------------------------------------
// Boundary and malformed-input cases
// ---------------------------------------------------------------------------

test('EA63-T21 a manifest field that is missing is NOT VERIFIED', () => {
  const manifest = manifestVariant((t) => t.replace(/^ {4}health: required\n/m, ''))
  const res = runGate(world(), { manifest })
  assertVerdict(res, 'NOT VERIFIED', 2, /missing 'health'/)
})

test('EA63-T22 a duplicate service in the manifest is NOT VERIFIED', () => {
  const manifest = manifestVariant((t) =>
    t.replace(/^ {2}web:\n(?: {4}.*\n)+/m, (block) => `${block}  web:\n    required: true\n`),
  )
  const res = runGate(world(), { manifest })
  assertVerdict(res, 'NOT VERIFIED', 2, /duplicate service 'web'/)
})

test('EA63-T23 a malformed digest is a usage error', () => {
  const res = runGate(world(), { digest: 'latest' })
  assertVerdict(res, 'USAGE ERROR', 3, /canonical sha256 digest/)
})

test('EA63-T24 a project that differs from the manifest is NOT VERIFIED', () => {
  const res = runGate(world(), { project: 'other-project' })
  assertVerdict(res, 'NOT VERIFIED', 2, /does not match --project|compose project/)
})

test('EA63-T25 an empty deployment ID is a usage error', () => {
  const res = runGate(world(), { deployment: '' })
  assertVerdict(res, 'USAGE ERROR', 3)
})

test('EA63-T26 a missing image-digest label fails', () => {
  const fleet = healthyFleet()
  fleet[0] = container('web', { digestLabel: '' })
  const res = runGate(world({ containers: fleet }))
  assertVerdict(res, 'FAIL', 1, /image-digest label '<none>'/)
})

test('EA63-T27 malformed docker JSON is NOT VERIFIED', () => {
  const res = runGate(world({ inspect_sequence: [{ not: 'an array' }] }))
  assertVerdict(res, 'NOT VERIFIED', 2, /malformed JSON/)
})

test('EA63-T28 duplicate container records are NOT VERIFIED', () => {
  const fleet = healthyFleet()
  const res = runGate(world({ inspect_sequence: [[...fleet, fleet[0]]] }))
  assertVerdict(res, 'NOT VERIFIED', 2, /more than once/)
})

test('EA63-T29 a tag instead of a digest-pinned reference fails', () => {
  const fleet = healthyFleet()
  fleet[0] = container('web', { reference: `${IMAGE}:staging-abc` })
  const res = runGate(world({ containers: fleet }))
  assertVerdict(res, 'FAIL', 1, /was created from 'ghcr.io\/example\/beaconhs:staging-abc'/)
})

test('EA63-T30 the manifest and compose health expectations must agree', () => {
  const config = composeConfig()
  delete config.services.worker.healthcheck
  const res = runGate(world({ compose_config: config }))
  assertVerdict(res, 'NOT VERIFIED', 2, /manifest requires health for 'worker'/)
})

test('EA63-T31 a compose service missing from the manifest is NOT VERIFIED', () => {
  const config = composeConfig()
  config.services.extra = { image: 'example/extra:latest' }
  const res = runGate(world({ compose_config: config }))
  assertVerdict(res, 'NOT VERIFIED', 2, /not registered in the manifest/)
})

test('EA63-T32 a manifest service missing from compose is NOT VERIFIED', () => {
  const config = composeConfig()
  delete config.services.minio
  const res = runGate(world({ compose_config: config }))
  assertVerdict(res, 'NOT VERIFIED', 2, /not declared in the compose file/)
})

test('EA63-T33 an expected image that is absent locally is NOT VERIFIED', () => {
  const res = runGate(world({ image_fail: true }))
  assertVerdict(res, 'NOT VERIFIED', 2, /is not present locally/)
})

test('EA63-T34 an unreadable manifest is NOT VERIFIED', () => {
  const res = runGate(world(), { manifest: join(scratch('nope'), 'missing.yaml') })
  assertVerdict(res, 'NOT VERIFIED', 2, /is not readable/)
})

test('EA63-T35 a container without a compose service label fails', () => {
  const fleet = healthyFleet()
  fleet[0] = container('web', { service: '' })
  const res = runGate(world({ containers: fleet }))
  assertVerdict(res, 'FAIL', 1, /no com\.docker\.compose\.service label/)
})

test('EA63-T36 the evidence record is emitted when requested', () => {
  const dir = scratch('json')
  const bin = installStub()
  const worldFile = join(dir, 'world.json')
  writeFileSync(worldFile, JSON.stringify(world()))
  const res = spawnSync('bash', [GATE, ...baseArgs(dir), '--json'], {
    encoding: 'utf8',
    cwd: ROOT,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      WORLD_FILE: worldFile,
      COUNTER_DIR: dir,
    },
  })
  assert.equal(res.status, 0, res.stderr)
  const record = JSON.parse(res.stdout)
  assert.equal(record.verdict, 'PASS')
  assert.equal(record.contract_version, 'ea63-compose-1')
  assert.equal(record.deployment_id, DEPLOYMENT)
  assert.equal(record.expected_digest, DIGEST)
  assert.equal(record.containers.length, 8)
})

test('EA63-T37 SIGTERM during a wait releases the lock', async () => {
  const dir = scratch('signal')
  const bin = installStub()
  const worldFile = join(dir, 'world.json')
  const fleet = healthyFleet()
  fleet[0] = container('web', { status: 'created', health: 'starting' })
  writeFileSync(worldFile, JSON.stringify(world({ containers: fleet })))
  const lock = join(dir, 'deploy.lock')

  const child = spawn('bash', [GATE, ...baseArgs(dir, { lock, timeout: 30, poll: 1 })], {
    cwd: ROOT,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      WORLD_FILE: worldFile,
      COUNTER_DIR: dir,
    },
    stdio: 'ignore',
  })
  const exited = new Promise((resolve) =>
    child.on('exit', (code, signal) => resolve(code ?? signal)),
  )
  await new Promise((resolve) => setTimeout(resolve, 400))
  child.kill('SIGTERM')
  const code = await exited

  assert.notEqual(code, 0, 'an interrupted verification must not report success')

  const after = runGate(world(), { lock })
  assertVerdict(after, 'PASS', 0)
})

// ---------------------------------------------------------------------------
// EA-64.1 — F-64-1: RestartCount is a top-level field in real `docker inspect`
// ---------------------------------------------------------------------------

function fleetWith(role, opts) {
  const fleet = healthyFleet()
  const index = fleet.findIndex((c) => c.Config.Labels['com.docker.compose.service'] === role)
  assert.notEqual(index, -1, `unknown role ${role}`)
  fleet[index] = container(role, opts)
  return fleet
}

test('EA641-T01 RestartCount 0 at the top level passes', () => {
  const res = runGate(world())
  assertVerdict(res, 'PASS', 0)
  assert.match(res.stdout, /all 8 container\(s\)/)
})

test('EA641-T02 RestartCount 1 fails', () => {
  const res = runGate(world({ containers: fleetWith('web', { restarts: 1 }) }))
  assertVerdict(res, 'FAIL', 1, /web container .* has restarted 1 time\(s\)/)
})

test('EA641-T03 RestartCount 6 fails', () => {
  const res = runGate(world({ containers: fleetWith('web', { restarts: 6 }) }))
  assertVerdict(res, 'FAIL', 1, /web container .* has restarted 6 time\(s\)/)
})

test('EA641-T04 a missing RestartCount is NOT VERIFIED', () => {
  const res = runGate(world({ containers: fleetWith('web', { restarts: OMIT }) }))
  assertVerdict(res, 'NOT VERIFIED', 2, /has no RestartCount/)
})

test('EA641-T05 a null RestartCount is NOT VERIFIED', () => {
  const res = runGate(world({ containers: fleetWith('web', { restarts: null }) }))
  assertVerdict(res, 'NOT VERIFIED', 2, /RestartCount=null/)
})

test('EA641-T06 a non-integer RestartCount is NOT VERIFIED', () => {
  const res = runGate(world({ containers: fleetWith('web', { restarts: '3' }) }))
  assertVerdict(res, 'NOT VERIFIED', 2, /non-integer RestartCount/)
})

test('EA641-T07 a negative RestartCount is NOT VERIFIED', () => {
  const res = runGate(world({ containers: fleetWith('web', { restarts: -1 }) }))
  assertVerdict(res, 'NOT VERIFIED', 2, /negative RestartCount/)
})

test('EA641-T08 a fractional RestartCount is NOT VERIFIED', () => {
  const res = runGate(world({ containers: fleetWith('web', { restarts: 1.5 }) }))
  assertVerdict(res, 'NOT VERIFIED', 2, /non-integer RestartCount/)
})

test('EA641-T09 healthcheck none plus restarts fails', () => {
  const res = runGate(world({ containers: fleetWith('collabora', { health: null, restarts: 6 }) }))
  assertVerdict(res, 'FAIL', 1, /collabora container .* has restarted 6 time\(s\)/)
})

test('EA641-T10 healthcheck required plus restarts fails', () => {
  const res = runGate(world({ containers: fleetWith('worker', { restarts: 6 }) }))
  assertVerdict(res, 'FAIL', 1, /worker container .* has restarted 6 time\(s\)/)
})

test('EA641-T11 the old wrong path State.RestartCount is no longer read', () => {
  const res = runGate(
    world({ containers: fleetWith('web', { restarts: OMIT, stateRestartCount: 0 }) }),
  )
  assertVerdict(res, 'NOT VERIFIED', 2, /has no RestartCount/)
})

// ---------------------------------------------------------------------------
// EA-64.1 — F-64-3: fixtures derived from EA-64's real inspect output
// ---------------------------------------------------------------------------

const REAL_FIXTURE_DIR = join(ROOT, 'docs/evidence/ea64/remediation/fixtures')

function loadRealFleet(name) {
  return JSON.parse(readFileSync(join(REAL_FIXTURE_DIR, name), 'utf8'))
}

function realRun(name) {
  const fleet = loadRealFleet(name)
  const labels = fleet[0].Config.Labels
  const project = labels['com.docker.compose.project']
  const reference = fleet[0].Config.Image
  const services = {}
  for (const c of fleet) {
    const svc = c.Config.Labels['com.docker.compose.service']
    // EA-64 fixtures predate the role-label requirement. Add the role label the
    // real deployment would carry, without changing any captured image/state
    // field, so the EA-64.1 regression still exercises real Docker output.
    if (!c.Config.Labels['com.beaconhs.role']) c.Config.Labels['com.beaconhs.role'] = svc
    services[svc] = {
      image: c.Config.Image,
      labels: {
        'com.beaconhs.deployment': c.Config.Labels['com.beaconhs.deployment'],
        'com.beaconhs.image-digest': c.Config.Labels['com.beaconhs.image-digest'],
        'com.beaconhs.role': svc,
      },
      ...(c.State.Health ? { healthcheck: { test: ['CMD', 'true'] } } : {}),
      ...(svc === 'scheduler' || svc === 'storage-init' ? { restart: 'no' } : {}),
    }
  }
  const manifest = manifestVariant((text) =>
    text.replace(/\n {2}postgres:[\s\S]*$/, '\n').replace(/^project: .*$/m, `project: ${project}`),
  )
  const res = runGate(
    world({
      containers: fleet,
      compose_config: { name: project, services },
      image: { Id: fleet[0].Image, RepoDigests: [reference] },
      images: { [reference]: { Id: fleet[0].Image, RepoDigests: [reference] } },
    }),
    {
      project,
      image: reference.slice(0, reference.indexOf('@')),
      digest: labels['com.beaconhs.image-digest'],
      deployment: labels['com.beaconhs.deployment'],
      manifest,
    },
  )
  return { res, fleet }
}

test('EA641-T12 the real EA-64 healthy sample passes', () => {
  const { res, fleet } = realRun('real-fleet-s1-healthy.json')
  assert.equal(fleet.length, 4)
  assertVerdict(res, 'PASS', 0)
})

test('EA641-T13 the real EA-64 crash-loop sample fails on its restart count', () => {
  const { res } = realRun('real-fleet-s4-crashloop.json')
  assertVerdict(res, 'FAIL', 1, /web container .* has restarted 6 time\(s\)/)
})

test('EA641-T14 real fixtures keep RestartCount at the top level', () => {
  for (const name of ['real-fleet-s1-healthy.json', 'real-fleet-s4-crashloop.json']) {
    const fleet = loadRealFleet(name)
    assert.ok(fleet.length > 0, name)
    for (const c of fleet) {
      assert.equal(typeof c.RestartCount, 'number', `${name}: RestartCount type`)
      assert.ok(Number.isInteger(c.RestartCount), `${name}: RestartCount is an integer`)
      assert.ok(c.RestartCount >= 0, `${name}: RestartCount is non-negative`)
      assert.equal(
        'RestartCount' in c.State,
        false,
        `${name}: Docker 29.9.2 has no State.RestartCount`,
      )
    }
  }
  const crash = loadRealFleet('real-fleet-s4-crashloop.json')
  const web = crash.find((c) => c.Config.Labels['com.docker.compose.service'] === 'web')
  assert.equal(web.RestartCount, 6)
  assert.equal(web.State.Status, 'restarting')
})

// ---------------------------------------------------------------------------
// EA-64.1 — F-64-2: registry host:port parsing
// ---------------------------------------------------------------------------

function fleetFor(image) {
  const fleet = healthyFleet()
  for (const c of fleet) {
    const role = c.Config.Labels['com.docker.compose.service']
    if (!PINNED[role]) c.Config.Image = `${image}@${DIGEST}`
  }
  return fleet
}

function composeConfigForGated(image) {
  const ref = `${image}@${DIGEST}`
  const config = composeConfig()
  for (const role of ['web', 'worker', 'scheduler', 'storage-init']) {
    config.services[role].image = ref
  }
  return config
}

function runForImage(image) {
  const ref = `${image}@${DIGEST}`
  return runGate(
    world({
      containers: fleetFor(image),
      compose_config: composeConfigForGated(image),
      images: { [ref]: { Id: IMAGE_ID, RepoDigests: [ref] } },
    }),
    { image },
  )
}

test('EA641-T15 an IPv4 registry with a port is accepted', () => {
  const res = runForImage('127.0.0.1:5055/ea64/app')
  assertVerdict(res, 'PASS', 0)
})

test('EA641-T16 a combined repository@digest matching --digest is accepted', () => {
  const res = runGate(world({ containers: fleetFor(IMAGE) }), { image: `${IMAGE}@${DIGEST}` })
  assertVerdict(res, 'PASS', 0)
})

test('EA641-T17 a combined repository@digest that differs from --digest is a usage error', () => {
  const res = runGate(world(), { image: `${IMAGE}@${OTHER_DIGEST}` })
  assertVerdict(res, 'USAGE ERROR', 3, /does not match --digest/)
})

test('EA641-T18 a GHCR repository with a multi-level path is accepted', () => {
  const res = runForImage('ghcr.io/example/team/beaconhs')
  assertVerdict(res, 'PASS', 0)
})

test('EA641-T19 localhost with a port is accepted', () => {
  const res = runForImage('localhost:5000/beaconhs')
  assertVerdict(res, 'PASS', 0)
})

test('EA641-T20 a single-label registry host with a port is accepted', () => {
  const res = runForImage('registry:5000/beaconhs')
  assertVerdict(res, 'PASS', 0)
})

test('EA641-T21 a tag on a GHCR repository is a usage error', () => {
  const res = runGate(world(), { image: `${IMAGE}:staging` })
  assertVerdict(res, 'USAGE ERROR', 3, /contains a tag/)
})

test('EA641-T22 a tag on a bare repository is a usage error', () => {
  const res = runGate(world(), { image: 'example/beaconhs:staging' })
  assertVerdict(res, 'USAGE ERROR', 3, /contains a tag/)
})

test('EA641-T23 a registry port above 65535 is a usage error', () => {
  const res = runGate(world(), { image: '127.0.0.1:70000/beaconhs' })
  assertVerdict(res, 'USAGE ERROR', 3, /must be 1-65535/)
})

test('EA641-T24 registry port 0 is a usage error', () => {
  const res = runGate(world(), { image: '127.0.0.1:0/beaconhs' })
  assertVerdict(res, 'USAGE ERROR', 3, /must be 1-65535/)
})

test('EA641-T25 a non-numeric registry port is a usage error', () => {
  const res = runGate(world(), { image: 'registry:abc/beaconhs' })
  assertVerdict(res, 'USAGE ERROR', 3, /must be 1-65535/)
})

test('EA641-T26 host:port without a repository path is a usage error', () => {
  const res = runGate(world(), { image: '127.0.0.1:5055' })
  assertVerdict(res, 'USAGE ERROR', 3, /without a repository path/)
})

test('EA641-T27 an empty path component is a usage error', () => {
  const res = runGate(world(), { image: 'ghcr.io//beaconhs' })
  assertVerdict(res, 'USAGE ERROR', 3, /empty path component/)
})

test('EA641-T28 a path component ending in an underscore is a usage error', () => {
  const res = runGate(world(), { image: 'ghcr.io/example/beaconhs_' })
  assertVerdict(res, 'USAGE ERROR', 3, /not a valid repository component/)
})

test('EA641-T29 an IPv6 registry host is explicitly rejected', () => {
  const res = runGate(world(), { image: '[::1]:5000/beaconhs' })
  assertVerdict(res, 'USAGE ERROR', 3, /IPv6 registry hosts are not supported/)
})

test('EA641-T30 an uppercase repository is a usage error', () => {
  const res = runGate(world(), { image: 'ghcr.io/example/BeaconHS' })
  assertVerdict(res, 'USAGE ERROR', 3, /lowercase repository reference/)
})

test('EA641-T31 a missing --digest is a usage error', () => {
  const res = runGate(world(), { digest: '' })
  assertVerdict(res, 'USAGE ERROR', 3, /--digest is required/)
})

test('EA641-T32 a container created from a tag on a port registry fails', () => {
  const image = '127.0.0.1:5055/ea64/app'
  const ref = `${image}@${DIGEST}`
  const fleet = fleetFor(image)
  fleet[0].Config.Image = `${image}:latest`
  const res = runGate(
    world({
      containers: fleet,
      compose_config: composeConfigForGated(image),
      images: { [ref]: { Id: IMAGE_ID, RepoDigests: [ref] } },
    }),
    { image },
  )
  assertVerdict(res, 'FAIL', 1, /was created from '127\.0\.0\.1:5055\/ea64\/app:latest'/)
})

// ---------------------------------------------------------------------------
// EA-65.1 — gated/pinned classification and deployment identity
// ---------------------------------------------------------------------------

test('EA651-T01 a gated image matching the approved digest passes', () => {
  const res = runGate(world())
  assertVerdict(res, 'PASS', 0, /gated image/)
})

test('EA651-T02 a gated image ID that differs from the approved digest fails', () => {
  const res = runGate(world({ containers: fleetWith('web', { imageId: OTHER_IMAGE_ID }) }))
  assertVerdict(res, 'FAIL', 1, /web container .* runs image 'sha256:b/)
})

test('EA651-T03 a pinned image matching its own manifest identity passes', () => {
  const res = runGate(world())
  assertVerdict(res, 'PASS', 0, /pinned identities/)
  assert.notEqual(pinnedRef('postgres'), EXPECTED_REF)
})

test('EA651-T04 a pinned image is not rejected by the gated EXPECTED_REF', () => {
  const res = runGate(world())
  assertVerdict(res, 'PASS', 0)
  assert.match(res.stdout, /all 8 container\(s\)/)
})

test('EA651-T05 a tag-only pinned image is NOT VERIFIED', () => {
  const manifest = manifestVariant((t) =>
    t.replace('expected_image: postgres\n', 'expected_image: postgres:16-alpine\n'),
  )
  const res = runGate(world(), { manifest })
  assertVerdict(res, 'NOT VERIFIED', 2, /must not contain a tag/)
})

test('EA651-T06 a pinned digest mismatch is NOT VERIFIED', () => {
  const manifest = manifestVariant((t) =>
    t.replace(
      'expected_digest: sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea',
      `expected_digest: ${OTHER_DIGEST}`,
    ),
  )
  const res = runGate(world(), { manifest })
  assertVerdict(res, 'NOT VERIFIED', 2, /is not present locally/)
})

test('EA651-T07 a pinned image absent locally is NOT VERIFIED', () => {
  const res = runGate(world({ image_fail_refs: [pinnedRef('redis')] }))
  assertVerdict(res, 'NOT VERIFIED', 2, /pinned service 'redis' image .* is not present locally/)
})

test('EA651-T08 a missing deployment label fails', () => {
  const res = runGate(world({ containers: fleetWith('web', { deployment: '' }) }))
  assertVerdict(res, 'FAIL', 1, /was created by deployment '<none>'/)
})

test('EA651-T09 a deployment ID mismatch fails', () => {
  const res = runGate(
    world({ containers: fleetWith('worker', { deployment: PREVIOUS_DEPLOYMENT }) }),
  )
  assertVerdict(res, 'FAIL', 1, /was created by deployment 'd{40}-1234567888-1'/)
})

test('EA651-T10 a missing gated image-digest label fails', () => {
  const res = runGate(world({ containers: fleetWith('web', { digestLabel: '' }) }))
  assertVerdict(res, 'FAIL', 1, /image-digest label '<none>'/)
})

test('EA651-T11 a pinned image-digest label must equal the pinned digest', () => {
  const good = runGate(world())
  assertVerdict(good, 'PASS', 0)
  const res = runGate(world({ containers: fleetWith('postgres', { digestLabel: OTHER_DIGEST }) }))
  assertVerdict(res, 'FAIL', 1, /image-digest label 'sha256:7/)
})

test('EA651-T12 a gated image-digest label must equal the approved digest', () => {
  const good = runGate(world())
  assertVerdict(good, 'PASS', 0)
  const res = runGate(world({ containers: fleetWith('web', { digestLabel: OTHER_DIGEST }) }))
  assertVerdict(res, 'FAIL', 1, /image-digest label 'sha256:7/)
})

test('EA651-T13 a missing role label fails', () => {
  const res = runGate(world({ containers: fleetWith('web', { role: '' }) }))
  assertVerdict(res, 'FAIL', 1, /role label '<none>'/)
})

test('EA651-T14 a role label that differs from the manifest fails', () => {
  const res = runGate(world({ containers: fleetWith('web', { role: 'worker' }) }))
  assertVerdict(res, 'FAIL', 1, /role label 'worker', expected 'web'/)
})

test('EA651-T15 two services with different deployment IDs fail', () => {
  const res = runGate(
    world({ containers: fleetWith('storage-init', { deployment: PREVIOUS_DEPLOYMENT }) }),
  )
  assertVerdict(res, 'FAIL', 1, /was created by deployment 'd{40}-1234567888-1'/)
})

test('EA651-T16 a one-shot task from an old deployment fails', () => {
  const res = runGate(
    world({ containers: fleetWith('scheduler', { deployment: PREVIOUS_DEPLOYMENT }) }),
  )
  assertVerdict(res, 'FAIL', 1, /was created by deployment/)
})

test('EA651-T17 a deployment ID change changes the Compose deployment label', () => {
  const first = composeConfig()
  const second = composeConfig()
  second.services.web.labels['com.beaconhs.deployment'] = PREVIOUS_DEPLOYMENT
  assert.notDeepEqual(first.services.web.labels, second.services.web.labels)
  const res = runGate(world({ compose_config: second }))
  assertVerdict(res, 'NOT VERIFIED', 2, /deployment label is .* expected/)
})

test('EA651-T18 a Compose service missing from the manifest is NOT VERIFIED', () => {
  const config = composeConfig()
  config.services.extra = { image: 'example/extra@sha256:' + '9'.repeat(64) }
  const res = runGate(world({ compose_config: config }))
  assertVerdict(res, 'NOT VERIFIED', 2, /not registered in the manifest/)
})

test('EA651-T19 a Compose image class that differs from the manifest is NOT VERIFIED', () => {
  const manifest = manifestVariant((t) =>
    t.replace(
      /  postgres:\n    role: postgres\n    image_class: pinned\n    expected_image: postgres\n    expected_digest: sha256:[0-9a-f]{64}\n/,
      '  postgres:\n    role: postgres\n    image_class: gated\n',
    ),
  )
  const res = runGate(world(), { manifest })
  assertVerdict(res, 'NOT VERIFIED', 2, /compose service 'postgres' declares image/)
})

test('EA651-T20 an unresolved Compose variable is NOT VERIFIED', () => {
  const config = composeConfig()
  config.services.web.image = '${BEACONHS_IMAGE}'
  const res = runGate(world({ compose_config: config }))
  assertVerdict(res, 'NOT VERIFIED', 2, /image is unresolved/)
})

test('EA651-T21 a duplicate manifest field is NOT VERIFIED', () => {
  const manifest = manifestVariant((t) =>
    t.replace('  web:\n    role: web\n', '  web:\n    role: web\n    role: web\n'),
  )
  const res = runGate(world(), { manifest })
  assertVerdict(res, 'NOT VERIFIED', 2, /duplicate field 'role'/)
})

test('EA651-T22 a gated service declaring expected_image is NOT VERIFIED', () => {
  const manifest = manifestVariant((t) =>
    t.replace(
      '  web:\n    role: web\n    image_class: gated\n',
      '  web:\n    role: web\n    image_class: gated\n    expected_image: alpine\n',
    ),
  )
  const res = runGate(world(), { manifest })
  assertVerdict(res, 'NOT VERIFIED', 2, /must not declare 'expected_image'/)
})

test('EA651-T23 deployment_label_required false is NOT VERIFIED', () => {
  const manifest = manifestVariant((t) =>
    t.replace(
      '  web:\n    role: web\n    image_class: gated\n    expected_container_count: 1\n    required: true\n    one_shot: false\n    health: required\n    deployment_label_required: true\n',
      '  web:\n    role: web\n    image_class: gated\n    expected_container_count: 1\n    required: true\n    one_shot: false\n    health: required\n    deployment_label_required: false\n',
    ),
  )
  const res = runGate(world(), { manifest })
  assertVerdict(res, 'NOT VERIFIED', 2, /deployment_label_required.*must be true/)
})

test('EA651-T24 a pinned service missing expected_digest is NOT VERIFIED', () => {
  const manifest = manifestVariant((t) =>
    t.replace(
      '    expected_image: postgres\n    expected_digest: sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea\n',
      '    expected_image: postgres\n',
    ),
  )
  const res = runGate(world(), { manifest })
  assertVerdict(res, 'NOT VERIFIED', 2, /pinned service 'postgres' is missing 'expected_digest'/)
})

// ---------------------------------------------------------------------------
// EA-66B.1: archive-derived source deployment identity
// ---------------------------------------------------------------------------

const SOURCE_DEPLOYMENT = 'c'.repeat(40)

test('EA66B1-G5-01 a matching source deployment label passes', () => {
  const image = {
    Id: IMAGE_ID,
    RepoDigests: [`${IMAGE}@${DIGEST}`],
    Config: { Labels: { 'com.beaconhs.deployment-id': SOURCE_DEPLOYMENT } },
  }
  const res = runGate(world({ image }), { sourceDeploymentId: SOURCE_DEPLOYMENT })
  assertVerdict(res, 'PASS', 0, /all 8 container\(s\)/)
})

test('EA66B1-G5-02 a gated image without the source deployment label is NOT VERIFIED', () => {
  const res = runGate(world(), { sourceDeploymentId: SOURCE_DEPLOYMENT })
  assertVerdict(res, 'NOT VERIFIED', 2, /carries source deployment label '<none>'/)
})

test('EA66B1-G5-03 a mismatched source deployment label is NOT VERIFIED', () => {
  const image = {
    Id: IMAGE_ID,
    RepoDigests: [`${IMAGE}@${DIGEST}`],
    Config: { Labels: { 'com.beaconhs.deployment-id': 'd'.repeat(40) } },
  }
  const res = runGate(world({ image }), { sourceDeploymentId: SOURCE_DEPLOYMENT })
  assertVerdict(res, 'NOT VERIFIED', 2, /source deployment label 'd{40}'/)
})

test('EA66B1-G5-04 a deployment id whose prefix differs is a usage error', () => {
  const res = runGate(world(), {
    sourceDeploymentId: SOURCE_DEPLOYMENT,
    deployment: `${'d'.repeat(40)}-1234567890-1`,
  })
  assertVerdict(res, 'USAGE ERROR', 3, /does not start with --source-deployment-id/)
})
