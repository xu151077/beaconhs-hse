# Phase 6U-B3-DS — Next plan

Date: 2026-10-20
Repository: `/home/test/projects/beaconhs-hse`
Branch / HEAD: `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`
Basis: `docs/phase-6u-b3-ds-release-gaps.md`.
This is a plan only. Phase DS implemented nothing.

## 1. Sequencing rule

Do not treat "more tests" as a substitute for wiring. Two of the four P1 items
exist because a correct control is **not connected to the pipeline**
(P1-1 DB tests, P1-2 key gate). Fix wiring first; it converts existing code into
reusable evidence and shrinks the remaining work.

Recommended order:

```
W1 (DB tests in CI)  →  W2 (key gate in deploy)  →  W3 (file-surface release run)
        →  W4 (WOPI risk decision)  →  W5..W9 (P2)  →  W10..W13 (P3)
```

Stop at the first failing stage. Do not start W3 until W1 is green, because the
file-surface run needs a reliable seeded environment.

## 2. Work packages

### W1 — Run the DB-backed suites in CI (P1-1)

- **Goal:** CI executes the 41 assertions it currently skips.
- **Steps:**
  1. Set `SEED_TEST_SCRATCH_DATABASE_URL` in the CI test step to the already
     provisioned `beaconhs_test` database (owner role for setup, app role for the
     runtime assertions — match what each suite expects).
  2. Keep the existing role creation and the double `migrate.ts` run.
  3. Re-run `pnpm test`; confirm `db` reports `0 skipped`.
  4. If any suite assumes a clean database, give it a dedicated schema or
     truncate a scratch schema — never the migration journal.
- **Acceptance:** `db: 0 skipped`; the five files named in P1-1 pass; the CI log
  is attached to the release record.
- **Evidence to attach:** CI job URL + `pnpm test` summary with skip counts.
- **Risk:** suites may have been written against a scratch database name. If so,
  fix the env name, not the assertion.

### W2 — Enforce the Server Action key gate in deployment (P1-2)

- **Goal:** a fleet with two different keys cannot complete a rollout.
- **Steps:**
  1. After the image is running (and before traffic is shifted), run
     `verify-server-action-key-consistency.ts --print` on every replica and
     compare the values; or run `--expect <fingerprint>` as an init probe.
  2. Fail the rollout on exit 1/2. Never print the key or the raw fingerprint in
     a public artifact.
  3. For the build-time-key deployment, pass `--key-file` from the same BuildKit
     secret mount; a `null` readiness fingerprint is expected and correct.
  4. Add a negative drill: start one replica with a different key and prove the
     rollout fails.
- **Acceptance:** positive rollout passes; one-replica mismatch fails the
  rollout; no key material in logs.
- **Evidence to attach:** workflow diff + both runs.

### W3 — File-surface authorization release run (P1-3)

- **Goal:** the file/Office surface is verified at the release image, not a local
  stack.
- **Steps:**
  1. Fix P2-2 first (denial must be 403/404), so the matrix asserts the right
     status.
  2. Run against a deployed stage with a seeded tenant and two users (site A,
     cross-tenant).
  3. Cover: upload → preview → DOCX edit → save → download → re-download
     (content marker) → version download → delete/replace; cross-tenant deny for
     attachment, master, version, preview, and export; frozen-state write deny.
  4. Store traces outside the repo; desensitize before attaching.
- **Acceptance:** every row PASS, with a request/trace reference and a content
  marker check; no 500 for a refusal.
- **Evidence to attach:** `docs/phase-6u-b3-ds-file-surface-run.md` (new,
  desensitized).

### W4 — WOPI risk decision (P1-4)

- **Goal:** make the unresolved status explicit and owned.
- **Steps:**
  1. Without changing business code, write a one-page risk note: one real
     phase-aj hang, no confirmed data/auth impact, predicate never reached,
     three server-side levers excluded in the mirror.
  2. Owner either accepts (with monitoring and a re-open trigger) or authorizes
     a continuation experiment (page suspension / socket stall).
  3. Do not label FIXED, WONTFIX, or "eliminated".
- **Acceptance:** a signed/dated acceptance record, or an approved experiment
  plan.
