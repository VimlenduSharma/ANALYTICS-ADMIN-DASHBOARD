# Runbook: rollback

## Decision boundary

Rollback application images when a release causes elevated errors, latency, regressions, or health failure and dependencies are otherwise healthy. Do not reverse a database migration blindly. Migrations are forward-oriented; assess data compatibility first and ship a corrective migration when required.

## Procedure

1. Freeze further promotion and identify the last accepted full commit SHA.
2. Confirm the earlier API and worker can read the current schema. If compatibility is uncertain, stop writes and involve the database owner.
3. Run the protected deployment workflow with `operation=rollback` and the accepted SHA.
4. Wait for API readiness, worker heartbeat, and edge health, then run the external release smoke.
5. Verify tenant authorization, one representative analytical read, queue recovery, error rate, and p95 latency.
6. Keep the failed images and logs available for investigation. Do not expose credentials or customer payloads in the incident record.
7. Record cause, affected interval, rolled-back and restored SHAs, schema version, approvals, and follow-up owner.

Escalate to the backup/restore runbook only when corruption or data loss is evidenced. Availability failure alone does not authorize restoring over a primary database.
