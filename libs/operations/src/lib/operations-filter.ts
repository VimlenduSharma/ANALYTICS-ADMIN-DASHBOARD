import {
  operationsIssueTypes,
  operationsSeverities,
  type OperationsFilters,
  type OperationsThresholds,
} from '@analytics-admin/contracts';
import { z } from 'zod';

const day = 86_400_000;
const optional = <Schema extends z.ZodType>(schema: Schema) =>
  z.preprocess(
    (value) => (value === '' ? undefined : value),
    schema.optional(),
  );
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const filterShape = {
  from: date.optional(),
  issueType: optional(z.enum(operationsIssueTypes)),
  locationId: optional(z.uuid()),
  severity: optional(z.enum(operationsSeverities)),
  to: date.optional(),
};

export const operationsFilterQuerySchema = z
  .strictObject(filterShape)
  .transform(normalizeFilter);

export const operationsIssuesQuerySchema = z
  .strictObject({
    ...filterShape,
    cursor: optional(z.string().min(1).max(1_024)),
    pageSize: z.coerce.number().int().min(10).max(100).default(25),
  })
  .transform((input, context) => ({
    ...normalizeFilter(input, context),
    cursor: input.cursor,
    pageSize: input.pageSize,
  }));

export const operationsThresholdSchema = z
  .strictObject({
    backlogCriticalMinutes: z.number().int().min(120).max(86_400),
    backlogWarningMinutes: z.number().int().min(60).max(43_200),
    cancellationWarningBasisPoints: z.number().int().min(0).max(10_000),
    cutoffLocalTime: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use 24-hour HH:mm'),
    dataStaleAfterMinutes: z.number().int().min(15).max(43_200),
    fulfilmentTargetMinutes: z.number().int().min(60).max(10_080),
    lowStockBufferQuantity: z.number().int().min(0).max(1_000_000_000),
    returnWarningBasisPoints: z.number().int().min(0).max(10_000),
    timezone: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .refine(isIanaTimezone, 'Use a recognized IANA timezone'),
  })
  .refine(
    ({ backlogCriticalMinutes, backlogWarningMinutes }) =>
      backlogCriticalMinutes > backlogWarningMinutes,
    {
      message: 'Critical backlog age must exceed warning backlog age',
      path: ['backlogCriticalMinutes'],
    },
  );

export const operationsAlertKeySchema = z
  .string()
  .trim()
  .min(3)
  .max(240)
  .regex(/^[a-z0-9:-]+$/);

export type OperationsIssueQuery = OperationsFilters & {
  cursor?: string;
  pageSize: number;
};

export type OperationsThresholdInput = z.input<
  typeof operationsThresholdSchema
>;

function normalizeFilter(
  input: z.output<z.ZodObject<typeof filterShape>>,
  context: z.RefinementCtx,
): OperationsFilters {
  const defaults = defaultRange();
  const from = input.from ?? defaults.from;
  const to = input.to ?? defaults.to;
  const fromTime = Date.parse(`${from}T00:00:00.000Z`);
  const toTime = Date.parse(`${to}T00:00:00.000Z`);
  if (
    !validDate(from, fromTime) ||
    !validDate(to, toTime) ||
    fromTime >= toTime
  ) {
    context.addIssue({
      code: 'custom',
      message: 'The start date must be before the end date',
      path: ['from'],
    });
  } else if (toTime - fromTime > 366 * day) {
    context.addIssue({
      code: 'custom',
      message: 'An operations range cannot exceed 366 days',
      path: ['to'],
    });
  }
  return compact({
    from,
    issueType: input.issueType,
    locationId: input.locationId,
    severity: input.severity,
    to,
  });
}

function defaultRange(
  now = new Date(),
): Pick<OperationsFilters, 'from' | 'to'> {
  const tomorrow = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  );
  return {
    from: new Date(tomorrow.getTime() - 30 * day).toISOString().slice(0, 10),
    to: tomorrow.toISOString().slice(0, 10),
  };
}

function validDate(value: string, timestamp: number): boolean {
  return (
    Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString().slice(0, 10) === value
  );
}

function isIanaTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as T;
}

export function defaultOperationsThresholds(): OperationsThresholds {
  return {
    backlogCriticalMinutes: 2_880,
    backlogWarningMinutes: 1_440,
    cancellationWarningBasisPoints: 1_000,
    cutoffLocalTime: '17:00',
    dataStaleAfterMinutes: 1_440,
    fulfilmentTargetMinutes: 1_440,
    lowStockBufferQuantity: '0',
    returnWarningBasisPoints: 500,
    timezone: 'UTC',
  };
}
