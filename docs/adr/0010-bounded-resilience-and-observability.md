# ADR 0010: Bounded resilience and observable overload

## Status

Accepted on 2026-09-13.

## Context

The product already has durable idempotent ingestion, PostgreSQL queues, tenant row security, and reconciled analytics. Under concurrency, however, unbounded connection waiting, unrestricted job admission, repeated aggregate reads, or retrying a failed dependency can turn one failure into system-wide resource exhaustion. Resilience behavior also needs to be visible and reproducible before deployment choices are made.

## Decision

1. Apply schema-validated budgets for API execution, database statements/connections, Redis/OIDC dependency calls, queue admission, and shutdown grace.
2. Use Redis fixed-window counters for distributed auth, webhook, and general API admission. Fail protected admission closed when the shared counter cannot be trusted.
3. Cache only expensive organization-scoped aggregate/filter reads. Include normalized input and an organization mutation generation in every key, retain a short TTL, coalesce local misses, and bypass safely to source on cache failure.
4. Serialize each queue's organization admission with a PostgreSQL advisory transaction lock. Resolve idempotent replay before checking capacity.
5. Share one bounded worker pump across import, export, and Governance processors and stop accepting new drains during graceful shutdown.
6. Use a closed/open/half-open circuit with one recovery probe around Redis and OIDC calls. Keep liveness process-only and make readiness report required dependency loss.
7. Export low-cardinality Prometheus request, cache, pool, circuit, and uptime metrics behind a production monitoring credential. Provision a read-only Grafana dashboard and actionable alert rules.
8. Treat a measured load profile, isolated fault suite, security suite, and content-verified backup restore as release evidence. State the tested boundary honestly rather than extrapolating unlimited capacity.

## Consequences

- Overload is rejected early with stable errors instead of consuming unbounded process memory or database connections.
- Repeated webhook/import delivery remains a correctness operation, not extra queue pressure.
- Redis is required for sessions and distributed admission, so authenticated traffic intentionally fails closed during its outage; aggregate cache failure alone does not make PostgreSQL data unavailable.
- Generation invalidation avoids request-path key scans, at the cost of old values living until their short TTL expires.
- In-process cache single-flight does not coordinate misses across API replicas. The short TTL and database budget are sufficient for the accepted profile; a distributed lock would add failure and lease complexity before evidence requires it.
- Metrics are process-local and Prometheus aggregates replicas. Production deployment must own scrape authentication, retention, routing, and cardinality budgets.
- A local 60-request/second result is a baseline for staging design, not a public production SLO.

## Alternatives considered

- **Cache every GET:** rejected because identity, audit, job status, and source records have different security/freshness needs and weak invalidation value.
- **Serve authenticated traffic without rate limiting when Redis fails:** rejected because replicas could no longer enforce a trustworthy global abuse boundary.
- **Let database and job queues grow without bounds:** rejected because delayed failure consumes the resources needed for recovery.
- **Add a message broker and analytical cube immediately:** deferred because the accepted profile passes with PostgreSQL coordination and normalized source reads.
- **Retry dependencies indefinitely:** rejected because synchronized retries amplify outages and hide a stable recovery state.
- **Restore over the source database in tests:** rejected because recovery evidence must not put local durable state at risk.

## Verification

Unit tests exercise circuit transitions, timeout, single half-open probing, bounded worker drains, and shutdown waiting. Live suites cover cache hit/invalidation, queue saturation with replay, 20-way concurrent signed-webhook idempotency, rate limits, protected metrics, clean shutdown, Redis outage behavior, tenant/security attacks, a 1,800-request load profile, and a custom-format PostgreSQL restore with critical-table content fingerprints.
