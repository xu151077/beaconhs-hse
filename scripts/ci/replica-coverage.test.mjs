// Phase EA-10 — contract tests for the replicated-task decision logic.
//
// These fixtures are deterministic task lists, NOT a Swarm. They pin what the
// gate must refuse: a partial fleet, a duplicated task, a task that is not
// running, a task that is not ready, a mixed commit, a mixed key, and a node
// scope narrower than the operator declared. The real multi-node path remains
// NOT RUN; nothing here claims otherwise.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { evaluateFleet, parseTaskInput } from './replica-coverage.mjs'

const FINGERPRINT = 'a'.repeat(32)
const OTHER = 'b'.repeat(32)

function task(overrides = {}) {
  return {
    containerId: 'c1',
    taskId: 't1',
    nodeId: 'node-a',
    state: 'running',
    ready: true,
    version: 'commit-1',
    keyState: 'build',
    ...overrides,
  }
}

test('a converged single-node fleet passes and reports its node scope', () => {
  const result = evaluateFleet({
    replicas: 2,
    expectedVersion: 'commit-1',
    expectedFingerprint: FINGERPRINT,
    tasks: [task({ taskId: 't1' }), task({ taskId: 't2', containerId: 'c2' })],
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.coverage, {
    taskCount: 2,
    distinctNodes: 1,
    nodes: ['node-a'],
    scope: 'single-node-observed',
    expectedNodes: null,
    placesUnobserved: null,
  })
})

test('a converged multi-node fleet passes and names every node', () => {
  const result = evaluateFleet({
    replicas: 2,
    expectedVersion: 'commit-1',
    expectedNodes: 2,
    tasks: [
      task({ taskId: 't1', nodeId: 'node-a' }),
      task({ taskId: 't2', nodeId: 'node-b', containerId: 'c2' }),
    ],
  })
  assert.equal(result.ok, true)
  assert.equal(result.coverage.scope, 'multi-node-observed')
  assert.deepEqual(result.coverage.nodes, ['node-a', 'node-b'])
})

test('a duplicated task id fails even when the count matches', () => {
  const result = evaluateFleet({
    replicas: 2,
    tasks: [task({ taskId: 't1' }), task({ taskId: 't1', containerId: 'c2' })],
  })
  assert.equal(result.ok, false)
  assert.ok(result.failures.some((failure) => failure.code === 'duplicate-task'))
})

test('a partial fleet fails on replica count', () => {
  const result = evaluateFleet({ replicas: 3, tasks: [task({ taskId: 't1' })] })
  assert.equal(result.ok, false)
  assert.ok(result.failures.some((failure) => failure.code === 'replica-count'))
})

test('a task that is not running fails', () => {
  const result = evaluateFleet({
    replicas: 1,
    tasks: [task({ state: 'exited' })],
  })
  assert.equal(result.ok, false)
  assert.ok(result.failures.some((failure) => failure.code === 'task-not-running'))
})

test('a task that is not ready fails', () => {
  const result = evaluateFleet({ replicas: 1, tasks: [task({ ready: false })] })
  assert.equal(result.ok, false)
  assert.ok(result.failures.some((failure) => failure.code === 'task-not-ready'))
})

test('a mixed-commit fleet fails and names the stale task', () => {
  const result = evaluateFleet({
    replicas: 2,
    expectedVersion: 'commit-2',
    tasks: [
      task({ taskId: 't1', version: 'commit-2' }),
      task({ taskId: 't2', version: 'commit-1' }),
    ],
  })
  assert.equal(result.ok, false)
  const failure = result.failures.find((entry) => entry.code === 'version-mismatch')
  assert.ok(failure)
  assert.match(failure.message, /task t2 reports version 'commit-1'/)
})

test('a mixed runtime-key fleet fails', () => {
  const result = evaluateFleet({
    replicas: 2,
    expectedFingerprint: FINGERPRINT,
    tasks: [task({ taskId: 't1', keyState: FINGERPRINT }), task({ taskId: 't2', keyState: OTHER })],
  })
  assert.equal(result.ok, false)
  assert.ok(result.failures.some((failure) => failure.code === 'fingerprint-mismatch'))
})

test('a matching runtime key passes', () => {
  const result = evaluateFleet({
    replicas: 1,
    expectedFingerprint: FINGERPRINT,
    tasks: [task({ keyState: FINGERPRINT })],
  })
  assert.equal(result.ok, true)
})

test('the build-time key is accepted without a runtime fingerprint', () => {
  const result = evaluateFleet({
    replicas: 1,
    expectedFingerprint: FINGERPRINT,
    tasks: [task({ keyState: 'build' })],
  })
  assert.equal(result.ok, true)
})

test('a task without key evidence fails', () => {
  const result = evaluateFleet({ replicas: 1, tasks: [task({ keyState: '' })] })
  assert.equal(result.ok, false)
  assert.ok(result.failures.some((failure) => failure.code === 'key-state-missing'))
})

test('fewer observed nodes than declared fails and counts the unobserved places', () => {
  const result = evaluateFleet({
    replicas: 2,
    expectedNodes: 2,
    tasks: [task({ taskId: 't1' }), task({ taskId: 't2', containerId: 'c2' })],
  })
  assert.equal(result.ok, false)
  const failure = result.failures.find((entry) => entry.code === 'node-coverage')
  assert.ok(failure)
  assert.match(failure.message, /observed on 1 node\(s\)/)
})

test('a task without a node id cannot prove placement', () => {
  const result = evaluateFleet({ replicas: 1, tasks: [task({ nodeId: '' })] })
  assert.equal(result.ok, false)
  assert.ok(result.failures.some((failure) => failure.code === 'node-unknown'))
})

test('an empty task list never passes', () => {
  const result = evaluateFleet({ replicas: 1, tasks: [] })
  assert.equal(result.ok, false)
  assert.ok(result.failures.some((failure) => failure.code === 'no-tasks'))
})

test('a non-positive replica count is a configuration failure', () => {
  const result = evaluateFleet({ replicas: 0, tasks: [] })
  assert.equal(result.ok, false)
  assert.ok(result.failures.some((failure) => failure.code === 'bad-replicas'))
})

test('NDJSON and JSON-array inputs parse identically', () => {
  const rows = [task({ taskId: 't1' }), task({ taskId: 't2', containerId: 'c2' })]
  assert.deepEqual(parseTaskInput(rows.map((row) => JSON.stringify(row)).join('\n')), rows)
  assert.deepEqual(parseTaskInput(JSON.stringify(rows)), rows)
  assert.deepEqual(parseTaskInput('   '), [])
})

test('the CLI exits 1 on a stale fleet and 0 on a converged one', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ea10-replicas-'))
  // The fixtures are derived from real docker output shapes; leaving them behind
  // would leak a directory per run.
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const bad = join(dir, 'bad.ndjson')
  writeFileSync(
    bad,
    [task({ taskId: 't1' }), task({ taskId: 't2', containerId: 'c2', version: 'old' })]
      .map((row) => JSON.stringify(row))
      .join('\n'),
  )
  const failed = spawnSync(
    process.execPath,
    [
      new URL('./replica-coverage.mjs', import.meta.url).pathname,
      'check',
      '--replicas',
      '2',
      '--version',
      'commit-1',
      bad,
    ],
    { encoding: 'utf8' },
  )
  assert.equal(failed.status, 1)
  assert.match(failed.stderr, /task t2 reports version 'old'/)

  const good = join(dir, 'good.ndjson')
  writeFileSync(good, JSON.stringify([task({ taskId: 't1' }), task({ taskId: 't2' })]))
  const output = execFileSync(
    process.execPath,
    [
      new URL('./replica-coverage.mjs', import.meta.url).pathname,
      'check',
      '--replicas',
      '2',
      '--version',
      'commit-1',
      '--fingerprint',
      FINGERPRINT,
      good,
    ],
    { encoding: 'utf8' },
  )
  assert.match(output, /2 task\(s\) on 1 node\(s\)/)
  assert.match(output, /single-node-observed/)
})
