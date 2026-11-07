# Phase DR — local same-origin mirror and tile-backpressure experiments

Date: 2026-10-20
Repository: `/home/test/projects/beaconhs-hse`
Branch / HEAD: `hse-platform` / `51a899b7aac0a942da327222a3eed355fca9798a`
Verdict: **no local reproduction of the Scenario 4 navigation hang; the three-leg
backpressure predicate was never satisfied.** Phase-aj was not touched and no
conclusion here is transferred to it.

Companion documents:

- `docs/phase-6u-b3-dr-local-mirror.md` — mirror construction, provenance, the five
  configuration defects found while building it.
- `docs/phase-6u-b3-dr-tile-backpressure.md` — predicate, per-run window series,
  per-lever analysis, limitations.
- `docs/phase-6u-b3-dq-local-mirror-design.md`, `docs/phase-6u-b3-dq-tile-backpressure-method.md`
  — the design this phase implements (predicate unchanged).

---

## 1. What this phase was for

The only reproduced Scenario 4 failure (Phase DK) has request-level evidence but no
CDP trace, and it was produced once out of 21 instrumented attempts. The missing
observable is the server-side tile stall: phase-aj runs Collabora at its default log
level, exposes no shell and no admin socket, so `client not consuming tiles` cannot
be read there without changing a deployment this phase was forbidden to change.

Phase DR therefore built a **twelve-hour throwaway mirror** — same Collabora digest,
same app commit, same-origin path routing — where the predicate is observable, and
ran a control plus four levers.

## 2. Environment and image identity

| Item              | Value                                                                                                                                               |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Collabora image   | `collabora/code@sha256:4e983196eb9878f339cc506c38c21f1cc3473bca3d6de883c5de08f9c0cc3a6c` — the digest phase-aj runs, **not** the `df33af88…` CI pin |
| App image         | `beaconhs:dr-mirror-51a899b7`, id `sha256:7d8c29e91bc7e49a015e05e09f6458240d444ae00b672650e1b3d74ff55d339f`, 2 860 483 528 bytes, built from HEAD   |
| Compose project   | `dn-mirror` (proxy + Collabora on an independent bridge; app in the host network namespace, bound to `172.17.0.1:3000` only)                        |
| Edge              | `127.0.0.1:80`, path-routed `/browser`, `/cool` (WebSocket, no buffering), `/hosting`                                                               |
| Mirror tenant     | `59710737-db5e-4822-95a7-ad83b1457fcd`, slug `dr-mirror-1792450000`, created through `provisionTenant()`                                            |
| Object prefix     | `t/59710737-db5e-4822-95a7-ad83b1457fcd/`                                                                                                           |
| Server Action key | generated per build, passed as a BuildKit secret, absent from image env (0 matches in `Config.Env`), file mode 0600 outside the repository          |

The full build/baseline record, including the five environment defects that had to be
fixed before the editor would open (stale host build, stripped `Host` port, discovery
origin validation, port stripping in `urlsrc`, `ssl.termination`), is in the mirror
document.

## 3. Control group (DR-B) — PASS

Certified run: `/tmp/opencode/phase-dr/evidence/control-final/`, exit code **0**.

| DR-B item                          | Result                                                                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Same-origin page                   | `http://localhost`                                                                                                              |
| `/browser` + `/hosting`            | discovery `200`, **278** action URLs, **all** on the mirror origin                                                              |
| WOPI discovery, read, edit init    | editor frame `http://localhost/browser/…/cool.html`, WOPISrc `http://host.docker.internal:3000`, kit started, document rendered |
| `/cool` WebSocket                  | `/cool/ws` created, frames in and out                                                                                           |
| Edit → save → download → re-verify | typed marker present in `word/document.xml` of the downloaded master (20 581 bytes)                                             |
| Legal freeze                       | `FROZEN` through `applyTransition` (not forced, not written directly)                                                           |
| Frozen re-open                     | frozen panel, **0 iframes**, 373 ms                                                                                             |
| `RECONCILING → ACTIVE`             | returned `ACTIVE`, version advanced                                                                                             |
| Leftovers                          | in-flight 0, unresolved write-arms 0, unconsumed reservations 0                                                                 |

