import {
  salesOrderStatuses,
  type SalesFilters,
  type SalesSort,
  type SortDirection,
} from '@analytics-admin/contracts';
import { z } from 'zod';

const optionalString = <Schema extends z.ZodType>(schema: Schema) =>
  z.preprocess(
    (value) => (value === '' ? undefined : value),
    schema.optional(),
  );
const identifier = optionalString(z.uuid());
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const filterShape = {
  channelId: identifier,
  currency: optionalString(z.string().regex(/^[A-Z]{3}$/)),
  from: date.optional(),
  locationId: identifier,
  productId: identifier,
  query: optionalString(z.string().trim().min(1).max(120)),
  status: optionalString(z.enum(salesOrderStatuses)),
  to: date.optional(),
};

export const salesFilterQuerySchema = z
  .strictObject(filterShape)
  .transform(normalizeFilter);

export const salesOrdersQuerySchema = z
  .strictObject({
    ...filterShape,
    cursor: optionalString(z.string().min(1).max(1_024)),
    direction: z.enum(['asc', 'desc']).default('desc'),
    pageSize: z.coerce.number().int().min(10).max(100).default(25),
    sort: z
      .enum(['occurredAt', 'orderNumber', 'revenue', 'status'])
      .default('occurredAt'),
  })
  .transform((input, context) => ({
    ...normalizeFilter(input, context),
    cursor: input.cursor,
    direction: input.direction,
    pageSize: input.pageSize,
    sort: input.sort,
  }));

export const salesFilterOptionsQuerySchema = z.strictObject({
  productQuery: optionalString(z.string().trim().min(1).max(80)),
  selectedProductId: identifier,
});

export const salesExportRequestSchema = z
  .strictObject({
    ...filterShape,
    direction: z.enum(['asc', 'desc']).default('desc'),
    sort: z
      .enum(['occurredAt', 'orderNumber', 'revenue', 'status'])
      .default('occurredAt'),
  })
  .transform((input, context) => ({
    direction: input.direction,
    filters: normalizeFilter(input, context),
    sort: input.sort,
  }));

export const salesExportStoredSchema = z.strictObject({
  direction: z.enum(['asc', 'desc']),
  filters: z.strictObject({
    channelId: z.uuid().optional(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    from: date,
    locationId: z.uuid().optional(),
    productId: z.uuid().optional(),
    query: z.string().trim().min(1).max(120).optional(),
    status: z.enum(salesOrderStatuses).optional(),
    to: date,
  }),
  sort: z.enum(['occurredAt', 'orderNumber', 'revenue', 'status']),
});

export type SalesOrderQuery = SalesFilters & {
  cursor?: string;
  direction: SortDirection;
  pageSize: number;
  sort: SalesSort;
};

export type SalesExportRequest = {
  direction: SortDirection;
  filters: SalesFilters;
  sort: SalesSort;
};

function normalizeFilter(
  input: z.output<z.ZodObject<typeof filterShape>>,
  context: z.RefinementCtx,
): SalesFilters {
  const defaults = defaultDateRange();
  const from = input.from ?? defaults.from;
  const to = input.to ?? defaults.to;
  const fromTime = Date.parse(`${from}T00:00:00.000Z`);
  const toTime = Date.parse(`${to}T00:00:00.000Z`);
  const datesAreValid = validDate(from, fromTime) && validDate(to, toTime);

  if (!datesAreValid || fromTime >= toTime) {
    context.addIssue({
      code: 'custom',
      message: 'The start date must be before the end date',
      path: ['from'],
    });
  } else if (toTime - fromTime > 366 * 86_400_000) {
    context.addIssue({
      code: 'custom',
      message: 'A sales range cannot exceed 366 days',
      path: ['to'],
    });
  }

  return compact({
    channelId: input.channelId,
    currency: input.currency,
    from,
    locationId: input.locationId,
    productId: input.productId,
    query: input.query,
    status: input.status,
    to,
  });
}

function defaultDateRange(now = new Date()): Pick<SalesFilters, 'from' | 'to'> {
  const tomorrow = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  );
  const from = new Date(tomorrow.getTime() - 30 * 86_400_000);
  return { from: isoDate(from), to: isoDate(tomorrow) };
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as T;
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function validDate(value: string, timestamp: number): boolean {
  return Number.isFinite(timestamp) && isoDate(new Date(timestamp)) === value;
}
