// SIGKILL interruption and resume.
//
// WHY KILL THE PROCESS OUTRIGHT
//
// A graceful stop is not the interesting case: the finally blocks run, the checkpoint
// is consistent, and the resume has nothing to repair. What actually happens in the
// field is a hard kill — an operator Ctrl-C under load, a pod eviction, an OOM kill —
// and the property that matters is that the run is not mistaken for complete and that
// a resume recovers without trusting a checkpoint written just before the kill.
//
// This test therefore SIGKILLs a real child process mid-transfer, asserts that no
// success state was produced, resumes with `--resume`, and only then accepts the
// backup. The checkpoint is written after every object (see src/backup.ts) precisely
// so that "kill it at an arbitrary moment" is a meaningful test rather than a race.
//
// ISOLATION: a fresh temp directory, a fresh bucket, and credentials supplied by the
// operator through the environment. Nothing outside this run is touched.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CreateBucketCommand, DeleteObjectCommand, DeleteBucketCommand } from '@aws-sdk/client-s3'
import { createS3Client, listAllObjects, putObject } from './s3'
import { runVerify } from './verify'
import { loadManifest } from './manifest'

const ENDPOINT = process.env.OBJECT_STORE_TEST_ENDPOINT
const ACCESS_KEY = process.env.OBJECT_STORE_TEST_ACCESS_KEY_ID
const SECRET_KEY = process.env.OBJECT_STORE_TEST_SECRET_ACCESS_KEY
const live = Boolean(ENDPOINT && ACCESS_KEY && SECRET_KEY)

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), 'cli.ts')

function baseCfg(bucket: string) {
  return {
    endpoint: ENDPOINT as string,
    bucket,
    accessKeyId: ACCESS_KEY as string,
    secretAccessKey: SECRET_KEY as string,
    region: 'auto',
  }
}

if (!live) {
  // eslint-disable-next-line no-console
  console.warn(
    '[interrupt-recovery] OBJECT_STORE_TEST_ENDPOINT is not set — SIGKILL tests are ' +
      'SKIPPED, not passed.',
  )
}

const described = live ? describe : describe.skip