- **Evidence to attach:** the acceptance record next to
  `docs/phase-6u-b3-dr-final-report.md`.

### W5 — `/api/v1` discovery 500 (P2-1)

- **Steps:** decide whether `monitored_sessions` is a public entity.
  - If yes: add a dedicated permission key and map it (do not alias another
    module's key).
  - If no: exclude it from the discovery/spec list with an explicit allow-list,
    and keep it out of the entity route.
- **Acceptance:** authenticated `GET /api/v1` → 200; a test asserts the status
  and that every listed entity has a resolvable read permission.
- **Do not:** weaken the "no duplicate permission" invariant.

### W6 — Denial status contract (P2-2)

- **Steps:** apply `withRouteErrors` (or a shared mapper) to page route handlers
  that call `assertCan`; update the CX spec to expect 403/404.
- **Acceptance:** no authorization refusal returns 500; a real fault still
  returns 500.
- **Note:** keep 404 where not-found is the deliberate anti-enumeration answer.

### W7 — Scheduler inspector tests (P2-3)

- **Steps:** unit-test `inspectRepeatableSchedules` for exact, missing,
  unexpected, duplicate, mismatched-pattern and count-mismatch states; test the
  `--check` exit codes.
- **Acceptance:** tests live in `packages/jobs` and run in CI.
- **Note:** the duplicate case is represented through the pure inspector, since a
  Redis sorted set cannot hold the same member twice.

### W8 — Stage-verify scheduler recovery (P2-4)

- **Steps:** deploy the current worker/scheduler to a stage; `--check` → 13/13
  exit 0; simulate registry loss; confirm the worker health turns unhealthy and
  re-registration restores 13/13.
- **Acceptance:** recorded logs for both states.

### W9 — Remaining P2 items

- **P2-5 (D4):** emit `recordDomainEvent` from
  `createCorrectiveActionForFailedPpeInspection`; test the outbox row.
- **P2-6:** assert the runtime DB role attributes at startup.
- **P2-7:** add `lint` tasks for `packages/*` and `apps/worker`; confirm the gate
  runs more than one task.
- **P2-8:** verify lifecycle/multipart/backup against the target object store.
- **P2-9:** owner chooses the drill containment option; record the result.

### W10–W13 — P3 hygiene

- Fix the stale key comment (P3-2).
- Refresh the `AGENTS.md` defect register and `docs/project-development-state.md`
  (P3-3, P3-4).
- Decide D3/D5/D6 (P3-5..P3-7) in a dedicated schema/flow pass; do not bundle
  them into a security release.
- Document the Edge Runtime warnings and the nav-gate inconsistency (P3-8, P3-9).

## 3. Release gate checklist

A release candidate may be declared **only** when all of these are true:

- [ ] All six gates pass on the release commit, each with its own captured exit
      code (`format:check`, `typecheck`, `lint`, `test`, `deadcode:check`,
      `build`).
- [ ] `pnpm test` reports **0 skipped DB assertions** (W1).
- [ ] The deploy pipeline proves one key across the fleet and fails on a
      mismatch (W2).
- [ ] The file-surface matrix passes at the release image (W3).
- [ ] WOPI has a written accept-or-fix decision (W4).
- [ ] `GET /api/v1` returns 200 for an authenticated key (W5).
- [ ] No authorization refusal returns 500 (W6).
- [ ] Scheduler inspector tests exist and pass; the deployed stack `--check`s
      13/13 (W7, W8).
- [ ] No P0 open; every remaining P1/P2 has an owner, a date, and an explicit
      accept/defer decision.

## 4. Explicit non-goals for the next pass

- Do not add Project Scope variants or an ad-hoc project filter inside a module.
- Do not force `FROZEN`, clear write-arms, or edit DB state to make a test pass.
- Do not modify `packages/storage/**`, `presignPut()`, `promoteObject()`,
  `ensureBucket()`, or the attachment finalization path without an explicit
  request.
- Do not operate phase-aj, the C2 drill, or production secrets.
- Do not mark WOPI FIXED/WONTFIX.
- Do not add a second owner/due-date/verification vocabulary to a module that can
  link to `corrective_actions`.
