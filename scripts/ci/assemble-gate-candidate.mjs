#!/usr/bin/env node
/**
 * Assemble a deployment-gate candidate from REAL registry and image data
 * (EA-56 Step D).
 *
 * The EA-54 gate is a pure policy engine: it consumes a JSON candidate and
 * refuses to invent anything. Something has to gather that candidate from the
 * registry and the image. This is that something, and it is the ONLY producer,
 * so there is exactly one place where values enter the policy check.
 *
 * Provenance sources, and why each is trustworthy:
 *
 *   index → attestation descriptor
 *     The index lists an attestation manifest annotated
 *     `vnd.docker.reference.digest`. That annotation is content-addressed
 *     registry data: it states which image manifest the attestation belongs to.
 *     It is the only place the subject binding is recorded.
 *
 *   provenance → build-arg:DEPLOYMENT_VERSION
 *     BuildKit records the build arguments it was given. For a local-path build
 *     context BuildKit does not emit `vcs.revision`, so the recorded build arg is
 *     the authentic provenance field that carries the revision. It is only
 *     trusted because Step C already validated that same value against the
 *     checked-out tree; this script never establishes origin on its own.
 *
 * What this script deliberately does NOT do:
 *   * invent evidence — an absent proof stays absent and the gate rejects it
 *   * fall back to a tag, BUILD_ID, or APP_VERSION
 *   * read a secret
 *
 * Usage
 *   node assemble-gate-candidate.mjs \
 *     --image <repo>@<index digest> --expect-revision <40-hex> \
 *     --policy <json file|inline json> --out <path> \
 *     [--json]
 *
 * Exit codes
 *   0  candidate written
 *   2  usage error
 *   3  a required input could not be read (fail closed)
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const SHA256_RE = /^sha256:[0-9a-f]{64}$/
const SHA1_RE = /^[0-9a-f]{40}$/
const PLATFORM = 'linux/amd64'
const ATTESTATION_TYPE = 'vnd.docker.reference.type'
const ATTESTATION_DIGEST = 'vnd.docker.reference.digest'

function parseArgs(argv) {
  const out = {
    image: '',
    expectRevision: '',
    policy: '',
    out: '',
    json: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--image') out.image = argv[++i] ?? ''
    else if (a === '--expect-revision') out.expectRevision = argv[++i] ?? ''
    else if (a === '--policy') out.policy = argv[++i] ?? ''
    else if (a === '--out') out.out = argv[++i] ?? ''
    else if (a === '--json') out.json = true
    else if (a === '--help' || a === '-h') {
      console.log(
        'usage: assemble-gate-candidate.mjs --image <repo@sha256:...> ' +
          '--expect-revision <40-hex> --policy <file|json> --out <path> ' +
          '[--json]',
      )
      process.exit(0)
    } else {
      console.error(`assemble-candidate: unknown argument ${a}`)
      process.exit(2)
    }
  }
  if (!out.image || !out.expectRevision || !out.policy || !out.out) {
    console.error('assemble-candidate: --image, --expect-revision, --policy and --out are required')
    process.exit(2)
  }
  return out
}

function sh(cmd, args) {
  try {
    return {
      ok: true,
      out: execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(),
      err: '',
    }
  } catch (e) {
    return {
      ok: false,
      out: (e.stdout ?? '').toString().trim(),
      err: (e.stderr ?? e.message ?? '').toString().trim(),
    }
  }
}

/**
 * Read a manifest or index verbatim.
 *
 * `docker manifest inspect` is deliberately NOT used: it strips the
 * `annotations` map, and the attestation descriptor's
 * `vnd.docker.reference.digest` annotation is exactly what binds provenance to
 * the image manifest. Losing it would make the provenance subject unknowable.
 */
function inspect(ref) {
  return sh('docker', ['buildx', 'imagetools', 'inspect', ref, '--raw'])
}

