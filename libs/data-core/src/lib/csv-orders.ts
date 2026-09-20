import { parse } from 'csv-parse/sync';
import { orderIngestionSchema, type OrderIngestion } from './order-contract';

export interface ImportIssue {
  field: string;
  message: string;
  row: number;
}

export type CsvOrdersResult =
  | { issues: ImportIssue[]; ok: false; totalRows: number }
  | { ok: true; orders: OrderIngestion[]; totalRows: number };

type CsvRow = Record<string, string>;

const requiredHeaders = [
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
] as const;

const orderColumns = [
  'order_number',
  'order_status',
  'currency',
  'occurred_at',
  'channel_external_id',
  'channel_name',
  'channel_kind',
  'location_external_id',
  'customer_external_id',
  'order_subtotal_minor',
  'order_discount_minor',
  'order_tax_minor',
  'order_shipping_minor',
  'order_total_minor',
] as const;

export function parseOrderCsv(csv: string, maxRows: number): CsvOrdersResult {
  let rows: CsvRow[];
  try {
    rows = parse(csv, {
      bom: true,
      columns: true,
      relax_column_count: false,
      skip_empty_lines: true,
      trim: true,
    }) as CsvRow[];
  } catch (error) {
    return {
      issues: [{ field: 'file', message: csvError(error), row: 1 }],
      ok: false,
      totalRows: 0,
    };
  }

  if (rows.length === 0) {
    return emptyFailure(
      'file',
      'must contain a header and at least one data row',
    );
  }
  if (rows.length > maxRows) {
    return emptyFailure(
      'file',
      `contains ${rows.length} rows; limit is ${maxRows}`,
      rows.length,
    );
  }

  const headers = new Set(Object.keys(rows[0] ?? {}));
  const missing = requiredHeaders.filter((header) => !headers.has(header));
  if (missing.length) {
    return {
      issues: missing.map((field) => ({
        field,
        message: 'required column is missing',
        row: 1,
      })),
      ok: false,
      totalRows: rows.length,
    };
  }

  const issues: ImportIssue[] = [];
  const groups = new Map<
    string,
    { firstRow: CsvRow; items: CsvRow[]; row: number }
  >();
  rows.forEach((row, index) => {
    const rowNumber = index + 2;
    const orderId = row['order_external_id'] ?? '';
    const current = groups.get(orderId);
    if (!current) {
      groups.set(orderId, { firstRow: row, items: [row], row: rowNumber });
      return;
    }
    for (const field of orderColumns) {
      if ((current.firstRow[field] ?? '') !== (row[field] ?? '')) {
        issues.push({
          field,
          message: 'must match every row for the same order',
          row: rowNumber,
        });
      }
    }
    current.items.push(row);
  });

  const orders: OrderIngestion[] = [];
  for (const group of groups.values()) {
    const candidate = toOrder(group.firstRow, group.items);
    const result = orderIngestionSchema.safeParse(candidate);
    if (result.success) {
      orders.push(result.data);
      continue;
    }
    issues.push(
      ...result.error.issues.map(({ message, path }) => ({
        field: path.join('.') || 'row',
        message,
        row: group.row,
      })),
    );
  }

  return issues.length
    ? { issues: issues.slice(0, 500), ok: false, totalRows: rows.length }
    : { ok: true, orders, totalRows: rows.length };
}

function toOrder(row: CsvRow, itemRows: CsvRow[]): unknown {
  const optional = (name: string) => row[name]?.trim() || undefined;
  const number = (name: string, fallback?: number) => {
    const raw = optional(name);
    return raw === undefined && fallback !== undefined ? fallback : Number(raw);
  };

  return {
    channel: {
      externalId: row['channel_external_id'],
      kind: row['channel_kind'],
      name: row['channel_name'],
    },
    ...(optional('customer_external_id')
      ? { customerReference: { externalId: optional('customer_external_id') } }
      : {}),
    currency: row['currency'],
    discountMinor: number('order_discount_minor', 0),
    externalId: row['order_external_id'],
    items: itemRows.map((item) => ({
      discountMinor: Number(item['item_discount_minor'] || 0),
      externalId: item['item_external_id'],
      name: item['product_name'],
      productExternalId: item['product_external_id'],
      quantity: Number(item['quantity']),
      sku: item['sku'],
      taxMinor: Number(item['item_tax_minor'] || 0),
      totalMinor: Number(item['item_total_minor']),
      unitPriceMinor: Number(item['unit_price_minor']),
    })),
    ...(optional('location_external_id')
      ? {
          location: {
            externalId: optional('location_external_id'),
            kind: optional('location_kind') || 'warehouse',
            name: optional('location_name') || optional('location_external_id'),
            timezone: optional('location_timezone') || 'UTC',
          },
        }
      : {}),
    occurredAt: row['occurred_at'],
    orderNumber: row['order_number'],
    ...(optional('payment_status')
      ? {
          payment: {
            authorizedMinor: number('payment_authorized_minor', 0),
            capturedMinor: number('payment_captured_minor', 0),
            refundedMinor: number('payment_refunded_minor', 0),
            status: optional('payment_status'),
          },
        }
      : {}),
    shippingMinor: number('order_shipping_minor', 0),
    sourceUpdatedAt: optional('source_updated_at'),
    status: row['order_status'],
    subtotalMinor: number('order_subtotal_minor'),
    taxMinor: number('order_tax_minor', 0),
    totalMinor: number('order_total_minor'),
  };
}

function emptyFailure(
  field: string,
  message: string,
  totalRows = 0,
): CsvOrdersResult {
  return { issues: [{ field, message, row: 1 }], ok: false, totalRows };
}

function csvError(error: unknown): string {
  return error instanceof Error ? error.message : 'CSV could not be parsed';
}
