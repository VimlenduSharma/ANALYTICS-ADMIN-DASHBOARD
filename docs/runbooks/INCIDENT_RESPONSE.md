# Runbook: incident response

## Priorities

1. Protect people and customer data.
2. Stop unauthorized access or destructive writes.
3. Preserve reliable evidence.
4. Restore bounded service safely.
5. Communicate through the organization's approved private channels.

## Initial response

Assign an incident lead, note the start time and affected environments, and classify confidentiality, integrity, and availability impact. Revoke exposed credentials and sessions rather than only hiding them. Restrict traffic at the WAF or origin when active abuse continues. Preserve relevant audit events, deployment SHAs, infrastructure events, and redacted application logs.

For dependency or capacity failure, follow [Dependency outage](DEPENDENCY_OUTAGE.md). For release regression, follow [Rollback](ROLLBACK.md). For evidenced data loss, follow [Backup and restore](BACKUP_RESTORE.md).

## Security events

- Rotate the affected secret and any credential derived from it.
- Search repository history, image layers, workflow logs, browser bundles, and observability systems for the exposed value.
- Revoke active sessions when identity or cookie integrity is uncertain.
- Review tenant access and audit trails for cross-organization activity.
- Preserve evidence before deleting malicious records or blocking accounts.

## Recovery and review

Confirm liveness, readiness, authentication, tenant isolation, idempotent replay, queue recovery, metrics, and alerts. Monitor through a defined stability window. The private incident review should capture impact, detection, timeline, contributing controls, corrective work, owners, and due dates without reproducing personal data or secrets.
