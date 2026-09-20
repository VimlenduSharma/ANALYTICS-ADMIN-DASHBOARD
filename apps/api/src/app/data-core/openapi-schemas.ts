import type { SchemaObject } from '@nestjs/swagger';

const nonNegativeInteger = { minimum: 0, type: 'integer' } as const;
const identifier = { maxLength: 160, minLength: 1, type: 'string' } as const;
const timestamp = { format: 'date-time', type: 'string' } as const;

export const orderIngestionOpenApiSchema: SchemaObject = {
  additionalProperties: false,
  properties: {
    channel: {
      additionalProperties: false,
      properties: {
        externalId: identifier,
        kind: {
          enum: ['marketplace', 'storefront', 'pos', 'wholesale', 'other'],
          type: 'string',
        },
        name: { maxLength: 120, minLength: 1, type: 'string' },
      },
      required: ['externalId', 'kind', 'name'],
      type: 'object',
    },
    customerReference: {
      additionalProperties: false,
      properties: {
        countryCode: {
          maxLength: 2,
          minLength: 2,
          pattern: '^[A-Z]{2}$',
          type: 'string',
        },
        externalId: identifier,
        metadata: { additionalProperties: true, type: 'object' },
      },
      required: ['externalId'],
      type: 'object',
    },
    currency: {
      maxLength: 3,
      minLength: 3,
      pattern: '^[A-Z]{3}$',
      type: 'string',
    },
    discountMinor: nonNegativeInteger,
    externalId: identifier,
    fulfilments: {
      items: {
        additionalProperties: false,
        properties: {
          carrier: { type: 'string' },
          deliveredAt: timestamp,
          externalId: identifier,
          locationExternalId: identifier,
          shippedAt: timestamp,
          status: {
            enum: [
              'pending',
              'processing',
              'shipped',
              'delivered',
              'cancelled',
            ],
            type: 'string',
          },
          trackingReference: identifier,
        },
        required: ['externalId', 'status'],
        type: 'object',
      },
      maxItems: 100,
      type: 'array',
    },
    items: {
      items: {
        additionalProperties: false,
        properties: {
          discountMinor: nonNegativeInteger,
          externalId: identifier,
          name: { minLength: 1, type: 'string' },
          productExternalId: identifier,
          quantity: { maximum: 1_000_000, minimum: 1, type: 'integer' },
          sku: identifier,
          taxMinor: nonNegativeInteger,
          totalMinor: nonNegativeInteger,
          unitPriceMinor: nonNegativeInteger,
        },
        required: [
          'externalId',
          'productExternalId',
          'sku',
          'name',
          'quantity',
          'unitPriceMinor',
          'totalMinor',
        ],
        type: 'object',
      },
      minItems: 1,
      type: 'array',
    },
    location: {
      additionalProperties: false,
      properties: {
        countryCode: {
          maxLength: 2,
          minLength: 2,
          pattern: '^[A-Z]{2}$',
          type: 'string',
        },
        externalId: identifier,
        kind: {
          enum: ['warehouse', 'store', 'virtual', 'other'],
          type: 'string',
        },
        name: { maxLength: 120, minLength: 1, type: 'string' },
        timezone: { maxLength: 80, minLength: 1, type: 'string' },
      },
      required: ['externalId', 'name'],
      type: 'object',
    },
    metadata: { additionalProperties: true, type: 'object' },
    occurredAt: timestamp,
    orderNumber: { minLength: 1, type: 'string' },
    payment: {
      additionalProperties: false,
      properties: {
        authorizedMinor: nonNegativeInteger,
        capturedMinor: nonNegativeInteger,
        refundedMinor: nonNegativeInteger,
        status: {
          enum: [
            'pending',
            'authorized',
            'captured',
            'partially_refunded',
            'refunded',
            'failed',
          ],
          type: 'string',
        },
      },
      required: ['status'],
      type: 'object',
    },
    returns: {
      items: {
        additionalProperties: false,
        properties: {
          amountMinor: nonNegativeInteger,
          externalId: identifier,
          receivedAt: timestamp,
          requestedAt: timestamp,
          status: {
            enum: ['requested', 'approved', 'received', 'rejected', 'refunded'],
            type: 'string',
          },
        },
        required: ['amountMinor', 'externalId', 'requestedAt', 'status'],
        type: 'object',
      },
      maxItems: 100,
      type: 'array',
    },
    shippingMinor: nonNegativeInteger,
    sourceUpdatedAt: timestamp,
    status: {
      enum: ['pending', 'confirmed', 'fulfilled', 'cancelled', 'refunded'],
      type: 'string',
    },
    subtotalMinor: nonNegativeInteger,
    taxMinor: nonNegativeInteger,
    totalMinor: nonNegativeInteger,
  },
  required: [
    'channel',
    'currency',
    'externalId',
    'items',
    'occurredAt',
    'orderNumber',
    'status',
    'subtotalMinor',
    'totalMinor',
  ],
  type: 'object',
};

