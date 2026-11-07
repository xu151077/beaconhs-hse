// CLI wrapper: bootstrap the Production email provider.
//
//   pnpm --filter @beaconhs/auth bootstrap:email-provider --config /path/email-provider.json
//   pnpm --filter @beaconhs/auth bootstrap:email-provider --config /path/email-provider.json --apply
//
// The secret file is JSON with the following shape:
//
//   {
//     "provider": "smtp",
//     "fromEmail": "noreply@company.com",
//     "fromName": "BeaconHS",
//     "smtpHost": "smtp.company.com",
//     "smtpPort": 587,
//     "smtpSecure": false,
//     "smtpUsername": "smtp-user@company.com",
//     "smtpPassword": "plaintext-password",
//     "enabled": true,
//     "mode": "tenant_optional"
//   }
//
// For production the policy should almost always be `"mode": "global_only"`
// so tenants cannot override the platform sender. Omitted optional fields keep
// their existing values; only explicitly provided fields overwrite.
//
// The password is read from the JSON file (not from argv or stdout). It is
// sealed with sealSecret(AES-256-GCM) before writing to the database.
//
// DRY RUN BY DEFAULT. Without --apply nothing is written.
//
// REFUSAL BY DEFAULT. With --apply but without --overwrite, a run against an
// already working provider writes nothing and reports `already configured`.
// Pass --overwrite to replace a live configuration deliberately.

import { readFileSync } from 'node:fs'
import { closeDatabaseConnections } from '@beaconhs/db'
import {
  bootstrapEmailProvider,
  type BootstrapEmailProviderInput,
} from './bootstrap-email-provider'

const USAGE = `usage: bootstrap:email-provider --config <path> [--apply] [--overwrite]

  --config <path>  path to the provider config JSON file (required)
  --apply          write to the database; without it this is a dry run
  --overwrite      replace an already working provider; without it a live
                   configuration is reported and left untouched`

export function parseArgs(argv: string[]): {
  configPath?: string
  apply: boolean
  overwrite: boolean
} {
  const args = argv.filter((arg) => arg !== '--')
  let configPath: string | undefined
  let apply = false
  let overwrite = false

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    switch (arg) {
      case '--config':
        configPath = args[i + 1]
        i += 1
        break
      case '--apply':
        apply = true
        break
      case '--overwrite':
        overwrite = true
        break
      default:
        throw new Error(`unrecognised argument: ${arg}\n${USAGE}`)
    }
  }

  if (!configPath) throw new Error(`--config is required\n${USAGE}`)
  return { configPath, apply, overwrite }
}

export async function main(argv: string[]): Promise<number> {
  let args: ReturnType<typeof parseArgs>
  try {
    args = parseArgs(argv)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 2
  }

  let config: BootstrapEmailProviderInput
  try {
    const raw = readFileSync(args.configPath!, 'utf8')
    config = JSON.parse(raw)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`Failed to read config file: ${msg}`)
    return 2
  }

  const result = await bootstrapEmailProvider(config, {
    apply: args.apply,
    overwrite: args.overwrite,
  })

  if (result.outcome === 'configured') {
    console.log(`provider configured: ${result.provider} (policy: ${result.mode})`)
    return 0
  }

  if (result.outcome === 'already_configured') {
    console.log(
      `already configured: ${result.provider} (policy: ${result.mode}) — nothing written. ` +
        'Rerun with --overwrite to replace the live configuration deliberately.',
    )
    return 0
  }

  if (result.outcome === 'dry_run_ok') {
    console.log(`dry run — provider would be: ${result.provider} (policy: ${result.mode})`)
    return 0
  }

  if (result.outcome === 'dry_run_failed') {
    console.error(`dry run failed: ${result.error}`)
    return 1
  }

  if (result.outcome === 'validation_failed') {
    console.error(`configuration rejected: ${result.error}`)
    return 1
  }

  if (result.outcome === 'connectivity_failed') {
    console.error(`connectivity check failed: ${result.error}`)
    return 1
  }

  return 1
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then(
    async (code) => {
      // Release pool handles so the process exits promptly instead of
      // lingering on idle connections after the work is done.
      await closeDatabaseConnections()
      process.exitCode = code
    },
    async (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error))
      await closeDatabaseConnections()
      process.exitCode = 1
    },
  )
}
