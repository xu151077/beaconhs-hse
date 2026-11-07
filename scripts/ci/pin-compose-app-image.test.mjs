#!/usr/bin/env node
/**
 * EA-66A.1 — isolated tests for `pin-compose-app-image.mjs`.
 *
 * No build, no pull, no deployment. The helper is exercised against the real
 * drill Compose fixture and against small invalid fixtures. When Docker Compose
 * is available, the rendered result is also passed through `docker compose
 * config` (config-only; no containers).
 *
 * Run: node --test scripts/ci/pin-compose-app-image.test.mjs
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const HELPER = join(ROOT, 'scripts/ci/pin-compose-app-image.mjs')
const MANIFEST = join(ROOT, 'deploy/gate5.manifest.yaml')
const DRILL = join(ROOT, 'deploy/drill-20261009.compose.yaml')
const IMAGE = 'beaconhs:ea661-test'
const APP_SERVICES = ['web', 'worker', 'scheduler', 'storage-init']
const PINNED_OR_OTHER = ['postgres', 'redis', 'minio', 'mailpit', 'collabora']

const scratchDirs = []
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'ea661-pin-'))
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

function runHelper(input, options = {}) {
  return spawnSync(
    'node',
    [HELPER, '--manifest', options.manifest ?? MANIFEST, '--image', options.image ?? IMAGE],
    {
      cwd: ROOT,
      input,
      encoding: 'utf8',
      timeout: 30000,
    },
  )
}

/** Strict subset parser mirroring the helper's target shape. */
function parseImages(text) {
  const services = new Map()
  const images = new Map()
  let inServices = false
  let current = null
  for (const line of text.split('\n')) {
    if (/^services:\s*(?:#.*)?$/.test(line)) {
      inServices = true
      current = null
      continue
    }
    if (inServices && /^\S/.test(line)) {
      inServices = false
      current = null
      continue
    }
    if (!inServices) continue
    const serviceMatch = /^  ([A-Za-z0-9_.-]+):\s*(?:#.*)?$/.exec(line)
    if (serviceMatch) {
      current = serviceMatch[1]
      assert.equal(services.has(current), false, `duplicate service ${current}`)
      services.set(current, true)
      continue
    }
    if (!current) continue
    const imageMatch = /^    image:\s*(\S+)/.exec(line)
    if (imageMatch) images.set(current, imageMatch[1])
  }
  return { services, images }
}

function stripApplicationImages(text) {
  let inServices = false
  let current = null
  return text
    .split('\n')
    .map((line) => {
      if (/^services:\s*(?:#.*)?$/.test(line)) {
        inServices = true
        current = null
        return line
      }
      if (inServices && /^\S/.test(line)) {
        inServices = false
        current = null
        return line
      }
      if (!inServices) return line
      const serviceMatch = /^  ([A-Za-z0-9_.-]+):\s*(?:#.*)?$/.exec(line)
      if (serviceMatch) {
        current = serviceMatch[1]
        return line
      }
      if (current && APP_SERVICES.includes(current) && /^    image:/.test(line)) {
        return '    image: <application-image>'
      }
      return line
    })
    .join('\n')
}

const DRILL_TEXT = readFileSync(DRILL, 'utf8')

test('EA661-PIN-01 pins only the gated application services', () => {
  const before = parseImages(DRILL_TEXT)
  const result = runHelper(DRILL_TEXT)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stderr, '')
  const after = parseImages(result.stdout)

  assert.equal(after.services.size, before.services.size)
  assert.deepEqual([...after.services.keys()], [...before.services.keys()])
  for (const service of APP_SERVICES) {
    assert.equal(after.images.get(service), IMAGE, service)
  }
  for (const service of PINNED_OR_OTHER) {
    assert.equal(after.images.get(service), before.images.get(service), service)
  }
})

test('EA661-PIN-02 preserves every non-application line', () => {
  const result = runHelper(DRILL_TEXT)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(stripApplicationImages(result.stdout), stripApplicationImages(DRILL_TEXT))
})

test('EA661-PIN-03 preserves service count and service set', () => {
  const before = parseImages(DRILL_TEXT)
  const result = runHelper(DRILL_TEXT)
  const after = parseImages(result.stdout)
  assert.equal(after.services.size, before.services.size)
  assert.deepEqual([...after.services.keys()].sort(), [...before.services.keys()].sort())
})

test('EA661-PIN-04 a missing gated service fails without output', () => {
  const withoutWorker = DRILL_TEXT.replace(/\n  worker:\n(?: {4}.*\n|\n)*?(?=  postgres:)/, '\n')
  assert.notEqual(withoutWorker, DRILL_TEXT)
  const result = runHelper(withoutWorker)
  assert.notEqual(result.status, 0)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /gated service 'worker' is missing/)
})

test('EA661-PIN-05 a duplicate image field fails without output', () => {
  const duplicate = DRILL_TEXT.replace(
    '  web:\n    image: beaconhs:drill-20261009\n',
    '  web:\n    image: beaconhs:drill-20261009\n    image: beaconhs:other\n',
  )
  const result = runHelper(duplicate)
  assert.notEqual(result.status, 0)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /duplicate image field for service 'web'/)
})

test('EA661-PIN-06 an unsafe image reference is rejected', () => {
  const result = runHelper(DRILL_TEXT, { image: 'beaconhs:test; rm -rf /' })
  assert.notEqual(result.status, 0)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /unsafe image reference/)
})

