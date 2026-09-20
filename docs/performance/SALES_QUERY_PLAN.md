# Sales query-plan acceptance

## Target

The representative target is an organization with 100,000 orders. Its actual 30-day, single-currency KPI query, including cancellation rules, payment refunds, item quantities, and AOV, must:

- use `orders_timeline_idx` or `orders_sales_currency_timeline_idx` rather than a sequential scan of the tenant's full history; and
- complete below 1,000 ms in the local PostgreSQL 17 integration environment.

The one-second gate is intentionally portable rather than presented as a production SLO. The mixed-load profile separately measures p95 budgets, concurrency, cache behavior, and failure handling.

## Latest evidence

On 2026-09-11, the final uncached Sales integration fixture inserted and analyzed 100,000 organization-scoped orders. The actual KPI query completed in **6.55 ms** using `orders_timeline_idx`.

The integration test reads the JSON plan recursively, requires an approved index name, and fails at or above the target. It creates a fresh isolated tenant for every run and removes it afterward, so the assertion does not depend on a checked-in benchmark dataset.

## Supporting indexes

- `(organization_id, currency, occurred_at DESC, id DESC)` covering common sales columns;
- `(organization_id, channel_id, occurred_at DESC, id DESC)`;
- `(organization_id, location_id, occurred_at DESC, id DESC)` for assigned locations; and
- the existing organization timeline and status-timeline indexes used when the planner estimates them more cheaply.

Query plans are evidence from one environment, not a promise of unlimited load. Production-like staging must retain representative data distributions, run warm and cold tests under concurrency, record buffer/cache conditions, and decide whether partitioning, rollups, or cache layers are justified.