This is the gate every experiment depends on: the mirror genuinely freezes, refuses
WOPI, renders the frozen panel, and recovers.

## 4. Experiments — parameters and results

Predicate, fixed before the first run: in one 5 s window, `TaskDuration` ≥ 1.5 s
**and** a native `client not consuming tiles` event **and** an open editor `/cool/ws`.
Plus a never-firing `load` for `REPRODUCED`.

| Run | Lever                                              | Freeze     | Nav       | `load` | Busy windows | Max `TaskDuration`/5 s | Tile stalls | `/cool/ws` open | Predicate     | Class            |
| --- | -------------------------------------------------- | ---------- | --------- | ------ | ------------ | ---------------------- | ----------- | --------------- | ------------- | ---------------- |
| A2  | control (v1 instrumentation)                       | `DRAINING` | 5 055 ms  | yes    | 0            | 0                      | 0           | no              | not met       | `NOT_REPRODUCED` |
| A3  | control (final instrumentation)                    | `DRAINING` | 5 058 ms  | yes    | 0            | 0                      | 0           | no              | not met       | `NOT_REPRODUCED` |
| B1  | 20× client CPU + 500-page DOCX                     | `DRAINING` | 12 157 ms | yes    | **1**        | **5.07 s**             | **0**       | **yes**         | leg 2 missing | `NOT_REPRODUCED` |
| B2  | repeat of B1                                       | `DRAINING` | 17 019 ms | yes    | **2**        | **5.14 s**, 2.77 s     | **0**       | **yes**         | leg 2 missing | `NOT_REPRODUCED` |
| C1  | Collabora capped at 0.5 CPU                        | `DRAINING` | 5 060 ms  | yes    | 0            | 0                      | 0           | no              | not met       | `NOT_REPRODUCED` |
| D1  | `per_document.max_concurrency=1` + 2 live sessions | `DRAINING` | 5 050 ms  | yes    | 0            | 0                      | 0           | no              | not met       | `NOT_REPRODUCED` |

Raw evidence was written to `/tmp/opencode/phase-dr/evidence/dr-c-{A2,A3,B1,B2,C1,D1}/result.json`
(mode 0700, outside the repository), each holding the per-window series, socket
timeline, Collabora event counts and the freeze-state row. Those files were deleted
with the rest of the phase material after this report was written (§5); the tables
here are the extracted, desensitized record.

### 4.1 Did all three legs ever co-occur?

**No — in no run.** Leg 1 (≥1.5 s `TaskDuration`) was met twice, decisively
(5.07 s and 5.14 s inside 5 s windows). Leg 3 (open `/cool/ws`) was met in those same
windows. Leg 2 (`client not consuming tiles`) was **never** emitted: 0 events across
all six runs, with 0 tile-drop lines.

### 4.2 Was the failure reproduced?

**No.** `load` fired in every run, including the two runs that saturated the client
main thread. No run satisfies `REPRODUCED`, and none satisfies `BACKPRESSURE_ONLY`
either, because backpressure itself was never observed.

### 4.3 Evidence strength, stated honestly

- The **negative** is strong for lever B: 100 % main-thread busy time, twice, a
  500-page / 174 000-word document, an open editor socket, and still no server-side
  tile stall. Client CPU starvation alone does not create the condition Collabora
  reports as a slow tile consumer, because the WebSocket reader lives in the browser
  process, not in the throttled renderer main thread.
- The **negative** for C and D is structurally weaker as evidence _about phase-aj_:
  the frozen re-open mints no WOPI token and never contacts Collabora
  (`socketsCreatedDuringNav = 0`), so starving the document server or limiting its
  per-document concurrency has no path to that page load. That is consistent with
  DK (0 WOPI calls in the failing run) but it means C and D test the levers, not the
  phase-aj mechanism.
- This does **not** eliminate a phase-aj root cause. It removes three candidate
  levers (client CPU, server CPU, per-document concurrency) from the space that can
  produce _this_ predicate, and it says nothing about the remaining candidate —
  the browser stopping to read the socket at all.

