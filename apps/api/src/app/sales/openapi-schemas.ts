import type { SchemaObject } from '@nestjs/swagger';

const identifier = { format: 'uuid', type: 'string' } as const;
const timestamp = { format: 'date-time', type: 'string' } as const;
const money = { pattern: '^[0-9]+$', type: 'string' } as const;
const status: SchemaObject = {
  enum: ['pending', 'confirmed', 'fulfilled', 'cancelled', 'refunded'],
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
    channelId: identifier,
    currency: { pattern: '^[A-Z]{3}$', type: 'string' },
    from: { format: 'date', type: 'string' },
    locationId: identifier,
    productId: identifier,
    query: { maxLength: 120, type: 'string' },
    status,
    to: { format: 'date', type: 'string' },
  },
  required: ['from', 'to'],
  type: 'object',
};
const comparison: SchemaObject = {
  additionalProperties: false,
  properties: {
    changeBasisPoints: { nullable: true, type: 'integer' },
    current: money,
    previous: money,
  },
  required: ['changeBasisPoints', 'current', 'previous'],
  type: 'object',
};
const segment: SchemaObject = {
  additionalProperties: false,
  properties: {
    id: identifier,
    label: { type: 'string' },
    orderCount: { minimum: 0, type: 'integer' },
    revenueMinor: money,
    shareBasisPoints: { maximum: 10_000, minimum: 0, type: 'integer' },
  },
  required: ['label', 'orderCount', 'revenueMinor', 'shareBasisPoints'],
  type: 'object',
};
const orderSummary: SchemaObject = {
  additionalProperties: false,
  properties: {
    channel: filterOption,
    currency: { pattern: '^[A-Z]{3}$', type: 'string' },
    id: identifier,
    itemCount: { minimum: 0, type: 'integer' },
    location: filterOption,
    netRevenueMinor: money,
    occurredAt: timestamp,
    orderNumber: { type: 'string' },
    refundedMinor: money,
    status,
    totalMinor: money,
  },
  required: [
    'channel',
    'currency',
    'id',
    'itemCount',
    'netRevenueMinor',
    'occurredAt',
    'orderNumber',
    'refundedMinor',
    'status',
    'totalMinor',
  ],
  type: 'object',
};
const fulfilment: SchemaObject = {
  additionalProperties: false,
  properties: {
    carrier: { type: 'string' },
    deliveredAt: timestamp,
    id: identifier,
    shippedAt: timestamp,
    status: { type: 'string' },
    trackingReference: { type: 'string' },
  },
  required: ['id', 'status'],
  type: 'object',
};
const payment: SchemaObject = {
  additionalProperties: false,
  properties: {
    capturedMinor: money,
    refundedMinor: money,
    status: { type: 'string' },
  },
  required: ['capturedMinor', 'refundedMinor', 'status'],
  type: 'object',
};
const returnedOrder: SchemaObject = {
  additionalProperties: false,
  properties: {
    amountMinor: money,
    id: identifier,
    requestedAt: timestamp,
    status: { type: 'string' },
  },
  required: ['amountMinor', 'id', 'requestedAt', 'status'],
  type: 'object',
};

export const salesOverviewOpenApiSchema: SchemaObject = {
  additionalProperties: false,
  properties: {
    channels: { items: segment, type: 'array' },
    currency: { pattern: '^[A-Z]{3}$', type: 'string' },
    definitions: {
      items: {
        additionalProperties: false,
        properties: {
          description: { type: 'string' },
          id: {
            enum: [
              'average-order-value',
              'items-sold',
              'net-revenue',
              'orders',
            ],
            type: 'string',
          },
          label: { type: 'string' },
        },
        required: ['description', 'id', 'label'],
        type: 'object',
      },
      type: 'array',
    },
    filters,
    freshness: {
      additionalProperties: false,
      properties: {
        dataThrough: timestamp,
        failedImportCount: { minimum: 0, type: 'integer' },
        generatedAt: timestamp,
        latestIngestedAt: timestamp,
        pendingImportCount: { minimum: 0, type: 'integer' },
        status: {
          enum: ['empty', 'fresh', 'partial', 'stale'],
          type: 'string',
        },
      },
      required: [
        'failedImportCount',
        'generatedAt',
        'pendingImportCount',
        'status',
      ],
      type: 'object',
    },
    granularity: { enum: ['day', 'week', 'month'], type: 'string' },
    kpis: {
      additionalProperties: false,
      properties: {
        averageOrderValueMinor: comparison,
        itemsSold: comparison,
        orderCount: comparison,
        revenueMinor: comparison,
      },
      required: [
        'averageOrderValueMinor',
        'itemsSold',
        'orderCount',
        'revenueMinor',
      ],
      type: 'object',
    },
    locations: { items: segment, type: 'array' },
    products: {
      items: {
        ...segment,
        properties: { ...segment.properties, sku: { type: 'string' } },
        required: [...(segment.required ?? []), 'sku'],
      },
      type: 'array',
    },
    trend: {
      items: {
        additionalProperties: false,
        properties: {
          averageOrderValueMinor: money,
          bucketStart: timestamp,
          orderCount: { minimum: 0, type: 'integer' },
          revenueMinor: money,
        },
        required: [
          'averageOrderValueMinor',
          'bucketStart',
          'orderCount',
          'revenueMinor',
        ],
        type: 'object',
      },
      type: 'array',
    },
  },
  required: [
    'channels',
    'definitions',
    'filters',
    'freshness',
    'granularity',
    'kpis',
    'locations',
    'products',
    'trend',
  ],
  type: 'object',
};