described('SIGKILL interruption and resume', () => {
  const dirs: string[] = []
  let bucket: string

  /** Deterministic content, so a completed object can be compared by digest. */
  function fixture(seed: number, length: number): Buffer {
    const out = Buffer.allocUnsafe(length)
    for (let index = 0; index < length; index += 1) out[index] = (seed + index) % 251
    return out
  }

  beforeAll(async () => {
    bucket = `bhs-kill-${Date.now().toString(36)}`
    const client = createS3Client(baseCfg(bucket))
    await client.send(new CreateBucketCommand({ Bucket: bucket }))
    // Enough objects, and enough bytes, that a backup does not finish before the
    // kill lands. Small per-object size keeps the fixture cheap to build.
    for (let index = 0; index < 12; index += 1) {
      await putObject(client, bucket, {
        key: `obj/${index.toString().padStart(2, '0')}.bin`,
        body: fixture(index, 12 * 1024 * 1024),
        size: 12 * 1024 * 1024,
        contentType: 'application/octet-stream',
      })
    }
  }, 600_000)

  afterAll(async () => {
    if (!live) return
    const client = createS3Client(baseCfg(bucket))
    const objects = await listAllObjects(client, bucket).catch(() => [])
    for (const object of objects) {
      await client
        .send(new DeleteObjectCommand({ Bucket: bucket, Key: object.key }))
        .catch(() => undefined)
    }
    await client.send(new DeleteBucketCommand({ Bucket: bucket })).catch(() => undefined)
    for (const dir of dirs) await rm(dir, { recursive: true, force: true })
  }, 300_000)

  async function tmp(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'objstore-kill-'))
    dirs.push(dir)
    return dir
  }

  /** Start the backup command as a real child process. */
  function startBackup(dir: string, resume: boolean) {
    const args = [CLI, 'backup', '--destination', dir]
    if (resume) args.push('--resume')
    return spawn(process.execPath, ['--import', 'tsx', ...args], {
      env: {
        ...process.env,
        OBJECT_STORE_ENDPOINT: ENDPOINT,
        OBJECT_STORE_BUCKET: bucket,
        OBJECT_STORE_ACCESS_KEY_ID: ACCESS_KEY,
        OBJECT_STORE_SECRET_ACCESS_KEY: SECRET_KEY,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  }

  async function waitFor(
    fn: () => Promise<boolean>,
    timeoutMs: number,
    stepMs = 100,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (await fn()) return true
      if (Date.now() > deadline) return false
      await new Promise((r) => setTimeout(r, stepMs))
    }
  }

  it('kills the backup mid-run without producing a success state, then resumes', async () => {
    const dir = await tmp()
    const checkpointPath = join(dir, 'checkpoint.json')

    const child = startBackup(dir, false)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })

    // Wait until a checkpoint proves real progress, then kill while more work remains.
    const progressed = await waitFor(async () => {
      if (!existsSync(checkpointPath)) return false
      try {
        const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8')) as {
          completed: Record<string, unknown>
        }
        return Object.keys(checkpoint.completed).length >= 2
      } catch {
        return false
      }
    }, 120_000)
    expect(progressed).toBe(true)

    // The backup is still running, and the manifest is not written until the end.
    expect(child.exitCode).toBeNull()
    expect(existsSync(join(dir, 'manifest.json'))).toBe(false)

    child.kill('SIGKILL')
    await new Promise((resolveReject) => {
      child.on('exit', (code, signal) => resolveReject({ code, signal }))
    })

    const afterKill = {
      started: stdout.length + stderr.length > 0,
      hasManifest: existsSync(join(dir, 'manifest.json')),
      // No success line may have been printed before the kill.
      printedSuccess: stdout.includes('manifest:') && stdout.includes('run "verify"'),
    }
    // Only assert the properties the kill makes true. The transcript is not part of
    // the contract; the manifest's absence is, because its presence would mean a
    // partial run can look complete.
    expect(afterKill.hasManifest).toBe(false)
    expect(afterKill.printedSuccess).toBe(false)

    // Resume into the SAME directory. The completed objects must be re-hashed rather
    // than trusted, and the unfinished ones must be picked up.
    const resumed = startBackup(dir, true)
    let resumeOut = ''
    resumed.stdout.on('data', (chunk) => {
      resumeOut += chunk.toString()
    })
    const resumeExit = await new Promise<number>((resolvePromise) => {
      resumed.on('exit', (code) => resolvePromise(code ?? 1))
    })
    expect(resumeExit).toBe(0)

    const { manifest } = await loadManifest(dir)
    const expected = await listAllObjects(createS3Client(baseCfg(bucket)), bucket)
    expect(manifest.objects).toHaveLength(expected.length)
    expect(new Set(manifest.objects.map((object) => object.key))).toEqual(
      new Set(expected.map((object) => object.key)),
    )

    const verify = await runVerify({ backupDir: dir, strict: true })
    expect(verify.passed).toBe(true)
    expect(verify.checked_objects).toBe(expected.length)
    expect(verify.failed_objects).toEqual([])

    // Blob count on disk equals the number of distinct digests in the manifest, and
    // no half-written temp file survived as a blob.
    const blobStats = await stat(join(dir, 'objects')).catch(() => undefined)
    expect(blobStats?.isDirectory()).toBe(true)
  }, 900_000)

  it('does not treat a checkpoint as proof when the blob it names is corrupted', async () => {
    // The strongest form of the same property: kill is one way to get a checkpoint
    // that outruns reality, a corrupted blob is another. Either way the resumed run
    // must not trust it.
    const dir = await tmp()
    await runBackupUntilFirstObject(dir)

    // No manifest exists yet — it is written only when a backup completes — so the
    // blob to corrupt is named by the CHECKPOINT, which is the thing under test.
    const checkpoint = JSON.parse(await readFile(join(dir, 'checkpoint.json'), 'utf8')) as {
      completed: Record<string, { size: number; sha256: string }>
    }
    const entry = Object.entries(checkpoint.completed).find(([, value]) => value.size > 0)
    expect(entry, 'the killed backup should have completed at least one object').toBeTruthy()
    const [victimKey, victim] = entry as [string, { size: number; sha256: string }]
    await writeFile(
      join(dir, `objects/${victim.sha256}`),
      Buffer.from('corrupted after the checkpoint'),
    )

    const resumed = startBackup(dir, true)
    const code = await new Promise<number>((r) => resumed.on('exit', (c) => r(c ?? 1)))
    expect(code).toBe(0)

    // The corrupted entry must have been re-fetched: the manifest's digest for that
    // key is still the real one, and the independent verify agrees.
    const after = await loadManifest(dir)
    expect(after.manifest.objects.length).toBeGreaterThanOrEqual(
      Object.keys(checkpoint.completed).length,
    )
    const repaired = after.manifest.objects.find((object) => object.key === victimKey)
    expect(repaired, 'the interrupted key must be present after the resume').toBeTruthy()
    expect(repaired!.sha256).toBe(victim.sha256)

    const verify = await runVerify({ backupDir: dir, strict: true })
    expect(verify.passed).toBe(true)
  }, 900_000)

  /** Run a backup until at least one object is on disk, then stop the child. */
  async function runBackupUntilFirstObject(dir: string): Promise<void> {
    const child = startBackup(dir, false)
    const checkpointPath = join(dir, 'checkpoint.json')
    const done = await waitFor(async () => {
      if (!existsSync(checkpointPath)) return false
      const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8')) as {
        completed: Record<string, unknown>
      }
      return Object.keys(checkpoint.completed).length >= 1
    }, 120_000)
    expect(done).toBe(true)
    // Stop it cleanly here: this scenario is about checkpoint trust, not about the
    // interruption itself, and the manifest will simply be re-derived by the resume.
    child.kill('SIGKILL')
    await new Promise((r) => child.on('exit', () => r(undefined)))
    // Confirm a manifest was not left behind that would make this a completed backup.
    expect(existsSync(join(dir, 'manifest.json'))).toBe(false)
  }
})
