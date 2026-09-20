# ADR 0004: OIDC BFF sessions and database-backed tenant authorization

- Status: Accepted
- Date: 2026-09-03

## Context

The dashboard must authenticate people without exposing provider credentials or tokens to browser JavaScript. A valid identity must not imply access to every organization, and a role sent by a browser cannot be treated as authorization evidence. State-changing cookie-authenticated requests also need an explicit cross-site request-forgery boundary.

## Decision

Use a backend-for-frontend identity boundary with these properties:

1. The API performs provider-neutral OpenID Connect discovery and Authorization Code flow with S256 PKCE, `state`, and `nonce`. Sign-in transactions are one-use Redis records with a ten-minute lifetime.
2. Provider access and ID tokens terminate at the API. The browser receives only a random opaque session token in a host-bound cookie; Redis stores only its SHA-256-derived lookup key and the server-side session record.
3. Sessions have idle and absolute expiry, rotate after a bounded age, and can be revoked individually or across the user. Rotation claims the old token atomically and invalidates it.
4. Production cookies use the `__Host-` prefix, `Secure`, `HttpOnly`, `SameSite=Lax`, and `Path=/`, with no `Domain` attribute. Insecure OIDC transport is permitted only in the isolated browser-test process when `NODE_ENV=test`; production identity endpoints must use HTTPS.
5. Unsafe API requests require both an exact trusted `Origin` and a constant-time match against a synchronizer CSRF token kept in the server-side session. Safe methods remain read-only.
6. PostgreSQL stores users, organizations, memberships, and durable audit events. Protected organization requests derive the user from the verified session and resolve membership from PostgreSQL on every request.
7. Roles are `OWNER`, `ADMIN`, `ANALYST`, and `VIEWER`. Owners can manage every role; Admins can manage only Analysts and Viewers; Analysts and Viewers cannot manage membership. A transaction-level lock prevents removal or demotion of the final Owner.
8. Both Angular route guards and API guards hide inaccessible management surfaces, but only the API decision is authoritative. Errors use the shared predictable API envelope and sign-in callbacks return bounded recovery codes rather than provider details.

## Consequences

- API instances remain horizontally scalable because session state is externalized to Redis and authorization state to PostgreSQL.
- Revocation and role changes take effect without waiting for a browser token to expire.
- Redis availability is required for authenticated requests and is therefore part of readiness.
- The first team shell can assign an existing directory identity after that person has signed in once. Invitation delivery is intentionally deferred to Governance.
- Session rotation is fail-closed under concurrent use: one request claims the old token and a racing request must retry with the rotated cookie.
- Provider-specific enterprise mapping and lifecycle provisioning remain adapters around this standards-based boundary rather than browser concerns.

## Verification

- Unit tests cover the role matrix and production cookie attributes.
- A compiled-API integration gate uses real PostgreSQL and Redis to verify anonymous denial, cross-tenant denial, Viewer denial, Admin escalation denial, CSRF token and Origin checks, final-Owner continuity, audit creation, logout, all-session revocation, and rotation invalidation.
- Playwright completes the real redirect/code/token/signature flow against an isolated signed OIDC test provider in desktop and mobile Chromium, then verifies route denial, logout, callback recovery, responsive access, and theme persistence.

## References

- [OAuth 2.0 Security Best Current Practice (RFC 9700)](https://www.rfc-editor.org/rfc/rfc9700.html)
- [OpenID Connect Core 1.0](https://openid.net/specs/openid-connect-core-1_0.html)
- [OWASP Cross-Site Request Forgery Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)
- [openid-client documentation](https://github.com/panva/openid-client)
