# Deployment contract

## Required services

A live environment needs:

- a container runtime for the web, API, worker, and one-shot migration images;
- PostgreSQL 17 with automated encrypted backups and point-in-time recovery;
- Redis 7 with TLS or a private network endpoint;
- an OpenID Connect application;
- a managed secret store;
- a TLS-terminating CDN/WAF and a controlled DNS zone; and
- Prometheus-compatible metrics, dashboards, alert routing, and named responders.

The application is provider-neutral. `deploy/compose.release.yaml` is the reference runtime topology and can be translated to a managed container service without changing image behavior.

## Cost-constrained demonstration profile

The supported no-monthly-charge profile is intended for interviews, product demonstrations, learning, and light evaluation traffic. It preserves the production security boundaries, but free providers do not promise the availability, capacity, backup retention, or support response expected from a paid production service.

Use this allocation:

- Cloudflare Pages: Angular assets, TLS, CDN/WAF, `/healthz`, and the same-origin `/api` proxy;
- Railway: one API service and one continuously running worker service;
- Neon: PostgreSQL 17 with separate owner and runtime credentials;
- Upstash Redis: TLS Redis endpoint for sessions, rate admission, and coordination;
- Auth0: a Regular Web Application using Authorization Code with PKCE; and
- provider-issued `pages.dev` and `up.railway.app` hostnames so no domain purchase is required.

Build Cloudflare Pages from `main` with `pnpm build:web:pages` and publish `dist/apps/web/browser`. Set `NODE_VERSION=24.19.0` and `PNPM_VERSION=11.19.0` as non-secret build variables. Configure `API_ORIGIN` and `EDGE_PROXY_SECRET` as encrypted Pages Function secrets. `API_ORIGIN` is the HTTPS Railway API origin; `EDGE_PROXY_SECRET` is a generated value of at least 32 characters and must exactly match the API service secret.

Create the Railway services from `deploy/Containerfile.runtime` with these build arguments:

| Workload       | `APP`        | Public port | Health check           |
| -------------- | ------------ | ----------- | ---------------------- |
| API service    | `api`        | `3000`      | `/api/v1/health/ready` |
| Worker service | `worker`     | none        | process lifecycle      |
| API pre-deploy | included in API image | none | `node migrations/main.js` |

Configure `node migrations/main.js` as the API service's Railway pre-deploy command. The runtime image includes this executable alongside the selected application so the hook runs against the exact release being deployed. The API and worker receive the pooled runtime database URL; only the API pre-deploy environment receives the direct database-owner URL. Create a separate non-owner Neon role for `RUNTIME_DATABASE_ROLE` before the first migration. Set the runtime PostgreSQL pool maximum to account for both processes and remain below Neon's connection limit.

Use the Cloudflare `pages.dev` origin as `WEB_ORIGIN`. Register `${WEB_ORIGIN}/api/v1/auth/callback` as the Auth0 Allowed Callback URL and `${WEB_ORIGIN}` as the Allowed Logout and Web Origins. Store Auth0, PostgreSQL, Redis, signing, encryption, metrics, and edge values only in provider secret stores.

## Public edge

Use a dedicated hostname such as `analytics.example.com`. The CDN/WAF must:

- enforce TLS 1.2 or newer and redirect HTTP to HTTPS;
- restrict direct origin access to the provider's edge network or require an unguessable edge proof that the edge replaces on every request;
- preserve the original host and client address through exactly one trusted reverse-proxy hop;
- enforce a request body limit at or below 10 MiB;
- rate-limit sign-in, webhook, and abusive API traffic without caching authenticated HTML or API responses;
- allow only required HTTP methods and block common injection, traversal, and protocol anomalies; and
- monitor certificate expiry, 5xx rate, origin latency, and WAF blocks.

The application Nginx layer adds CSP, frame denial, referrer policy, MIME sniffing protection, HSTS, and private-product indexing restrictions. Hashed static assets are immutable; the HTML shell is not cached.

## Database identities

Provision two distinct credentials:

- migration identity: schema owner with permission to create and alter application objects;
- runtime identity: non-owner, non-superuser, no `BYPASSRLS`, and no schema migration permission.

The migration job requires `MIGRATION_DATABASE_URL`, `DATABASE_URL`, and `RUNTIME_DATABASE_ROLE`. API and worker environments receive only `DATABASE_URL`. Production startup fails if the migration ledger does not exactly match the release.

## Runtime secrets

Inject these values from the environment's managed secret store. Never commit them or place them in image build arguments:

- `DATABASE_URL`
- `REDIS_URL`
- `OIDC_CLIENT_ID`
- `OIDC_CLIENT_SECRET`
- `CREDENTIAL_ENCRYPTION_KEY`
- `EDGE_PROXY_SECRET` when the API origin is publicly routable
- `WEBHOOK_SIGNING_KEY`
- `METRICS_BEARER_TOKEN`

Set `NODE_ENV=production`, `WEB_ORIGIN` to the canonical HTTPS origin, and `OIDC_REDIRECT_URI` to its callback. Other bounded defaults are defined and validated in `libs/config`.

## GitHub environments

Create protected `staging` and `production` environments. Each needs:

- secret `DEPLOY_WEBHOOK_URL`: the provider's authenticated deployment endpoint;
- secret `DEPLOY_WEBHOOK_TOKEN`: a scoped token for that endpoint; and
- variable `APPLICATION_URL`: the canonical HTTPS application origin.

Configure required reviewers for production. The deployment endpoint must pull the four images for the requested full commit SHA, run the migration container to completion, start API and worker, wait for API readiness, promote web traffic, and return only after the deployment is stable. A rollback request follows the same contract with a previously accepted SHA.

## Observability and ownership

Protect `/api/v1/observability/metrics` with the monitoring bearer token and a private network policy. Import the dashboards and alerts under `observability/`. Route alerts for dependency failure, saturation, elevated error rate, queue pressure, and latency to a named operator. Record the service owner, security contact, data-protection contact, backup owner, and DNS owner in the private operations system rather than this public repository.

## Pre-launch acceptance

A production launch is not complete until:

1. staging uses production-like managed services and the real OIDC flow;
2. migrations, integration, security, accessibility, and browser gates pass;
3. the release and rollback runbooks are rehearsed with immutable images;
4. a backup is restored into an isolated destination and validated;
5. DNS, TLS, WAF, origin restriction, health checks, dashboards, and alert delivery are verified; and
6. the built browser bundle and full repository history pass secret scanning.
