import type { GovernanceJobType } from '@analytics-admin/contracts';
import { createHash } from 'node:crypto';
import { z } from 'zod';

const timezone = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine(isValidTimezone, 'must be a valid IANA timezone');

export const profileUpdateSchema = z.strictObject({
  displayName: z.string().trim().min(1).max(120),
  locale: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/),
  timezone,
});

export const settingsUpdateSchema = z.strictObject({
  auditRetentionDays: z.coerce.number().int().min(30).max(3_650),
  exportRetentionHours: z.coerce.number().int().min(1).max(168),
  name: z.string().trim().min(2).max(100),
  operationalDataRetentionDays: z.coerce.number().int().min(30).max(3_650),
  privacyExportRetentionHours: z.coerce.number().int().min(1).max(168),
  reportingTimezone: timezone,
  weekStartsOn: z.coerce.number().int().min(0).max(6),
});

export const invitationCreateSchema = z.strictObject({
  email: z
    .email()
    .max(320)
    .transform((value) => value.toLowerCase()),
  role: z.enum(['ADMIN', 'ANALYST', 'VIEWER']),
});

export const governanceJobRequestSchema = z.strictObject({
  subjectExternalId: z.string().trim().min(1).max(160).optional(),
  type: z.enum(['retention', 'privacy-export', 'privacy-delete']),
});

export const auditQuerySchema = z.strictObject({
  actorUserId: z.uuid().optional(),
  cursor: z.string().trim().min(1).max(2_000).optional(),
  eventType: z.string().trim().min(1).max(160).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  to: z.iso.datetime({ offset: true }).optional(),
});

export type GovernanceSettingsInput = z.infer<typeof settingsUpdateSchema>;
export type GovernanceJobRequest = z.infer<typeof governanceJobRequestSchema>;
export type GovernanceAuditQuery = z.infer<typeof auditQuerySchema>;

export function validateJobSubject(input: GovernanceJobRequest): void {
  const requiresSubject = input.type !== 'retention';
  if (requiresSubject !== Boolean(input.subjectExternalId)) {
    throw new Error(
      requiresSubject
        ? 'A customer reference is required for this privacy workflow'
        : 'Retention jobs cannot target a customer',
    );
  }
}

export function requestDigest(input: {
  subjectExternalId?: string;
  type: GovernanceJobType;
}): string {
  return createHash('sha256')
    .update(JSON.stringify([input.type, input.subjectExternalId ?? null]))
    .digest('hex');
}

function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}
