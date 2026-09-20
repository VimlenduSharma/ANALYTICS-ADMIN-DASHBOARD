# Security Policy

## Reporting a vulnerability

Use the repository's private security-advisory channel. Do not open a public issue containing exploit details, credentials, personal data, or private infrastructure information. Include the affected commit or release, reproduction conditions, and expected impact.

## Supported code

Security fixes target the latest release and the current `main` branch. A production operator should pin immutable image digests or full commit SHA tags and apply security updates through the normal staging gate.

## Security boundaries

- Provider tokens, database credentials, encryption keys, webhook keys, monitoring tokens, and refresh tokens are server-only.
- Browser sessions use opaque identifiers in `Secure`, `HttpOnly`, `SameSite=Lax`, `__Host-` cookies. Session records are rotated and revocable in Redis.
- State-changing browser requests require CSRF proof and an allowed origin.
- Organization authorization is checked in the API and enforced again through PostgreSQL row-level security.
- Query values are passed as PostgreSQL parameters. Dynamic identifiers are either fixed application constants or validated before quoting.
- Import and webhook idempotency is transactional; invalid CSV input cannot partially commit business rows.
- Runtime database roles must be non-owner roles without `SUPERUSER` or `BYPASSRLS`. A separate deployment identity runs migrations.
- Integration credentials are encrypted at rest, returned once at creation, and redacted from logs and API responses.
- Public error responses use stable codes and do not include stack traces, connection details, SQL, or secret values.

## Credential handling

Local credentials belong only in ignored `.env` files. Production credentials belong in a managed secret store and are injected at runtime. They must not be placed in workflow inputs, image build arguments, source files, browser configuration, issue text, or log output.

A credential committed at any point is considered compromised and must be revoked or rotated. Removing it from the current tree is not sufficient because repository history and caches may retain it.

## Deployment controls

Production requires TLS at the public edge, origin access restrictions, a managed WAF/CDN, protected deployment approvals, immutable images, migration gating, authenticated monitoring, automated backups, and a rehearsed rollback. See [Deployment](docs/DEPLOYMENT.md).