function jsonOrNull(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** Split `<repo>@sha256:<64hex>` into its parts, or exit 3. */
function splitDigestRef(ref) {
  const at = ref.lastIndexOf('@')
  if (at === -1) {
    console.error(
      'assemble-candidate: --image must be digest-addressed (<repo>@sha256:...), not a tag',
    )
    process.exit(3)
  }
  const repo = ref.slice(0, at)
  const digest = ref.slice(at + 1)
  if (!SHA256_RE.test(digest)) {
    console.error(`assemble-candidate: '${digest}' is not a canonical sha256 digest`)
    process.exit(3)
  }
  return { repo, digest }
}

/** Normalise an index entry into the shape the gate consumes. */
function describeManifest(entry) {
  const platform = entry.platform ?? {}
  const annotations = entry.annotations ?? {}
  const attestation = annotations[ATTESTATION_TYPE] === 'attestation-manifest'
  return {
    digest: entry.digest,
    mediaType: entry.mediaType,
    platform: { os: platform.os, architecture: platform.architecture },
    ...(attestation ? { attestation: true } : {}),
    ...(annotations[ATTESTATION_DIGEST] ? { subject: annotations[ATTESTATION_DIGEST] } : {}),
  }
}

const args = parseArgs(process.argv.slice(2))

// ---- policy ---------------------------------------------------------------
let policy
try {
  const raw = existsSync(args.policy) ? readFileSync(args.policy, 'utf8') : args.policy
  policy = JSON.parse(raw)
} catch (err) {
  console.error(
    `assemble-candidate: policy is neither a readable file nor valid JSON: ${err.message}`,
  )
  process.exit(3)
}

const { repo, digest: indexDigest } = splitDigestRef(args.image)

if (!SHA1_RE.test(args.expectRevision)) {
  console.error(`assemble-candidate: '${args.expectRevision}' is not a 40-hex revision`)
  process.exit(3)
}

const candidate = {
  _generated_by: 'assemble-gate-candidate/1.0.0',
  deployment_id: process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT ?? '1'}`
    : `local-${Date.now()}`,
  deployment_environment: process.env.DEPLOY_ENVIRONMENT ?? 'dev',
  source_revision: args.expectRevision,
  externally_sourced_revision: true,
  oci_index_digest: indexDigest,
  target_platform: PLATFORM,
  policy,
}

// ---- index → platform manifest → config -----------------------------------
const indexRes = inspect(args.image)
if (!indexRes.ok) {
  console.error(
    `assemble-candidate: cannot read the index from the registry: ${indexRes.err} ` +
      '(treat this as a tool failure, not a pass)',
  )
  process.exit(3)
}
const index = jsonOrNull(indexRes.out)
if (!index) {
  console.error('assemble-candidate: registry returned a non-JSON index')
  process.exit(3)
}

const entries = (index.manifests ?? []).map(describeManifest)
candidate.oci_index = { digest: indexDigest, manifests: entries }

const platformManifests = entries.filter(
  (m) => !m.attestation && `${m.platform.os}/${m.platform.architecture}` === PLATFORM,
)
if (platformManifests.length !== 1) {
  // Leave platform_manifest_digest unset: the gate rejects an unresolved target
  // rather than this script guessing among candidates.
  console.error(
    `assemble-candidate: expected exactly one ${PLATFORM} image manifest in the index, ` +
      `found ${platformManifests.length}; leaving it unresolved`,
  )
} else {
  const manifestDigest = platformManifests[0].digest
  candidate.platform_manifest_digest = manifestDigest

  const manRes = inspect(`${repo}@${manifestDigest}`)
  const manifest = manRes.ok ? jsonOrNull(manRes.out) : null
  if (!manifest) {
    console.error(
      `assemble-candidate: cannot read the platform manifest ${manifestDigest}: ` +
        `${manRes.err || 'non-JSON response'}`,
    )
  } else {
    candidate.platform_manifest = {
      digest: manifestDigest,
      config: { digest: manifest.config?.digest ?? null },
      layers: (manifest.layers ?? []).length,
    }
    candidate.image_config_digest = manifest.config?.digest ?? null
  }
}

// ---- provenance -----------------------------------------------------------
// Subject binding: the attestation descriptor's annotation is authentic,
// content-addressed registry data naming the manifest it attests.
const attestation = entries.find((m) => m.attestation)
if (!attestation) {
  console.error(
    'assemble-candidate: the index carries no attestation manifest, so no provenance ' +
      'can be verified; provenance stays absent and the gate will reject it',
  )
}

let provenanceStatement = null
if (attestation) {
  // Read the SLSA predicate straight from the index the build produced. There is
  // deliberately no "supply your own provenance file" escape hatch: an operator
  // could then assert provenance the build never emitted.
  const provRes = sh('docker', [
    'buildx',
    'imagetools',
    'inspect',
    args.image,
    '--format',
    '{{json .Provenance}}',
  ])
  const pred = provRes.ok ? jsonOrNull(provRes.out) : null
  const slsa = pred?.SLSA
  if (slsa) {
    provenanceStatement = {
      _type: 'https://in-toto.io/Statement/v1',
      predicateType: 'https://slsa.dev/provenance/v1',
      // The attestation descriptor binds this predicate to the manifest.
      subject: attestation.subject
        ? [{ digest: { sha256: attestation.subject.replace(/^sha256:/, '') } }]
        : [],
      predicate: slsa,
      _source: 'buildx imagetools inspect .Provenance',
    }
  }
}

if (provenanceStatement) {
  const subject =
    provenanceStatement.subject?.[0]?.digest?.sha256 ??
    (attestation?.subject ? attestation.subject.replace(/^sha256:/, '') : null)
  const slsa = provenanceStatement.predicate ?? {}
  const vcsRevision = slsa.runDetails?.metadata?.buildkit_metadata?.vcs?.revision ?? null
  const buildArgRevision =
    slsa.buildDefinition?.externalParameters?.request?.args?.['build-arg:DEPLOYMENT_VERSION'] ??
    slsa.externalParameters?.request?.args?.['build-arg:DEPLOYMENT_VERSION'] ??
    null
  const completeness =
    slsa.runDetails?.metadata?.buildkit_completeness ?? slsa.metadata?.buildkit_completeness ?? null

  candidate.provenance = {
    subject_digest: subject ? `sha256:${subject}` : null,
    source_revision: vcsRevision ?? buildArgRevision,
    // Recorded so the provenance of the revision field is auditable rather than
    // implied: vcs.revision is BuildKit's own VCS observation, the build arg is
    // the value Step C verified independently.
    source_revision_field: vcsRevision
      ? 'vcs.revision'
      : buildArgRevision
        ? 'build-arg:DEPLOYMENT_VERSION'
        : null,
    completeness,
    _source: provenanceStatement._source,
  }
  if (!vcsRevision && buildArgRevision) {
    console.error(
      'assemble-candidate: BuildKit emitted no vcs.revision for this local-context build; ' +
        'falling back to the verified DEPLOYMENT_VERSION build argument ' +
        '(origin established by verify-source-origin.mjs, not by this script)',
    )
  }
} else if (attestation) {
  console.error(
    'assemble-candidate: provenance could not be read; leaving provenance absent ' +
      '(the gate will reject it rather than accept a synthesised value)',
  )
}

// ---- embedded identity, read from the image itself ------------------------
const idRes = sh('node', [
  new URL('./verify-image-identity.mjs', import.meta.url).pathname,
  '--image',
  args.image,
  '--expect',
  args.expectRevision,
  '--json',
])
const identity = jsonOrNull(idRes.out)
if (identity?.extraction === 'ok') {
  candidate.embedded_source_revision = identity.embedded ?? ''
} else {
  // Never synthesise: an absent identity must reach the gate as absent.
  console.error(
    `assemble-candidate: could not read the embedded identity (${
      identity?.reason ?? idRes.err ?? 'unknown'
    }); embedded_source_revision stays absent and the gate will reject it`,
  )
}

writeFileSync(args.out, JSON.stringify(candidate, null, 2) + '\n')

if (args.json) {
  console.log(JSON.stringify({ written: args.out, candidate }, null, 2))
} else {
  console.log(`candidate written: ${args.out}`)
  console.log(`  index:     ${candidate.oci_index_digest}`)
  console.log(`  manifest:  ${candidate.platform_manifest_digest ?? '<unresolved>'}`)
  console.log(`  config:    ${candidate.image_config_digest ?? '<unresolved>'}`)
  console.log(`  embedded:  ${candidate.embedded_source_revision || '<absent>'}`)
  console.log(
    `  provenance:${candidate.provenance ? ` subject=${candidate.provenance.subject_digest}` : ' <absent>'}`,
  )
  if (candidate.provenance) {
    console.log(
      `  revision:  ${candidate.provenance.source_revision ?? '<absent>'} ` +
        `(${candidate.provenance.source_revision_field ?? 'no field'})`,
    )
  }
  console.log(`  policy:    ${JSON.stringify(policy)}`)
}
