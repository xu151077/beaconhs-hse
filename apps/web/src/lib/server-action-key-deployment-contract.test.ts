import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Deployment contract for the Server Action key.
//
// The application can prove that THIS instance's key is usable (readiness) and
// that two configurations hold the SAME key (the fingerprint gate). It cannot
// prove that a running fleet is consistent, because an instance cannot observe
// its peers. That invariant therefore lives in the deployment: either every
// replica shares the build-time key embedded in the image, or every replica is
// given the same runtime override. These assertions pin the deployment files to
// one of those two shapes so a future edit cannot quietly introduce per-instance
// keys.

const repoFile = (path: string) =>
  readFileSync(new URL(`../../../../${path}`, import.meta.url), 'utf8')

describe('Server Action key deployment contract', () => {
  it('builds the image with the required BuildKit secret', () => {
    const workflow = repoFile('.github/workflows/deploy-dev.yml')
    expect(workflow).toContain(
      'next_server_actions_key=${{ secrets.DEV_NEXT_SERVER_ACTIONS_ENCRYPTION_KEY }}',
    )
  })

  it('runs every deployed web replica on the same embedded build-time key', () => {
    const compose = repoFile('deploy/dokploy-dev.compose.yaml')
    // A runtime override here would have to be identical for every replica; the
    // deployed stack deliberately relies on the build-time key instead.
    expect(compose).not.toContain('NEXT_SERVER_ACTIONS_ENCRYPTION_KEY')
  })

  it('requires the runtime override to equal the build-time key when one is configured', () => {
    const compose = repoFile('deploy/local-production.compose.yaml')
    expect(compose).toContain(
      'NEXT_SERVER_ACTIONS_ENCRYPTION_KEY: ${NEXT_SERVER_ACTIONS_ENCRYPTION_KEY:?',
    )
    expect(compose).toContain('must match the build-time key')
  })

  it('ships a consistency gate that can compare a build-time key file', () => {
    const script = repoFile('apps/web/scripts/verify-server-action-key-consistency.ts')
    expect(script).toContain('--expect')
    expect(script).toContain('--key-file')
    expect(script).toContain('fingerprint mismatch')
  })

  it('checks key validity at the readiness boundary', () => {
    const route = repoFile('apps/web/src/app/api/health/ready/route.ts')
    expect(route).toContain('assertServerActionKeyUsable')
  })

  it('runs the image gate before migrations and deployment', () => {
    const workflow = repoFile('.github/workflows/deploy-dev.yml')
    const gate = workflow.indexOf("Gate the image's Server Action key")
    const migrations = workflow.indexOf('Run database migrations')
    const deploy = workflow.indexOf('Deploy the compose on Dokploy')
    expect(gate).toBeGreaterThan(-1)
    expect(gate).toBeLessThan(migrations)
    expect(gate).toBeLessThan(deploy)
    expect(workflow).toContain('verify-server-action-key-gate.sh image')
    expect(workflow).toContain('verify-server-action-key-gate.sh fingerprint --env')
  })

  it('checks every running web replica after the rollout', () => {
    const workflow = repoFile('.github/workflows/deploy-dev.yml')
    const readiness = workflow.indexOf('Wait for external readiness')
    const replicas = workflow.indexOf('Verify every web replica')
    expect(readiness).toBeGreaterThan(-1)
    expect(replicas).toBeGreaterThan(readiness)
    expect(workflow).toContain('verify-server-action-key-gate.sh replicas')
  })

  // Phase EA-5: the replicated check fails when it cannot reach the tasks, so it
  // must only run on the path that can (`direct`). Failing instead of guessing is
  // right, but running it on the Dokploy compose path would fail every deploy.
  it('only runs the replicated check where the tasks are reachable', () => {
    const workflow = repoFile('.github/workflows/deploy-dev.yml')
    const replicas = workflow.slice(workflow.indexOf('- name: Verify every web replica'))
    expect(replicas).toContain("if: env.DOKPLOY_DEPLOY_MODE == 'direct'")
    // The replicated gate must refuse a fleet that has not finished converging,
    // instead of certifying whichever task was sampled first.
    const gate = repoFile('scripts/ci/verify-server-action-key-gate.sh')
    expect(gate).toContain('did not settle')
    expect(gate).toContain('.UpdateStatus.State')
  })

  it('exercises the gate scenarios in CI, not just the script file', () => {
    const ci = repoFile('.github/workflows/ci.yml')
    expect(ci).toContain('scripts/ci/verify-server-action-key-gate.test.sh')
    // Phase EA-10: the replicated-task contract has its own negative fixtures;
    // they must run in CI or the fleet checks are untested code.
    expect(ci).toContain('node --test scripts/ci/replica-coverage.test.mjs')
    const gate = repoFile('scripts/ci/verify-server-action-key-gate.sh')
    expect(gate).toContain('server-reference-manifest.json')
    expect(gate).toContain('compare_fingerprints')
  })

  // Phase EA-4: the LOCAL build entry point must enforce the same gate. The
  // Dockerfile requires the BuildKit secret, so a build without it fails — and
  // before EA-4 nothing locally ever verified the key the image embedded.
  it('gates the local image build on the embedded key', () => {
    const ci = repoFile('.github/workflows/ci.yml')
    expect(ci).toContain('scripts/ci/build-local-image-key-gate.test.sh')

    const build = repoFile('scripts/build-local-image-with-key-gate.sh')
    expect(build).toContain('next_server_actions_key')
    expect(build).toContain('verify-server-action-key-gate.sh')
    // The embedded key is read back through the shared gate's `image` mode, so
    // there is exactly one implementation of that check.
    expect(build).toContain('"$GATE" image "$IMAGE" "$expected"')
    // The key must arrive as a secret, never as a build-arg.
    expect(build).toContain('--secret id=next_server_actions_key')
    expect(build).not.toContain('--build-arg NEXT_SERVER_ACTIONS_ENCRYPTION_KEY')
    // ...but its fingerprint must be bound into the build cache key, because
    // BuildKit does not hash secret content: without it a rebuild after a
    // rotation reuses the layer that still holds the previous key.
    expect(build).toContain('--build-arg NEXT_SERVER_ACTIONS_KEY_FINGERPRINT="$expected"')
  })

  // Phase EA-5: the drill build entry point had the same defect — it built
  // without the required secret, so it failed at the build step and never
  // verified the key. Every local build entry must now supply the secret AND
  // compare the embedded fingerprint before any deploy step runs.
  it('gates every local build entry point on the embedded key', () => {
    const drill = repoFile('scripts/build-drill-image.sh')
    expect(drill).toContain('--secret id=next_server_actions_key')
    expect(drill).not.toContain('--build-arg NEXT_SERVER_ACTIONS_ENCRYPTION_KEY')
    // The embedded key is verified through the shared gate's `image` mode, so
    // there is one implementation of "read the manifest back out and compare".
    expect(drill).toContain('verify-server-action-key-gate.sh')
    expect(drill).toContain('"$GATE" image "$DRILL_IMAGE_NAME" "$expected"')
    // One immutable tag is built, gated, shipped and deployed. Recomputing the
    // tag after the build pointed the compose file at a tag that was never
    // built, and shipped the floating `drill-latest` alias instead.
    expect(drill.match(/^DRILL_IMAGE_NAME=/gm)).toHaveLength(1)
    expect(drill).toContain('docker save "$DRILL_IMAGE_NAME"')
    expect(drill).toContain('--build-arg NEXT_SERVER_ACTIONS_KEY_FINGERPRINT="$expected"')
    // The gate must run BEFORE the image is copied to the drill host.
    const gateAt = drill.indexOf('"$GATE" image "$DRILL_IMAGE_NAME"')
    const deployAt = drill.indexOf('docker save')
    expect(gateAt).toBeGreaterThan(-1)
    expect(deployAt).toBeGreaterThan(-1)
    expect(gateAt).toBeLessThan(deployAt)
  })

  // Phase EA-6: the drill host runs a SEPARATE checkout, so editing the local
  // compose file never reaches it — the remote stack would be recreated from its
  // own stale tag, i.e. the previous image. The recreate must pin the shipped
  // tag on the host that runs the stack, under a stable project name.
  it('recreates the drill stack on the shipped tag, not the host stale one', () => {
    const drill = repoFile('scripts/build-drill-image.sh')
    // The pinning mechanism is asserted in the next test: `-C` was proven invalid.
    expect(drill).toContain('config >/dev/null')
    // A per-run timestamp project would create a NEW stack each deploy instead of
    // updating the running one.
    expect(drill).not.toContain('--project-name beaconhs-drill-$(date')
    // The driver check must resolve this deployment's worker, never a container
    // name that belongs to another stack (the name may still be named in the
    // comment that explains the bug).
    const commands = drill
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n')
    expect(commands).not.toContain('beaconhs-phase-aj-worker-1')
    expect(commands).toContain('com.docker.compose.project=$DRILL_PROJECT')
  })

  // Phase EA-7: `docker compose` has no `-C` shorthand, so the previous way of
  // pinning the image made the remote recreate fail outright. Phase EA-7 also
  // found that the image copy probed the ssh host with `docker exec` (both
  // branches identical) and that the local `sed` rewrote a file the drill host
  // never reads.
  it('pins the drill image through validated compose content, not a flag', () => {
    const drill = repoFile('scripts/build-drill-image.sh')
    const commands = drill
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n')
    expect(commands).not.toContain('-C $DRILL_IMAGE_NAME')
    expect(commands).toContain('docker compose -f - --project-name $DRILL_PROJECT config')
    expect(commands).toContain('--project-name $DRILL_PROJECT \\')
    // Shipping is one guarded copy over the ssh transport, then a presence check.
    expect(commands).toContain('docker save "$DRILL_IMAGE_NAME" | ssh "$DRILL_HOST" docker load')
    expect(commands).toContain('docker image inspect $DRILL_IMAGE_NAME')
    expect(commands).not.toContain('docker exec "$DRILL_HOST"')
    // No local compose rewrite: the running stack reads the host's own file.
    expect(commands).not.toContain('sed -i')
    // An explicitly empty override must stop the run instead of defaulting.
    expect(commands).toContain('is set but empty; refusing to guess the drill target')
    // The build log must not be a world-readable file that outlives the run.
    // EA-66B.1 moved the log into one private build directory that also holds
    // the extracted source context and the source manifest.
    const build = repoFile('scripts/build-local-image-with-key-gate.sh')
    expect(build).not.toContain('/tmp/beaconhs-key-gate-build.log')
    expect(build).toContain('chmod 700 "$BUILD_DIR"')
    expect(build).toContain('chmod 600 "$BUILD_LOG"')
  })

  // Phase EA-5: the CI acceptance tests are what keep both entry points honest,
  // so the deploy gate's own contract is pinned here as well.
  it('runs the isolated acceptance tests for both gate entry points', () => {
    const ci = repoFile('.github/workflows/ci.yml')
    expect(ci).toContain('scripts/ci/verify-server-action-key-gate.test.sh')
    expect(ci).toContain('scripts/ci/build-local-image-key-gate.test.sh')
  })

  // Phase EA-5: the CI build had the same cache defect — BuildKit does not hash
  // secret content, so the GHA-cached `next build` layer would keep serving the
  // previous key after a rotation and the image gate would block the deploy. The
  // workflow must compute the fingerprint without an install step and pass it as
  // a build argument, never the key itself.
  it('binds the key fingerprint into the CI build cache key', () => {
    const workflow = repoFile('.github/workflows/deploy-dev.yml')
    expect(workflow).toContain('scripts/ci/server-action-key-fingerprint.mjs')
    const buildArgs = workflow.slice(
      workflow.indexOf('build-args: |'),
      workflow.indexOf('secrets: |'),
    )
    expect(buildArgs).toContain('NEXT_SERVER_ACTIONS_KEY_FINGERPRINT=')
    // The key itself must never become a build argument (it would be recorded in
    // the image config/history); only its non-invertible fingerprint may be.
    expect(buildArgs).not.toContain('NEXT_SERVER_ACTIONS_ENCRYPTION_KEY')
  })

  // Phase EA-8: a rolling update leaves the fleet on two commits while every task
  // still reports "ready" — reproduced locally with two instances, both 200, on
  // different versions. The readiness wait samples ONE url, so the replicated
  // check must pin the commit too, or a half-rolled-out release passes.
  it('pins every replica to the expected commit, not just to a key', () => {
    const workflow = repoFile('.github/workflows/deploy-dev.yml')
    const replicas = workflow.slice(workflow.indexOf('- name: Verify every web replica'))
    expect(replicas).toContain('"$EXPECTED_SERVER_ACTION_KEY_FINGERPRINT" "$GITHUB_SHA"')

    const gate = repoFile('scripts/ci/verify-server-action-key-gate.sh')
    expect(gate).toContain('expected_version="${3:-}"')
    expect(gate).toContain('reports version')
    // The version comes from the same readiness body the gate already fetches.
    expect(gate).toContain('.version // empty')
  })

  // Phase EA-5: no compose stack may silently disable the runtime override that
  // the build-time-key contract requires when one is configured.
  it('keeps the runtime override mandatory where one is configured', () => {
    const compose = repoFile('deploy/local-production.compose.yaml')
    expect(compose).toContain(
      'NEXT_SERVER_ACTIONS_ENCRYPTION_KEY: ${NEXT_SERVER_ACTIONS_ENCRYPTION_KEY:?required',
    )
  })
})
