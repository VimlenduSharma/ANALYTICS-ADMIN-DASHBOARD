import type { SchemaObject } from '@nestjs/swagger';

const identifier = { format: 'uuid', type: 'string' } as const;
const timestamp = { format: 'date-time', type: 'string' } as const;
const organizationRole: SchemaObject = {
  enum: ['OWNER', 'ADMIN', 'ANALYST', 'VIEWER'],
  type: 'string',
};
const invitationRole: SchemaObject = {
  enum: ['ADMIN', 'ANALYST', 'VIEWER'],
  type: 'string',
};
const jobType: SchemaObject = {
  enum: ['retention', 'privacy-export', 'privacy-delete'],
  type: 'string',
};

export const profileOpenApiSchema: SchemaObject = {
  additionalProperties: false,
  properties: {
    displayName: { maxLength: 120, minLength: 1, type: 'string' },
    email: { format: 'email', type: 'string' },
    locale: {
      pattern: '^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$',
      type: 'string',
    },
    timezone: { maxLength: 80, minLength: 1, type: 'string' },
  },
  required: ['displayName', 'email', 'locale', 'timezone'],
  type: 'object',
};

export const profileUpdateOpenApiSchema: SchemaObject = {
  additionalProperties: false,
  properties: {
    displayName: { maxLength: 120, minLength: 1, type: 'string' },
    locale: {
      pattern: '^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$',
      type: 'string',
    },
    timezone: { maxLength: 80, minLength: 1, type: 'string' },
  },
  required: ['displayName', 'locale', 'timezone'],
  type: 'object',
};

export const governanceSettingsOpenApiSchema: SchemaObject = {
  additionalProperties: false,
  properties: {
    auditRetentionDays: { maximum: 3_650, minimum: 30, type: 'integer' },
    exportRetentionHours: { maximum: 168, minimum: 1, type: 'integer' },
    name: { maxLength: 100, minLength: 2, type: 'string' },
    operationalDataRetentionDays: {
      maximum: 3_650,
      minimum: 30,
      type: 'integer',
    },
    privacyExportRetentionHours: { maximum: 168, minimum: 1, type: 'integer' },
    reportingTimezone: { maxLength: 80, minLength: 1, type: 'string' },
    slug: { type: 'string' },
    updatedAt: timestamp,
    weekStartsOn: { maximum: 6, minimum: 0, type: 'integer' },
  },
  required: [
    'auditRetentionDays',
    'exportRetentionHours',
    'name',
    'operationalDataRetentionDays',
    'privacyExportRetentionHours',
    'reportingTimezone',
    'slug',
    'weekStartsOn',
  ],
  type: 'object',
};

export const governanceSettingsUpdateOpenApiSchema: SchemaObject = {
  additionalProperties: false,
  properties: {
    auditRetentionDays: { maximum: 3_650, minimum: 30, type: 'integer' },
    exportRetentionHours: { maximum: 168, minimum: 1, type: 'integer' },
    name: { maxLength: 100, minLength: 2, type: 'string' },
    operationalDataRetentionDays: {
      maximum: 3_650,
      minimum: 30,
      type: 'integer',
    },
    privacyExportRetentionHours: { maximum: 168, minimum: 1, type: 'integer' },
    reportingTimezone: { maxLength: 80, minLength: 1, type: 'string' },
    weekStartsOn: { maximum: 6, minimum: 0, type: 'integer' },
  },
  required: [
    'auditRetentionDays',
    'exportRetentionHours',
    'name',
    'operationalDataRetentionDays',
    'privacyExportRetentionHours',
    'reportingTimezone',
    'weekStartsOn',
  ],
  type: 'object',
};

export const invitationOpenApiSchema: SchemaObject = {
  additionalProperties: false,
  properties: {
    acceptedAt: timestamp,
    createdAt: timestamp,
    email: { format: 'email', type: 'string' },
    expiresAt: timestamp,
    id: identifier,
    role: invitationRole,
    status: {
      enum: ['accepted', 'expired', 'pending', 'revoked'],
      type: 'string',
    },
  },
  required: ['createdAt', 'email', 'expiresAt', 'id', 'role', 'status'],
  type: 'object',
};

