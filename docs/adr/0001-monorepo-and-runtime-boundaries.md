# ADR 0001: Monorepo and Runtime Boundaries

- Status: Accepted
- Date: 2026-09-02

## Context

The product needs a browser application, request-serving API, background processing, and contracts shared across those boundaries. Business features will grow in phases and must remain independently testable and deployable.

## Decision

Use an Nx monorepo managed with pnpm. Keep three applications: Angular web, NestJS/Fastify API, and a NestJS application-context worker. Shared libraries contain serializable contracts, server environment validation, and test fixtures. Nx tags prevent browser and server code from bypassing shared boundaries.

The API handles bounded synchronous work. Imports, aggregate refreshes, and exports will run in the worker so request latency is not coupled to long jobs. PostgreSQL is the system of record and Redis supports ephemeral coordination.

## Consequences

- One repository can atomically change an API contract and its consumer.
- The API and worker can scale and deploy independently.
- Build tooling is more involved than separate small repositories, so pinned versions and CI checks are mandatory.
- Shared libraries must remain narrow; they are not a place for cross-application shortcuts.
