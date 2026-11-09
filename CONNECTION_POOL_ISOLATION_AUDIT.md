# BeaconHS Connection-Pool Isolation Audit — Deep Round 2

## Method

Tenant-bound API keys on two tenants (Acme `demo` + phase-bs) issued
specifically for the probe (3 `audit:` keys on Acme + 1 on phase-bs for the
concurrency run). Each request response was parsed and every row's tenant
identity asserted against the DB ground truth (4 incidents, all Acme; 0 in
phase-bs). DB state re-verified after the run: incident counts unchanged,
all probe keys deleted (api_keys back to 0).

## Design

- 30 parallel lanes × interleaved Acme/phase keys over `/api/v1/incidents`.
- Each lane alternates tenants (even/odd indices), plus noise requests:
  one invalid-uuid list GET (400 path) and one aborted mid-flight request
  (AbortController, 15ms) interleaved to exercise error/abort/reuse cycles of
  the connection pool.

## Numbers

| run | total   | elapsed  | Acme ok | Acme non-200 | Acme leaks | phase ok | phase non-200 | phase leaks | aborts absorbed | DB unchanged                          |
| --- | ------- | -------- | ------- | ------------ | ---------- | -------- | ------------- | ----------- | --------------- | ------------------------------------- |
| C1  | **120** | **4.9s** | 60/60   | 0            | **0**      | 60/60    | 0             | **0**       | 20              | ✓ (4 incidents, 0 keys after cleanup) |

Each Acme response's row set was a subset of Acme's 4 incidents; each
phase-bs response was empty. No request of either tenant ever contained a
foreign tenant's rows; no unexpected errors occurred during abort/reload
cycles. Connection-pool context bleed (a tenant's rows coming back on
another tenant's key after an aborted/failing cycle) was directly tested and
**did not occur**: the app.tenant_id GUC is scoped per tenant context
(transaction), and fresh connections default to fail-closed (0 rows), so the
pool cannot carry one tenant's visibility into another's request.

## Findings grade

| P0  | P1  | P2  | P3  |
| --- | --- | --- | --- |
| 0   | 0   | 0   | 0   |

No P-level finding. Highest-sensitivity operational fact: pool pressure under
30 lanes did not produce cross-tenant rows in a single one of 120 responses;
the earlier 5.4s run with less contention mirrors the same outcome.
