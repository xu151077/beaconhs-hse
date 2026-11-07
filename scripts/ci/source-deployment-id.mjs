#!/usr/bin/env node
/**
 * Derive the build deployment identity from the actual source archive.
 *
 * WHY THIS EXISTS
 *
 * EA-66B found that `scripts/build-local-image-with-key-gate.sh` stamped
 * `git rev-parse HEAD` into the image while building the dirty working tree.
 * The image therefore claimed a revision whose content it did not contain.
 *
 * The authoritative input is the source archive that is used as the Docker
 * build context. This helper binds the deployment identity to that archive:
 *
 *   deployment_id = sha256(
 *     "beaconhs-source-deployment-id-v1\n" +
 *     "archive_sha256=<archive sha256>\n" +
 *     "release=<release label>\n"
 *   )[0:40]
 *
 * The result is 40 lowercase hex, so it satisfies the Dockerfile's
 * `^[0-9a-f]{40}$` assertion and Next.js's `deploymentId` contract.
 *
 * Git HEAD is deliberately NOT part of the derivation:
 *
 *   - the same archive always produces the same deployment id;
 *   - a HEAD change with an unchanged archive does not change the id;
 *   - any archive change changes the id.
 *
 * HEAD, branch and cleanliness are recorded in the source manifest as
 * provenance metadata, not as the identity.
 *
 * USAGE
 *   node source-deployment-id.mjs --archive <file> [--release <label>] \
 *        [--git-head <sha>] [--git-branch <name>] [--worktree-clean true|false] \
 *        [--manifest <path>] [--json]
 *
 * Exit codes: 0 success, 2 usage/IO error.
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import process from 'node:process'

const ALGORITHM = 'beaconhs-source-deployment-id/1'
const SCHEMA = 'beaconhs-source-manifest/1'
const ID_RE = /^[0-9a-f]{40}$/
const HEAD_RE = /^[0-9a-f]{40}$/
const RELEASE_RE = /^[A-Za-z0-9._-]{1,64}$/

function fail(message) {
  console.error(`source-deployment-id: ${message}`)
  process.exit(2)
}

function parseArgs(argv) {
  const out = {
    archive: '',
    release: 'local',
    gitHead: '',
    gitBranch: '',
    worktreeClean: '',
    manifest: '',
    json: false,
    cwd: process.cwd(),
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    switch (arg) {
      case '--archive':
        out.archive = argv[index + 1] ?? ''
        index += 1
        break
      case '--release':
        out.release = argv[index + 1] ?? ''
        index += 1
        break
      case '--git-head':
        out.gitHead = argv[index + 1] ?? ''
        index += 1
        break
      case '--git-branch':
        out.gitBranch = argv[index + 1] ?? ''
        index += 1
        break
      case '--worktree-clean':
        out.worktreeClean = argv[index + 1] ?? ''
        index += 1
        break
      case '--manifest':
        out.manifest = argv[index + 1] ?? ''
        index += 1
        break
      case '--cwd':
        out.cwd = argv[index + 1] ?? process.cwd()
        index += 1
        break
      case '--json':
        out.json = true
        break
      case '--help':
      case '-h':
        console.log(
          'usage: node source-deployment-id.mjs --archive <file> [--release <label>] ' +
            '[--git-head <sha>] [--git-branch <name>] [--worktree-clean true|false] ' +
            '[--manifest <path>] [--json]',
        )
        process.exit(0)
        break
      default:
        fail(`unknown argument '${arg}'`)
    }
  }
  if (!out.archive) fail('--archive is required')
  if (!RELEASE_RE.test(out.release)) {
    fail(`--release '${out.release}' must match ${RELEASE_RE}`)
  }
  if (out.gitHead && !HEAD_RE.test(out.gitHead)) {
    fail(`--git-head '${out.gitHead}' is not 40 lowercase hex`)
  }
  if (out.worktreeClean && out.worktreeClean !== 'true' && out.worktreeClean !== 'false') {
    fail("--worktree-clean must be 'true' or 'false'")
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
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim(),
    }
  } catch {
    return { ok: false, out: '' }
  }
}

function sha256File(path) {
  const hash = createHash('sha256')
  hash.update(readFileSync(path))
  return hash.digest('hex')
}

function deriveDeploymentId(archiveSha256, release) {
  const material = [
    'beaconhs-source-deployment-id-v1',
    `archive_sha256=${archiveSha256}`,
    `release=${release}`,
    '',
  ].join('\n')
  return createHash('sha256').update(material, 'utf8').digest('hex').slice(0, 40)
}

const args = parseArgs(process.argv.slice(2))
const archivePath = resolve(args.cwd, args.archive)

let archiveStat
try {
  archiveStat = statSync(archivePath)
} catch (error) {
  fail(`cannot stat archive '${archivePath}': ${error.message}`)
}
if (!archiveStat.isFile()) fail(`archive '${archivePath}' is not a regular file`)
if (archiveStat.size === 0) fail(`archive '${archivePath}' is empty`)

const archiveSha256 = sha256File(archivePath)

let gitHead = args.gitHead
let gitBranch = args.gitBranch
let worktreeClean = args.worktreeClean === '' ? null : args.worktreeClean === 'true' ? true : false

if (!gitHead) {
  const head = git(['rev-parse', 'HEAD'], args.cwd)
  gitHead = head.ok && HEAD_RE.test(head.out) ? head.out : null
}
if (!gitBranch) {
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], args.cwd)
  gitBranch = branch.ok ? branch.out : null
}
if (worktreeClean === null) {
  const status = git(['status', '--porcelain'], args.cwd)
  worktreeClean = status.ok ? status.out === '' : null
}

const deploymentId = deriveDeploymentId(archiveSha256, args.release)
if (!ID_RE.test(deploymentId)) {
  fail(`derived deployment id '${deploymentId}' is not 40 lowercase hex`)
}

const result = {
  schema: ALGORITHM,
  algorithm: ALGORITHM,
  release: args.release,
  deployment_id: deploymentId,
  source_archive: {
    path: archivePath,
    sha256: archiveSha256,
    bytes: archiveStat.size,
  },
  git_head: gitHead,
  git_branch: gitBranch,
  worktree_clean: worktreeClean,
  derivation:
    "sha256('beaconhs-source-deployment-id-v1\\narchive_sha256=<archive sha256>\\nrelease=<release>\\n')[0:40]",
}

if (args.manifest) {
  const manifest = {
    schema: SCHEMA,
    captured_at_utc: new Date().toISOString(),
    git_head: gitHead,
    git_branch: gitBranch,
    worktree_clean: worktreeClean,
    source_archive: result.source_archive,
    deployment: {
      algorithm: ALGORITHM,
      release: args.release,
      deployment_id: deploymentId,
      derivation: result.derivation,
    },
    build_args: {
      DEPLOYMENT_VERSION: deploymentId,
    },
  }
  try {
    mkdirSync(dirname(resolve(args.cwd, args.manifest)), { recursive: true })
    writeFileSync(resolve(args.cwd, args.manifest), `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
    })
    chmodSync(resolve(args.cwd, args.manifest), 0o600)
  } catch (error) {
    fail(`cannot write manifest '${args.manifest}': ${error.message}`)
  }
}

if (args.json) {
  console.log(JSON.stringify(result, null, 2))
} else {
  console.log(deploymentId)
}