## 5. Cleanup

Inventory was captured before teardown; only phase-owned resources were removed.

| Resource                                                  | Result                                                                                                                                                                                                                   |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `dn-mirror-app`, `dn-mirror-proxy`, `dn-mirror-collabora` | stopped and removed                                                                                                                                                                                                      |
| `dn-mirror_default` network                               | removed                                                                                                                                                                                                                  |
| `dn-mirror` volumes                                       | none existed (verified before and after)                                                                                                                                                                                 |
| Ports `80`, `3000`, `9981`                                | free                                                                                                                                                                                                                     |
| Objects `t/59710737-…/`                                   | 9 objects deleted through `deleteObject`; 0 remaining; MinIO shows 0 files under the prefix                                                                                                                              |
| Tenant rows                                               | tenant deleted (185 cascading foreign keys), plus the non-cascading `storage_freeze` (1), `in_flight_writes` (33), `storage_write_arms` (2), `storage_object_deletion_outbox` (0 after purge), `email_log`/`sms_log` (0) |
| Auth identity                                             | `account` (1), `session` (11), `user` (1) for `dr-mirror@example.local` deleted                                                                                                                                          |
| Post-cleanup counts                                       | tenants 0, users 0, tenant_users 0, documents 0, attachments 0, outbox 0, storage_freeze 0, role_assignments 0                                                                                                           |
| Temporary repo files                                      | all 10 phase scripts/specs/helpers removed (verified absent); `git status` shows no phase-harness file                                                                                                                   |
| Evidence + key material                                   | `/tmp/opencode/phase-dr/` (evidence, `buildkey.txt`, `app.env`, storage state) deleted after this report was written                                                                                                     |

**Images are intentionally retained.** The project permission policy hard-denies
`docker rmi`; the deny was not circumvented. To finish:

```
docker rmi beaconhs:dr-mirror-51a899b7 caddy:2-alpine
```

`caddy:2-alpine` was pulled by this phase; no other container on this host uses it.
The retained app image needs a fresh `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` if it is
ever run again — the generated key was deleted with the rest of the phase material
and must not be recovered from anywhere.

## 6. Proof that phase-aj and the dev stack were unaffected

| Surface               | Observation                                                                                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| phase-aj web / worker | up **28 hours** continuously, unchanged `beaconhs:phase-cq-20261019-driver` — uptime predates this phase, so nothing restarted them                                                               |
| phase-aj Collabora    | digest unchanged (`4e983196…`); the mirror ran its own container                                                                                                                                  |
| phase-aj data         | no query, write, freeze or migration was issued against it; the only phase-aj interaction was read-only `docker ps`/`docker inspect` over the existing drill SSH host                             |
| Dev stack containers  | postgres, redis, minio, mailpit up 5 days; collabora up 6 days — no restart                                                                                                                       |
| Dev stack data        | one **new** tenant was created through `provisionTenant()` and then fully removed; no existing tenant row, object prefix, volume or network was reused or altered                                 |
| Shared bucket         | the app's normal storage bootstrap ran its documented `_privacy-probe/<uuid>` write-and-delete (one synthetic byte, not tenant data); phase objects lived only under `t/59710737-…/` and are gone |

Disclosure: the mirror's database **was** the dev Postgres and its objects **were** in
the dev MinIO bucket. That is inherent to running a second app without a second
database and is why the tenant and prefix were freshly generated and then purged.
The dev stack's schema, migrations and existing rows were not modified.

## 7. Git state

| Item               | Value                                                  |
| ------------------ | ------------------------------------------------------ |
| HEAD               | `51a899b7aac0a942da327222a3eed355fca9798a` (unchanged) |
| Branch             | `hse-platform`                                         |
| Staged             | 0                                                      |
| Modified (tracked) | 124 (pre-existing; none from this phase)               |
| Untracked          | 415 (412 pre-existing + the three DR documents)        |

No commit, push, deploy, reset, clean, restore or checkout was performed at any
point.

## 8. Quality gates

Each gate was run to completion with its own exit code captured.

