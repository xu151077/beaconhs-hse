#!/usr/bin/env bash
# Phase CP — Deploy freeze driver to drill host via SSH

set -euo pipefail

DRILL_HOST=${DRILL_HOST:-beaconhs-drill}
DRILL_DIR=${DRILL_DIR:-/home/test/projects/beaconhs-hse}
DRILL_COMPOSE_FILE=${DRILL_COMPOSE_FILE:-deploy/drill-20261009.compose.yaml}

echo "=== Phase CP — Deploying freeze driver to drill host ==="

# 1. Copy driver source code and Dockerfile to drill host
echo "Step 1: Copying source code and Dockerfile to drill host..."
ssh "$DRILL_HOST" "mkdir -p /home/ceshi/beaconhs-phase-aj/apps/worker/src"
scp -r "$DRILL_DIR/apps/worker/src/bt-freeze-driver.ts" "$DRILL_HOST:/home/ceshi/beaconhs-phase-aj/apps/worker/src/"
scp -r "$DRILL_DIR/apps/worker/src/bt-freeze-driver.test.ts" "$DRILL_HOST:/home/ceshi/beaconhs-phase-aj/apps/worker/src/"
scp "$DRILL_DIR/Dockerfile.test" "$DRILL_HOST:/home/ceshi/beaconhs-phase-aj/"

# 2. Build the image on drill host
echo "Step 2: Building beaconhs:drill-$(date +%Y%m%d-%H%M%S) on drill host..."
DRILL_IMAGE_NAME="beaconhs:drill-$(date +%Y%m%d-%H%M%S)"
DEPLOYMENT_VERSION="51a899b7aac0a942da327222a3eed355fca9798a"
ssh "$DRILL_HOST" "cd /home/ceshi/beaconhs-phase-aj && rm -rf .docker && docker buildx build --tag \"$DRILL_IMAGE_NAME\" --file Dockerfile.test --build-arg DEPLOYMENT_VERSION=$DEPLOYMENT_VERSION --progress=plain . 2>&1"

# 3. Restart services on drill host
echo "Step 3: Restarting services on drill host..."
ssh "$DRILL_HOST" "cd /home/test/projects/beaconhs-hse && docker compose -f $DRILL_COMPOSE_FILE --project-name beaconhs-drill-20261009 up -d --force-recreate"

# 4. Wait for services to be healthy
echo "Step 4: Waiting for services to be healthy..."
sleep 15

# 5. Verify driver exists
echo "Step 5: Verifying driver exists in worker container..."
if docker exec beaconhs-phase-aj-worker-1 ls -la /app/apps/worker/src/bt-freeze-driver.ts; then
  echo "✅ Freeze driver found in worker container"
else
  echo "❌ Freeze driver NOT found in worker container"
  exit 1
fi

# 6. Test driver status command
echo "Step 6: Testing driver status command..."
DRIVER_STATUS=$(ssh "$DRILL_HOST" "docker exec beaconhs-phase-aj-worker-1 tsx /app/apps/worker/src/bt-freeze-driver.ts status")
echo "Driver status: $DRIVER_STATUS"

# 7. Verify tenant state is still ACTIVE
echo "Step 7: Verifying tenant state..."
ssh "$DRILL_HOST" "docker exec beaconhs-phase-aj-postgres-1 psql -U beaconhs_super -d beaconhs -c \"SELECT state, version FROM storage_freeze WHERE tenant_id = 'ea5a149b-ea76-48e0-abbe-fa360f520d8e';\""

# 8. Record image digest
echo ""
echo "=== Deployment Summary ==="
echo "New image: $DRILL_IMAGE_NAME"
echo "Compose file: $DRILL_COMPOSE_FILE"
echo "Drill host: $DRILL_HOST"
echo "Services restarted"
echo ""
echo "Next step: Run freeze/multipart E2E tests"
