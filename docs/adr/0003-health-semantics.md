# ADR 0003: Liveness and Readiness Semantics

- Status: Accepted
- Date: 2026-09-02

## Context

A process can be alive while unable to serve useful traffic because its database or cache is unavailable. Treating both cases as one health signal causes broken deployments and restart loops.

## Decision

Expose separate versioned endpoints. Liveness checks only the API process. Readiness checks PostgreSQL and Redis concurrently and reports each dependency's state and observed latency. Dependency connection and query time are bounded; readiness returns HTTP 503 when any required dependency is unavailable.

The frontend consumes readiness through the same-origin development proxy and models loading, healthy, degraded, and unreachable states explicitly.

## Consequences

- An orchestrator can stop routing traffic without repeatedly restarting a healthy process during a dependency outage.
- Operators and users can identify the affected dependency without exposing internal connection details.
- Future optional dependencies need an explicit policy before they can affect readiness.
