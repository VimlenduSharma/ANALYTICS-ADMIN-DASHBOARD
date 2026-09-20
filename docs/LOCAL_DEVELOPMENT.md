# Local Development

## Prerequisites

- Node.js 24.19 (the repository includes `.nvmrc` and `.node-version`).
- pnpm 11.19, activated through Corepack or installed independently.
- Docker Desktop, Colima, or another Docker Engine with Compose v2.

The package manager enforces the Node engine range, and Nx commands run through a small repository wrapper that fails early on an unsupported runtime. Angular's project-level persistent compiler cache is disabled because both its LMDB and SQLite backends proved unstable on this newer macOS release. Nx still caches complete task outputs, so repeatable repository-level caching remains available without the native cache risk.

Confirm the toolchain before installing:

```bash
node --version
pnpm --version
docker compose version
```

## First start

```bash
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm dev` performs three jobs in sequence:

1. Creates `.env` with cryptographically random local PostgreSQL and webhook signing secrets when the file is absent. Existing environments receive only missing values.
2. Starts health-checked PostgreSQL and Redis containers.
3. Builds the API and worker sequentially once, so their shared dependency outputs cannot race on a cold workspace.
4. Starts the Angular application, NestJS API, and background worker in watch mode.

The environment script uses an exclusive file write and never overwrites an existing `.env`. Local credentials remain ignored by Git. Production credentials must come from the selected hosting platform's secret manager, not this script.

Backend listener variables are named `API_HOST` and `API_PORT` so they cannot accidentally configure Angular's development server. PostgreSQL remains on port 5432 inside its container and is exposed on loopback port 55432 by default. To choose another host port, change both `POSTGRES_HOST_PORT` and the port in `DATABASE_URL` in the private `.env`.

## Useful commands

```bash
pnpm dev:web       # Angular application only
pnpm dev:api       # REST API only
pnpm dev:worker    # background worker only
pnpm infra:up      # PostgreSQL and Redis only
pnpm infra:down    # stop local containers
pnpm check         # complete static, test, and build gate
pnpm integration   # complete compiled backend behavior chain
pnpm resilience    # cache, backpressure, concurrency, outage, and shutdown gate
pnpm security      # isolated tenant and HTTP security gate
pnpm load          # accepted 30-second mixed-load profile
pnpm backup:restore # safe temporary PostgreSQL restore exercise
pnpm openapi:generate # refresh the versioned API specification and typed client
pnpm openapi:check # fail if either generated API artifact is stale
pnpm public:check  # check the production browser bundle for configured secrets
pnpm e2e           # desktop, tablet, and mobile Chromium journeys
```

Build phases in `pnpm build`, `pnpm check`, and `pnpm e2e` are intentionally serialized on a cold workspace. Concurrent API/worker or API/web bootstraps can otherwise contend over the same generated library output while Nx is restoring/building dependencies. Once those outputs exist, the long-running services still run together.

## Identity provider setup

The application starts safely without an identity provider and presents a recoverable “sign-in unavailable” state. To use a real development tenant, register a confidential web application with an OpenID Connect provider and add these values only to the ignored `.env`:

```dotenv
OIDC_CLIENT_ID=provider-issued-client-id
OIDC_CLIENT_SECRET=provider-issued-secret
OIDC_ISSUER_URL=https://identity-provider.example/tenant
OIDC_REDIRECT_URI=http://localhost:4200/api/v1/auth/callback
```

Register the redirect URI exactly as shown. The issuer must expose standard discovery metadata. Provider credentials and tokens terminate at the API and must never be placed in Angular files, committed environment files, browser storage, screenshots, or logs. Production validation requires HTTPS for both issuer and callback; production values belong in a managed secret store.

The Team screen assigns an existing directory identity. Governance also provides audited invitations with one-time acceptance links for people who have not joined the organization.

`pnpm e2e` uses a signed local OIDC provider that exists only in the browser-test process. It validates discovery, Authorization Code, S256 PKCE, state, nonce, client authentication, ID-token signature, route protection, and recovery behavior, then removes its synthetic identities and sessions.

## Data ingestion

The API accepts real organization data through authenticated order REST requests, HMAC-signed webhook endpoints, and durable CSV jobs. It does not load sample business records. See [Data ingestion](DATA_INGESTION.md) for headers, file columns, reconciliation rules, signature construction, status polling, and database-role requirements.

The generated OpenAPI document is available at `http://localhost:3000/api/openapi.json`. Regeneration starts a short-lived compiled API, so PostgreSQL and Redis must be healthy first.

## Sales analytics

Open `/organizations/{organizationId}/sales` after signing in and ingesting source orders. The page starts empty for a new organization and derives filters, KPIs, trends, segments, drill-downs, and exports from committed tenant data. See [Sales analytics](SALES_ANALYTICS.md) for exact metric and filtering semantics.

`SALES_EXPORT_MAX_ROWS` bounds one CSV job (50,000 by default), and `SALES_EXPORT_POLL_MS` controls worker polling (2,000 ms by default). Keep production values in managed runtime configuration. Reducing the poll interval or raising the row limit changes database and worker capacity and must be measured rather than treated as a cosmetic setting.

## Operations intelligence

Open `/organizations/{organizationId}/operations` after signing in. The workspace derives service risk from committed orders, fulfilments, returns, and inventory. A new organization remains empty until those sources are supplied through supported ingestion boundaries. See [Operations intelligence](OPERATIONS_INTELLIGENCE.md) for metric denominators, timezone/cutoff behavior, threshold limits, source-health semantics, role policy, alert workflow, and issue pagination.

Inventory snapshots are accepted at `POST /api/v1/organizations/{organizationId}/data/inventory`. Use a new `Idempotency-Key` for each distinct snapshot and send the BFF CSRF token. The same key and body can be retried safely; changing content under an existing key returns a conflict.

The Operations integration suite includes a local 50,000-order first-page threshold. Treat that check as deterministic regression evidence, not a deployed latency or concurrency promise.

## Resilience and observability

The API applies bounded rate, queue, request-time, dependency, and PostgreSQL pool budgets. Sales and Operations aggregates use short organization-scoped Redis caching with mutation invalidation and source fallback. See [Resilience and service protection](RESILIENCE.md) for exact policy and failure semantics.

Start the optional local monitoring stack with:

```bash
docker compose --profile observability up -d --wait prometheus grafana
```

Prometheus binds to `127.0.0.1:59090` and Grafana to `127.0.0.1:53000`. The local dashboard is read-only and intentionally contains no customer or credential labels. Production requires a separate metrics bearer credential and owned alert routing.

## Health model

- `GET /api/v1/health/live` proves that the API process can respond. It does not contact dependencies.
- `GET /api/v1/health/ready` checks PostgreSQL and Redis concurrently with bounded connection/query timeouts. It returns HTTP 503 when either dependency is unavailable.
- The Angular shell treats loading, degraded readiness, and network failure as different states and gives the user an explicit retry path.

## Common recovery steps

If readiness is degraded, run `docker compose ps` and inspect only the failing service's logs. If a local port is already occupied, choose another `POSTGRES_HOST_PORT` and update `DATABASE_URL`; do not stop an unrelated service or expose a database port on a public interface.

If local environment values need to be regenerated, move the existing `.env` to a secure backup location and run `pnpm env:prepare`. The script intentionally refuses to replace the original file.
