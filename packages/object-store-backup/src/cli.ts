// Command-line entry point for the object-store backup tool.
//
//   pnpm --filter @beaconhs/object-store-backup inventory [--endpoint …] [--bucket …]
//   pnpm --filter @beaconhs/object-store-backup backup --destination /secure/path/backup
//   pnpm --filter @beaconhs/object-store-backup verify --backup-dir /secure/path/backup
//   pnpm --filter @beaconhs/object-store-backup restore --backup-dir … --endpoint … --bucket …
//
// USAGE NOTES
//
// Credentials come from the environment, never from a flag. A flag value reaches
// argv, the process table, and the shell history; an environment variable does not
// reach argv. `OBJECT_STORE_*` names are the tool's own; `R2_*` is accepted as a
// fallback because that is what BeaconHS deployments already export.
//
// `restore` is the only command that writes, and it refuses to run against a target
// that already holds any of the backed-up keys unless `--overwrite` is given
// explicitly. There is no automatic production switch, no reverse sync and no
// rollback executor in this tool: it moves bytes and proves they arrived.

import { resolveStoreConfig, redactEndpoint, type StoreConfigInput } from './config'
import { runBackup } from './backup'
import { runDiff } from './diff'
import { runInventory } from './inventory'
import { runRestore } from './restore'
import { runVerify } from './verify'
import { createS3Client } from './s3'

const USAGE = `usage: object-store-backup <command> [options]

Commands:
  inventory   Read-only count of objects, bytes and bucket lifecycle. Writes nothing.
              With --diff it reports what changed against a baseline instead.
  backup      Copy every object to a local directory, with a manifest of hashes,
              metadata and tags.
  verify      Re-check an existing backup directory against its manifest.
  restore     Restore a backup into a named target store.

Common options:
  --endpoint <url>     S3 endpoint (env OBJECT_STORE_ENDPOINT or R2_ENDPOINT)
  --bucket <name>      Bucket (env OBJECT_STORE_BUCKET or R2_BUCKET)
  --access-key <id>    Access key id (prefer the environment variable)
  --secret-key <key>   Secret access key (prefer the environment variable)
  --region <region>    Signature region (default auto)

inventory --diff:
  --diff <path>        Baseline manifest, or the backup directory holding it. The
                       report is evidence only: it never writes to a store. An
                       encrypted (format-2) backup is decrypted and its HMAC is
                       verified first, exactly as verify does.
  --current <path>     Compare against this second manifest instead of the live
                       bucket. Two manifests give an authoritative content
                       comparison; a live inventory gives ADDED/DELETED from keys
                       and sizes, and UNKNOWN for same-size objects, because an
                       inventory does not read object bodies.
  --output <path>      Write the JSON report here. Written to a temporary name and
                       renamed, so an interrupt cannot leave a half-written report.
                       Comparing an encrypted baseline requires BACKUP_AGE_IDENTITY
                       and BACKUP_HMAC_KEY_FILE.

backup:
  --destination <dir>  Backup directory. Created with mode 0700 when absent.
  --create-bucket      Create the bucket if it is missing (otherwise refuse).
  --resume             Skip objects recorded as done in a checkpoint, after
                       re-hashing each one.
  --encrypt            Write an encrypted backup (format 2): object blobs, the
                       manifest and the checkpoint are age-encrypted, and a keyed
                       HMAC over the manifest is written to backup.hmac. Requires
                       BACKUP_AGE_RECIPIENT and BACKUP_HMAC_KEY(_FILE); the age
                       CLI must be on PATH. The tool refuses to fall back to a
                       plaintext backup.

Encryption keys (never written into the backup directory):
  BACKUP_AGE_RECIPIENT       age public key (or BACKUP_AGE_RECIPIENT_FILE).
  BACKUP_AGE_IDENTITY        age identity file needed to decrypt/verify/restore.
  BACKUP_HMAC_KEY_FILE       File holding the HMAC secret (preferred), or
                             BACKUP_HMAC_KEY. Key files must not be readable by
                             group or others.
  Run "backup --generate-key" to print a fresh random HMAC key, then store it
  yourself with mode 0600. Nothing is written to disk by that flag.

verify:
  --backup-dir <dir>   Backup directory to verify.
  --strict             Also fail when objects/ holds unreferenced files.

restore:
  --backup-dir <dir>     Backup directory to restore from.
  --create-target-bucket Create the target bucket when missing.
  --overwrite            Replace objects that already exist on the target.
  --apply-lifecycle      Write the captured lifecycle configuration to the target
                         bucket. Without it the target bucket is never modified.
  --public-endpoint <url> Endpoint used for the presigned-URL and anonymous-access
                         checks. Defaults to --endpoint.
  --lifecycle-file <path> Lifecycle XML to apply to the target bucket, read from this
                         file. Use it when the captured configuration cannot
                         reproduce incomplete-upload cleanup (MinIO accepts but never
                         returns AbortIncompleteMultipartUpload).

Credentials are read from OBJECT_STORE_ACCESS_KEY_ID / OBJECT_STORE_SECRET_ACCESS_KEY
(or R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY). Passing them as flags is supported but
puts them in argv; prefer the environment.

Exit codes: 0 success, 2 usage error, 1 operational failure.`

