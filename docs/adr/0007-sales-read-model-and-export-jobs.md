# ADR 0007: Transactional sales read model and durable exports

- **Status:** accepted
- **Date:** 2026-09-11

## Context

Sales cards, charts, rows, URLs, and downloads must agree even while ingestion continues. The product also needs large exports without keeping an API request open or allowing a worker to bypass tenant isolation. A prematurely maintained aggregate table would make ingestion and backfill behavior more complex before query measurements justify it.

## Decision

1. Compute sales analytics directly from normalized committed orders inside tenant-scoped, read-only `REPEATABLE READ` transactions.
2. Build every view from one strict filter contract using an inclusive UTC start and exclusive UTC end. Reject mixed-currency monetary aggregation unless one currency is selected.
3. Store money as `bigint` minor units and serialize it as strings. Perform ratios in PostgreSQL numeric arithmetic and percentage comparisons in integer basis points.
4. Use stable keyset pagination. Bind each cursor to the filter, sort, and direction context with a deterministic hash so a changed query cannot reuse stale position state.
5. Keep exports asynchronous and durable in PostgreSQL. Store only organization IDs in the global dispatch table; claim and generate business rows after entering forced row-level-security context.
6. Cap attempts, claim age, row count, and retention. Make idempotency, terminal failures, requester-only access, and audit creation database-verifiable behavior.
7. Treat indexes and query plans as acceptance evidence. Do not add caches or materialized aggregates until representative measurements show that the normalized read model misses its budget.

## Consequences

- A KPI, chart point, drill-down row, and CSV can be traced to the same source records and filter semantics.
- Read-only repeatable snapshots prevent internal disagreement during one overview request, at the cost of several sequential aggregate queries on one connection.
- Direct aggregation is simpler to rebuild and reason about at the current scale. Rollups remain justified only when measured cardinality or concurrency requires them.
- PostgreSQL is both the system of record and the export queue, avoiding a second delivery system while still supporting multiple workers with row locks and leases.
- Product line sales are deliberately distinct from order net revenue until source systems provide defensible line-level refund allocation.

## Alternatives considered

- **Client-side aggregation:** rejected because it would expose excessive records, disagree across pages, and make authorization and exports harder to defend.
- **Offset pagination:** rejected because concurrent inserts can shift later pages and large offsets require growing scans.
- **Synchronous CSV responses:** rejected because row count and connection lifetime are user-controlled and would consume API capacity.
- **Global worker reads with row security disabled:** rejected because convenient queue claiming is not a reason to expose business rows across tenants.
- **Precomputed daily cubes immediately:** deferred until measurements establish a real need and define refresh/backfill service levels.

## Verification

The Sales integration gate reconciles every KPI against an independent source-record query, checks trend and segment totals, verifies top-segment denominator behavior, applies one filter to overview/rows/export, exercises keyset boundaries and cursor misuse, proves requester and tenant isolation, and runs the range query over 100,000 orders with `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`.
