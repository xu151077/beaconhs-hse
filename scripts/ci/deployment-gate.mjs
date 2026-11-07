#!/usr/bin/env node
/**
 * EA-54 — deployment identity gate (isolated reference implementation).
 *
 * This is the *policy engine* that EA-51/52/53 designed but never connected to
 * anything. It is deliberately a standalone process: the point of EA-54 is to
 * prove that a failing gate prevents the following step from running.
 *
 * DESIGN CONSTRAINTS ENCODED HERE
 *   1. Fail closed. Any missing field, unparseable evidence, or mismatch is a
 *      non-zero exit. There is no "warn and continue" path.
 *   2. A field must never be filled from a neighbouring field. `require()` takes
 *      an explicit path; nothing falls back.
 *   3. Digest comparisons normalise the `sha256:` prefix (EA-48 G1 class bug).
 *   4. The image's self-declared revision is treated as a CLAIM. It only counts
 *      when compared to an externally supplied `source_revision` AND the object
 *      it came from is the digest-addressed candidate.
 *   5. BUILD_ID and APP_VERSION are explicitly rejected as identity sources.
 *   6. Every check records a status and a reason; the deployment record is built
 *      from those records, never from defaults.
 *
 * Exit codes
 *   0  PASS  — all required checks passed; caller may continue
 *   1  FAIL  — a required check failed (blocks the deployment)
 *   3  CONFIG — malformed input/structure (also blocks; distinct for diagnosis)
 *   4  VERIFIER_ERROR — the verifier itself failed (fail closed)
 *
 * Usage:
 *   node deployment-gate.mjs --input <candidate.json> [--json] [--record <path>]
 */
import { readFileSync, writeFileSync } from 'node:fs'

const GATE_VERSION = 'ea54-gate/1.0.0'
const SHA256_RE = /^sha256:[0-9a-f]{64}$/
const SHA1_40_RE = /^[0-9a-f]{40}$/
const BUILD_ID_RE = /^build-[A-Za-z0-9_-]+$/

// ---------------------------------------------------------------- utilities

function norm(d) {
  if (typeof d !== 'string') return d
  return d.startsWith('sha256:') ? d.slice('sha256:'.length) : d
}

function isDigest(v) {
  return typeof v === 'string' && SHA256_RE.test(v)
}

function isRevision(v) {
  return typeof v === 'string' && SHA1_40_RE.test(v)
}

function parseArgs(argv) {
  const out = { input: '', json: false, record: '' }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--input') out.input = argv[++i] ?? ''
    else if (a === '--json') out.json = true
    else if (a === '--record') out.record = argv[++i] ?? ''
    else if (a === '--help' || a === '-h') {
      console.log('usage: deployment-gate.mjs --input <candidate.json> [--json] [--record <path>]')
      process.exit(0)
    }
  }
  if (!out.input) {
    console.error('deployment-gate: --input is required')
    process.exit(3)
  }
  return out
}

/** A check record. Never write `status: 'PASS'` unless the comparison ran. */
function check(
  id,
  gate,
  ok,
  { reason = '', required = true, observed = null, expected = null } = {},
) {
  return {
    id,
    gate,
    required,
    status: ok === null ? 'NOT RUN' : ok ? 'PASS' : required ? 'FAIL' : 'PARTIAL',
    reason,
    observed,
    expected,
  }
}

// ---------------------------------------------------------------- gates

/**
 * Gate 0 — inputs and authorization.
 * Requires an explicit policy object. An absent policy is a failure, not a
 * default-allow.
 */