export const ingestionResultOpenApiSchema: SchemaObject = {
  additionalProperties: false,
  properties: {
    externalId: { type: 'string' },
    orderId: { format: 'uuid', type: 'string' },
    status: { enum: ['accepted'], type: 'string' },
  },
  required: ['externalId', 'orderId', 'status'],
  type: 'object',
};

const importIssueOpenApiSchema: SchemaObject = {
  additionalProperties: false,
  properties: {
    field: { type: 'string' },
    message: { type: 'string' },
    row: { minimum: 1, type: 'integer' },
  },
  required: ['field', 'message', 'row'],
  type: 'object',
};

export const importJobOpenApiSchema: SchemaObject = {
  additionalProperties: false,
  properties: {
    acceptedRows: nonNegativeInteger,
    createdAt: timestamp,
    errorReport: { items: importIssueOpenApiSchema, type: 'array' },
    filename: { type: 'string' },
    id: { format: 'uuid', type: 'string' },
    rejectedRows: nonNegativeInteger,
    status: {
      enum: ['queued', 'processing', 'completed', 'failed'],
      type: 'string',
    },
    totalRows: nonNegativeInteger,
  },
  required: [
    'acceptedRows',
    'createdAt',
    'errorReport',
    'filename',
    'id',
    'rejectedRows',
    'status',
    'totalRows',
  ],
  type: 'object',
};

export const webhookEndpointOpenApiSchema: SchemaObject = {
  additionalProperties: false,
  properties: {
    createdAt: timestamp,
    id: { format: 'uuid', type: 'string' },
    name: { type: 'string' },
    status: { enum: ['active', 'revoked'], type: 'string' },
  },
  required: ['createdAt', 'id', 'name', 'status'],
  type: 'object',
};

export const createdWebhookEndpointOpenApiSchema: SchemaObject = {
  ...webhookEndpointOpenApiSchema,
  properties: {
    ...webhookEndpointOpenApiSchema.properties,
    path: { type: 'string' },
    secret: {
      description: 'Returned once. Store it in the sender secret manager.',
      type: 'string',
    },
  },
  required: [
    ...(webhookEndpointOpenApiSchema.required ?? []),
    'path',
    'secret',
  ],
};

export const inventorySnapshotOpenApiSchema: SchemaObject = {
  additionalProperties: false,
  properties: {
    location: {
      additionalProperties: false,
      properties: {
        countryCode: {
          maxLength: 2,
          minLength: 2,
          pattern: '^[A-Z]{2}$',
          type: 'string',
        },
        externalId: identifier,
        kind: {
          enum: ['warehouse', 'store', 'virtual', 'other'],
          type: 'string',
        },
        name: { maxLength: 120, minLength: 1, type: 'string' },
        timezone: { maxLength: 80, minLength: 1, type: 'string' },
      },
      required: ['externalId', 'name'],
      type: 'object',
    },
    onHandQuantity: nonNegativeInteger,
    product: {
      additionalProperties: false,
      properties: {
        externalId: identifier,
        name: { maxLength: 200, minLength: 1, type: 'string' },
        sku: identifier,
      },
      required: ['externalId', 'name', 'sku'],
      type: 'object',
    },
    reorderPoint: nonNegativeInteger,
    reservedQuantity: nonNegativeInteger,
    sourceUpdatedAt: timestamp,
  },
  required: [
    'location',
    'onHandQuantity',
    'product',
    'reorderPoint',
    'sourceUpdatedAt',
  ],
  type: 'object',
};

export const inventoryIngestionResultOpenApiSchema: SchemaObject = {
  additionalProperties: false,
  properties: {
    locationId: { format: 'uuid', type: 'string' },
    productId: { format: 'uuid', type: 'string' },
    status: { enum: ['accepted'], type: 'string' },
  },
  required: ['locationId', 'productId', 'status'],
  type: 'object',
};
