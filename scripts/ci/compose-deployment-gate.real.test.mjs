#!/usr/bin/env node
/**
 * EA-65.1 — real Docker/Compose tests for gated/pinned classification and the
 * deployment-identity labels.
 *
 * These tests are deliberately separate from the fixture suite: they create a
 * real isolated Compose project, start real containers, render Compose with
 * real variable interpolation, and run the real verifier. They skip (with a
 * named reason) when no Docker daemon or required public test images exist.
 *
 * Run: node --test scripts/ci/compose-deployment-gate.real.test.mjs
 *
 * Isolation: unique project name, project-scoped network and volume, no
 * published ports, no production volumes, no GHCR, no database or object-store
 * data. The test images are public and already present on the host:
 *   - alpine@sha256:294b683c…  (gated)
 *   - postgres@sha256:721873c3… (pinned)
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const GATE = join(ROOT, 'scripts/ci/reconcile-compose-digest.sh')
const GATED_IMAGE = 'alpine'
const GATED_DIGEST = 'sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6'
const PINNED_IMAGE = 'postgres'
const PINNED_DIGEST = 'sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea'
const GATED_REF = `${GATED_IMAGE}@${GATED_DIGEST}`
const PINNED_REF = `${PINNED_IMAGE}@${PINNED_DIGEST}`
const DEPLOYMENT = `${'a'.repeat(40)}-6510000001-1`
const OTHER_DEPLOYMENT = `${'b'.repeat(40)}-6510000002-1`
const OTHER_DIGEST = `sha256:${'9'.repeat(64)}`

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    encoding: 'utf8',
    cwd: opts.cwd ?? ROOT,
    env: { ...process.env, ...(opts.env ?? {}) },
    timeout: opts.timeout ?? 120000,
  })
}

function skipReason() {
  const info = run('docker', ['info'])
  if (info.status !== 0) return 'Docker daemon is not available'
  const compose = run('docker', ['compose', 'version'])
  if (compose.status !== 0) return 'Docker Compose is not available'
  for (const ref of [GATED_REF, PINNED_REF]) {
    if (run('docker', ['image', 'inspect', ref]).status !== 0) {
      return `required test image is not present locally: ${ref}`
    }
  }
  return ''
}

const SKIP = skipReason()
const TEST_OPTS = SKIP ? { skip: SKIP } : {}

function projectName(suffix) {
  return `beaconhs-ea651-${suffix}-${process.pid}-${Date.now()}`.toLowerCase()
}

function composeText(name) {
  return `name: ${name}

services:
  web:
    image: ${GATED_REF}
    command: ["sleep", "3600"]
    labels:
      com.beaconhs.deployment: "\${EA651_DEPLOYMENT_ID:?deployment required}"
      com.beaconhs.image-digest: "\${EA651_GATED_DIGEST:?gated digest required}"
      com.beaconhs.role: "web"
    healthcheck:
      test: ["CMD", "true"]
      interval: 1s
      timeout: 1s
      retries: 3
      start_period: 0s
    volumes:
      - ea651-data:/data
  worker:
    image: ${GATED_REF}
    command: ["sleep", "3600"]
    labels:
      com.beaconhs.deployment: "\${EA651_DEPLOYMENT_ID:?deployment required}"
      com.beaconhs.image-digest: "\${EA651_GATED_DIGEST:?gated digest required}"
      com.beaconhs.role: "worker"
    healthcheck:
      test: ["CMD", "true"]
      interval: 1s
      timeout: 1s
      retries: 3
      start_period: 0s
  scheduler:
    image: ${GATED_REF}
    command: ["true"]
    labels:
      com.beaconhs.deployment: "\${EA651_DEPLOYMENT_ID:?deployment required}"
      com.beaconhs.image-digest: "\${EA651_GATED_DIGEST:?gated digest required}"
      com.beaconhs.role: "scheduler"
    restart: "no"
  postgres:
    image: ${PINNED_REF}
    command: ["sleep", "3600"]
    labels:
      com.beaconhs.deployment: "\${EA651_DEPLOYMENT_ID:?deployment required}"
      com.beaconhs.image-digest: "${PINNED_DIGEST}"
      com.beaconhs.role: "postgres"
    healthcheck:
      test: ["CMD", "true"]
      interval: 1s
      timeout: 1s
      retries: 3
      start_period: 0s

volumes:
  ea651-data:
`
}

function manifestText(project, composeFile) {
  return `project: ${project}
compose_file: ${composeFile}

services:
  web:
    role: web
    image_class: gated
    expected_container_count: 1
    required: true
    one_shot: false
    health: required
    deployment_label_required: true
    image_digest_label_required: true
  worker:
    role: worker
    image_class: gated
    expected_container_count: 1
    required: true
    one_shot: false
    health: required
    deployment_label_required: true
    image_digest_label_required: true
  scheduler:
    role: scheduler
    image_class: gated
    expected_container_count: 1
    required: true
    one_shot: true
    health: none
    expected_exit_code: 0
    deployment_label_required: true
    image_digest_label_required: true
  postgres:
    role: postgres
    image_class: pinned
    expected_image: ${PINNED_IMAGE}
    expected_digest: ${PINNED_DIGEST}
    expected_container_count: 1
    required: true
    one_shot: false
    health: required
    deployment_label_required: true
    image_digest_label_required: true
`
}

function runVerifier({
  project,
  composeFile,
  manifest,
  deployment = DEPLOYMENT,
  digest = GATED_DIGEST,
  env = {},
}) {
  return run(
    'bash',
    [
      GATE,
      '--project',
      project,
      '--image',
      GATED_IMAGE,
      '--digest',
      digest,
      '--deployment-id',
      deployment,
      '--manifest',
      manifest,
      '--compose-file',
      composeFile,
      '--lock',
      join(dirname(composeFile), 'gate.lock'),
      '--timeout',
      '60',
      '--poll-interval',
      '1',
      '--json',
    ],
    {
      env: {
        EA651_DEPLOYMENT_ID: deployment,
        EA651_GATED_DIGEST: digest,
        ...env,
      },
    },
  )
}

test('EA651-REAL-01 isolated gated + pinned Compose fleet passes Gate 5', TEST_OPTS, () => {
  const dir = mkdtempSync(join(tmpdir(), 'ea651-real-'))
  const project = projectName('pass')
  const composeFile = join(dir, 'compose.yaml')
  const manifest = join(dir, 'manifest.yaml')
  const composeEnv = {
    EA651_DEPLOYMENT_ID: DEPLOYMENT,
    EA651_GATED_DIGEST: GATED_DIGEST,
  }
  writeFileSync(composeFile, composeText(project))
  writeFileSync(manifest, manifestText(project, composeFile))
  const cleanup = () => {
    run('docker', ['compose', '-f', composeFile, '-p', project, 'down', '-v', '--remove-orphans'], {
      cwd: dir,
      env: composeEnv,
    })
    rmSync(dir, { recursive: true, force: true })
  }

  try {
    const up = run(
      'docker',
      ['compose', '-f', composeFile, '-p', project, 'up', '-d', '--pull', 'never'],
      { cwd: dir, env: composeEnv },
    )
    assert.equal(up.status, 0, `compose up failed\nstdout:\n${up.stdout}\nstderr:\n${up.stderr}`)

    const result = runVerifier({ project, composeFile, manifest, env: composeEnv })
    assert.equal(
      result.status,
      0,
      `verifier failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    )
    const record = JSON.parse(result.stdout)
    assert.equal(record.verdict, 'PASS')
    assert.equal(record.containers.length, 4)
    assert.equal(record.services.web.image_class, 'gated')
    assert.equal(record.services.postgres.image_class, 'pinned')
    assert.equal(record.services.postgres.expected_reference, PINNED_REF)
    assert.ok(record.containers.every((c) => c.restarts === 0))

    const inspect = run('docker', ['inspect', ...record.containers.map((c) => c.id)])
    assert.equal(inspect.status, 0)
    const bodies = JSON.parse(inspect.stdout)
    for (const body of bodies) {
      const service = body.Config.Labels['com.docker.compose.service']
      assert.equal(body.Config.Labels['com.beaconhs.deployment'], DEPLOYMENT, service)
      assert.equal(body.Config.Labels['com.beaconhs.role'], service, service)
      assert.equal(
        body.Config.Labels['com.beaconhs.image-digest'],
        service === 'postgres' ? PINNED_DIGEST : GATED_DIGEST,
        service,
      )
    }
  } finally {
    cleanup()
  }
})

test('EA651-REAL-02 a different deployment ID is rejected', TEST_OPTS, () => {
  const dir = mkdtempSync(join(tmpdir(), 'ea651-real-'))
  const project = projectName('deploy')
  const composeFile = join(dir, 'compose.yaml')
  const manifest = join(dir, 'manifest.yaml')
  const composeEnv = {
    EA651_DEPLOYMENT_ID: DEPLOYMENT,
    EA651_GATED_DIGEST: GATED_DIGEST,
  }
  writeFileSync(composeFile, composeText(project))
  writeFileSync(manifest, manifestText(project, composeFile))
  const cleanup = () => {
    run('docker', ['compose', '-f', composeFile, '-p', project, 'down', '-v', '--remove-orphans'], {
      cwd: dir,
      env: composeEnv,
    })
    rmSync(dir, { recursive: true, force: true })
  }

  try {
    const up = run(
      'docker',
      ['compose', '-f', composeFile, '-p', project, 'up', '-d', '--pull', 'never'],
      { cwd: dir, env: composeEnv },
    )
    assert.equal(up.status, 0, `compose up failed: ${up.stderr}`)

    const result = runVerifier({
      project,
      composeFile,
      manifest,
      deployment: OTHER_DEPLOYMENT,
      env: { EA651_DEPLOYMENT_ID: OTHER_DEPLOYMENT },
    })
    assert.equal(result.status, 1, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
    assert.match(result.stdout, /was created by deployment/)
  } finally {
    cleanup()
  }
})

test('EA651-REAL-03 a different gated digest is NOT VERIFIED', TEST_OPTS, () => {
  const dir = mkdtempSync(join(tmpdir(), 'ea651-real-'))
  const project = projectName('digest')
  const composeFile = join(dir, 'compose.yaml')
  const manifest = join(dir, 'manifest.yaml')
  const composeEnv = {
    EA651_DEPLOYMENT_ID: DEPLOYMENT,
    EA651_GATED_DIGEST: GATED_DIGEST,
  }
  writeFileSync(composeFile, composeText(project))
  writeFileSync(manifest, manifestText(project, composeFile))
  const cleanup = () => {
    run('docker', ['compose', '-f', composeFile, '-p', project, 'down', '-v', '--remove-orphans'], {
      cwd: dir,
      env: composeEnv,
    })
    rmSync(dir, { recursive: true, force: true })
  }

  try {
    const up = run(
      'docker',
      ['compose', '-f', composeFile, '-p', project, 'up', '-d', '--pull', 'never'],
      { cwd: dir, env: composeEnv },
    )
    assert.equal(up.status, 0, `compose up failed: ${up.stderr}`)

    const result = runVerifier({
      project,
      composeFile,
      manifest,
      digest: OTHER_DIGEST,
      env: { EA651_GATED_DIGEST: OTHER_DIGEST },
    })
    assert.equal(result.status, 2, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
    assert.match(
      result.stdout + result.stderr,
      /is not present locally|image is unresolved|declares image/,
    )
  } finally {
    cleanup()
  }
})

test('EA651-REAL-04 a deployment ID change changes the rendered Compose config', TEST_OPTS, () => {
  const dir = mkdtempSync(join(tmpdir(), 'ea651-real-'))
  const project = projectName('config')
  const composeFile = join(dir, 'compose.yaml')
  writeFileSync(composeFile, composeText(project))
  try {
    const render = (id) => {
      const result = run(
        'docker',
        ['compose', '-f', composeFile, '-p', project, 'config', '--format', 'json'],
        {
          cwd: dir,
          env: { EA651_DEPLOYMENT_ID: id, EA651_GATED_DIGEST: GATED_DIGEST },
        },
      )
      assert.equal(result.status, 0, result.stderr)
      return JSON.parse(result.stdout)
    }
    const first = render(DEPLOYMENT)
    const second = render(OTHER_DEPLOYMENT)
    assert.equal(first.services.web.labels['com.beaconhs.deployment'], DEPLOYMENT)
    assert.equal(second.services.web.labels['com.beaconhs.deployment'], OTHER_DEPLOYMENT)
    assert.notEqual(
      first.services.web.labels['com.beaconhs.deployment'],
      second.services.web.labels['com.beaconhs.deployment'],
    )
    assert.equal(first.services.web.image, GATED_REF)
    assert.equal(first.services.postgres.image, PINNED_REF)
    assert.equal(first.services.postgres.labels['com.beaconhs.image-digest'], PINNED_DIGEST)
    assert.equal(first.services.scheduler.restart, 'no')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('EA651-REAL-05 a missing required Compose variable is refused', TEST_OPTS, () => {
  const dir = mkdtempSync(join(tmpdir(), 'ea651-real-'))
  const project = projectName('missing')
  const composeFile = join(dir, 'compose.yaml')
  writeFileSync(composeFile, composeText(project))
  try {
    const result = run(
      'docker',
      ['compose', '-f', composeFile, '-p', project, 'config', '--format', 'json'],
      { cwd: dir, env: { EA651_GATED_DIGEST: GATED_DIGEST } },
    )
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /required variable EA651_DEPLOYMENT_ID is missing a value/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('EA651-REAL-06 a missing role label fails after a real deployment', TEST_OPTS, () => {
  const dir = mkdtempSync(join(tmpdir(), 'ea651-real-'))
  const project = projectName('role')
  const composeFile = join(dir, 'compose.yaml')
  const manifest = join(dir, 'manifest.yaml')
  const composeEnv = {
    EA651_DEPLOYMENT_ID: DEPLOYMENT,
    EA651_GATED_DIGEST: GATED_DIGEST,
  }
  const broken = composeText(project).replace(
    '      com.beaconhs.role: "worker"\n',
    '      com.beaconhs.role: ""\n',
  )
  writeFileSync(composeFile, broken)
  writeFileSync(manifest, manifestText(project, composeFile))
  const cleanup = () => {
    run('docker', ['compose', '-f', composeFile, '-p', project, 'down', '-v', '--remove-orphans'], {
      cwd: dir,
      env: composeEnv,
    })
    rmSync(dir, { recursive: true, force: true })
  }

  try {
    const up = run(
      'docker',
      ['compose', '-f', composeFile, '-p', project, 'up', '-d', '--pull', 'never'],
      { cwd: dir, env: composeEnv },
    )
    assert.equal(up.status, 0, `compose up failed: ${up.stderr}`)

    const result = runVerifier({ project, composeFile, manifest, env: composeEnv })
    assert.equal(result.status, 2, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
    assert.match(result.stdout, /role label is '<none>'/)
  } finally {
    cleanup()
  }
})