function gate0(candidate) {
  const checks = []
  const policy = candidate.policy

  checks.push(
    check('G0.policy_present', 0, Boolean(policy), {
      reason: policy ? 'policy supplied' : 'no policy object: refusing to assume defaults',
      observed: policy ? Object.keys(policy) : null,
    }),
  )

  const requireEvidence = policy?.require_signature
  checks.push(
    check(
      'G0.policy_declares_requirements',
      0,
      policy !== undefined && typeof requireEvidence === 'boolean',
      {
        reason: 'policy must state whether signature/SBOM evidence is mandatory',
      },
    ),
  )

  checks.push(
    check('G0.source_revision_format', 0, isRevision(candidate.source_revision), {
      reason: isRevision(candidate.source_revision)
        ? 'source_revision is a 40-hex git SHA'
        : 'source_revision missing or not 40-hex',
      observed: candidate.source_revision ?? null,
    }),
  )

  checks.push(
    check('G0.candidate_digest_format', 0, isDigest(candidate.oci_index_digest), {
      reason: isDigest(candidate.oci_index_digest)
        ? 'candidate index digest is canonical'
        : 'candidate index digest missing or not sha256:<64hex>',
      observed: candidate.oci_index_digest ?? null,
    }),
  )

  checks.push(
    check(
      'G0.source_revision_not_build_id',
      0,
      !(
        typeof candidate.source_revision === 'string' && BUILD_ID_RE.test(candidate.source_revision)
      ),
      {
        reason: 'a Next BUILD_ID is not a source revision',
        observed: candidate.source_revision ?? null,
      },
    ),
  )

  checks.push(
    check(
      'G0.source_revision_not_app_version_proxy',
      0,
      !(
        candidate.source_revision &&
        candidate.app_version_runtime &&
        candidate.source_revision === candidate.app_version_runtime &&
        !candidate.externally_sourced_revision
      ),
      {
        reason: 'source_revision must come from an external build context, not a runtime env value',
      },
    ),
  )

  return checks
}

/**
 * Gate 1 — OCI identity resolution.
 * Verifies the *relationships* between index → platform manifest → config,
 * not merely the format of each string.
 */
function gate1(candidate) {
  const checks = []
  const idx = candidate.oci_index

  checks.push(check('G1.index_present', 1, Boolean(idx), { reason: 'OCI index document required' }))
  if (!idx) return checks

  // The supplied candidate digest must be the digest OF the supplied index.
  checks.push(
    check(
      'G1.index_digest_matches_candidate',
      1,
      norm(idx.digest) === norm(candidate.oci_index_digest),
      {
        reason: 'candidate digest must be the digest of the supplied index document',
        observed: idx.digest ?? null,
        expected: candidate.oci_index_digest ?? null,
      },
    ),
  )

  const target = candidate.target_platform
  checks.push(
    check('G1.target_platform_declared', 1, typeof target === 'string' && target.includes('/'), {
      reason: 'target platform must be explicit, e.g. linux/amd64',
      observed: target ?? null,
    }),
  )

  const manifests = Array.isArray(idx.manifests) ? idx.manifests : []
  const matching = manifests.filter((m) => {
    const p = m.platform ?? {}
    return `${p.os}/${p.architecture}` === target && m.attestation !== true
  })

  checks.push(
    check('G1.exactly_one_platform_manifest', 1, matching.length === 1, {
      reason:
        matching.length === 1
          ? 'exactly one image manifest for the target platform'
          : `expected 1 target-platform manifest, found ${matching.length}`,
      observed: matching.length,
      expected: 1,
    }),
  )

  if (matching.length !== 1) return checks

  const chosen = matching[0]
  checks.push(
    check(
      'G1.manifest_digest_matches_pinned',
      1,
      norm(chosen.digest) === norm(candidate.platform_manifest_digest),
      {
        reason: 'resolved manifest digest must equal the pinned platform_manifest_digest',
        observed: chosen.digest ?? null,
        expected: candidate.platform_manifest_digest ?? null,
      },
    ),
  )

  // The manifest document, if supplied, must actually be the one addressed by
  // the descriptor. This is the "format correct but object wrong" trap.
  const man = candidate.platform_manifest
  checks.push(
    check('G1.manifest_document_present', 1, Boolean(man), {
      reason: 'manifest document required to verify config linkage',
    }),
  )
  if (man) {
    checks.push(
      check(
        'G1.manifest_document_digest_matches',
        1,
        norm(man.digest ?? candidate.platform_manifest_digest) === norm(chosen.digest),
        {
          reason: 'supplied manifest must be the object the index points at',
          observed: man.digest ?? null,
          expected: chosen.digest ?? null,
        },
      ),
    )
    checks.push(
      check(
        'G1.config_digest_matches_manifest',
        1,
        norm(man.config?.digest) === norm(candidate.image_config_digest),
        {
          reason: 'image config digest must equal the manifest config digest',
          observed: man.config?.digest ?? null,
          expected: candidate.image_config_digest ?? null,
        },
      ),
    )
    checks.push(
      check('G1.config_digest_format', 1, isDigest(man.config?.digest), {
        reason: 'config digest must be canonical sha256:<64hex>',
        observed: man.config?.digest ?? null,
      }),
    )
  }

  return checks
}

