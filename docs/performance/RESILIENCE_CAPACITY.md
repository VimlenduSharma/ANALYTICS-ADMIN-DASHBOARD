# Capacity report

## Accepted local profile

The accepted boundary is a 30-second mixed HTTP workload against the compiled NestJS/Fastify API, PostgreSQL 17, and Redis 7 on the local macOS arm64 Docker environment.

- 250 tenant-scoped orders are ingested before measurement.
- 60 requests/second are scheduled with a maximum concurrency of 30.
- 1,800 measured requests use a fixed mix: 10% liveness, 45% cached Sales overview, 25% cached Operations overview, and 20% server-filtered first-page Orders.
- Sales and Operations are warmed before measurement. Orders intentionally continues through PostgreSQL so the profile includes non-cache read pressure.
- The pass gate is less than 1% HTTP/network errors and each route at or below its own p95 budget.

## Result recorded 2026-09-12

| Route class         | Requests | Errors |      p50 |      p95 |       p99 | p95 budget |
| ------------------- | -------: | -----: | -------: | -------: | --------: | ---------: |
| Liveness            |      180 |      0 |  2.28 ms |  3.33 ms |   9.52 ms |     100 ms |
| Sales overview      |      810 |      0 |  5.67 ms | 13.77 ms | 164.51 ms |     300 ms |
| Operations overview |      450 |      0 |  5.70 ms | 11.32 ms | 131.13 ms |     400 ms |
| Orders page         |      360 |      0 | 12.65 ms | 28.17 ms | 237.90 ms |     300 ms |

The runner completed all **1,800** requests in **30.00 seconds**, achieved **60.01 requests/second**, and recorded **0.000% errors**. Every p95 budget passed.

## Capacity statement

One local API process with a ten-connection PostgreSQL pool sustained this precise 60-request/second profile with substantial p95 headroom. This is a reproducible development acceptance boundary, not a production SLO, peak-capacity claim, or promise about unlimited users.

The result supports retaining normalized PostgreSQL reads plus short-lived aggregate caching for the current release. It does not yet justify the operational complexity of precomputed cubes, table partitioning, a separate broker, or object storage solely for throughput.

## Scaling and retest triggers

Retest in staging with production-like network distance, managed service tiers, TLS, representative tenant cardinality, and multiple replicas before setting an external SLO. Increase the profile in controlled steps and stop at the first breached error, latency, pool-waiting, CPU, memory, or queue-depth budget.

Revisit the read model when any of these holds:

- Sales or Orders p95 consumes 70% of its budget for three representative runs;
- database pool waiting remains above zero or database CPU/IO is the limiting resource;
- cache hit rate is low because filters or tenants have high cardinality;
- one tenant's queue repeatedly reaches its admission limit; or
- webhook/import traffic and interactive reads contend for the same database budget.

For horizontal sizing, total possible database connections equal pool maximum multiplied by API and worker replica counts, plus migration and operator reserve. Autoscaling must respect that global database ceiling rather than scaling HTTP replicas independently.

## Reproduction

```bash
pnpm load
```

Override `LOAD_CONCURRENCY`, `LOAD_DURATION_SECONDS`, `LOAD_REQUESTS_PER_SECOND`, or `LOAD_SEED_ORDERS` only to define a new named profile. Do not compare results from changed profiles as if they were the same capacity gate.