export const salesFilterOptionsOpenApiSchema: SchemaObject = {
  additionalProperties: false,
  properties: {
    channels: { items: filterOption, type: 'array' },
    currencies: { items: { type: 'string' }, type: 'array' },
    locations: { items: filterOption, type: 'array' },
    products: {
      items: {
        ...filterOption,
        properties: { ...filterOption.properties, sku: { type: 'string' } },
        required: ['id', 'label', 'sku'],
      },
      type: 'array',
    },
  },
  required: ['channels', 'currencies', 'locations', 'products'],
  type: 'object',
};

export const salesOrdersOpenApiSchema: SchemaObject = {
  additionalProperties: false,
  properties: {
    filters,
    items: { items: orderSummary, type: 'array' },
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
    sort: {
      additionalProperties: false,
      properties: {
        direction: { enum: ['asc', 'desc'], type: 'string' },
        field: {
          enum: ['occurredAt', 'orderNumber', 'revenue', 'status'],
          type: 'string',
        },
      },
      required: ['direction', 'field'],
      type: 'object',
    },
  },
  required: ['filters', 'items', 'pageInfo', 'sort'],
  type: 'object',
};

export const salesOrderDetailOpenApiSchema: SchemaObject = {
  ...orderSummary,
  properties: {
    ...orderSummary.properties,
    customerReference: { type: 'string' },
    discountMinor: money,
    fulfilments: { items: fulfilment, type: 'array' },
    items: {
      items: {
        additionalProperties: false,
        properties: {
          id: identifier,
          name: { type: 'string' },
          quantity: { minimum: 1, type: 'integer' },
          sku: { type: 'string' },
          totalMinor: money,
          unitPriceMinor: money,
        },
        required: [
          'id',
          'name',
          'quantity',
          'sku',
          'totalMinor',
          'unitPriceMinor',
        ],
        type: 'object',
      },
      type: 'array',
    },
    payment,
    returns: { items: returnedOrder, type: 'array' },
    shippingMinor: money,
    subtotalMinor: money,
    taxMinor: money,
  },
  required: [
    ...(orderSummary.required ?? []),
    'discountMinor',
    'fulfilments',
    'items',
    'returns',
    'shippingMinor',
    'subtotalMinor',
    'taxMinor',
  ],
};

export const salesExportRequestOpenApiSchema: SchemaObject = {
  additionalProperties: false,
  properties: {
    ...filters.properties,
    direction: { default: 'desc', enum: ['asc', 'desc'], type: 'string' },
    sort: {
      default: 'occurredAt',
      enum: ['occurredAt', 'orderNumber', 'revenue', 'status'],
      type: 'string',
    },
  },
  type: 'object',
};

export const salesExportOpenApiSchema: SchemaObject = {
  additionalProperties: false,
  properties: {
    completedAt: timestamp,
    createdAt: timestamp,
    downloadReady: { type: 'boolean' },
    expiresAt: timestamp,
    failureCode: { type: 'string' },
    id: identifier,
    rowCount: { minimum: 0, type: 'integer' },
    status: {
      enum: ['queued', 'processing', 'completed', 'failed'],
      type: 'string',
    },
  },
  required: ['createdAt', 'downloadReady', 'id', 'rowCount', 'status'],
  type: 'object',
};
