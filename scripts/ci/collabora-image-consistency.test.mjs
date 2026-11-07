#!/usr/bin/env node
/**
 * EA-66A.1 — Collabora image consistency test.
 *
 * One immutable Collabora reference must be used by the canonical Compose file,
 * the Gate 5 manifest, and the (legacy) deploy workflow. This test is static:
 * no registry, pull, build or deployment.
 *
 * Chosen reference: collabora/code@sha256:4e983196… (26.04.4.2).
 * Evidence: local image + target image both have this digest; the registry
 * manifest resolves to an amd64 platform manifest; the older workflow tag
 * 26.04.2.1.1@sha256:df33af88… is a different, older image and is not local.
 *
 * Run: node --test scripts/ci/collabora-image-consistency.test.mjs
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const COMPOSE = join(ROOT, 'deploy/local-production.compose.yaml')
const MANIFEST = join(ROOT, 'deploy/gate5.manifest.yaml')
const WORKFLOW = join(ROOT, '.github/workflows/deploy-dev.yml')
const EXPECTED_DIGEST = 'sha256:4e983196eb9878f339cc506c38c21f1cc3473bca3d6de883c5de08f9c0cc3a6c'
const EXPECTED_REF = `collabora/code@${EXPECTED_DIGEST}`

function composeRef() {
  const text = readFileSync(COMPOSE, 'utf8')
  const match = /^  collabora:\n(?: {4}.*\n)*? {4}image:\s*(\S+)/m.exec(text)
  assert.ok(match, 'collabora service image not found')
  return match[1]
}

function manifestRef() {
  const text = readFileSync(MANIFEST, 'utf8')
  const block = /^  collabora:\n((?: {4}.*\n)+)/m.exec(text)
  assert.ok(block, 'collabora manifest block not found')
  const image = /^ {4}expected_image:\s*(\S+)$/m.exec(block[1])
  const digest = /^ {4}expected_digest:\s*(\S+)$/m.exec(block[1])
  assert.ok(image, 'collabora expected_image missing')
  assert.ok(digest, 'collabora expected_digest missing')
  return `${image[1]}@${digest[1]}`
}

function workflowRef() {
  const text = readFileSync(WORKFLOW, 'utf8')
  const match = /^ {2}COLLABORA_IMAGE:\s*(\S+)\s*$/m.exec(text)
  assert.ok(match, 'COLLABORA_IMAGE not found in deploy-dev.yml')
  return match[1]
}

test('EA661-COL-01 canonical Compose and Gate 5 manifest use the same digest', () => {
  assert.equal(composeRef(), EXPECTED_REF)
  assert.equal(manifestRef(), EXPECTED_REF)
})

test('EA661-COL-02 the legacy workflow uses the same canonical digest', () => {
  assert.equal(workflowRef(), EXPECTED_REF)
  assert.doesNotMatch(readFileSync(WORKFLOW, 'utf8'), /df33af88c59e26b7/)
})

test('EA661-COL-03 the reference is a canonical sha256 digest, not a tag', () => {
  for (const ref of [composeRef(), manifestRef(), workflowRef()]) {
    assert.match(ref, /^collabora\/code@sha256:[0-9a-f]{64}$/)
  }
  assert.match(EXPECTED_DIGEST, /^sha256:[0-9a-f]{64}$/)
})

test('EA661-COL-04 no silent tag-only Collabora fallback exists', () => {
  const compose = readFileSync(COMPOSE, 'utf8')
  assert.doesNotMatch(compose, /collabora\/code:latest/)
  assert.doesNotMatch(compose, /COLLABORA_IMAGE/)
})

test('EA661-COL-05 the local image, if present, is linux/amd64', () => {
  const result = spawnSync(
    'docker',
    ['image', 'inspect', EXPECTED_REF, '--format', '{{.Os}}/{{.Architecture}}'],
    { encoding: 'utf8', timeout: 15000 },
  )
  if (result.status !== 0) {
    // The static consistency test must not fail merely because the image was
    // not loaded on a CI runner. The EA-66A evidence records local presence.
    return
  }
  assert.equal(result.stdout.trim(), 'linux/amd64')
})
