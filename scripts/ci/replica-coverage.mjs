#!/usr/bin/env node
// Fleet decision logic for `verify-server-action-key-gate.sh replicas <stack>`.
//
// WHY THIS IS A SEPARATE MODULE
//
// The shell gate can only enumerate what `docker ps` shows it, which on a Swarm
// node is the tasks scheduled to THAT node. Phase EA-9 confirmed the gate never
// read a task's node placement, so on a multi-node stack it silently covered a
// subset. Two things were missing: a single place that decides whether an
// observed task list is a complete, homogeneous fleet, and tests that pin the
// negative cases. This module is that place; the shell collects facts and
// delegates the decision.
//
// WHAT IT DOES *NOT* CLAIM
//
// It judges the list it is given. It cannot discover tasks on nodes it cannot
// reach, so it reports node coverage explicitly and never prints "all replicas"
// when it only saw one node's worth. `--expected-nodes` turns that from a
// report into an assertion when the operator knows the topology.
//
// INPUT (one JSON object per line, or a JSON array)
//
//   {
//     "containerId": "…",          // docker container id (diagnostics only)
//     "taskId": "…",               // com.docker.swarm.task.id — must be unique
//     "nodeId": "…",               // com.docker.swarm.node.id — coverage key
//     "state": "running",          // docker State.Status
//     "ready": true,               // readiness probe result for THIS task
//     "version": "…",              // version reported by THIS task's readiness body
//     "keyState": "build" | "<32 hex>"   // per-task Server Action key evidence
//   }
//
// `keyState: "build"` means the task logged "uses the verified build-time key";
// the immutable image gate already proved that key, so no runtime value is
// compared. A hex value is a runtime override fingerprint and must match.

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const FINGERPRINT = /^[0-9a-f]{32}$/

/**
 * Decide whether an observed task list is a complete, homogeneous, converged fleet.
 *
 * Pure and deterministic: same input, same output, no clock, no docker.
 */
export function evaluateFleet({
  replicas,
  expectedVersion = '',
  expectedFingerprint = '',
  expectedNodes = 0,
  tasks,
}) {
  const failures = []
  const fail = (code, message) => failures.push({ code, message })

  if (!Number.isInteger(replicas) || replicas < 1) {
    fail('bad-replicas', `desired replica count must be a positive integer, got ${replicas}`)
  }
  if (expectedFingerprint && !FINGERPRINT.test(expectedFingerprint)) {
    fail('bad-fingerprint', 'the expected fingerprint is not 32 hex characters')
  }
  if (expectedNodes !== 0 && (!Number.isInteger(expectedNodes) || expectedNodes < 1)) {
    fail('bad-nodes', `expected node count must be a positive integer, got ${expectedNodes}`)
  }

  const list = Array.isArray(tasks) ? tasks : []
  if (list.length === 0) fail('no-tasks', 'no web task was observed')

  const seen = new Map()
  for (const task of list) {
    const id = String(task?.taskId ?? '')
    if (!id) {
      fail('task-id-missing', 'a task has no swarm task id; the fleet cannot be identified')
      continue
    }
    seen.set(id, (seen.get(id) ?? 0) + 1)
  }
  for (const [id, count] of seen) {
    if (count > 1) fail('duplicate-task', `task ${id} was observed ${count} times`)
  }
  if (Number.isInteger(replicas) && replicas > 0 && list.length !== replicas) {
    fail(
      'replica-count',
      `observed ${list.length} task(s) but the service wants ${replicas}; refusing to certify a partial fleet`,
    )
  }

  for (const task of list) {
    const id = String(task?.taskId ?? '') || String(task?.containerId ?? 'unknown')
    const state = String(task?.state ?? '')
    if (state !== 'running') {
      fail('task-not-running', `task ${id} is '${state || 'unknown'}', not running`)
    }
    if (task?.ready !== true) {
      fail('task-not-ready', `task ${id} did not report ready`)
    }
    if (expectedVersion && String(task?.version ?? '') !== expectedVersion) {
      fail(
        'version-mismatch',
        `task ${id} reports version '${task?.version ?? 'none'}', expected '${expectedVersion}'`,
      )
    }
    const keyState = String(task?.keyState ?? '')
    if (!keyState) {
      fail('key-state-missing', `task ${id} produced no Server Action key evidence`)
    } else if (keyState !== 'build') {
      if (!FINGERPRINT.test(keyState)) {
        fail('key-state-unknown', `task ${id} reported an unrecognised key state '${keyState}'`)
      } else if (expectedFingerprint && keyState !== expectedFingerprint) {
        fail(
          'fingerprint-mismatch',
          `task ${id} uses runtime key fingerprint ${keyState}, expected ${expectedFingerprint}`,
        )
      }
    }
  }

  const nodes = [...new Set(list.map((task) => String(task?.nodeId ?? '')).filter(Boolean))].sort()
  for (const task of list) {
    if (!String(task?.nodeId ?? '')) {
      fail(
        'node-unknown',
        `task ${String(task?.taskId ?? task?.containerId ?? 'unknown')} has no node id; placement cannot be proven`,
      )
    }
  }
  if (expectedNodes !== 0 && nodes.length !== expectedNodes) {
    fail(
      'node-coverage',
      `tasks were observed on ${nodes.length} node(s) (${nodes.join(', ') || 'none'}), expected ${expectedNodes}; tasks on unobserved nodes cannot be checked`,
    )
  }

  const coverage = {
    taskCount: list.length,
    distinctNodes: nodes.length,
    nodes,
    // Deliberately not "single-node verified": this only says every task the
    // local daemon could see reported the same thing.
    scope: nodes.length === 1 ? 'single-node-observed' : 'multi-node-observed',
    expectedNodes: expectedNodes === 0 ? null : expectedNodes,
    placesUnobserved: expectedNodes === 0 ? null : Math.max(expectedNodes - nodes.length, 0),
  }

  return { ok: failures.length === 0, failures, coverage }
}

