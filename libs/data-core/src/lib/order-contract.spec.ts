import { canonicalJson, orderIngestionSchema } from './order-contract';

describe('order ingestion contract', () => {
  it('normalizes currency and applies explicit safe defaults', () => {
    const order = orderIngestionSchema.parse(validOrder());

    expect(order).toMatchObject({
      currency: 'USD',
      discountMinor: 0,
      fulfilments: [],
      returns: [],
      shippingMinor: 0,
      taxMinor: 0,
    });
  });

  it('rejects order and line totals that cannot be reconciled', () => {
    const result = orderIngestionSchema.safeParse({
      ...validOrder(),
      totalMinor: 999,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.map((issue) => issue.path.join('.')),
      ).toContain('totalMinor');
    }
  });

  it('rejects unknown fields instead of silently discarding them', () => {
    const order = validOrder();
    const result = orderIngestionSchema.safeParse({
      ...order,
      channel: { ...(order['channel'] as object), unsupported: true },
      unsupported: true,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.filter(
          (issue) => issue.code === 'unrecognized_keys',
        ),
      ).toHaveLength(2);
    }
  });

  it('canonicalizes object keys without changing array order', () => {
    expect(canonicalJson({ z: 1, nested: { b: 2, a: [3, 1] }, a: true })).toBe(
      '{"a":true,"nested":{"a":[3,1],"b":2},"z":1}',
    );
  });
});

function validOrder(): Record<string, unknown> {
  return {
    channel: { externalId: 'web', kind: 'storefront', name: 'Web store' },
    currency: 'usd',
    externalId: 'order-100',
    items: [
      {
        externalId: 'line-1',
        name: 'Field notebook',
        productExternalId: 'notebook-1',
        quantity: 2,
        sku: 'NOTE-1',
        totalMinor: 1_000,
        unitPriceMinor: 500,
      },
    ],
    occurredAt: '2026-09-03T10:00:00Z',
    orderNumber: 'ORDER-100',
    status: 'confirmed',
    subtotalMinor: 1_000,
    totalMinor: 1_000,
  };
}
