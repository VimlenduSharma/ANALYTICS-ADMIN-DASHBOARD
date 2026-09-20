# ADR 0002: Secret Boundaries

- Status: Accepted
- Date: 2026-09-02

## Context

The product will eventually connect to identity providers and external data sources. Those integrations require credentials that must not enter browser bundles, source history, screenshots, or logs.

## Decision

All privileged integrations terminate at the API or worker. The browser uses same-origin REST calls and, once Identity is implemented, an opaque secure session cookie. Server configuration is parsed from process environment at startup and fails closed when required values are missing or malformed.

For local work, an idempotent script writes a random password into an ignored mode-`0600` `.env` file. It never replaces an existing file. `.env.example` contains only non-secret placeholders. Production values will be injected by a managed secret store.

## Consequences

- Frontend environment files cannot become a credential channel.
- Server processes will refuse to start with incomplete configuration, making deployment errors visible early.
- Local onboarding remains one command without sharing a default password.
- Future connector credentials require encryption, write-only API behaviour, rotation, and audit events.
