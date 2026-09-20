# ADR 0009: Encrypted governance and resumable privacy workflows

## Status

Accepted on 2026-09-12.

## Context

Organization owners need to rotate integration credentials, control retention, satisfy privacy requests, invite members, and inspect an accountable history. These operations are security-sensitive, potentially destructive, and too expensive or failure-prone to complete inside one HTTP request. Returning stored cleartext secrets or allowing jobs to restart from memory would make the control plane unsafe under replica restarts and retries.

## Decision

1. Keep browser authentication in the existing BFF session and authorize Governance routes from current organization membership on every request.
2. Limit policy and privacy jobs to Owners. Permit Admins to inspect Governance, manage integration credentials, and invite only Analyst or Viewer roles.
3. Generate per-endpoint random webhook credentials. Encrypt them with AES-256-GCM using unique IVs and organization/endpoint/version additional authenticated data. Return cleartext only on creation or rotation.
4. Persist invitation token digests rather than invitation tokens, enforce normalized-email acceptance, expiry, revocation, and one-time use.
5. Store retention, export, and deletion requests as idempotent jobs. Lease organization dispatch rows globally, then process business state in forced-RLS tenant transactions.
6. Make retention progress phase- and batch-checkpointed. Recover stale claims, cap retries, and expose stable terminal states.
7. Encrypt privacy-export artifacts in bounded authenticated chunks and apply a separately configurable download expiry.
8. Preserve de-identified commercial facts during subject deletion while removing the customer reference and identifying order metadata.
9. Record every sensitive request and lifecycle transition in the audit stream and bind audit pagination cursors to their filters.

## Consequences

- A database read alone does not disclose active integration secrets or privacy exports.
- Credential rotation invalidates the prior secret immediately and has an auditable version boundary.
- Multiple worker replicas can make progress without processing the same organization dispatch concurrently.
- Retention and privacy work survives worker interruption, but PostgreSQL remains a required queue and artifact dependency at this scale.
- The deployment encryption key is now a high-value managed secret. Loss prevents decryption; compromise requires credential and artifact rotation procedures.
- De-identified financial retention is an explicit product/legal policy, not an accidental side effect of deletion.

## Alternatives considered

- **Store webhook secrets as one-way hashes:** rejected because HMAC verification needs the original key unless a separate signing service owns verification.
- **Derive every endpoint secret from one root key:** replaced because independent random credentials can be rotated without invalidating unrelated endpoints.
- **Return credentials from list endpoints:** rejected because convenience would turn every read path into a secret-exfiltration path.
- **Run deletion synchronously:** rejected because large subjects, transient failures, and request timeouts need durable checkpoints and observable recovery.
- **Introduce a separate queue and object store immediately:** deferred until load evidence justifies another consistency and operations boundary.
- **Delete complete financial orders for every privacy request:** rejected as a universal default; deployed legal basis and retention obligations must be configured explicitly.

## Verification

The Governance integration suite tests role escalation and cross-tenant denial, token hashing and one-time acceptance, encrypted-at-rest credential storage, immediate rotation, job idempotency, stale-claim recovery, retry exhaustion, encrypted export chunks, retention, privacy deletion, cursor binding, RLS, and OpenAPI exposure against live PostgreSQL, Redis, and the compiled API.
