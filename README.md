# Analytics Admin Dashboard

A multi-tenant analytics workspace for sales, fulfilment, inventory, governance, and operational risk. It accepts organization-owned data through authenticated APIs, signed webhooks, and atomic CSV imports, then exposes reconciled metrics and drill-down workflows without shipping sample business data.

## Product capabilities

- Revenue, orders, average order value, product, channel, and location analysis with consistent URL-bound filters.
- Fulfilment lead time, backlog aging, returns, cancellation, stock risk, service-level views, alerts, and configurable organization thresholds.
- Cursor-paginated investigation views and requester-scoped export jobs for large result sets.
- Organization membership with Owner, Admin, Analyst, and Viewer policies.
- Data-source credentials that are encrypted at rest and shown once at creation.
- Audit exploration, retention controls, resumable privacy export/deletion jobs, and accountable member invitations.
- Responsive, keyboard-accessible light and dark interfaces with explicit loading, empty, stale, partial, error, and success states.

## Runtime architecture

The Nx workspace contains four independently deployable applications:

- `web`: Angular 22 browser application served by Nginx.
- `api`: NestJS 11 and Fastify REST API.
- `worker`: background import, export, governance, and retention processing.
- `migrations`: one-shot schema deployment gate.

PostgreSQL 17 is the durable system of record. Forced row-level security backs application authorization. Redis 7 stores opaque browser sessions, short-lived aggregate cache entries, distributed admission state, and coordination data. OpenID Connect uses Authorization Code with PKCE through a backend-for-frontend boundary.

See [Architecture](docs/ARCHITECTURE.md) and the decision records in `docs/adr` for the detailed boundaries.

## Security model

- The browser receives an opaque session identifier only in a `Secure`, `HttpOnly`, `SameSite=Lax`, `__Host-` cookie. Provider tokens and client secrets remain server-side.
- State-changing requests require a session-bound CSRF token and an allowed origin.
- Every tenant read or write is checked in the API and inside a PostgreSQL transaction with row-level security context.
- SQL values are parameterized. The few dynamic identifiers used by infrastructure code are constrained to validated allowlists or identifier grammar.
- Runtime database identities cannot own the schema, run migrations, use `BYPASSRLS`, or act as superusers.
- Production migration credentials, encryption keys, OIDC secrets, webhook keys, and monitoring tokens are injected at deployment time and never built into images.
- Rate limits, bounded database pools, request timeouts, circuit breakers, queue backpressure, graceful shutdown, and authenticated metrics define predictable failure behavior.

Read [Security Policy](SECURITY.md) before reporting a vulnerability.

## Local development

Requirements:

- Node.js 24.19
- pnpm 11.19
- Docker Desktop or a compatible Docker Engine with Compose

```bash
pnpm install --frozen-lockfile
pnpm dev
```

The command creates an ignored local `.env` when needed, starts PostgreSQL and Redis, and serves the web, API, and worker processes. Local sign-in requires an OIDC application configured only in `.env`.

- Web: `http://localhost:4200`
- API liveness: `http://localhost:3000/api/v1/health/live`
- API readiness: `http://localhost:3000/api/v1/health/ready`
- OpenAPI: `http://localhost:3000/api/openapi.json`

Use the dedicated [VS Code workspace](analytics-admin-dashboard.code-workspace), or read [Local development](docs/LOCAL_DEVELOPMENT.md) for identity setup and troubleshooting.

## Verification

```bash
pnpm check
pnpm integration
pnpm migrate:test
pnpm security
pnpm resilience
pnpm load
pnpm backup:restore
pnpm openapi:check
pnpm e2e
```

The gates cover formatting, strict type checks, lint, unit tests, production builds, live PostgreSQL and Redis integration, cross-tenant authorization, SQL injection boundaries, migration forward verification, fault behavior, idempotency, accessibility, and desktop/tablet/mobile browser journeys. The accepted local mixed-load profile is documented in [Capacity evidence](docs/performance/RESILIENCE_CAPACITY.md); it is evidence for one measured environment, not a claim of unlimited scale.

## Release

Images are built from pinned multi-stage container definitions and published to GitHub Container Registry by immutable commit SHA. A protected deployment environment promotes the same image set to staging or production, runs the one-shot migration gate before traffic moves, and executes external smoke checks after promotion. Selecting an earlier tested SHA uses the same path for rollback.

Provider-specific host, domain, DNS, TLS, WAF, secret-store, backup, and monitoring ownership must be configured before the first live release. The repository does not contain those credentials.

- [Deployment contract](docs/DEPLOYMENT.md)
- [Release runbook](docs/runbooks/RELEASE.md)
- [Rollback runbook](docs/runbooks/ROLLBACK.md)
- [Incident response](docs/runbooks/INCIDENT_RESPONSE.md)
- [Backup and restore](docs/runbooks/BACKUP_RESTORE.md)
- [Privacy operations](docs/PRIVACY_OPERATIONS.md)

## License

Released under the [MIT License](LICENSE).
