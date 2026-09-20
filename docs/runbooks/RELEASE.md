# Runbook: release

## Preconditions

- The commit is reviewed and all continuous-integration jobs pass.
- Four images exist under one immutable full commit SHA.
- Staging and production use separate secret sets and data services.
- The target backup is current and the previous accepted image SHA is recorded.
- The release owner, approver, rollback owner, and observation window are named privately.

## Procedure

1. Deploy the immutable SHA to staging through the protected GitHub environment.
2. Run the one-shot migration image. Stop if runtime-role validation, migration application, or runtime verification fails.
3. Wait for API readiness, worker heartbeat, and edge health.
4. Run `APPLICATION_URL=https://staging.example.com pnpm release:smoke` plus the production-like browser and security journeys.
5. Inspect error rate, p95 latency, database pool waiting, queue depth, circuit state, and dependency readiness through the observation window.
6. Approve the production environment and promote the same SHA. Do not rebuild between environments.
7. Repeat smoke and observability checks. Exercise one tenant-scoped read and one idempotent replay without introducing sample business data.
8. Record the deployed SHA, migration ledger, approvers, start/end time, health evidence, and previous rollback SHA in the private operations log.

## Stop conditions

Do not promote when a schema check fails, a runtime role owns or bypasses row security, readiness is degraded, secret scanning reports a match, an accessibility/security journey fails, or the observed error/latency budget is exceeded.