/**
 * Gate 2 — embedded identity inside the candidate image.
 * The image's claim is compared to the externally supplied revision.
 */
function gate2(candidate) {
  const checks = []
  const embedded = candidate.embedded_source_revision

  checks.push(
    check(
      'G2.embedded_present',
      2,
      embedded !== undefined && embedded !== null && embedded !== '',
      {
        reason: embedded ? 'image declares a revision' : 'image declares no revision',
        observed: embedded ?? null,
      },
    ),
  )

  checks.push(
    check('G2.embedded_well_formed', 2, isRevision(embedded), {
      reason: isRevision(embedded)
        ? 'embedded value is a 40-hex revision'
        : 'embedded value is not a 40-hex revision',
      observed: embedded ?? null,
    }),
  )

  checks.push(
    check(
      'G2.embedded_not_build_id',
      2,
      !(typeof embedded === 'string' && BUILD_ID_RE.test(embedded)),
      {
        reason: 'BUILD_ID must never be used as a source revision',
        observed: embedded ?? null,
      },
    ),
  )

  checks.push(
    check(
      'G2.embedded_matches_expected',
      2,
      isRevision(embedded) && embedded === candidate.source_revision,
      {
        reason: 'the image must declare the revision the build was supposed to use',
        observed: embedded ?? null,
        expected: candidate.source_revision ?? null,
      },
    ),
  )

  // Explicitly record that this check alone does not establish provenance.
  checks.push(
    check('G2.self_claim_is_not_proof', 2, null, {
      required: false,
      reason:
        "NOTE: a matching embedded revision is the image's own claim. It becomes evidence " +
        'only together with Gate 3 (externally verifiable evidence) — never on its own.',
    }),
  )

  return checks
}

/**
 * Gate 3 — supply-chain evidence.
 *
 * Policy-driven, because the authorization for signatures (A1/A2) and SBOMs does
 * not exist yet. Three sub-modes, each honest about what it proves:
 *   - policy requires signature  → all signature checks are required
 *   - policy does not require it → checks are marked PARTIAL with a reason
 */