test('EA661-PIN-07 a manifest with no gated service is rejected', () => {
  const dir = scratch()
  const manifest = join(dir, 'no-gated.yaml')
  writeFileSync(
    manifest,
    `project: p\ncompose_file: c\nservices:\n  web:\n    role: web\n    image_class: pinned\n`,
  )
  const result = runHelper(DRILL_TEXT, { manifest })
  assert.notEqual(result.status, 0)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /declares no gated services/)
})

function composeAvailable() {
  const result = spawnSync('docker', ['compose', 'version'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 15000,
  })
  return result.status === 0
}

const COMPOSE_SKIP = composeAvailable() ? {} : { skip: 'docker compose is not available' }

test('EA661-PIN-08 the rendered file passes docker compose config', COMPOSE_SKIP, () => {
  const dir = scratch()
  const rendered = runHelper(DRILL_TEXT)
  assert.equal(rendered.status, 0, rendered.stderr)
  const file = join(dir, 'compose.yaml')
  const envFile = join(dir, 'test.env')
  writeFileSync(file, rendered.stdout)
  writeFileSync(
    envFile,
    [
      'APP_VERSION=51a899b7aac0a942da327222a3eed355fca9798a',
      'DRILL_APP_PASSWORD=test-app',
      'DRILL_APP_URL=http://127.0.0.1:3010',
      'DRILL_ATTACHMENT_CAPABILITY_SECRET=test-attachment',
      'DRILL_BETTER_AUTH_SECRET=test-auth',
      'DRILL_MIGRATOR_PASSWORD=test-migrator',
      'DRILL_MINIO_SECRET=test-minio',
      'DRILL_POSTGRES_PASSWORD=test-postgres',
      'DRILL_SUPER_PASSWORD=test-super',
      '',
    ].join('\n'),
  )
  const config = spawnSync(
    'docker',
    ['compose', '-f', file, '--env-file', envFile, 'config', '--format', 'json'],
    { cwd: dir, encoding: 'utf8', timeout: 30000 },
  )
  assert.equal(config.status, 0, config.stderr)
  const parsed = JSON.parse(config.stdout)
  assert.deepEqual(
    Object.keys(parsed.services).sort(),
    [...parseImages(DRILL_TEXT).services.keys()].sort(),
  )
  for (const service of APP_SERVICES) assert.equal(parsed.services[service].image, IMAGE)
  for (const service of PINNED_OR_OTHER) {
    assert.equal(
      parsed.services[service].image,
      parseImages(DRILL_TEXT).images.get(service),
      service,
    )
  }
})
