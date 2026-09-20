import type { SchemaObject } from '@nestjs/swagger';

const identifier = { format: 'uuid', type: 'string' } as const;
const timestamp = { format: 'date-time', type: 'string' } as const;
const quantity = { pattern: '^[0-9]+$', type: 'string' } as const;
const severity: SchemaObject = {
  enum: ['critical', 'warning', 'info'],
  type: 'string',
};
const issueType: SchemaObject = {
  enum: ['backlog', 'late-fulfilment', 'low-stock', 'cancellation', 'return'],
  type: 'string',
};
const filterOption: SchemaObject = {
  additionalProperties: false,
  properties: { id: identifier, label: { type: 'string' } },
  required: ['id', 'label'],
  type: 'object',
};
const filters: SchemaObject = {
  additionalProperties: false,
  properties: {
    from: { format: 'date', type: 'string' },
    issueType,
    locationId: identifier,
    severity,
    to: { format: 'date', type: 'string' },
  },
  required: ['from', 'to'],
  type: 'object',
};

export const operationsThresholdsOpenApiSchema: SchemaObject = {
  additionalProperties: false,
  properties: {
    backlogCriticalMinutes: { maximum: 86_400, minimum: 120, type: 'integer' },
    backlogWarningMinutes: { maximum: 43_200, minimum: 60, type: 'integer' },
    cancellationWarningBasisPoints: {
      maximum: 10_000,
      minimum: 0,
      type: 'integer',
    },
    cutoffLocalTime: {
      pattern: '^([01]\\d|2[0-3]):[0-5]\\d$',
      type: 'string',
    },
    dataStaleAfterMinutes: { maximum: 43_200, minimum: 15, type: 'integer' },
    fulfilmentTargetMinutes: { maximum: 10_080, minimum: 60, type: 'integer' },
    lowStockBufferQuantity: quantity,
    returnWarningBasisPoints: {
      maximum: 10_000,
      minimum: 0,
      type: 'integer',
    },
    timezone: { maxLength: 80, minLength: 1, type: 'string' },
    updatedAt: timestamp,
  },
  required: [
    'backlogCriticalMinutes',
    'backlogWarningMinutes',
    'cancellationWarningBasisPoints',
    'cutoffLocalTime',
    'dataStaleAfterMinutes',
    'fulfilmentTargetMinutes',
    'lowStockBufferQuantity',
    'returnWarningBasisPoints',
    'timezone',
  ],
  type: 'object',
};

export const operationsThresholdRequestOpenApiSchema: SchemaObject = {
  ...operationsThresholdsOpenApiSchema,
  properties: {
    ...operationsThresholdsOpenApiSchema.properties,
    lowStockBufferQuantity: {
      maximum: 1_000_000_000,
      minimum: 0,
      type: 'integer',
    },
  },
};

const sourceHealth: SchemaObject = {
  additionalProperties: false,
  properties: {
    lastReceivedAt: timestamp,
    source: {
      enum: ['orders', 'fulfilments', 'inventory'],
      type: 'string',
    },
    status: { enum: ['current', 'delayed', 'missing'], type: 'string' },
  },
  required: ['source', 'status'],
  type: 'object',
};

const locationSummary: SchemaObject = {
  additionalProperties: false,
  properties: {
    averageFulfilmentLeadMinutes: { nullable: true, type: 'integer' },
    backlogCount: { minimum: 0, type: 'integer' },
    id: identifier,
    label: { type: 'string' },
    lowStockCount: { minimum: 0, type: 'integer' },
    overdueCount: { minimum: 0, type: 'integer' },
    serviceLevelBasisPoints: { nullable: true, type: 'integer' },
    sourceStatus: {
      enum: ['current', 'delayed', 'missing'],
      type: 'string',
    },
    timezone: { type: 'string' },
  },
  required: [
    'averageFulfilmentLeadMinutes',
    'backlogCount',
    'label',
    'lowStockCount',
    'overdueCount',
    'serviceLevelBasisPoints',
    'sourceStatus',
    'timezone',
  ],
  type: 'object',
};

const alert: SchemaObject = {
  additionalProperties: false,
  properties: {
    acknowledgedAt: timestamp,
    actionLabel: { type: 'string' },
    count: { minimum: 0, type: 'integer' },
    key: { type: 'string' },
    location: filterOption,
    message: { type: 'string' },
    query: {
      additionalProperties: false,
      properties: {
        issueType,
        locationId: identifier,
        severity,
      },
      type: 'object',
    },
    severity,
    status: { enum: ['active', 'acknowledged'], type: 'string' },
    title: { type: 'string' },
    type: issueType,
  },
  required: [
    'actionLabel',
    'count',
    'key',
    'message',
    'query',
    'severity',
    'status',
    'title',
    'type',
  ],
  type: 'object',
};

export const operationsOverviewOpenApiSchema: SchemaObject = {
  additionalProperties: false,
  properties: {
    alerts: { items: alert, type: 'array' },
    filters,
    health: {
      additionalProperties: false,
      properties: {
        failedImportCount: { minimum: 0, type: 'integer' },
        generatedAt: timestamp,
        pendingImportCount: { minimum: 0, type: 'integer' },
        sources: { items: sourceHealth, type: 'array' },
        status: {
          enum: ['healthy', 'delayed', 'missing', 'partial', 'empty'],
          type: 'string',
        },
      },
      required: [
        'failedImportCount',
        'generatedAt',
        'pendingImportCount',
        'sources',
        'status',
      ],
      type: 'object',
    },
    kpis: {
      additionalProperties: false,
      properties: {
        averageFulfilmentLeadMinutes: { nullable: true, type: 'integer' },
        backlogCount: { minimum: 0, type: 'integer' },
        cancellationRateBasisPoints: { minimum: 0, type: 'integer' },
        lowStockCount: { minimum: 0, type: 'integer' },
        returnRateBasisPoints: { minimum: 0, type: 'integer' },
        serviceLevelBasisPoints: { nullable: true, type: 'integer' },
        stockOnHandQuantity: quantity,
      },
      required: [
        'averageFulfilmentLeadMinutes',
        'backlogCount',
        'cancellationRateBasisPoints',
        'lowStockCount',
        'returnRateBasisPoints',
        'serviceLevelBasisPoints',
        'stockOnHandQuantity',
      ],
      type: 'object',
    },
    locations: { items: locationSummary, type: 'array' },
    thresholds: operationsThresholdsOpenApiSchema,
  },
  required: ['alerts', 'filters', 'health', 'kpis', 'locations', 'thresholds'],
  type: 'object',
};

const issue: SchemaObject = {
  additionalProperties: false,
  properties: {
    ageMinutes: { minimum: 0, type: 'integer' },
    detail: { type: 'string' },
    entityId: { type: 'string' },
    id: { type: 'string' },
    location: filterOption,
    occurredAt: timestamp,
    quantity,
    severity,
    title: { type: 'string' },
    type: issueType,
  },
  required: ['detail', 'entityId', 'id', 'severity', 'title', 'type'],
  type: 'object',
};

export const operationsIssuesOpenApiSchema: SchemaObject = {
  additionalProperties: false,
  properties: {
    filters,
    items: { items: issue, type: 'array' },
    pageInfo: {
      additionalProperties: false,
      properties: {
        hasNextPage: { type: 'boolean' },
        nextCursor: { type: 'string' },
        pageSize: { maximum: 100, minimum: 10, type: 'integer' },
      },
      required: ['hasNextPage', 'pageSize'],
      type: 'object',
    },
  },
  required: ['filters', 'items', 'pageInfo'],
  type: 'object',
};