function gate3(candidate) {
  const checks = []
  const policy = candidate.policy ?? {}
  const requireSig = policy.require_signature === true
  const requireSbom = policy.require_sbom === true

  // ---- signature
  const sig = candidate.signature
  if (!requireSig) {
    checks.push(
      check('G3.signature_required_by_policy', 3, null, {
        required: false,
        reason:
          'policy does not require a signature (A1/A2 not authorized); ' +
          'the identity chain is therefore INCOMPLETE by policy, not by defect',
      }),
    )
  } else {
    checks.push(
      check('G3.signature_present', 3, Boolean(sig), {
        reason: sig ? 'signature evidence present' : 'policy requires a signature; none supplied',
      }),
    )
    if (sig) {
      checks.push(
        check(
          'G3.signature_subject_matches_manifest',
          3,
          norm(sig.subject_digest) === norm(candidate.platform_manifest_digest),
          {
            reason: 'signature subject must be the target platform manifest digest',
            observed: sig.subject_digest ?? null,
            expected: candidate.platform_manifest_digest ?? null,
          },
        ),
      )
      checks.push(
        check(
          'G3.signature_identity_allowed',
          3,
          typeof sig.identity === 'string' && sig.identity === policy.allowed_signer_identity,
          {
            reason: 'signer identity must match the approved workflow identity',
            observed: sig.identity ?? null,
            expected: policy.allowed_signer_identity ?? null,
          },
        ),
      )
      checks.push(
        check('G3.signature_crypto_valid', 3, sig.verified === true, {
          reason: 'cryptographic verification result must be supplied by a real verifier',
          observed: sig.verified ?? null,
        }),
      )
    }
  }

  // ---- provenance
  const prov = candidate.provenance
  checks.push(
    check('G3.provenance_present', 3, Boolean(prov), {
      reason: prov ? 'provenance present' : 'no provenance supplied',
    }),
  )
  if (prov) {
    checks.push(
      check(
        'G3.provenance_subject_matches_manifest',
        3,
        norm(prov.subject_digest) === norm(candidate.platform_manifest_digest),
        {
          reason: 'provenance subject must be the target platform manifest digest',
          observed: prov.subject_digest ?? null,
          expected: candidate.platform_manifest_digest ?? null,
        },
      ),
    )
    checks.push(
      check(
        'G3.provenance_revision_matches_source',
        3,
        prov.source_revision === candidate.source_revision,
        {
          reason: 'provenance vcs.revision must equal the expected source revision',
          observed: prov.source_revision ?? null,
          expected: candidate.source_revision ?? null,
        },
      ),
    )
    checks.push(
      check('G3.provenance_completeness_recorded', 3, prov.completeness !== undefined, {
        required: false,
        reason:
          `buildkit_completeness=${JSON.stringify(prov.completeness ?? null)} ` +
          '(recorded, not enforced — A7 undecided)',
      }),
    )
  }

  // ---- SBOM
  const sbom = candidate.sbom
  if (!requireSbom) {
    checks.push(
      check('G3.sbom_required_by_policy', 3, null, {
        required: false,
        reason: 'policy does not require an SBOM; identity chain incomplete by policy',
      }),
    )
  } else {
    checks.push(
      check('G3.sbom_present', 3, Boolean(sbom), {
        reason: sbom ? 'SBOM evidence present' : 'policy requires an SBOM; none supplied',
      }),
    )
    if (sbom) {
      checks.push(
        check(
          'G3.sbom_subject_matches_manifest',
          3,
          norm(sbom.subject_digest) === norm(candidate.platform_manifest_digest),
          {
            reason: 'SBOM subject must be the target platform manifest digest',
            observed: sbom.subject_digest ?? null,
            expected: candidate.platform_manifest_digest ?? null,
          },
        ),
      )
    }
  }

  return checks
}

/**
 * Gate 5 — post-deployment identity reconciliation.
 *
 * Compares what was requested against what the platform reports and what the
 * running instance reports. Two of the three sources are frequently unavailable
 * in this repository (no platform API access, no way to read a live container
 * digest), and the gate must say so rather than treating "not reported" as
 * "matches".
 *
 * It deliberately does NOT read APP_VERSION. A runtime environment string cannot
 * identify an image (EA-51 D3).
 */
function gate5(candidate) {
  const checks = []

  // -- the platform's own record of what it deployed
  const recorded = candidate.platform_recorded_digest
  if (recorded === undefined) {
    checks.push(
      check('G5.platform_digest_available', 5, null, {
        required: false,
        reason:
          'the deployment platform did not report a deployed digest; ' +
          'reconciliation is NOT VERIFIED (not "matching")',
      }),
    )
  } else {
    checks.push(
      check(
        'G5.platform_digest_matches_candidate',
        5,
        norm(recorded) === norm(candidate.oci_index_digest),
        {
          reason: 'the platform must report the digest that was requested',
          observed: recorded,
          expected: candidate.oci_index_digest ?? null,
        },
      ),
    )
  }

  // -- the running instance's digest
  const running = candidate.running_image_digest
  if (running === undefined) {
    checks.push(
      check('G5.running_digest_available', 5, null, {
        required: false,
        reason:
          'no live instance digest is available to this process; ' +
          'runtime reconciliation is NOT VERIFIED',
      }),
    )
  } else {
    checks.push(
      check(
        'G5.running_digest_matches_candidate',
        5,
        norm(running) === norm(candidate.oci_index_digest),
        {
          reason: 'the running image must be the candidate',
          observed: running,
          expected: candidate.oci_index_digest ?? null,
        },
      ),
    )
  }

  // -- readiness must never be used as an identity signal
  if (candidate.readiness !== undefined) {
    checks.push(
      check('G5.readiness_is_not_identity', 5, null, {
        required: false,
        reason:
          `readiness reported ${JSON.stringify(candidate.readiness)}; ` +
          'a health signal is not evidence of image identity and is ignored here',
      }),
    )
  }

  // -- APP_VERSION must never be promoted to identity
  if (candidate.app_version_runtime !== undefined) {
    checks.push(
      check('G5.app_version_not_used_as_identity', 5, null, {
        required: false,
        reason:
          `APP_VERSION=${JSON.stringify(candidate.app_version_runtime)} recorded as ` +
          'runtime metadata only; the identity judgement above does not use it',
      }),
    )
  }

  return checks
}

