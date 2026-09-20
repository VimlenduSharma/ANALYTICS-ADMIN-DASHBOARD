import { z } from 'zod';

const identifier = z.string().trim().min(1).max(160);
const label = z.string().trim().min(1).max(200);
const minorUnits = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const currency = z
  .string()
  .trim()
  .length(3)
  .transform((value) => value.toUpperCase())
  .pipe(z.string().regex(/^[A-Z]{3}$/));
const countryCode = z
  .string()
  .trim()
  .length(2)
  .transform((value) => value.toUpperCase())
  .pipe(z.string().regex(/^[A-Z]{2}$/));
const timestamp = z.iso.datetime({ offset: true });
const metadata = z.record(z.string(), z.unknown()).default({});
const timezone = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine(isIanaTimezone, 'must be a recognized IANA timezone');

const channelSchema = z
  .object({
    externalId: identifier,
    kind: z.enum(['marketplace', 'storefront', 'pos', 'wholesale', 'other']),
    name: label.max(120),
  })
  .strict();

const locationSchema = z
  .object({
    countryCode: countryCode.optional(),
    externalId: identifier,
    kind: z
      .enum(['warehouse', 'store', 'virtual', 'other'])
      .default('warehouse'),
    name: label.max(120),
    timezone: timezone.default('UTC'),
  })
  .strict();

const customerReferenceSchema = z
  .object({
    countryCode: countryCode.optional(),
    externalId: identifier,
    metadata,
  })
  .strict();

export const orderItemSchema = z
  .object({
    discountMinor: minorUnits.default(0),
    externalId: identifier,
    name: label,
    productExternalId: identifier,
    quantity: z.number().int().min(1).max(1_000_000),
    sku: identifier,
    taxMinor: minorUnits.default(0),
    totalMinor: minorUnits,
    unitPriceMinor: minorUnits,
  })
  .strict()
  .superRefine((item, context) => {
    const expected =
      BigInt(item.quantity) * BigInt(item.unitPriceMinor) -
      BigInt(item.discountMinor) +
      BigInt(item.taxMinor);
    if (BigInt(item.totalMinor) !== expected) {
      context.addIssue({
        code: 'custom',
        message: `must equal quantity × unit price − discount + tax (${expected.toString()})`,
        path: ['totalMinor'],
      });
    }
  });

const paymentSchema = z
  .object({
    authorizedMinor: minorUnits.default(0),
    capturedMinor: minorUnits.default(0),
    refundedMinor: minorUnits.default(0),
    status: z.enum([
      'pending',
      'authorized',
      'captured',
      'partially_refunded',
      'refunded',
      'failed',
    ]),
  })
  .strict()
  .refine((payment) => payment.refundedMinor <= payment.capturedMinor, {
    message: 'refunded amount cannot exceed captured amount',
    path: ['refundedMinor'],
  });

const fulfilmentSchema = z
  .object({
    carrier: label.optional(),
    deliveredAt: timestamp.optional(),
    externalId: identifier,
    locationExternalId: identifier.optional(),
    shippedAt: timestamp.optional(),
    status: z.enum([
      'pending',
      'processing',
      'shipped',
      'delivered',
      'cancelled',
    ]),
    trackingReference: identifier.optional(),
  })
  .strict()
  .refine(
    (fulfilment) =>
      !fulfilment.deliveredAt ||
      !fulfilment.shippedAt ||
      new Date(fulfilment.deliveredAt) >= new Date(fulfilment.shippedAt),
    { message: 'delivery cannot precede shipment', path: ['deliveredAt'] },
  );

const returnSchema = z
  .object({
    amountMinor: minorUnits,
    externalId: identifier,
    receivedAt: timestamp.optional(),
    requestedAt: timestamp,
    status: z.enum([
      'requested',
      'approved',
      'received',
      'rejected',
      'refunded',
    ]),
  })
  .strict()
  .refine(
    (orderReturn) =>
      !orderReturn.receivedAt ||
      new Date(orderReturn.receivedAt) >= new Date(orderReturn.requestedAt),
    { message: 'receipt cannot precede request', path: ['receivedAt'] },
  );

export const orderIngestionSchema = z
  .object({
    channel: channelSchema,
    customerReference: customerReferenceSchema.optional(),
    discountMinor: minorUnits.default(0),
    externalId: identifier,
    fulfilments: z.array(fulfilmentSchema).max(100).default([]),
    items: z.array(orderItemSchema).min(1).max(5_000),
    location: locationSchema.optional(),
    metadata,
    occurredAt: timestamp,
    orderNumber: label,
    payment: paymentSchema.optional(),
    returns: z.array(returnSchema).max(100).default([]),
    shippingMinor: minorUnits.default(0),
    sourceUpdatedAt: timestamp.optional(),
    status: z.enum([
      'pending',
      'confirmed',
      'fulfilled',
      'cancelled',
      'refunded',
    ]),
    subtotalMinor: minorUnits,
    taxMinor: minorUnits.default(0),
    totalMinor: minorUnits,
    currency,
  })
  .strict()
  .superRefine((order, context) => {
    const expected =
      BigInt(order.subtotalMinor) -
      BigInt(order.discountMinor) +
      BigInt(order.taxMinor) +
      BigInt(order.shippingMinor);
    if (BigInt(order.totalMinor) !== expected) {
      context.addIssue({
        code: 'custom',
        message: `must equal subtotal − discount + tax + shipping (${expected.toString()})`,
        path: ['totalMinor'],
      });
    }

    const itemTotal = order.items.reduce(
      (sum, item) => sum + BigInt(item.totalMinor),
      0n,
    );
    if (itemTotal !== BigInt(order.subtotalMinor)) {
      context.addIssue({
        code: 'custom',
        message: `must equal the item total (${itemTotal.toString()})`,
        path: ['subtotalMinor'],
      });
    }

    uniqueBy(order.items, 'externalId', context, 'items');
    uniqueBy(order.fulfilments, 'externalId', context, 'fulfilments');
    uniqueBy(order.returns, 'externalId', context, 'returns');
  });

export type OrderIngestion = z.infer<typeof orderIngestionSchema>;

export const inventorySnapshotSchema = z
  .object({
    location: locationSchema,
    onHandQuantity: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    product: z
      .object({
        externalId: identifier,
        name: label,
        sku: identifier,
      })
      .strict(),
    reorderPoint: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    reservedQuantity: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER)
      .default(0),
    sourceUpdatedAt: timestamp,
  })
  .strict()
  .refine(
    ({ onHandQuantity, reservedQuantity }) =>
      reservedQuantity <= onHandQuantity,
    {
      message: 'reserved quantity cannot exceed on-hand quantity',
      path: ['reservedQuantity'],
    },
  );

export type InventorySnapshot = z.infer<typeof inventorySnapshotSchema>;

function uniqueBy<
  Item extends { externalId: string },
  Collection extends Item[],
>(
  items: Collection,
  key: 'externalId',
  context: z.RefinementCtx,
  path: string,
): void {
  const seen = new Set<string>();
  for (const [index, item] of items.entries()) {
    if (!seen.has(item[key])) {
      seen.add(item[key]);
      continue;
    }
    context.addIssue({
      code: 'custom',
      message: 'must be unique within the order',
      path: [path, index, key],
    });
  }
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function isIanaTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}
