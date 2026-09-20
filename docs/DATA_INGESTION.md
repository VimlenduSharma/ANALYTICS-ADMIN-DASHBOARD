# Data Ingestion

The ingestion boundary accepts source-owned order snapshots through authenticated REST, signed webhooks, and atomic CSV jobs. Production starts empty; these interfaces accept data supplied by each organization.

## Shared order rules

- Source identifiers are strings up to 160 characters and must remain stable within a source.
- Monetary values are non-negative integer minor units. For example, USD 19.95 is `1995`.
- Currency and country values use uppercase ISO-style three- and two-letter codes.
- Timestamps are ISO 8601 instants with an explicit offset, such as `2026-09-03T10:30:00Z`.
- The order total must equal `subtotal - discount + tax + shipping`.
- The subtotal must equal the sum of line totals. Each line total must equal `quantity × unit price - discount + tax`.
- Re-sending a source order replaces its line, payment, fulfilment, and return snapshot atomically.

The authoritative machine contract is available at `GET /api/openapi.json`. Generate the checked-in TypeScript client with `pnpm openapi:generate` while local infrastructure is running.

## Authenticated REST

`POST /api/v1/organizations/{organizationId}/data/orders` requires an Owner, Admin, or Analyst session, the session CSRF token, and a stable `Idempotency-Key` header.

```http
Content-Type: application/json
Idempotency-Key: source-delivery-01J8Y8X4JED0Q6N5KGT61V7MZY
X-CSRF-Token: <session-bound token>
```

The JSON body follows the generated `DataController_ingestOrder_v1` request type. Unknown properties and unreconciled totals are rejected before persistence. Reusing an idempotency key with different content returns `409 IDEMPOTENCY_KEY_REUSED`.

## Signed webhooks

An Owner or Admin creates an endpoint through `POST /api/v1/organizations/{organizationId}/data/webhooks`. The response returns the endpoint secret once. Store it in the sending platform's secret manager; later list responses never contain it.

Each delivery sends:

```http
X-Webhook-Event-Id: <stable unique delivery identifier>
X-Webhook-Timestamp: <Unix seconds>
X-Webhook-Signature: v1=<lowercase SHA-256 HMAC in hexadecimal>
```

Compute the signature over the exact bytes `${timestamp}.${rawRequestBody}` using the base64url-decoded endpoint secret as the HMAC-SHA256 key. The API compares the digest in constant time, rejects timestamps outside the configured five-minute window, and uses the event identifier as the idempotency key. Revoking the endpoint makes every later signature fail closed.

The root `WEBHOOK_SIGNING_KEY` is server-only. It belongs in a production secret manager and must never enter Angular configuration, source control, logs, screenshots, or a third-party sender.

## Atomic CSV imports

Send UTF-8 CSV bytes to `POST /api/v1/organizations/{organizationId}/data/imports/orders` with `Content-Type: text/csv`, `X-Import-Filename`, `Idempotency-Key`, and the normal session/CSRF credentials. Poll `GET /api/v1/organizations/{organizationId}/data/imports/{importId}` until the job is `completed` or `failed`.

Required columns:

- `order_external_id`, `order_number`, `order_status`, `currency`, `occurred_at`
- `channel_external_id`, `channel_name`, `channel_kind`
- `item_external_id`, `product_external_id`, `sku`, `product_name`
- `quantity`, `unit_price_minor`, `item_total_minor`
- `order_subtotal_minor`, `order_total_minor`

Optional columns:

- `order_discount_minor`, `order_tax_minor`, `order_shipping_minor`, `source_updated_at`
- `item_discount_minor`, `item_tax_minor`
- `location_external_id`, `location_name`, `location_kind`, `location_timezone`
- `customer_external_id`
- `payment_status`, `payment_authorized_minor`, `payment_captured_minor`, `payment_refunded_minor`

Rows sharing `order_external_id` form one order and must repeat the same order-level values. The worker parses and validates every row before opening the business-data transaction. If any row is invalid, no order from the file is written and the job exposes a bounded field/row error report. Completed and failed jobs discard the raw CSV payload.

## Database roles

PostgreSQL row security is a second boundary, not a replacement for API authorization. In deployment:

- the migration role owns schema objects and is not used for requests;
- the API role is non-owner, cannot bypass row security, and receives only required DML privileges;
- the queue worker may use a separate narrowly scoped role that can claim jobs across organizations, then sets the organization context before processing business rows; and
- application transactions set `app.organization_id` locally so pooled connections cannot retain tenant state.

Production migration execution is isolated in the one-shot deployment gate. Integration tests also prove the row-security policies through a temporary non-owner role.