| Gate                  |       Exit code |
| --------------------- | --------------: |
| `pnpm format:check`   |               0 |
| `pnpm typecheck`      | 0 (27/27 tasks) |
| `pnpm lint`           |               0 |
| `pnpm test`           | 0 (25/25 tasks) |
| `pnpm deadcode:check` |               0 |
| `pnpm build`          |   0 (4/4 tasks) |

The three new documents were formatted with Prettier before `format:check` ran. No
gate was suppressed, skipped or bypassed.

## 9. Non-equivalent factors versus phase-aj

Every conclusion above is bounded by these differences:

1. **No TLS.** The mirror runs plain HTTP on loopback with `ssl.termination=false`;
   phase-aj terminates TLS at Traefik and sets `ssl.termination=true`. This was
   forced: Collabora strips the port from `urlsrc`, and `validatedActionUrl`
   accepts only HTTPS or loopback HTTP.
2. **No Cloudflare Tunnel, no Traefik, no public DNS.** One direct loopback hop.
3. **App placement.** The app runs in the host network namespace bound to the
   docker0 address, because the dev database is published only on `127.0.0.1` and
   the discovery validator needs a loopback origin. phase-aj runs the app as a
   container named `web`.
4. **`logging.level=information`** on the mirror (that is the point); phase-aj runs
   at its deployment default.
5. **Freeze state was `DRAINING`, not `FROZEN`, in every experiment.** With the
   editor session left open, the drain never verified. The gate refuses writes in
   both states and the frozen panel rendered identically, but DK reached `FROZEN`
   and this is a real difference.
6. **Fixture provenance.** The 500-page document was injected into the mirror tenant
   through the product's `putObject` + DB-backed in-flight tracker (the CSP of a
   production build blocks the browser-direct upload against plain-HTTP loopback
   MinIO). The document itself, and the WOPI/editor path exercised on it, are real.
7. **Scale and host.** One tenant, one user, one document at a time; a 3.4 GB host
   without phase-aj's parallel load.
8. **Shared Collabora capability gap.** `coolmount` logs `Failed to exec coolmount
… needs CAP_SYS_ADMIN` on container start in **both** the dev stack and the
   mirror (neither passes `cap_add: SYS_ADMIN`; both run as uid 1001). It is
   pre-existing and shared, not a mirror deviation, and documents still load.

## 10. Next steps

1. **Suspend the whole page, not just its main thread.** The one mechanism this
   phase did not exercise is a page whose socket reader stops: CDP
   `Page.setWebLifecycleState('frozen')`, or a genuinely backgrounded/occluded
   window (occlusion results from headless Chromium are invalid — `visibilityState`
   stays `visible` — so this needs a headed run).
2. **Stall the socket path.** `tc netem` on the loopback hop, or a proxy that stops
   reading `/cool/ws`, is the direct way to make Collabora log
   `client not consuming tiles` and confirm the predicate can be satisfied at all in
   the mirror. If it cannot be satisfied even then, the predicate itself is wrong and
   the DQ method must be revised before any further phase-aj attempt.
3. **Re-instrument phase-aj only on explicit authorisation**, at
   `logging.level=information`, during a real freeze window — the mirror cannot
   prove anything about Cloudflare/Traefik/network conditions.
4. **Re-attempt the DK sequence exactly** (same tab, same document, freeze, `goto`)
   with the CDP recorder from Phase DK plus the tile log, to see whether the 158 s
   lingering socket is reproducible at all.
5. **Do not** treat this phase as eliminating backpressure as a root cause: it
   removed three levers from consideration, and the strongest remaining candidate is
   now "the browser stopped reading the socket", which is exactly the case the
   predicate requires and the mirror never produced.

## 11. What could not be verified

- Whether the three-leg predicate is satisfiable at all in this mirror — it never
  occurred, so the predicate's _reachability_ is unproven.
- Dropped-tile counts: Collabora emits no such counter; recorded as **not
  observable**, never inferred.
- Any phase-aj behaviour: nothing was executed there beyond read-only inspection.
- The `FROZEN` state under an open editor session in the mirror — the state machine
  settled at `DRAINING` every time, so the experiment never ran in `FROZEN`.
