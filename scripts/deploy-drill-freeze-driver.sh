#!/usr/bin/env bash
# Phase CO — Deploy freeze driver to drill host

set -euo pipefail

DRILL_HOST=${DRILL_HOST:-beaconhs-drill}
DRILL_DIR=${DRILL_DIR:-/home/test/projects/beaconhs-hse}
DRILL_COMPOSE_FILE=${DRILL_COMPOSE_FILE:-deploy/drill-20261009.compose.yaml}

echo "=== Phase CO — Deploying freeze driver to drill host ==="

# 1. Copy source code to drill host
echo "Copying source code to drill host..."
ssh "$DRILL_HOST" "mkdir -p /home/test/projects/beaconhs-hse/apps/worker/src"
scp -r "$DRILL_DIR/apps/worker/src/bt-freeze-driver.ts" "$DRILL_HOST:/home/test/projects/beaconhs-hse/apps/worker/src/"
scp -r "$DRILL_DIR/apps/worker/src/bt-freeze-driver.test.ts" "$DRILL_HOST:/home/test/projects/beaconhs-hse/apps/worker/src/"

# 2. Build the image on drill host
echo "Building beaconhs:drill-$(date +%Y%m%d-%H%M%S) on drill host..."
ssh "$DRILL_HOST" "cd /home/test/projects/beaconhs-hse && docker build \
  --tag beaconhs:drill-$(date +%Y%m%d-%H%M%S) \
  --tag beaconhs:drill-latest \
  --build-arg DEPLOYMENT_VERSION=\$(git rev-parse HEAD) \
  --file Dockerfile \
  ."

# 3. Restart services on drill host
echo "Restarting services on drill host..."
ssh "$DRILL_HOST" "cd /home/test/projects/beaconhs-hse && docker compose -f $DRILL_COMPOSE_FILE --project-name beaconhs-drill-20261009 up -d --force-recreate"

# 4. Wait for services to be healthy
echo "Waiting for services to be healthy..."
sleep 15

# 5. Verify driver exists
echo "Verifying driver exists in worker container..."
if docker exec beaconhs-phase-aj-worker-1 ls -la /app/apps/worker/src/bt-freeze-driver.ts; then
  echo "✅ Freeze driver found in worker container"
else
  echo "❌ Freeze driver NOT found in worker container"
  exit 1
fi

# 6. Test driver status command
echo "Testing driver status command..."
DRIVER_STATUS=$(ssh "$DRILL_HOST" "docker exec beaconhs-phase-aj-worker-1 tsx /app/apps/worker/src/bt-freeze-driver.ts status")
echo "Driver status: $DRIVER_STATUS"

# 7. Record image digest
echo ""
echo "=== Deployment Summary ==="
echo "New image: beaconhs:drill-$(date +%Y%m%d-%H%M%S)"
echo "Compose file: $DRILL_COMPOSE_FILE"
echo "Drill host: $DRILL_HOST"
echo "Services restarted"
echo ""
echo "Next step: Run freeze/multipart E2E tests"
