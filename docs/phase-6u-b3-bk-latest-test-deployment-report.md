# Phase BK - Latest Test Deployment Report

**Date:** 2026-10-16  
**Status:** ✅ SUCCESS  
**Image Tag:** `beaconhs:phase-bk-20261016-160000`  
**Commit SHA:** `51a899b7aac0a942da327222a3eed355fca9798a`

---

## Deployment Summary

| Item                  | Status | Details                                                                         |
| --------------------- | ------ | ------------------------------------------------------------------------------- |
| Source Sync           | ✅     | rsync from local workspace to `/home/ceshi/beaconhs-phase-aj/`                  |
| Docker Build          | ✅     | Image built with all 4 packages (web, worker, ops-bootstrap-admin, ops-migrate) |
| Compose Update        | ✅     | Updated `phase-aj-compose-final.yaml` to use new image tag                      |
| Services Started      | ✅     | All 7 containers running and healthy                                            |
| Database Migration    | ✅     | 50 applied, 0 pending, 0 historical                                             |
| RLS Policies          | ✅     | 191 tables covered                                                              |
| Health Check          | ✅     | `/api/health/ready` returns `{"status":"ready"}`                                |
| HTTPS Domain          | ✅     | `https://beaconhs-test.xuhaoqing.top` accessible                                |
| Old Container Cleanup | ✅     | `beaconhs-drill-20261009` project stopped and removed                           |

---

## Running Containers

| Container                     | Status     | Port                           |
| ----------------------------- | ---------- | ------------------------------ |
| beaconhs-phase-aj-web-1       | ✅ healthy | 127.0.0.1:3010→3000            |
| beaconhs-phase-aj-worker-1    | ✅ running | 3000/tcp                       |
| beaconhs-phase-aj-postgres-1  | ✅ healthy | 127.0.0.1:3013→5432            |
| beaconhs-phase-aj-redis-1     | ✅ healthy | 127.0.0.1:3014→6379            |
| beaconhs-phase-aj-minio-1     | ✅ healthy | 127.0.0.1:3011→9000            |
| beaconhs-phase-aj-mailpit-1   | ✅ healthy | 127.0.0.1:3017→1025, 3016→8025 |
| beaconhs-phase-aj-collabora-1 | ✅ healthy | 127.0.0.1:3015→9980            |

---

## URLs

| Service             | URL                                                  |
| ------------------- | ---------------------------------------------------- |
| **Application**     | https://beaconhs-test.xuhaoqing.top                  |
| **Health Check**    | https://beaconhs-test.xuhaoqing.top/api/health/ready |
| **Mailpit (Email)** | http://10.10.31.30:3016                              |

---

## Admin Account

| Field            | Value                    |
| ---------------- | ------------------------ |
| **Email**        | admin@beaconhs.local     |
| **Login Method** | Magic Link (via Mailpit) |
| **Mailpit URL**  | http://10.10.31.30:3016  |

### Login Steps:

1. Open https://beaconhs-test.xuhaoqing.top/login
2. Enter email: `admin@beaconhs.local`
3. Click "Send Magic Link"
4. Open Mailpit at http://10.10.31.30:3016
5. Click the magic link in the latest email
6. You're logged in as super-admin

---

## Environment Configuration

Key variables in `.env`:

- `APP_URL`: https://beaconhs-test.xuhaoqing.top
- `R2_ENDPOINT`: http://127.0.0.1:3012 (gateway)
- `R2_INTERNAL_ENDPOINT`: http://beaconhs-phase-aj-minio-1:9000
- `COLLABORA_URL`: https://beaconhs-test.xuhaoqing.top
- `DATABASE_OWNER_ROLE`: beaconhs_owner

---

## Notes

1. **drizzle directory**: Manually copied to container after build (`docker cp`) because Dockerfile's ops-migrate deploy doesn't include it. Consider updating Dockerfile for future builds.

2. **Build secret**: Used temporary `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` for build. Production deployments should use the real key from secrets manager.

3. **Preserved data**:
   - Existing PostgreSQL database intact
   - MinIO storage bucket preserved
   - Redis cache preserved

4. **Cleanup completed**: Old `beaconhs-drill-20261009` compose project fully removed (9 containers stopped and deleted).

---

## Verification Commands

```bash
# Check container status
ssh ceshi@10.10.31.30 "docker ps --format 'table {{.Names}}\t{{.Status}}' | grep beaconhs"

# Health check
curl -sk https://beaconhs-test.xuhaoqing.top/api/health/ready

# View logs
ssh ceshi@10.10.31.30 "docker logs beaconhs-phase-aj-web-1 --tail 50"
```
