# Resilience and service protection

Bounded failure handling protects the tenant-safe data model. The objective is predictable service behavior under contention or dependency loss, not an unsupported claim that one deployment can serve unlimited traffic.

## Request admission

Redis owns distributed fixed-window counters so horizontally scaled API replicas enforce one shared limit. Keys contain a SHA-256 digest of the opaque session token or client address; raw credentials and addresses are not persisted in rate-limit keys.

| Traffic class     |        Default budget | Boundary                           |
| ----------------- | --------------------: | ---------------------------------- |
| Authentication    |    20 requests/minute | Routes below `/auth/`              |
| Signed webhooks   | 1,200 requests/minute | Public order webhook delivery      |
| Other API traffic |   600 requests/minute | All remaining versioned API routes |

Liveness, readiness, metrics, and OpenAPI remain outside user admission limits so operators can diagnose overload. Admitted responses expose limit, remaining, and reset headers. Exhausted windows return `429 RATE_LIMITED` with `Retry-After`. If Redis cannot make the distributed admission decision, protected traffic fails closed with `503 RATE_LIMIT_UNAVAILABLE`; liveness remains available and readiness reports the dependency failure.

## Cache policy

Sales overview, Sales filter options, and Operations overview use a 20-second Redis read-through cache by default. Keys include organization ID, a mutation generation, response namespace, and a hash of normalized filters. Tenant and filter values can therefore never share a cached response accidentally.

- Successful source mutations increment the organization's generation, making prior keys unreachable immediately.
- Concurrent misses in one API process share one source promise to avoid a local request stampede.
- Redis read/write failure bypasses the cache and serves the PostgreSQL source when authorization/session admission has already succeeded.
- Source-query errors are never cached.
- `X-Analytics-Cache` reports `HIT`, `MISS`, or `BYPASS` for diagnostics.
- Old generations expire through the bounded TTL; no wildcard deletion runs on a request path.

Asynchronous import completion is bounded by the cache TTL after enqueue invalidation. A future event-driven completion invalidation is justified only if the measured freshness budget becomes shorter than that bound.

## Queue pressure and shutdown

Imports, Sales exports, and Governance jobs each admit at most 100 queued or processing jobs per organization by default. An organization-and-queue advisory transaction lock makes count-and-insert atomic across API replicas. A valid idempotent replay is resolved before capacity enforcement, so a retry does not become an overload failure. New work beyond the bound returns `429 QUEUE_BACKPRESSURE` with the queue name and limit.

Workers share one `QueuePump` implementation. Each pump permits one active drain, processes a bounded batch, then yields to the polling interval. On `SIGTERM`, new drains stop and the active unit receives a 15-second grace period. PostgreSQL leases and durable checkpoints preserve uncompleted work for a later worker.

The API enables framework shutdown hooks and closes Redis and PostgreSQL cleanly. The live resilience test requires a clean `SIGTERM` exit in under five seconds while idle.

## Timeouts, circuits, and pools

- API handler budget: 8 seconds; expiry returns `408 REQUEST_TIMEOUT`.
- PostgreSQL statement budget: 10 seconds; connection acquisition budget: 2 seconds.
- PostgreSQL pool: 0 minimum, 10 maximum, no more than 20 queued acquirers per process by default. Further work fails quickly with `503 DATABASE_POOL_SATURATED`.
- Redis and OIDC dependency calls: bounded timeout plus a three-failure circuit. The circuit rejects immediately while open, permits one half-open probe after five seconds, and closes only after a successful probe.
- Redis loss keeps liveness healthy, marks readiness degraded, bypasses non-security cache reads where possible, and fails session/rate-limited access closed.

Every value is schema-validated at startup and can be overridden by deployment configuration. Pool sizing must be multiplied by the maximum API and worker replica counts and kept below the managed database connection budget.

## Telemetry and alerts

`GET /api/v1/observability/metrics` exports Prometheus counters, latency histograms, cache outcomes, PostgreSQL pool state, Redis circuit state, and process uptime. Production requires a separate bearer credential of at least 32 characters. The credential stays in the deployment secret store and is never sent to the Angular application.

The optional local profile provisions Prometheus and a read-only Grafana dashboard:

```bash
docker compose --profile observability up -d --wait prometheus grafana
```

- Prometheus: `http://127.0.0.1:59090`
- Grafana: `http://127.0.0.1:53000`

Alert rules cover an unavailable API target, greater-than-one-percent server-error burn, p95 latency above 750 ms, a saturated database pool, and an open dependency circuit. Release must route these alerts to an owned production destination and inject the metrics token through a secret file or managed runtime configuration.

## Verification commands

```bash
pnpm resilience
pnpm security
pnpm load
pnpm backup:restore
```

The test harness creates isolated synthetic tenants only, exercises the compiled API against real PostgreSQL and Redis, and removes the exact test identities afterward. It never seeds presentation data into the product.

See the [capacity report](performance/RESILIENCE_CAPACITY.md), [dependency outage runbook](runbooks/DEPENDENCY_OUTAGE.md), and [backup/restore runbook](runbooks/BACKUP_RESTORE.md).
