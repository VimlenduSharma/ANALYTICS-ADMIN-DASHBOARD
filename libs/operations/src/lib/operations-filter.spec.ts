import {
  operationsFilterQuerySchema,
  operationsThresholdSchema,
} from './operations-filter';

describe('operations request schemas', () => {
  it('normalizes a bounded UTC reporting range', () => {
    expect(
      operationsFilterQuerySchema.parse({
        from: '2026-09-01',
        severity: 'critical',
        to: '2026-09-12',
      }),
    ).toEqual({
      from: '2026-09-01',
      severity: 'critical',
      to: '2026-09-12',
    });
  });

  it('rejects invalid ranges and unknown query keys', () => {
    expect(() =>
      operationsFilterQuerySchema.parse({
        from: '2026-09-12',
        surprise: 'yes',
        to: '2026-09-01',
      }),
    ).toThrow();
  });

  it('accepts valid threshold ordering and IANA timezones', () => {
    expect(
      operationsThresholdSchema.parse({
        backlogCriticalMinutes: 2_880,
        backlogWarningMinutes: 1_440,
        cancellationWarningBasisPoints: 800,
        cutoffLocalTime: '17:30',
        dataStaleAfterMinutes: 720,
        fulfilmentTargetMinutes: 1_440,
        lowStockBufferQuantity: 4,
        returnWarningBasisPoints: 500,
        timezone: 'Asia/Kolkata',
      }).timezone,
    ).toBe('Asia/Kolkata');
  });

  it('rejects invalid cutoff, timezone, and threshold ordering', () => {
    expect(() =>
      operationsThresholdSchema.parse({
        backlogCriticalMinutes: 60,
        backlogWarningMinutes: 120,
        cancellationWarningBasisPoints: 0,
        cutoffLocalTime: '25:00',
        dataStaleAfterMinutes: 15,
        fulfilmentTargetMinutes: 60,
        lowStockBufferQuantity: 0,
        returnWarningBasisPoints: 0,
        timezone: 'Not/A_Zone',
      }),
    ).toThrow();
  });
});
