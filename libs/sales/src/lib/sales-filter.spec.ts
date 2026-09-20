import {
  salesExportRequestSchema,
  salesExportStoredSchema,
  salesFilterQuerySchema,
  salesOrdersQuerySchema,
} from './sales-filter';

describe('sales filters', () => {
  it('normalizes one shared filter contract for overview, orders, and exports', () => {
    const input = {
      channelId: '4e70f6c4-66b7-46ee-b3ab-f4b5cb7d0562',
      currency: 'USD',
      from: '2026-08-01',
      status: 'confirmed',
      to: '2026-09-01',
    };
    const overview = salesFilterQuerySchema.parse(input);
    const orders = salesOrdersQuerySchema.parse(input);
    const exportRequest = salesExportRequestSchema.parse(input);

    expect(orders).toMatchObject(overview);
    expect(exportRequest.filters).toEqual(overview);
    expect(exportRequest).toMatchObject({
      direction: 'desc',
      sort: 'occurredAt',
    });
    expect(salesExportStoredSchema.parse(exportRequest)).toEqual(exportRequest);
  });

  it.each([
    [{ from: '2026-02-30', to: '2026-03-02' }, 'calendar date'],
    [{ from: '2026-09-02', to: '2026-09-01' }, 'reversed range'],
    [{ from: '2025-01-01', to: '2026-09-01' }, 'oversized range'],
  ])('rejects an invalid %s', (input) => {
    expect(salesFilterQuerySchema.safeParse(input).success).toBe(false);
  });

  it('rejects unknown fields and cursors outside their bounded shape', () => {
    expect(
      salesFilterQuerySchema.safeParse({ unsupported: true }),
    ).toMatchObject({ success: false });
    expect(
      salesOrdersQuerySchema.safeParse({ cursor: 'x'.repeat(1_025) }),
    ).toMatchObject({ success: false });
  });
});