/** Drop the `--` that every task runner forwards before the user's arguments. */
export function normaliseArgs(argv: readonly string[]): string[] {
  return argv.filter((arg) => arg !== '--')
}

export type ParsedArgs = {
  command: string
  store: StoreConfigInput
  destination?: string
  backupDir?: string
  createBucket: boolean
  createTargetBucket: boolean
  overwrite: boolean
  applyLifecycle: boolean
  resume: boolean
  strict: boolean
  publicEndpoint?: string
  lifecycleFile?: string
  diffBaseline?: string
  diffCurrent?: string
  outputPath?: string
  encrypt: boolean
  generateKey: boolean
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const args = normaliseArgs(argv)
  // `--help` is recognised wherever it appears: the usage text is the answer, so it
  // goes to stdout with exit 0 rather than being mistaken for a missing command.
  if (args.includes('--help') || args.includes('-h')) throw new UsageError(USAGE)

  const command = args[0]
  if (command === undefined || command.startsWith('-')) {
    throw new UsageError(`a command is required\n${USAGE}`)
  }
  if (!['inventory', 'backup', 'verify', 'restore'].includes(command)) {
    throw new UsageError(`unknown command: ${command}\n${USAGE}`)
  }

  const out: ParsedArgs = {
    command,
    store: {},
    createBucket: false,
    createTargetBucket: false,
    overwrite: false,
    applyLifecycle: false,
    resume: false,
    strict: false,
    encrypt: false,
    generateKey: false,
  }

  /** Flags that take a value, mapped to a setter. */
  const valueFlags: Record<string, (value: string) => void> = {
    '--endpoint': (value) => {
      out.store.endpoint = value
    },
    '--bucket': (value) => {
      out.store.bucket = value
    },
    '--access-key': (value) => {
      out.store.accessKeyId = value
    },
    '--secret-key': (value) => {
      out.store.secretAccessKey = value
    },
    '--region': (value) => {
      out.store.region = value
    },
    '--destination': (value) => {
      out.destination = value
    },
    '--backup-dir': (value) => {
      out.backupDir = value
    },
    '--public-endpoint': (value) => {
      out.publicEndpoint = value
    },
    '--lifecycle-file': (value) => {
      out.lifecycleFile = value
    },
    '--diff': (value) => {
      out.diffBaseline = value
    },
    '--current': (value) => {
      out.diffCurrent = value
    },
    '--output': (value) => {
      out.outputPath = value
    },
  }
  const booleanFlags: Record<string, () => void> = {
    '--create-bucket': () => {
      out.createBucket = true
    },
    '--create-target-bucket': () => {
      out.createTargetBucket = true
    },
    '--overwrite': () => {
      out.overwrite = true
    },
    '--apply-lifecycle': () => {
      out.applyLifecycle = true
    },
    '--resume': () => {
      out.resume = true
    },
    '--encrypt': () => {
      out.encrypt = true
    },
    '--strict': () => {
      out.strict = true
    },
    '--generate-key': () => {
      out.generateKey = true
    },
  }

  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === undefined) throw new UsageError(`missing argument\n${USAGE}`)
    const setValue = valueFlags[arg]
    if (setValue) {
      const value = args[index + 1]
      if (value === undefined) throw new UsageError(`${arg} requires a value\n${USAGE}`)
      setValue(value)
      index += 1
      continue
    }
    const setFlag = booleanFlags[arg]
    if (setFlag) {
      setFlag()
      continue
    }
    throw new UsageError(`unrecognised argument: ${arg}\n${USAGE}`)
  }

  // `backup --generate-key` only prints a secret: it takes no destination and touches
  // no store, so requiring one would make the flag unusable.
  if (out.command === 'backup' && out.destination === undefined && !out.generateKey) {
    throw new UsageError(`backup requires --destination\n${USAGE}`)
  }
  if ((out.command === 'verify' || out.command === 'restore') && out.backupDir === undefined) {
    throw new UsageError(`${out.command} requires --backup-dir\n${USAGE}`)
  }
  return out
}

