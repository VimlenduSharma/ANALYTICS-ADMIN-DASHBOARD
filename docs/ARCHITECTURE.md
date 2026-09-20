# Architecture

## System boundaries

The browser application is a presentation and interaction client. It never stores identity-provider tokens, signing keys, database credentials, integration credentials, or long-lived bearer tokens. It calls same-origin `/api` routes through the public edge.

The API owns request authentication, authorization, validation, transactional commands, analytical reads, and stable error contracts. The worker owns asynchronous import, export, retention, privacy, and recovery work. Both run from immutable images and share application libraries, contracts, and environment validation without sharing process state.

PostgreSQL is authoritative for organizations, membership, source data, idempotency receipts, jobs, policies, and audit events. Redis contains disposable coordination state: opaque sessions, distributed request admission, circuit state, and short-lived aggregate cache entries. Loss of Redis degrades or fails closed according to the route's security role; it does not become a second system of record.

## Request path

The public CDN and WAF terminate TLS and forward only to the private Nginx origin. Nginx serves the Angular build and proxies `/api` to the API service. The API accepts one trusted proxy hop, validates the configured web origin, and applies security headers, request limits, deadlines, and rate admission before domain work starts.

OpenID Connect sign-in uses Authorization Code with PKCE. The callback exchanges the authorization code on the server, creates an opaque Redis session, and sets a host-only cookie. State-changing browser requests also submit a session-bound CSRF value held in memory.

Organization routes resolve membership and permission before entering a tenant transaction. The transaction sets `app.organization_id`; forced PostgreSQL policies reject rows outside that organization even if an application query is wrong. Audit events are committed in the same durable boundary as sensitive changes.

## Data ingestion

REST, signed webhook, and CSV paths normalize input through shared schemas. Idempotency keys and source identities are protected by database constraints. CSV validation and writes occur through durable jobs and transactions, so rejected files do not partially mutate source state. OpenAPI is generated from the compiled API and the checked-in client is verified for drift.

## Analytical reads

Sales and operations views aggregate committed source records inside tenant-scoped, read-only repeatable-read transactions. Every filter is represented in the URL and the server query so cards, charts, tables, and exports share one definition. Large drill-downs use bounded keyset pagination. Cache entries are organization-scoped, short-lived, and safe to rebuild from PostgreSQL.

## Deployment boundary

Runtime identities only verify the expected migration ledger. The one-shot migration image uses a separate database identity to acquire an advisory lock, apply forward migrations transactionally, grant bounded runtime access, and verify the result through the runtime identity before promotion.

API and worker processes handle termination signals, stop accepting new work, and close Redis and PostgreSQL connections within the configured grace period. Readiness reflects required dependency health; liveness reports only process viability.

## Scaling model

The measured baseline is a bounded modular service, not an assertion of unlimited users. Scale API and worker replicas horizontally only after accounting for aggregate database pool size and queue ownership. Add read replicas, maintained rollups, partitioning, or a separate event platform only when query plans, cardinality, and concurrent load evidence justify their operational cost.