export const invitationCreateOpenApiSchema: SchemaObject = {
  additionalProperties: false,
  properties: {
    email: { format: 'email', type: 'string' },
    role: invitationRole,
  },
  required: ['email', 'role'],
  type: 'object',
};

export const createdInvitationOpenApiSchema: SchemaObject = {
  ...invitationOpenApiSchema,
  properties: {
    ...invitationOpenApiSchema.properties,
    acceptancePath: { type: 'string' },
  },
  required: [...(invitationOpenApiSchema.required ?? []), 'acceptancePath'],
};

const dataSource: SchemaObject = {
  additionalProperties: false,
  properties: {
    credentialRotatedAt: timestamp,
    eventCount: { minimum: 0, type: 'integer' },
    id: { type: 'string' },
    kind: {
      enum: ['csv', 'inventory-api', 'orders-api', 'orders-webhook'],
      type: 'string',
    },
    lastReceivedAt: timestamp,
    name: { type: 'string' },
    status: { enum: ['active', 'revoked', 'waiting'], type: 'string' },
  },
  required: ['eventCount', 'id', 'kind', 'name', 'status'],
  type: 'object',
};

export const governanceJobOpenApiSchema: SchemaObject = {
  additionalProperties: false,
  properties: {
    completedAt: timestamp,
    createdAt: timestamp,
    downloadReady: { type: 'boolean' },
    expiresAt: timestamp,
    failureCode: { type: 'string' },
    id: identifier,
    processedCount: { minimum: 0, type: 'integer' },
    requestedByDisplayName: { type: 'string' },
    status: {
      enum: ['queued', 'processing', 'completed', 'failed'],
      type: 'string',
    },
    subjectExternalId: { maxLength: 160, type: 'string' },
    type: jobType,
  },
  required: [
    'createdAt',
    'downloadReady',
    'id',
    'processedCount',
    'requestedByDisplayName',
    'status',
    'type',
  ],
  type: 'object',
};

export const governanceJobRequestOpenApiSchema: SchemaObject = {
  additionalProperties: false,
  properties: {
    subjectExternalId: { maxLength: 160, minLength: 1, type: 'string' },
    type: jobType,
  },
  required: ['type'],
  type: 'object',
};

export const governanceOverviewOpenApiSchema: SchemaObject = {
  additionalProperties: false,
  properties: {
    invitations: { items: invitationOpenApiSchema, type: 'array' },
    jobs: { items: governanceJobOpenApiSchema, type: 'array' },
    settings: governanceSettingsOpenApiSchema,
    sources: { items: dataSource, type: 'array' },
  },
  required: ['invitations', 'jobs', 'settings', 'sources'],
  type: 'object',
};

const auditEvent: SchemaObject = {
  additionalProperties: false,
  properties: {
    actorDisplayName: { type: 'string' },
    createdAt: timestamp,
    eventType: { type: 'string' },
    id: { type: 'string' },
    metadata: { additionalProperties: true, type: 'object' },
    targetId: { type: 'string' },
    targetType: { type: 'string' },
  },
  required: ['createdAt', 'eventType', 'id', 'metadata'],
  type: 'object',
};

export const governanceAuditOpenApiSchema: SchemaObject = {
  additionalProperties: false,
  properties: {
    filters: { additionalProperties: false, type: 'object' },
    items: { items: auditEvent, type: 'array' },
    pageInfo: {
      additionalProperties: false,
      properties: {
        hasNextPage: { type: 'boolean' },
        nextCursor: { type: 'string' },
        pageSize: { maximum: 100, minimum: 1, type: 'integer' },
      },
      required: ['hasNextPage', 'pageSize'],
      type: 'object',
    },
  },
  required: ['filters', 'items', 'pageInfo'],
  type: 'object',
};

export const invitationAcceptanceOpenApiSchema: SchemaObject = {
  additionalProperties: false,
  properties: { token: { maxLength: 200, minLength: 40, type: 'string' } },
  required: ['token'],
  type: 'object',
};

export const organizationAccessOpenApiSchema: SchemaObject = {
  additionalProperties: false,
  properties: {
    id: identifier,
    name: { type: 'string' },
    role: organizationRole,
    slug: { type: 'string' },
  },
  required: ['id', 'name', 'role', 'slug'],
  type: 'object',
};