export async function main(argv: readonly string[]): Promise<number> {
  let parsed: ParsedArgs
  try {
    parsed = parseArgs(argv)
  } catch (error) {
    if (error instanceof UsageError) {
      // The usage text is the answer to `--help`, so it belongs on stdout there and
      // on stderr for a genuine mistake.
      const isHelp = error.message === USAGE
      const line = error.message
      if (isHelp) console.log(line)
      else console.error(line)
      return isHelp ? 0 : 2
    }
    console.error(error instanceof Error ? error.message : String(error))
    return 2
  }

  const log = (line: string): void => console.log(line)

  // Key generation needs no store, no credentials and no network, so it runs before
  // any configuration is resolved. Printing the key rather than writing a file is
  // deliberate: the operator decides where the secret lands and with what mode.
  if (parsed.generateKey) {
    const { generateHmacKey } = await import('./crypto')
    process.stdout.write(`${generateHmacKey()}\n`)
    return 0
  }

  if (parsed.command === 'verify') {
    const report = await runVerify({
      backupDir: parsed.backupDir as string,
      strict: parsed.strict,
      log,
    })
    return report.passed ? 0 : 1
  }

  const config = resolveStoreConfig(parsed.store)
  const client = createS3Client(config)
  try {
    if (parsed.command === 'inventory') {
      if (parsed.diffBaseline !== undefined) {
        const report = await runDiff({
          baselinePath: parsed.diffBaseline,
          ...(parsed.diffCurrent !== undefined ? { currentManifestPath: parsed.diffCurrent } : {}),
          ...(parsed.outputPath !== undefined ? { outputPath: parsed.outputPath } : {}),
          client,
          endpoint: config.endpoint,
          bucket: config.bucket,
          log,
        })
        return 0
      }
      await runInventory({ config, client, log })
      return 0
    }
    if (parsed.command === 'backup') {
      const result = await runBackup({
        config,
        client,
        destination: parsed.destination as string,
        createBucket: parsed.createBucket,
        resume: parsed.resume,
        encrypt: parsed.encrypt,
        log,
      })
      // A backup is not usable until it has been verified; say so and exit 0 only
      // for the copy itself.
      log(`backup directory: ${result.backupDir}`)
      log(`endpoint: ${redactEndpoint(config.endpoint)}   bucket: ${config.bucket}`)
      return 0
    }

    const report = await runRestore({
      backupDir: parsed.backupDir as string,
      target: config,
      createTargetBucket: parsed.createTargetBucket,
      overwrite: parsed.overwrite,
      applyLifecycle: parsed.applyLifecycle,
      ...(parsed.publicEndpoint !== undefined ? { publicEndpoint: parsed.publicEndpoint } : {}),
      ...(parsed.lifecycleFile !== undefined ? { lifecycleFile: parsed.lifecycleFile } : {}),
      log,
    })
    return report.passed ? 0 : 1
  } finally {
    client.destroy()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    })
}
