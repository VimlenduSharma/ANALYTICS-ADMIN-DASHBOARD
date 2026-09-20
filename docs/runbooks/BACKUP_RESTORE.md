# Runbook: PostgreSQL backup and restore

## Safety boundary

`pnpm backup:restore` is a local verification exercise. It takes a custom-format dump from the Compose PostgreSQL service, creates a uniquely named temporary database, restores into that database, compares counts and deterministic content fingerprints for critical tables, drops only the temporary database, and deletes the owner-only temporary dump.

The script never drops, truncates, or restores over the source database. Do not adapt it to a production destination without an approved change, a verified target identifier, and an incident/recovery owner.

## Local exercise

```bash
pnpm infra:up
pnpm backup:restore
```

A passing result includes:

- a non-empty custom-format backup with the PostgreSQL magic header;
- all applied migration rows;
- equal source/restored counts and fingerprints for migrations, organizations, orders, and audit events; and
- successful cleanup of the random restore database and local temporary directory.

## Production recovery procedure

1. Declare the recovery point, recovery-time objective, destination environment, and incident owner.
2. Quiesce writes or isolate the replacement destination. Never restore into a writable active primary.
3. Verify backup provenance, encryption, checksum, retention status, PostgreSQL compatibility, and point-in-time recovery coordinates.
4. Restore into a new isolated database/cluster using a least-privilege recovery identity.
5. Validate migrations, constraints, row counts/fingerprints, tenant row security, recent idempotency receipts, and application smoke queries.
6. Run the security and critical browser journeys against the isolated replacement.
7. Switch traffic through the platform's controlled promotion mechanism only after approval; retain the former primary for the rollback window.
8. Record measured RPO/RTO, discrepancies, approvals, and follow-up actions without exposing connection details or customer data.

The local exercise proves logical dump and restore behavior. A production launch additionally requires verified automated encryption, point-in-time recovery, off-primary retention, documented RPO/RTO, and named restore ownership in the selected infrastructure provider.
