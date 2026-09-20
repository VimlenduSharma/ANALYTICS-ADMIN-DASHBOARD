# Sales analytics contract

Sales uses a tenant-scoped analytical read model over committed source orders. Production starts empty: the page reports real records accepted through the ingestion boundaries and never substitutes sample metrics.

## Reporting boundary

- Every request is authorized against active organization membership. Owner, Admin, Analyst, and Viewer may read Sales; export status and downloads are additionally restricted to the user who requested them.
- API reads run in `REPEATABLE READ`, read-only transactions with transaction-local organization context. Forced PostgreSQL row-level security remains the second tenant boundary.
- `from` is inclusive and `to` is exclusive at UTC midnight. A range must be valid, ordered, and no longer than 366 days.
- Channel, location, product, status, currency, and order-reference filters are composed once and reused by metrics, trends, rows, and exports.
- Monetary responses remain decimal strings in minor units so JSON never truncates PostgreSQL `bigint` values.
- A currency is mandatory when matching records contain more than one currency. The API returns `SALES_CURRENCY_REQUIRED` instead of adding unlike money.

## Metric definitions

| Metric              | Definition                                                                                                                                           |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Net revenue         | `max(order total - payment refunds, 0)` for non-cancelled orders. Cancelled orders contribute zero.                                                  |
| Orders              | Count of non-cancelled source orders in the selected period.                                                                                         |
| Average order value | Net revenue divided by non-cancelled orders, rounded to the nearest minor unit. An empty period reports zero with no misleading percentage increase. |
| Items sold          | Sum of line-item quantities for non-cancelled orders.                                                                                                |

The comparison period has exactly the same duration and ends where the selected period begins. Percentage changes are integer basis points. When the previous value is zero and the current value is non-zero, `changeBasisPoints` is `null` and the interface describes the value as new rather than infinite growth.

Trend buckets use UTC days for ranges up to 45 days, weeks up to 180 days, and months beyond that. Each bucket contains reconciled net revenue, order count, and AOV. The interface exposes all three measures through one keyboard-operable chart control and follows it with a semantic values table.

Channel and location segments report net revenue. Product segments report line sales before order-level refunds because a payment refund cannot be allocated to a line without source allocation data. The interface labels this distinction. Up to eight segments are returned; each share still uses all matching segments as its denominator, so a truncated list does not falsely add to 100 percent.

## Orders and pagination

`GET /api/v1/organizations/{organizationId}/sales/orders` supports server-side filtering and stable sorting by occurrence time, order number, net revenue, or status. Pages contain 10–100 records and use a signed-context cursor containing the final sort value, record ID, direction, and a SHA-256 hash of the active filter set. Reusing a cursor after filters, sorting, or direction change fails validation instead of skipping or duplicating records.

The drill-down endpoint resolves the authorized order with its line items, payment summary, fulfilments, returns, and source reference. It returns 404 for a record outside the active tenant, avoiding cross-tenant existence disclosure.

## Exports

`POST /api/v1/organizations/{organizationId}/sales/exports` stores the normalized filter and sort contract in a durable PostgreSQL job. It requires CSRF protection and an idempotency key scoped to organization and requesting user.

The worker leases an organization from a non-sensitive dispatch table, then immediately enters that tenant's row-security context before claiming or producing an export. `FOR UPDATE SKIP LOCKED` allows worker replicas to claim distinct work. Processing claims become recoverable after five minutes, stop after three attempts, and enter an explicit terminal failure state. Completed CSV payloads expire after 24 hours; the default limit is 50,000 rows and oversized requests fail with `EXPORT_ROW_LIMIT` rather than returning a silent partial file.

CSV columns come from the same ordered row projection used by the on-screen table. Values are escaped according to CSV rules and downloaded only by the requesting user.

## Freshness states

- `empty`: the organization has no committed source orders.
- `fresh`: committed orders exist and the latest write is no older than 24 hours.
- `partial`: an import is queued/processing or a recent import failed; displayed totals include committed records only.
- `stale`: committed records exist but none were updated in the last 24 hours.

Every response includes its generation time, latest ingestion time where available, source-data horizon, and import counts. A refresh failure keeps the last successful values visible with an explicit retry action.

## Endpoints

| Method | Path                                 | Purpose                                                         |
| ------ | ------------------------------------ | --------------------------------------------------------------- |
| `GET`  | `/sales/overview`                    | KPIs, comparison, trends, segments, freshness, and definitions  |
| `GET`  | `/sales/filter-options`              | Tenant-derived currency, channel, location, and product choices |
| `GET`  | `/sales/orders`                      | Filtered, sorted, cursor-paginated source records               |
| `GET`  | `/sales/orders/{orderId}`            | Order drill-down                                                |
| `POST` | `/sales/exports`                     | Queue an idempotent CSV export                                  |
| `GET`  | `/sales/exports/{exportId}`          | Read the requesting user's export state                         |
| `GET`  | `/sales/exports/{exportId}/download` | Download a completed, unexpired export                          |

The complete versioned schema is available at `/api/openapi.json`; `pnpm openapi:generate` refreshes the checked-in client and `pnpm openapi:check` rejects contract drift.
