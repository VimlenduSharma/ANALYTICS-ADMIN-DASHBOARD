import { parseOrderCsv } from './csv-orders';

describe('order CSV parser', () => {
  it('groups multiple item rows into one validated order', () => {
    const result = parseOrderCsv(
      csv([row('line-1', 500), row('line-2', 500)]),
      10,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.orders).toHaveLength(1);
      expect(result.orders[0]?.items).toHaveLength(2);
      expect(result.totalRows).toBe(2);
    }
  });

  it('returns bounded field-level errors instead of partial orders', () => {
    const result = parseOrderCsv(csv([row('line-1', 999)]), 10);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.issues.some((issue) => issue.field.includes('totalMinor')),
      ).toBe(true);
    }
  });
});

const headers = [
  'order_external_id',
  'order_number',
  'order_status',
  'currency',
  'occurred_at',
  'channel_external_id',
  'channel_name',
  'channel_kind',
  'item_external_id',
  'product_external_id',
  'sku',
  'product_name',
  'quantity',
  'unit_price_minor',
  'item_total_minor',
  'order_subtotal_minor',
  'order_total_minor',
].join(',');

function row(itemId: string, itemTotal: number): string {
  return [
    'order-1',
    'ORDER-1',
    'confirmed',
    'USD',
    '2026-09-03T10:00:00Z',
    'web',
    'Web Store',
    'storefront',
    itemId,
    `product-${itemId}`,
    `SKU-${itemId}`,
    'Field notebook',
    '1',
    '500',
    String(itemTotal),
    '1000',
    '1000',
  ].join(',');
}

function csv(rows: string[]): string {
  return [headers, ...rows].join('\n');
}
