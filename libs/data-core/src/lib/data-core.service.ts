import type { InventoryIngestionResult } from '@analytics-admin/contracts';
import { ConflictException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { DatabaseService } from './database.service';
import {
  canonicalJson,
  type InventorySnapshot,
  type OrderIngestion,
} from './order-contract';

export interface IngestionResult {
  externalId: string;
  orderId: string;
  status: 'accepted';
}

interface IdempotencyRow<Response> {
  requestSha256: string;
  response: Response | null;
}

interface IdentifierRow {
  id: string;
}

@Injectable()
export class DataCoreService {
  constructor(private readonly database: DatabaseService) {}

  ingestOrder(input: {
    actorUserId?: string;
    idempotencyKey: string;
    order: OrderIngestion;
    organizationId: string;
    source: string;
  }): Promise<IngestionResult> {
    return this.database.tenantTransaction(input.organizationId, (client) =>
      this.ingestOrderInTransaction(client, input),
    );
  }

  ingestInventory(input: {
    actorUserId?: string;
    idempotencyKey: string;
    organizationId: string;
    snapshot: InventorySnapshot;
    source: string;
  }): Promise<InventoryIngestionResult> {
    return this.database.tenantTransaction(
      input.organizationId,
      async (client) => {
        const requestSha256 = sha256(canonicalJson(input.snapshot));
        const previous = await claimRequest<InventoryIngestionResult>(client, {
          idempotencyKey: input.idempotencyKey,
          organizationId: input.organizationId,
          requestSha256,
          source: input.source,
        });
        if (previous) return previous;

        const locationId = await upsertLocation(
          client,
          input.organizationId,
          input.snapshot.location,
        );
        const productId = await upsertInventoryProduct(
          client,
          input.organizationId,
          input.snapshot,
        );
        await client.query(
          `INSERT INTO inventory (
           organization_id, product_id, location_id, on_hand_quantity,
           reserved_quantity, reorder_point, source_updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (organization_id, product_id, location_id) DO UPDATE SET
           on_hand_quantity = EXCLUDED.on_hand_quantity,
           reserved_quantity = EXCLUDED.reserved_quantity,
           reorder_point = EXCLUDED.reorder_point,
           source_updated_at = EXCLUDED.source_updated_at,
           updated_at = now()`,
          [
            input.organizationId,
            productId,
            locationId,
            input.snapshot.onHandQuantity,
            input.snapshot.reservedQuantity,
            input.snapshot.reorderPoint,
            input.snapshot.sourceUpdatedAt,
          ],
        );
        const response: InventoryIngestionResult = {
          locationId,
          productId,
          status: 'accepted',
        };
        await completeRequest(client, input, response);
        await client.query(
          `INSERT INTO audit_events (
           organization_id, actor_user_id, event_type, target_type, target_id, metadata
         ) VALUES ($1, $2, 'data.inventory_ingested', 'product', $3, $4)`,
          [
            input.organizationId,
            input.actorUserId ?? null,
            productId,
            { locationId, source: input.source },
          ],
        );
        return response;
      },
    );
  }

  async ingestOrderInTransaction(
    client: PoolClient,
    input: {
      actorUserId?: string;
      idempotencyKey: string;
      order: OrderIngestion;
      organizationId: string;
      source: string;
    },
  ): Promise<IngestionResult> {
    const requestSha256 = sha256(canonicalJson(input.order));
    const previous = await claimRequest<IngestionResult>(client, {
      idempotencyKey: input.idempotencyKey,
      organizationId: input.organizationId,
      requestSha256,
      source: input.source,
    });
    if (previous) return previous;

    const channelId = await upsertChannel(
      client,
      input.organizationId,
      input.order,
    );
    const locationId = input.order.location
      ? await upsertLocation(client, input.organizationId, input.order.location)
      : null;
    const customerId = input.order.customerReference
      ? await upsertCustomer(
          client,
          input.organizationId,
          input.order.customerReference,
        )
      : null;

    await upsertProducts(client, input.organizationId, input.order);
    const orderId = await upsertOrder(client, {
      channelId,
      customerId,
      locationId,
      order: input.order,
      organizationId: input.organizationId,
    });
    await replaceOrderChildren(client, {
      locationId,
      order: input.order,
      orderId,
      organizationId: input.organizationId,
    });

    const response: IngestionResult = {
      externalId: input.order.externalId,
      orderId,
      status: 'accepted',
    };
    await completeRequest(client, input, response);
    await client.query(
      `
        INSERT INTO audit_events (
          organization_id, actor_user_id, event_type, target_type, target_id, metadata
        ) VALUES ($1, $2, 'data.order_ingested', 'order', $3, $4)
      `,
      [
        input.organizationId,
        input.actorUserId ?? null,
        orderId,
        { externalId: input.order.externalId, source: input.source },
      ],
    );
    return response;
  }
}

async function claimRequest<Response>(
  client: PoolClient,
  input: {
    idempotencyKey: string;
    organizationId: string;
    requestSha256: string;
    source: string;
  },
): Promise<Response | undefined> {
  await client.query(
    `INSERT INTO ingestion_requests (
       organization_id, source, idempotency_key, request_sha256
     ) VALUES ($1, $2, $3, $4)
     ON CONFLICT (organization_id, source, idempotency_key) DO NOTHING`,
    [
      input.organizationId,
      input.source,
      input.idempotencyKey,
      input.requestSha256,
    ],
  );
  const result = await client.query<IdempotencyRow<Response>>(
    `SELECT request_sha256 AS "requestSha256", response
     FROM ingestion_requests
     WHERE organization_id = $1 AND source = $2 AND idempotency_key = $3
     FOR UPDATE`,
    [input.organizationId, input.source, input.idempotencyKey],
  );
  const previous = result.rows[0];
  if (!previous) throw new Error('Idempotency record was not persisted');
  if (previous.requestSha256 !== input.requestSha256) {
    throw new ConflictException({
      code: 'IDEMPOTENCY_KEY_REUSED',
      message: 'The idempotency key was already used for different content',
    });
  }
  return previous.response ?? undefined;
}

function completeRequest(
  client: PoolClient,
  input: { idempotencyKey: string; organizationId: string; source: string },
  response: unknown,
): Promise<unknown> {
  return client.query(
    `UPDATE ingestion_requests SET response = $4, completed_at = now()
     WHERE organization_id = $1 AND source = $2 AND idempotency_key = $3`,
    [input.organizationId, input.source, input.idempotencyKey, response],
  );
}

async function upsertInventoryProduct(
  client: PoolClient,
  organizationId: string,
  snapshot: InventorySnapshot,
): Promise<string> {
  const result = await client.query<IdentifierRow>(
    `INSERT INTO products (organization_id, external_id, sku, name)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (organization_id, external_id) DO UPDATE SET
       sku = EXCLUDED.sku, name = EXCLUDED.name, status = 'active', updated_at = now()
     RETURNING id`,
    [
      organizationId,
      snapshot.product.externalId,
      snapshot.product.sku,
      snapshot.product.name,
    ],
  );
  return requiredId(result.rows[0], 'inventory product');
}

async function upsertChannel(
  client: PoolClient,
  organizationId: string,
  order: OrderIngestion,
): Promise<string> {
  const result = await client.query<IdentifierRow>(
    `
      INSERT INTO channels (organization_id, external_id, name, kind)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (organization_id, external_id) DO UPDATE SET
        name = EXCLUDED.name,
        kind = EXCLUDED.kind,
        updated_at = now()
      RETURNING id
    `,
    [
      organizationId,
      order.channel.externalId,
      order.channel.name,
      order.channel.kind,
    ],
  );
  return requiredId(result.rows[0], 'channel');
}

async function upsertLocation(
  client: PoolClient,
  organizationId: string,
  location: NonNullable<OrderIngestion['location']>,
): Promise<string> {
  const result = await client.query<IdentifierRow>(
    `
      INSERT INTO locations (
        organization_id, external_id, name, kind, timezone, country_code
      ) VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (organization_id, external_id) DO UPDATE SET
        name = EXCLUDED.name,
        kind = EXCLUDED.kind,
        timezone = EXCLUDED.timezone,
        country_code = EXCLUDED.country_code,
        updated_at = now()
      RETURNING id
    `,
    [
      organizationId,
      location.externalId,
      location.name,
      location.kind,
      location.timezone,
      location.countryCode ?? null,
    ],
  );
  return requiredId(result.rows[0], 'location');
}

async function upsertCustomer(
  client: PoolClient,
  organizationId: string,
  customer: NonNullable<OrderIngestion['customerReference']>,
): Promise<string> {
  const result = await client.query<IdentifierRow>(
    `
      INSERT INTO customer_references (
        organization_id, external_id, country_code, metadata
      ) VALUES ($1, $2, $3, $4)
      ON CONFLICT (organization_id, external_id) DO UPDATE SET
        country_code = EXCLUDED.country_code,
        metadata = EXCLUDED.metadata,
        updated_at = now()
      RETURNING id
    `,
    [
      organizationId,
      customer.externalId,
      customer.countryCode ?? null,
      customer.metadata,
    ],
  );
  return requiredId(result.rows[0], 'customer reference');
}

function upsertProducts(
  client: PoolClient,
  organizationId: string,
  order: OrderIngestion,
): Promise<unknown> {
  return client.query(
    `
      INSERT INTO products (organization_id, external_id, sku, name)
      SELECT $1, item.product_external_id, item.sku, item.name
      FROM jsonb_to_recordset($2::jsonb) AS item(
        product_external_id text, sku text, name text
      )
      ON CONFLICT (organization_id, external_id) DO UPDATE SET
        sku = EXCLUDED.sku,
        name = EXCLUDED.name,
        status = 'active',
        updated_at = now()
    `,
    [
      organizationId,
      JSON.stringify(
        order.items.map((item) => ({
          name: item.name,
          product_external_id: item.productExternalId,
          sku: item.sku,
        })),
      ),
    ],
  );
}

async function upsertOrder(
  client: PoolClient,
  input: {
    channelId: string;
    customerId: string | null;
    locationId: string | null;
    order: OrderIngestion;
    organizationId: string;
  },
): Promise<string> {
  const order = input.order;
  const result = await client.query<IdentifierRow>(
    `
      INSERT INTO orders (
        organization_id, channel_id, location_id, customer_reference_id,
        external_id, order_number, status, currency, subtotal_minor,
        discount_minor, tax_minor, shipping_minor, total_minor, occurred_at,
        source_updated_at, metadata
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9,
        $10, $11, $12, $13, $14, $15, $16
      )
      ON CONFLICT (organization_id, channel_id, external_id) DO UPDATE SET
        location_id = EXCLUDED.location_id,
        customer_reference_id = EXCLUDED.customer_reference_id,
        order_number = EXCLUDED.order_number,
        status = EXCLUDED.status,
        currency = EXCLUDED.currency,
        subtotal_minor = EXCLUDED.subtotal_minor,
        discount_minor = EXCLUDED.discount_minor,
        tax_minor = EXCLUDED.tax_minor,
        shipping_minor = EXCLUDED.shipping_minor,
        total_minor = EXCLUDED.total_minor,
        occurred_at = EXCLUDED.occurred_at,
        source_updated_at = EXCLUDED.source_updated_at,
        metadata = EXCLUDED.metadata,
        updated_at = now()
      RETURNING id
    `,
    [
      input.organizationId,
      input.channelId,
      input.locationId,
      input.customerId,
      order.externalId,
      order.orderNumber,
      order.status,
      order.currency,
      order.subtotalMinor,
      order.discountMinor,
      order.taxMinor,
      order.shippingMinor,
      order.totalMinor,
      order.occurredAt,
      order.sourceUpdatedAt ?? null,
      order.metadata,
    ],
  );
  return requiredId(result.rows[0], 'order');
}

async function replaceOrderChildren(
  client: PoolClient,
  input: {
    locationId: string | null;
    order: OrderIngestion;
    orderId: string;
    organizationId: string;
  },
): Promise<void> {
  const { order, orderId, organizationId } = input;
  await client.query(
    `DELETE FROM order_items WHERE organization_id = $1 AND order_id = $2`,
    [organizationId, orderId],
  );
  await client.query(
    `
      INSERT INTO order_items (
        organization_id, order_id, product_id, external_id, sku, name,
        quantity, unit_price_minor, discount_minor, tax_minor, total_minor
      )
      SELECT
        $1, $2, product.id, item.external_id, item.sku, item.name,
        item.quantity, item.unit_price_minor, item.discount_minor,
        item.tax_minor, item.total_minor
      FROM jsonb_to_recordset($3::jsonb) AS item(
        external_id text, product_external_id text, sku text, name text,
        quantity integer, unit_price_minor bigint, discount_minor bigint,
        tax_minor bigint, total_minor bigint
      )
      JOIN products product
        ON product.organization_id = $1
        AND product.external_id = item.product_external_id
    `,
    [
      organizationId,
      orderId,
      JSON.stringify(
        order.items.map((item) => ({
          discount_minor: item.discountMinor,
          external_id: item.externalId,
          name: item.name,
          product_external_id: item.productExternalId,
          quantity: item.quantity,
          sku: item.sku,
          tax_minor: item.taxMinor,
          total_minor: item.totalMinor,
          unit_price_minor: item.unitPriceMinor,
        })),
      ),
    ],
  );

  await client.query(
    `DELETE FROM payment_summaries WHERE organization_id = $1 AND order_id = $2`,
    [organizationId, orderId],
  );
  if (order.payment) {
    await client.query(
      `
        INSERT INTO payment_summaries (
          organization_id, order_id, status, currency, authorized_minor,
          captured_minor, refunded_minor
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      `,
      [
        organizationId,
        orderId,
        order.payment.status,
        order.currency,
        order.payment.authorizedMinor,
        order.payment.capturedMinor,
        order.payment.refundedMinor,
      ],
    );
  }

  await client.query(
    `DELETE FROM fulfilments WHERE organization_id = $1 AND order_id = $2`,
    [organizationId, orderId],
  );
  for (const fulfilment of order.fulfilments) {
    if (
      fulfilment.locationExternalId &&
      fulfilment.locationExternalId !== order.location?.externalId
    ) {
      throw new ConflictException({
        code: 'FULFILMENT_LOCATION_UNKNOWN',
        message:
          'A fulfilment references a location not present in the order payload',
      });
    }
    await client.query(
      `
        INSERT INTO fulfilments (
          organization_id, order_id, location_id, external_id, status,
          carrier, tracking_reference, shipped_at, delivered_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `,
      [
        organizationId,
        orderId,
        input.locationId,
        fulfilment.externalId,
        fulfilment.status,
        fulfilment.carrier ?? null,
        fulfilment.trackingReference ?? null,
        fulfilment.shippedAt ?? null,
        fulfilment.deliveredAt ?? null,
      ],
    );
  }

  await client.query(
    `DELETE FROM returns WHERE organization_id = $1 AND order_id = $2`,
    [organizationId, orderId],
  );
  for (const orderReturn of order.returns) {
    await client.query(
      `
        INSERT INTO returns (
          organization_id, order_id, external_id, status, amount_minor,
          currency, requested_at, received_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `,
      [
        organizationId,
        orderId,
        orderReturn.externalId,
        orderReturn.status,
        orderReturn.amountMinor,
        order.currency,
        orderReturn.requestedAt,
        orderReturn.receivedAt ?? null,
      ],
    );
  }
}

function requiredId(row: IdentifierRow | undefined, entity: string): string {
  if (!row) throw new Error(`${entity} upsert returned no identifier`);
  return row.id;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