/** Parse NDJSON or a JSON array; anything else is a configuration error. */
export function parseTaskInput(text) {
  const trimmed = text.trim()
  if (!trimmed) return []
  if (trimmed.startsWith('[')) return JSON.parse(trimmed)
  return trimmed
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line))
}

function usage() {
  console.error(
    'usage: replica-coverage.mjs check --replicas <n> [--version <version>] ' +
      '[--fingerprint <32hex>] [--expected-nodes <n>] [--task <json>]... [file]',
  )
}

function parseArgs(argv) {
  const options = { replicas: 0, version: '', fingerprint: '', expectedNodes: 0, tasks: [] }
  let file = ''
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    switch (arg) {
      case '--replicas':
        options.replicas = Number(argv[++index])
        break
      case '--version':
        options.version = argv[++index] ?? ''
        break
      case '--fingerprint':
        options.fingerprint = argv[++index] ?? ''
        break
      case '--expected-nodes':
        options.expectedNodes = Number(argv[++index])
        break
      case '--task':
        options.tasks.push(JSON.parse(argv[++index] ?? '{}'))
        break
      default:
        if (arg.startsWith('--')) {
          usage()
          process.exit(2)
        }
        file = arg
    }
  }
  return { options, file }
}

function main() {
  const [command, ...rest] = process.argv.slice(2)
  if (command !== 'check') {
    usage()
    process.exit(2)
  }
  const { options, file } = parseArgs(rest)
  const fromFile = file ? parseTaskInput(readFileSync(file, 'utf8')) : []
  const tasks = [...options.tasks, ...fromFile]

  const result = evaluateFleet({
    replicas: options.replicas,
    expectedVersion: options.version,
    expectedFingerprint: options.fingerprint,
    expectedNodes: options.expectedNodes,
    tasks,
  })

  if (!result.ok) {
    for (const failure of result.failures) {
      console.error(`server-action-key-gate: ${failure.message}`)
    }
    process.exit(1)
  }

  const coverage = result.coverage
  console.log(
    `server-action-key-gate: ${coverage.taskCount} task(s) on ${coverage.distinctNodes} node(s) ` +
      `match the expected commit and key (${coverage.scope}; node ids: ${coverage.nodes.join(', ')})`,
  )
  if (coverage.placesUnobserved) {
    console.log(
      `server-action-key-gate: NOTE ${coverage.placesUnobserved} expected node(s) were not observed ` +
        'locally; this run proves only the tasks listed above',
    )
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
