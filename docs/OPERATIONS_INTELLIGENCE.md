# Operations intelligence

The Operations workspace turns committed order, fulfilment, return, and inventory records into traceable service-risk views. It starts empty for a new organization and never loads showcase business data.

## Source and snapshot boundary

An overview is evaluated inside one tenant-scoped, read-only `REPEATABLE READ` transaction using PostgreSQL's transaction timestamp. Cards, alerts, location rows, source health, and policy values therefore describe one internally consistent point in time.

Orders and fulfilments enter through the existing authenticated ingestion boundaries. Inventory positions can be submitted through `POST /api/v1/organizations/{organizationId}/data/inventory` with `Idempotency-Key` and `X-CSRF-Token` headers. Replaying the same key and body returns the original result; reusing the key for different content fails with a conflict.

## Metric definitions

The date range is half-open UTC: `from` is inclusive at `00:00:00.000Z`, while `to` is exclusive at the same boundary. A location filter scopes order, fulfilment, return, and inventory results consistently.

- **Average fulfilment lead time:** rounded average minutes from order occurrence to the first non-cancelled shipment. Rows with a shipment before the order timestamp are excluded from this average.
- **Backlog:** commercial orders—orders not cancelled or refunded—with no recorded non-cancelled shipment.
- **Cancellation rate:** cancelled scoped orders divided by all scoped orders, expressed in integer basis points.
- **Return rate:** commercial scoped orders with at least one non-rejected return divided by all commercial scoped orders, expressed in integer basis points.
- **Service level:** commercial shipped orders whose first shipment occurred at or before the deterministic deadline divided by all commercial shipped orders. Open overdue backlog is reported separately and does not enter this denominator.
- **Stock on hand:** sum of `onHandQuantity` for the scoped inventory positions. Quantities cross JSON as decimal strings where JavaScript integer precision is not guaranteed.
- **Low-stock risk:** an inventory position where `onHandQuantity - reservedQuantity` is less than or equal to `reorderPoint + lowStockBufferQuantity`. A position with no available quantity is critical.

Location rows apply the same definitions and expose overdue backlog, service level, lead time, low-stock count, source status, and the timezone used by the location.

## Deterministic service deadline

For each order, the database chooses the location's valid IANA timezone; a missing or invalid legacy location timezone falls back to the organization's operations timezone. It converts the order occurrence to local wall-clock time and builds a deadline as follows:

1. Start with the order's local calendar date.
2. If the local order time is later than the configured cutoff, move to the next local calendar date. An order exactly at the cutoff stays on the current date.
3. Combine that date with the configured local cutoff.
4. Convert the local timestamp back through the chosen IANA timezone, then add the fulfilment target minutes.

PostgreSQL performs the timezone conversion, including daylight-saving transitions. The current policy intentionally uses calendar days; business calendars, weekends, and holidays remain a measured extension rather than an undocumented assumption.

## Policy and authorization

Thresholds are stored per organization and validated as a complete policy:

- warning backlog: 60–43,200 minutes;
- critical backlog: 120–86,400 minutes and greater than the warning value;
- fulfilment target: 60–10,080 minutes;
- stale-data threshold: 15–43,200 minutes;
- cancellation and return thresholds: 0–10,000 basis points;
- low-stock buffer: 0–1,000,000,000 units;
- cutoff: valid 24-hour `HH:mm`; and
- timezone: recognized IANA timezone.

Owner and Admin roles can change policy. Owner, Admin, Analyst, and Viewer roles can read the overview and issue pages. Owner, Admin, and Analyst roles can acknowledge or reopen an alert. Every policy change and alert lifecycle action creates an organization audit event. Database row-level security remains forced for the underlying tenant tables.

## Health states

Orders, fulfilments, and inventory each report one source state:

- `current`: the most recent committed record is within the organization's stale-data threshold;
- `delayed`: a record exists but is older than that threshold; or
- `missing`: no committed record exists for the source.

The overall state is `empty` when all three sources are missing, `partial` when an import is queued, processing, or recently failed, `missing` when only part of the required source set is absent, `delayed` when complete sources are old, and `healthy` only when all sources are current. A refresh failure preserves the last successful browser snapshot and offers an explicit retry instead of presenting old data as healthy.

## Alerts and issue drill-down

Alerts are derived from the same snapshot as the KPIs. They cover aged backlog, low/out-of-stock positions, late fulfilments, organization cancellation rate, and organization return rate. Alert links apply the corresponding issue type, severity, and location filters.

Acknowledgement is a durable, organization-scoped workflow state, not a deletion of source risk. Reopening removes that acknowledgement. If an alert no longer meets policy, it naturally disappears from the active calculation while its source records and audit history remain intact.

Issue pages support `issueType`, `severity`, `locationId`, `from`, and `to`, with a page size from 10 to 100. They use stable keyset pagination ordered by severity, occurrence, and issue ID. The opaque cursor contains a hash of its filter context, so a cursor cannot be replayed after the query changes.

## REST surface

- `GET /api/v1/organizations/{organizationId}/operations/overview`
- `GET /api/v1/organizations/{organizationId}/operations/issues`
- `PATCH /api/v1/organizations/{organizationId}/operations/thresholds`
- `POST /api/v1/organizations/{organizationId}/operations/alerts/{alertKey}/acknowledgement`
- `DELETE /api/v1/organizations/{organizationId}/operations/alerts/{alertKey}/acknowledgement`
- `POST /api/v1/organizations/{organizationId}/data/inventory`

All endpoints require the opaque BFF session. Mutations also require the CSRF token and trusted-origin checks enforced by the shared API guards. The generated TypeScript client and checked-in OpenAPI document are regenerated from the compiled API.

## Capacity boundary

The scale gate requests the first ten backlog issues from an organization containing 50,000 orders and requires a response below 2,000 ms in the local PostgreSQL 17 environment. This is a repeatable engineering threshold, not a production concurrency or unlimited-user claim. The mixed-load profile separately measures latency distributions, concurrency, queue backpressure, and failure behavior.
