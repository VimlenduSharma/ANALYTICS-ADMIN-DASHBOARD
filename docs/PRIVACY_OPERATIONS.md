# Privacy operations

The product provides organization-scoped export, deletion, and retention workflows. This document describes technical behavior and is not a substitute for jurisdiction-specific legal advice or an organization's published privacy notice.

## Export and deletion requests

Only authorized organization roles can create requests. Each request has a durable identifier, actor, organization, target reference, state, checkpoint, attempt count, and audit history. Workers claim bounded batches; an interrupted job resumes from its last committed checkpoint. Terminal failure remains visible and can be retried through an authorized action.

Exports are requester-scoped and expire according to the configured policy. Delivery storage must be private, encrypted, short-lived, and accessed through a time-bounded authorization check. Deletion preserves records that an approved legal or financial retention rule requires and records the applied basis without copying unnecessary personal data into logs.

## Retention

Retention configuration is organization-scoped, validated, role-protected, and audited. A policy change affects future eligible processing and must not silently rewrite audit history. Operators should monitor queue age, retries, terminal failures, and processed counts.

## Operational safeguards

- Verify the requesting identity and organization before creating work.
- Never put personal data, export payloads, credentials, or one-time links in logs or incident channels.
- Encrypt payloads in transit and at rest.
- Make temporary artifacts inaccessible after expiry or cancellation.
- Record actor, reason, timestamps, counts, and outcome for sensitive actions.
- Test recovery by interrupting a job between checkpoints and confirming exactly-once effective results.