/**
 * Gate 4 — final verdict.
 * Aggregates only. It does not invent any status: if a required check is missing
 * from the set, that is itself a failure.
 */
function passedStatus(checks, id) {
  return checks.find((c) => c.id === id)?.status === 'PASS'
}

function gate4(allChecks, candidate) {
  const checks = []
  const required = allChecks.filter((c) => c.required && c.status !== 'NOT RUN')
  const failed = required.filter((c) => c.status === 'FAIL')

  // A verifier that silently skipped required checks must not pass.
  const expectedGates = [0, 1, 2, 3, 5]
  const coveredGates = new Set(allChecks.map((c) => c.gate))
  const missingGates = expectedGates.filter((g) => !coveredGates.has(g))
  checks.push(
    check('G4.all_gates_executed', 4, missingGates.length === 0, {
      reason:
        missingGates.length === 0
          ? 'every gate produced at least one check'
          : `no checks emitted for gates: ${missingGates.join(', ')}`,
      observed: [...coveredGates].sort(),
      expected: expectedGates,
    }),
  )

  checks.push(
    check('G4.no_required_failures', 4, failed.length === 0, {
      reason:
        failed.length === 0
          ? 'no required check failed'
          : `required checks failed: ${failed.map((c) => c.id).join(', ')}`,
      observed: failed.map((c) => c.id),
      expected: [],
    }),
  )

  // "Chain complete" has two independent conditions, and conflating them was a
  // real bug found by EA54-T15: the policy must DEMAND the full set *and* every
  // demanded piece must actually have been evaluated and passed. A policy that
  // requires a signature while none was supplied is not a complete chain.
  const policy = candidate.policy ?? {}
  const policyDemands = policy.require_signature === true && policy.require_sbom === true
  const evidenceVerified =
    passedStatus(allChecks, 'G3.signature_subject_matches_manifest') &&
    passedStatus(allChecks, 'G3.signature_crypto_valid') &&
    passedStatus(allChecks, 'G3.provenance_subject_matches_manifest') &&
    passedStatus(allChecks, 'G3.sbom_subject_matches_manifest')
  const chainComplete = policyDemands && evidenceVerified
  checks.push(
    check('G4.identity_chain_complete', 4, chainComplete, {
      required: false,
      reason: chainComplete
        ? 'policy demanded signature + SBOM and all of them verified'
        : policyDemands
          ? 'policy demanded signature + SBOM but they did not all verify'
          : 'policy did not require signature and/or SBOM: the chain is INCOMPLETE by policy',
    }),
  )

  return checks
}

// ---------------------------------------------------------------- main

