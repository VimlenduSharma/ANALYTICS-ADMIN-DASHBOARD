# Governance and privacy operations

The Governance workspace is the organization control plane for access, connected data, retention, privacy requests, and accountability. It starts from real organization state and does not create sample members, integrations, customers, or jobs.

## Authorization boundary

All organization routes derive tenant access from the opaque BFF session and a current PostgreSQL membership. The Angular guard improves navigation, but API guards remain authoritative.

- **Owner:** organization policy, retention and privacy jobs, invitations through Admin, credential lifecycle, audit history, and role management.
- **Admin:** Governance overview, invitations for Analyst or Viewer, credential lifecycle, audit history, and delegated role management.
- **Analyst and Viewer:** no Governance route or API access.
- **Invited user:** may accept only a pending, unexpired invitation issued to the exact normalized email on the signed-in identity.

Sensitive mutations require the shared trusted-origin and CSRF checks. Role decisions are made per request; invitation input cannot create an Owner, and an Admin cannot invite or promote another Admin.

## Integration credentials

Every webhook endpoint receives 32 cryptographically random bytes represented as a base64url value. The cleartext is returned once when the endpoint is created or rotated. List and overview responses never contain it.

PostgreSQL stores only AES-256-GCM ciphertext, a unique 96-bit IV, an authentication tag, and a credential version. The cipher binds each value to organization ID, endpoint ID, and version as additional authenticated data. Moving ciphertext to another tenant, endpoint, or version therefore fails authentication. Rotation commits the new encrypted value before returning it, so the old secret stops verifying immediately. Revocation rejects all subsequent events.

`CREDENTIAL_ENCRYPTION_KEY` is a 32-byte base64url deployment secret. Local setup generates it into the ignored `.env`; production must supply it from a managed secret system. Key rotation and external KMS envelope encryption are Release operations and must use an explicit versioned migration, not an in-place environment change.

## Invitations and profile settings

Invitation links contain a random one-time token. Only its SHA-256 digest is persisted. Pending invitations expire after seven days, can be revoked, and become unusable after the first successful acceptance. Creating, revoking, and accepting an invitation produces an organization audit event.

Profiles expose display name, locale, and IANA timezone. Email remains identity-provider managed. Profile input is strictly validated and cannot carry roles, organization IDs, or other privilege-bearing fields.

## Durable retention and privacy jobs

Owner requests enter an organization-scoped queue with an idempotency key and canonical request digest. Replaying the same key and meaning returns one job; changing the request under that key fails with a conflict.

Workers lease organization dispatch rows with `FOR UPDATE SKIP LOCKED`, then enter a forced-RLS tenant transaction for business work. Abandoned processing leases return to the queue after five minutes. Five failed claims terminate with a stable failure code rather than retrying forever.

Retention progresses through bounded batches of at most 500 records per transaction:

1. expired sales exports;
2. terminal imports;
3. completed ingestion receipts;
4. closed orders and their dependent records; and
5. expired audit events.

The job checkpoint records its current phase and processed count. A worker interruption resumes from durable state without restarting completed phases.

Privacy exports resolve one customer external reference inside the organization and serialize its customer and order data. The artifact is divided into 64 KiB chunks, encrypted independently with AES-256-GCM and job/chunk authenticated context, and deleted after the configured download window. Downloads require an active authorized session and a completed, unexpired job.

Privacy deletion removes the customer reference and identifying order metadata while retaining de-identified financial facts needed for legitimate reporting. The operation is auditable and idempotent. Product policy and legal review must define whether a deployed organization is entitled to retain those financial facts.

## Audit explorer

The explorer filters by event type, actor, and UTC date bounds. Results use stable keyset pagination. Each opaque cursor includes a digest of its filters, so it cannot be replayed after query context changes. The API caps pages at 100 events and never returns events from another organization.

## REST surface

- `GET` and `PATCH /api/v1/profile`
- `GET /api/v1/organizations/{organizationId}/governance`
- `PATCH /api/v1/organizations/{organizationId}/governance/settings`
- `GET` and `POST /api/v1/organizations/{organizationId}/governance/invitations`
- `DELETE /api/v1/organizations/{organizationId}/governance/invitations/{invitationId}`
- `GET /api/v1/organizations/{organizationId}/governance/audit-events`
- `POST /api/v1/organizations/{organizationId}/governance/jobs`
- `GET /api/v1/organizations/{organizationId}/governance/jobs/{jobId}`
- `GET /api/v1/organizations/{organizationId}/governance/jobs/{jobId}/download`
- `POST /api/v1/organizations/{organizationId}/invitations/accept`
- `PUT /api/v1/organizations/{organizationId}/data/webhooks/{endpointId}/credential`

The compiled OpenAPI document and generated TypeScript client define the request and response shapes for these routes.

## Accessibility and responsive behavior

Governance uses the shared shell, fields, banners, dialogs, toasts, focus restoration, theme, and reduced-motion behavior. The job table is an explicitly labelled keyboard-focusable scroll region on narrow screens. Automated critical journeys run axe-core against WCAG 2.2 AA tags in both light and dark themes, while Playwright verifies keyboard confirmation, semantic names, page overflow, and desktop/tablet/mobile visual baselines.

Automated checks reduce known regressions; they do not replace manual screen-reader, zoom, cognitive-accessibility, or assistive-technology review before Release.
