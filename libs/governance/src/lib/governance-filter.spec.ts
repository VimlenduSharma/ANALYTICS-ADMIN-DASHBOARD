import {
  auditQuerySchema,
  governanceJobRequestSchema,
  profileUpdateSchema,
  requestDigest,
  settingsUpdateSchema,
} from './governance-filter';

describe('governance validation', () => {
  it('accepts strict, bounded governance inputs', () => {
    expect(
      settingsUpdateSchema.parse({
        auditRetentionDays: 365,
        exportRetentionHours: 24,
        name: 'Northstar Retail',
        operationalDataRetentionDays: 730,
        privacyExportRetentionHours: 12,
        reportingTimezone: 'Asia/Kolkata',
        weekStartsOn: 1,
      }).reportingTimezone,
    ).toBe('Asia/Kolkata');
    expect(
      profileUpdateSchema.parse({
        displayName: 'Asha Rao',
        locale: 'en-IN',
        timezone: 'Asia/Kolkata',
      }).locale,
    ).toBe('en-IN');
  });

  it('rejects unknown fields and unbounded queries', () => {
    expect(() => governanceJobRequestSchema.parse({ type: 'erase' })).toThrow();
    expect(() => auditQuerySchema.parse({ pageSize: 101 })).toThrow();
    expect(() =>
      profileUpdateSchema.parse({
        displayName: 'Asha',
        locale: 'en-IN',
        timezone: 'UTC',
        role: 'OWNER',
      }),
    ).toThrow();
  });

  it('builds deterministic idempotency digests', () => {
    expect(
      requestDigest({ type: 'privacy-export', subjectExternalId: 'c-1' }),
    ).toBe(requestDigest({ type: 'privacy-export', subjectExternalId: 'c-1' }));
  });
});
