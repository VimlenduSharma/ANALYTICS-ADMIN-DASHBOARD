# ADR 0005: Transactional ingestion and tenant-owned business data

- **Status:** accepted
- **Date:** 2026-09-03

## Context

The product must accept the same real source data through synchronous REST, asynchronous CSV files, and externally delivered webhooks without producing duplicate orders or partially committed snapshots. Organization identifiers arrive through routes, but neither application bugs nor direct database access should silently cross tenant boundaries. API contracts also need to remain usable by Angular without manually maintained duplicate interfaces.

## Decision

Use PostgreSQL as the durable source of truth and a shared server library as the owner of migrations, validation, idempotency, and import mechanics.

1. Every tenant-owned table carries `organization_id`. Composite foreign keys pair entity IDs with that organization, preventing a valid identifier from one tenant being attached to another tenant's record.
2. Money is stored as `bigint` minor units with a three-letter currency code. Database checks and Zod refinements independently enforce reconciled order, line, and refund totals.
3. Source identity is expressed through organization-scoped unique keys. Order ingestion upserts the parent and replaces the child snapshot in one transaction.
4. `ingestion_requests` stores `(organization, source, idempotency key)`, a canonical request hash, and the completed response. The row is locked during processing. Same-key/same-content delivery returns the stored response; changed content fails with a conflict.
5. Webhook endpoint secrets are derived from a server-only root key and endpoint ID, returned once, and never stored as plaintext. Signatures cover the timestamp and exact raw body, are compared in constant time, and expire after a bounded clock window.
6. CSV uploads become durable PostgreSQL jobs. Workers claim with `FOR UPDATE SKIP LOCKED`, validate the whole file before business writes, and commit all orders plus final job state in one tenant transaction. Raw file content is removed on terminal status.
7. Tenant tables enable and force PostgreSQL row-level security. Policies use a transaction-local `app.organization_id`; the runtime API role must be a non-owner without `BYPASSRLS`.
8. Nest generates a versioned OpenAPI document from controller metadata. Hey API generates a checked-in buildable Fetch SDK and TypeScript models, and a drift check compares both generated artifacts with the live API.
9. Migrations carry explicit `up` and `down` SQL. The acceptance suite applies both migrations in a disposable schema, rolls Data Core down, and applies it forward again.

## Consequences

- Duplicate transport delivery and duplicate source snapshots are separate concerns and are both handled explicitly.
- A failed validation, constraint, or child write rolls back the idempotency receipt and all business changes together.
- CSV jobs survive API or worker restarts and can be claimed safely by multiple worker replicas. Retry exhaustion, terminal failure, and measured backpressure use the shared queue policy.
- The worker needs carefully controlled cross-tenant queue-claim access; after claiming, business processing returns to a tenant-local transaction.
- Replacing snapshot children favors correctness and clear source semantics. If measured write amplification becomes material, a later change can use keyed child upserts without altering the external contract.
- Automatic startup migrations are acceptable during phased local development. Release must separate the schema-owner migration role from API/worker runtime roles.

## Alternatives considered

- **In-memory jobs:** rejected because process restarts lose work and horizontal workers cannot coordinate safely.
- **Accept valid CSV rows while rejecting others:** rejected because users could not reason about which version of a file became authoritative.
- **Store webhook secrets directly:** rejected because a database read would expose every sender credential.
- **Application-only tenant filters:** rejected because one missed predicate would become a cross-tenant disclosure.
- **Floating-point money:** rejected because binary rounding is inappropriate for reconciliation and database checks.
- **Hand-maintained frontend interfaces:** rejected because they drift silently from versioned API behavior.

## References

- [PostgreSQL row security](https://www.postgresql.org/docs/17/ddl-rowsecurity.html)
- [PostgreSQL `SELECT` locking and `SKIP LOCKED`](https://www.postgresql.org/docs/17/sql-select.html)
- [Nest raw body access](https://docs.nestjs.com/faq/raw-body)
- [Nest OpenAPI introduction](https://docs.nestjs.com/openapi/introduction)
- [Hey API OpenAPI TypeScript](https://heyapi.dev/docs/openapi/typescript/get-started)