function main() {
  const args = parseArgs(process.argv.slice(2))
  let candidate
  let record = null

  try {
    candidate = JSON.parse(readFileSync(args.input, 'utf8'))
  } catch (err) {
    // Unparseable input is a verifier error, and it must fail closed.
    const out = {
      gate_version: GATE_VERSION,
      verdict: 'ERROR',
      reason: `cannot read/parse candidate: ${err.message}`,
      checks: [],
      deployment_record: null,
    }
    emit(out, args)
    process.exit(4)
  }

  try {
    const all = [
      ...gate0(candidate),
      ...gate1(candidate),
      ...gate2(candidate),
      ...gate3(candidate),
      ...gate5(candidate),
    ]
    const verdictChecks = gate4(all, candidate)
    const checks = [...all, ...verdictChecks]

    const requiredFailed = checks.some((c) => c.required && c.status === 'FAIL')
    const malformed = checks.some((c) => c.status === 'NOT RUN' && c.required)

    const verdict = requiredFailed ? 'FAIL' : malformed ? 'FAIL' : 'PASS'

    record = buildRecord(candidate, checks, verdict)

    emit(
      {
        gate_version: GATE_VERSION,
        verdict,
        reason:
          verdict === 'PASS'
            ? 'all required checks passed'
            : `blocked: ${checks
                .filter((c) => c.status === 'FAIL')
                .map((c) => c.id)
                .join(', ')}`,
        counts: {
          pass: checks.filter((c) => c.status === 'PASS').length,
          fail: checks.filter((c) => c.status === 'FAIL').length,
          partial: checks.filter((c) => c.status === 'PARTIAL').length,
          not_run: checks.filter((c) => c.status === 'NOT RUN').length,
        },
        checks,
        deployment_record: record,
      },
      args,
    )

    if (args.record) writeFileSync(args.record, JSON.stringify(record, null, 2) + '\n')
    process.exit(verdict === 'PASS' ? 0 : 1)
  } catch (err) {
    emit(
      {
        gate_version: GATE_VERSION,
        verdict: 'ERROR',
        reason: `gate crashed (fail closed): ${err.message}`,
        checks: [],
        deployment_record: null,
      },
      args,
    )
    process.exit(4)
  }
}

/**
 * The deployment record is *derived* from check results, never from defaults.
 * A field is only populated when the corresponding check actually passed, so an
 * unverified value can never appear as if it were verified.
 */
function buildRecord(candidate, checks, verdict) {
  const passed = (id) => checks.find((c) => c.id === id)?.status === 'PASS'
  return {
    record_version: 'ea54-record/1.0.0',
    gate_version: GATE_VERSION,
    verdict,
    deployment_id: candidate.deployment_id ?? null,
    deployment_environment: candidate.deployment_environment ?? null,
    executed_at_utc: new Date().toISOString(),
    source_revision: passed('G0.source_revision_format') ? candidate.source_revision : null,
    oci_index_digest: passed('G1.index_digest_matches_candidate')
      ? candidate.oci_index_digest
      : null,
    platform_manifest_digest: passed('G1.manifest_digest_matches_pinned')
      ? candidate.platform_manifest_digest
      : null,
    image_config_digest: passed('G1.config_digest_matches_manifest')
      ? candidate.image_config_digest
      : null,
    embedded_source_revision: passed('G2.embedded_matches_expected')
      ? candidate.embedded_source_revision
      : null,
    signature_verified: passed('G3.signature_crypto_valid') ? true : null,
    provenance_subject_verified: passed('G3.provenance_subject_matches_manifest') ? true : null,
    sbom_subject_verified: passed('G3.sbom_subject_matches_manifest') ? true : null,
    identity_chain_complete: passed('G4.identity_chain_complete') ? true : false,
    checks: checks.map((c) => ({ id: c.id, gate: c.gate, status: c.status, required: c.required })),
  }
}

function emit(out, args) {
  if (args.json) {
    console.log(JSON.stringify(out, null, 2))
    return
  }
  console.log(`gate: ${out.gate_version}`)
  console.log(`verdict: ${out.verdict}`)
  if (out.counts) {
    const c = out.counts
    console.log(`counts: pass=${c.pass} fail=${c.fail} partial=${c.partial} not_run=${c.not_run}`)
  }
  console.log(`reason: ${out.reason}`)
  if (out.checks?.length) {
    console.log('')
    for (const c of out.checks) {
      const tag = c.status.padEnd(8)
      const req = c.required ? 'REQ ' : 'opt '
      console.log(`  [${tag}] ${req}G${c.gate} ${c.id}${c.reason ? ` — ${c.reason}` : ''}`)
    }
  }
}

main()
