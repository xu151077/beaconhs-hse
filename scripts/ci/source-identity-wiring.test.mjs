#!/usr/bin/env node
/**
 * EA-66B.1 — static wiring tests for the archive-derived build identity.
 *
 * These tests do not build an image. They pin the shape of the two scripts that
 * carry the fix so a later edit cannot silently reintroduce `git rev-parse HEAD`
 * as the build identity or drop the post-build verification.
 *
 * Run: node --test scripts/ci/source-identity-wiring.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const BUILD = readFileSync(join(ROOT, 'scripts/build-local-image-with-key-gate.sh'), 'utf8')
const GATE = readFileSync(join(ROOT, 'scripts/ci/reconcile-compose-digest.sh'), 'utf8')

test('EA66B1-WIRE-01 the build derives its id from the source archive helper', () => {
  assert.match(BUILD, /SOURCE_CONTEXT_ARCHIVE=/)
  assert.match(BUILD, /source-deployment-id\.mjs/)
  assert.match(BUILD, /--archive "\$SOURCE_CONTEXT_ARCHIVE"/)
  assert.match(BUILD, /--build-arg DEPLOYMENT_VERSION="\$DEPLOYMENT_ID"/)
  assert.doesNotMatch(BUILD, /--build-arg DEPLOYMENT_VERSION="?\$\(git rev-parse HEAD\)/)
})

test('EA66B1-WIRE-02 the build uses the extracted archive as the Docker context', () => {
  assert.match(BUILD, /tar "\$\{TAR_EXTRACT\[@\]\}" "\$SOURCE_CONTEXT_ARCHIVE" -C "\$CONTEXT_DIR"/)
  assert.match(BUILD, /--file "\$CONTEXT_DIR\/Dockerfile"/)
  assert.match(BUILD, /"\$CONTEXT_DIR" >"\$BUILD_LOG"/)
  assert.match(BUILD, /archive file count/)
})

test('EA66B1-WIRE-03 the image carries the same id in labels and Next.js', () => {
  assert.match(BUILD, /com\.beaconhs\.deployment-id=\$\{DEPLOYMENT_ID\}/)
  assert.match(BUILD, /com\.beaconhs\.source-archive-sha256=\$\{ARCHIVE_SHA\}/)
  assert.match(BUILD, /verify-image-identity\.mjs/)
  assert.match(BUILD, /--expect "\$DEPLOYMENT_ID"/)
  assert.match(BUILD, /source-manifest\.json/)
})

test('EA66B1-WIRE-04 the Server Action key remains a BuildKit secret only', () => {
  assert.match(BUILD, /--secret id=next_server_actions_key,src="\$KEY_FILE"/)
  assert.doesNotMatch(BUILD, /--build-arg NEXT_SERVER_ACTIONS_ENCRYPTION_KEY/)
  assert.doesNotMatch(BUILD, /echo .*NEXT_SERVER_ACTIONS_ENCRYPTION_KEY/)
  assert.match(BUILD, /grep -qF -f "\$KEY_FILE"/)
})

test('EA66B1-WIRE-05 Gate 5 can require the archive-derived image label', () => {
  assert.match(GATE, /--source-deployment-id/)
  assert.match(GATE, /SOURCE_DEPLOYMENT_ID/)
  assert.match(GATE, /com\.beaconhs\.deployment-id/)
  assert.match(GATE, /does not start with --source-deployment-id/)
})
