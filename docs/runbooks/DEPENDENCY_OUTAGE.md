# Runbook: dependency outage

## Trigger

Use this runbook when readiness is `503`, the `AnalyticsDependencyCircuitOpen` alert fires, database acquisition begins queueing, or user requests return `REDIS_UNAVAILABLE`, `RATE_LIMIT_UNAVAILABLE`, `DATABASE_POOL_SATURATED`, or `DEPENDENCY_UNAVAILABLE`.

## First response

1. Confirm `/api/v1/health/live` still answers. If it does not, treat the API process or platform as the primary incident.
2. Read `/api/v1/health/ready` and identify the failing dependency from `details.dependencies`.
3. Check request error rate and latency, database pool total/idle/waiting values, cache outcomes, and dependency circuit state in the Resilience dashboard.
4. Freeze nonessential imports, exports, or privacy jobs if queue depth is rising. Do not increase limits while a dependency remains unhealthy.
5. Check the managed dependency's health, connection quota, recent configuration changes, and regional status. Never paste connection strings, tokens, or customer payloads into the incident channel.

## Redis behavior

- Liveness remains healthy and readiness becomes degraded.
- Authentication/session and distributed rate-admission paths fail closed.
- Aggregate cache operations bypass to PostgreSQL only after a request has already passed the security boundary.
- Three failed calls open the circuit; calls reject quickly until the reset interval permits one probe.

Restore Redis connectivity or revert the bad endpoint. Confirm one half-open probe succeeds, the circuit metric returns to zero, readiness becomes `200`, and authenticated traffic recovers before reopening queued work.

## PostgreSQL behavior

- New source reads and writes fail; the API must not invent stale success for transactions.
- The statement timeout bounds slow queries, the acquisition queue is capped, and excess work returns a stable saturation error.
- Do not blindly increase API replicas: each replica owns a pool and can worsen connection exhaustion.

Restore connectivity or release the identified blocker. Confirm pool waiting returns to zero, migration state is unchanged, readiness becomes `200`, and one tenant-scoped read plus one idempotent replay succeeds.

## Recovery checks

1. Verify liveness and readiness.
2. Confirm five-minute error rate and p95 latency return inside budget.
3. Replay one previously accepted webhook/import idempotency key and verify no duplicate source record or job appears.
4. Confirm queue processing resumes and stale leases recover within their documented claim window.
5. Record start/end time, affected routes and tenants, dependency cause, corrective action, and follow-up owner. Never record secrets or raw personal data.

Escalate to rollback when the outage follows a release and dependency health is otherwise normal. Escalate to restore only when data loss or corruption is evidenced; availability loss alone is not permission to overwrite the primary database.
