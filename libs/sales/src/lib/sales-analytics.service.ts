import type {
  MetricDefinition,
  ProductSalesSegment,
  SalesFilterOptionsResponse,
  SalesFilters,
  SalesFreshness,
  SalesKpis,
  SalesOrderDetail,
  SalesOrdersResponse,
  SalesOrderSummary,
  SalesOverviewResponse,
  SalesSegment,
  SalesSort,
  SortDirection,
} from '@analytics-admin/contracts';
import { DatabaseService } from '@analytics-admin/data-core';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { SalesExportRequest, SalesOrderQuery } from './sales-filter';

const metricDefinitions: MetricDefinition[] = [
  {
    description:
      'Order total less captured refunds. Cancelled orders contribute zero.',
    id: 'net-revenue',
    label: 'Net revenue',
  },
  {
    description:
      'Non-cancelled source orders in the selected UTC reporting period.',
    id: 'orders',
    label: 'Orders',
  },
  {
    description:
      'Net revenue divided by non-cancelled orders. Empty periods have no average.',
    id: 'average-order-value',
    label: 'Average order value',
  },
  {
    description: 'Sum of line-item quantities on non-cancelled orders.',
    id: 'items-sold',
    label: 'Items sold',
  },
];

interface MetricRow {
  averageOrderValueMinor: string | null;
  itemsSold: string;
  orderCount: string;
  revenueMinor: string;
}

interface TrendRow {
  averageOrderValueMinor: string | null;
  bucketStart: Date | string;
  orderCount: string;
  revenueMinor: string;
}

interface SegmentRow {
  id: string | null;
  label: string;
  orderCount: string;
  revenueMinor: string;
  sku?: string;
  totalRevenueMinor: string;
}

interface OrderRow {
  channelId: string;
  channelLabel: string;
  currency: string;
  id: string;
  itemCount: string;
  locationId: string | null;
  locationLabel: string | null;
  netRevenueMinor: string;
  occurredAt: Date | string;
  orderNumber: string;
  refundedMinor: string;
  status: SalesOrderSummary['status'];
  totalMinor: string;
}

interface DetailRow extends OrderRow {
  customerReference: string | null;
  discountMinor: string;
  shippingMinor: string;
  subtotalMinor: string;
  taxMinor: string;
}

interface CursorPayload {
  direction: SortDirection;
  filterHash: string;
  id: string;
  sort: SalesSort;
  value: string;
}

const cursorSchema = z.strictObject({
  direction: z.enum(['asc', 'desc']),
  filterHash: z.string().length(64),
  id: z.uuid(),
  sort: z.enum(['occurredAt', 'orderNumber', 'revenue', 'status']),
  value: z.string().max(320),
});

const commercialOrder = "filtered.status <> 'cancelled'";
const netRevenue = `CASE WHEN ${commercialOrder}
  THEN GREATEST(filtered.total_minor - filtered.refunded_minor, 0)
  ELSE 0 END`;

@Injectable()
export class SalesAnalyticsService {
  constructor(private readonly database: DatabaseService) {}

  overview(
    organizationId: string,
    requestedFilter: SalesFilters,
  ): Promise<SalesOverviewResponse> {
    return this.database.tenantReadTransaction(
      organizationId,
      async (client) => {
        const currency = await this.resolveCurrency(
          client,
          organizationId,
          requestedFilter,
        );
        const filters = compact({ ...requestedFilter, currency });
        const previousRange = previousPeriod(filters);
        const granularity = trendGranularity(filters);
        const current = await this.metrics(client, organizationId, filters);
        const previous = await this.metrics(client, organizationId, {
          ...filters,
          ...previousRange,
        });
        const trend = await this.trend(
          client,
          organizationId,
          filters,
          granularity,
        );
        const channels = await this.segments(
          client,
          organizationId,
          filters,
          'channel',
        );
        const locations = await this.segments(
          client,
          organizationId,
          filters,
          'location',
        );
        const products = await this.productSegments(
          client,
          organizationId,
          filters,
        );
        const freshness = await this.freshness(client, organizationId);

        return {
          channels,
          currency,
          definitions: metricDefinitions,
          filters,
          freshness,
          granularity,
          kpis: comparisons(current, previous),
          locations,
          products,
          trend,
        };
      },
    );
  }

  filterOptions(
    organizationId: string,
    input: { productQuery?: string; selectedProductId?: string },
  ): Promise<SalesFilterOptionsResponse> {
    return this.database.tenantReadTransaction(
      organizationId,
      async (client) => {
        const productParameters = new SqlParameters();
        const organization = productParameters.add(organizationId, 'uuid');
        const selected = input.selectedProductId
          ? productParameters.add(input.selectedProductId, 'uuid')
          : undefined;
        const productSearch = input.productQuery
          ? `AND ((product.name ILIKE ${productParameters.add(`%${input.productQuery}%`)}
          OR product.sku ILIKE ${productParameters.add(`%${input.productQuery}%`)})
          ${selected ? `OR product.id = ${selected}` : ''})`
          : '';
        const currencies = await client.query<{ currency: string }>(
          `SELECT DISTINCT currency FROM orders
           WHERE organization_id = $1 ORDER BY currency`,
          [organizationId],
        );
        const channels = await client.query<{ id: string; label: string }>(
          `SELECT id, name AS label FROM channels
           WHERE organization_id = $1 ORDER BY lower(name), id`,
          [organizationId],
        );
        const locations = await client.query<{ id: string; label: string }>(
          `SELECT id, name AS label FROM locations
           WHERE organization_id = $1 ORDER BY lower(name), id`,
          [organizationId],
        );
        const products = await client.query<{
          id: string;
          label: string;
          sku: string;
        }>(
          `SELECT product.id, product.name AS label, product.sku
           FROM products product
           WHERE product.organization_id = ${organization}
             AND product.status = 'active'
             ${productSearch}
           ORDER BY ${selected ? `product.id = ${selected} DESC,` : ''}
             lower(product.name), product.id
           LIMIT 50`,
          productParameters.values,
        );
        return {
          channels: channels.rows,
          currencies: currencies.rows.map(({ currency }) => currency),
          locations: locations.rows,
          products: products.rows,
        };
      },
    );
  }

  listOrders(
    organizationId: string,
    query: SalesOrderQuery,
  ): Promise<SalesOrdersResponse> {
    return this.database.tenantReadTransaction(
      organizationId,
      async (client) => {
        const rows = await this.orderRows(
          client,
          organizationId,
          query,
          query.pageSize + 1,
        );
        const hasNextPage = rows.length > query.pageSize;
        const visible = rows.slice(0, query.pageSize);
        const last = visible.at(-1);
        return {
          filters: salesFilters(query),
          items: visible.map(mapOrder),
          pageInfo: {
            hasNextPage,
            nextCursor:
              hasNextPage && last ? encodeCursor(last, query) : undefined,
            pageSize: query.pageSize,
          },
          sort: { direction: query.direction, field: query.sort },
        };
      },
    );
  }

  orderDetail(
    organizationId: string,
    orderId: string,
  ): Promise<SalesOrderDetail> {
    return this.database.tenantReadTransaction(
      organizationId,
      async (client) => {
        const order = await client.query<DetailRow>(
          `${orderSelect}
           WHERE orders.organization_id = $1 AND orders.id = $2`,
          [organizationId, orderId],
        );
        const items = await client.query<{
          id: string;
          name: string;
          quantity: number;
          sku: string;
          totalMinor: string;
          unitPriceMinor: string;
        }>(
          `SELECT id, name, quantity, sku,
             total_minor AS "totalMinor", unit_price_minor AS "unitPriceMinor"
           FROM order_items
           WHERE organization_id = $1 AND order_id = $2
           ORDER BY id`,
          [organizationId, orderId],
        );
        const payment = await client.query<{
          capturedMinor: string;
          refundedMinor: string;
          status: string;
        }>(
          `SELECT status, captured_minor AS "capturedMinor",
             refunded_minor AS "refundedMinor"
           FROM payment_summaries
           WHERE organization_id = $1 AND order_id = $2`,
          [organizationId, orderId],
        );
        const fulfilments = await client.query<{
          carrier: string | null;
          deliveredAt: Date | null;
          id: string;
          shippedAt: Date | null;
          status: string;
          trackingReference: string | null;
        }>(
          `SELECT id, status, carrier,
             tracking_reference AS "trackingReference",
             shipped_at AS "shippedAt", delivered_at AS "deliveredAt"
           FROM fulfilments
           WHERE organization_id = $1 AND order_id = $2
           ORDER BY id`,
          [organizationId, orderId],
        );
        const returns = await client.query<{
          amountMinor: string;
          id: string;
          requestedAt: Date;
          status: string;
        }>(
          `SELECT id, status, amount_minor AS "amountMinor",
             requested_at AS "requestedAt"
           FROM returns
           WHERE organization_id = $1 AND order_id = $2
           ORDER BY requested_at, id`,
          [organizationId, orderId],
        );
        const row = order.rows[0];
        if (!row) throw new NotFoundException('Order not found');
        return {
          ...mapOrder(row),
          customerReference: row.customerReference ?? undefined,
          discountMinor: row.discountMinor,
          fulfilments: fulfilments.rows.map((item) =>
            compact({
              carrier: item.carrier ?? undefined,
              deliveredAt: item.deliveredAt ? iso(item.deliveredAt) : undefined,
              id: item.id,
              shippedAt: item.shippedAt ? iso(item.shippedAt) : undefined,
              status: item.status,
              trackingReference: item.trackingReference ?? undefined,
            }),
          ),
          items: items.rows,
          payment: payment.rows[0],
          returns: returns.rows.map((item) => ({
            amountMinor: item.amountMinor,
            id: item.id,
            requestedAt: iso(item.requestedAt),
            status: item.status,
          })),
          shippingMinor: row.shippingMinor,
          subtotalMinor: row.subtotalMinor,
          taxMinor: row.taxMinor,
        };
      },
    );
  }

  exportCsv(
    organizationId: string,
    request: SalesExportRequest,
    maxRows: number,
  ): Promise<{ csv: string; rowCount: number; truncated: boolean }> {
    return this.database.tenantReadTransaction(
      organizationId,
      async (client) => {
        const query: SalesOrderQuery = {
          ...request.filters,
          direction: request.direction,
          pageSize: 100,
          sort: request.sort,
        };
        const rows = await this.orderRows(
          client,
          organizationId,
          query,
          maxRows + 1,
        );
        const truncated = rows.length > maxRows;
        const visible = rows.slice(0, maxRows).map(mapOrder);
        return {
          csv: ordersCsv(visible),
          rowCount: visible.length,
          truncated,
        };
      },
    );
  }

  private async resolveCurrency(
    client: PoolClient,
    organizationId: string,
    filters: SalesFilters,
  ): Promise<string | undefined> {
    if (filters.currency) return filters.currency;
    const parameters = new SqlParameters();
    const filtered = filteredOrders(organizationId, filters, parameters, {
      omitCurrency: true,
    });
    const result = await client.query<{ currency: string }>(
      `WITH filtered AS (${filtered})
       SELECT DISTINCT currency FROM filtered ORDER BY currency LIMIT 3`,
      parameters.values,
    );
    if (result.rows.length <= 1) return result.rows[0]?.currency;
    throw new BadRequestException({
      code: 'SALES_CURRENCY_REQUIRED',
      details: { currencies: result.rows.map(({ currency }) => currency) },
      message: 'Choose one currency before comparing monetary sales metrics',
    });
  }

  private async metrics(
    client: PoolClient,
    organizationId: string,
    filters: SalesFilters,
  ): Promise<MetricRow> {
    const parameters = new SqlParameters();
    const filtered = filteredOrders(organizationId, filters, parameters);
    const result = await client.query<MetricRow>(
      `WITH filtered AS (${filtered})
       SELECT
         count(*) FILTER (WHERE ${commercialOrder}) AS "orderCount",
         coalesce(sum(${netRevenue}), 0) AS "revenueMinor",
         coalesce(sum(items.quantity) FILTER (WHERE ${commercialOrder}), 0) AS "itemsSold",
         round(sum(${netRevenue})::numeric /
           nullif(count(*) FILTER (WHERE ${commercialOrder}), 0))::bigint
           AS "averageOrderValueMinor"
       FROM filtered
       LEFT JOIN LATERAL (
         SELECT coalesce(sum(quantity), 0)::bigint AS quantity
         FROM order_items
         WHERE organization_id = filtered.organization_id
           AND order_id = filtered.id
       ) items ON true`,
      parameters.values,
    );
    return required(result.rows[0], 'sales metrics');
  }

  private async trend(
    client: PoolClient,
    organizationId: string,
    filters: SalesFilters,
    granularity: SalesOverviewResponse['granularity'],
  ): Promise<SalesOverviewResponse['trend']> {
    if (!filters.currency) return [];
    const parameters = new SqlParameters();
    const filtered = filteredOrders(organizationId, filters, parameters);
    const bucket = `date_trunc('${granularity}', filtered.occurred_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`;
    const result = await client.query<TrendRow>(
      `WITH filtered AS (${filtered})
       SELECT ${bucket} AS "bucketStart",
         count(*) FILTER (WHERE ${commercialOrder}) AS "orderCount",
         coalesce(sum(${netRevenue}), 0) AS "revenueMinor",
         coalesce(round(sum(${netRevenue})::numeric /
           nullif(count(*) FILTER (WHERE ${commercialOrder}), 0)), 0)::bigint
           AS "averageOrderValueMinor"
       FROM filtered
       GROUP BY 1 ORDER BY 1`,
      parameters.values,
    );
    return result.rows.map((row) => ({
      averageOrderValueMinor: row.averageOrderValueMinor ?? '0',
      bucketStart: iso(row.bucketStart),
      orderCount: Number(row.orderCount),
      revenueMinor: row.revenueMinor,
    }));
  }

  private async segments(
    client: PoolClient,
    organizationId: string,
    filters: SalesFilters,
    dimension: 'channel' | 'location',
  ): Promise<SalesSegment[]> {
    if (!filters.currency) return [];
    const parameters = new SqlParameters();
    const filtered = filteredOrders(organizationId, filters, parameters);
    const join =
      dimension === 'channel'
        ? 'JOIN channels dimension ON dimension.id = filtered.channel_id AND dimension.organization_id = filtered.organization_id'
        : 'LEFT JOIN locations dimension ON dimension.id = filtered.location_id AND dimension.organization_id = filtered.organization_id';
    const result = await client.query<SegmentRow>(
      `WITH filtered AS (${filtered}), segments AS (
         SELECT dimension.id, coalesce(dimension.name, 'Unassigned') AS label,
           count(*) FILTER (WHERE ${commercialOrder}) AS "orderCount",
           coalesce(sum(${netRevenue}), 0) AS "revenueMinor"
         FROM filtered ${join}
         GROUP BY dimension.id, dimension.name
       )
       SELECT segments.*, sum("revenueMinor") OVER () AS "totalRevenueMinor"
       FROM segments
       ORDER BY "revenueMinor" DESC, label LIMIT 8`,
      parameters.values,
    );
    return withShares(result.rows);
  }

  private async productSegments(
    client: PoolClient,
    organizationId: string,
    filters: SalesFilters,
  ): Promise<ProductSalesSegment[]> {
    if (!filters.currency) return [];
    const parameters = new SqlParameters();
    const filtered = filteredOrders(organizationId, filters, parameters);
    const selectedProduct = filters.productId
      ? `AND item.product_id = ${parameters.add(filters.productId, 'uuid')}`
      : '';
    const result = await client.query<SegmentRow>(
      `WITH filtered AS (${filtered}), segments AS (
         SELECT product.id, product.name AS label, product.sku,
           count(DISTINCT filtered.id) FILTER (WHERE ${commercialOrder}) AS "orderCount",
           coalesce(sum(CASE WHEN ${commercialOrder} THEN item.total_minor ELSE 0 END), 0)
             AS "revenueMinor"
         FROM filtered
         JOIN order_items item
           ON item.organization_id = filtered.organization_id
           AND item.order_id = filtered.id
           ${selectedProduct}
         JOIN products product
           ON product.organization_id = item.organization_id
           AND product.id = item.product_id
         GROUP BY product.id, product.name, product.sku
       )
       SELECT segments.*, sum("revenueMinor") OVER () AS "totalRevenueMinor"
       FROM segments
       ORDER BY "revenueMinor" DESC, label LIMIT 8`,
      parameters.values,
    );
    return withShares(result.rows).map((row, index) => ({
      ...row,
      sku: required(result.rows[index]?.sku, 'product SKU'),
    }));
  }

  private async freshness(
    client: PoolClient,
    organizationId: string,
  ): Promise<SalesFreshness> {
    const result = await client.query<{
      dataThrough: Date | null;
      failedImportCount: string;
      latestIngestedAt: Date | null;
      pendingImportCount: string;
    }>(
      `SELECT
         (SELECT max(occurred_at) FROM orders WHERE organization_id = $1) AS "dataThrough",
         (SELECT max(updated_at) FROM orders WHERE organization_id = $1) AS "latestIngestedAt",
         (SELECT count(*) FROM data_imports
          WHERE organization_id = $1 AND status IN ('queued', 'processing')) AS "pendingImportCount",
         (SELECT count(*) FROM data_imports
          WHERE organization_id = $1 AND status = 'failed'
            AND created_at >= now() - interval '24 hours') AS "failedImportCount"`,
      [organizationId],
    );
    const row = required(result.rows[0], 'sales freshness');
    const pendingImportCount = Number(row.pendingImportCount);
    const failedImportCount = Number(row.failedImportCount);
    const latestIngestedAt = row.latestIngestedAt
      ? iso(row.latestIngestedAt)
      : undefined;
    const age = latestIngestedAt
      ? Date.now() - Date.parse(latestIngestedAt)
      : Number.POSITIVE_INFINITY;
    const status: SalesFreshness['status'] = !row.dataThrough
      ? 'empty'
      : pendingImportCount > 0 || failedImportCount > 0
        ? 'partial'
        : age > 24 * 60 * 60 * 1_000
          ? 'stale'
          : 'fresh';
    return compact({
      dataThrough: row.dataThrough ? iso(row.dataThrough) : undefined,
      failedImportCount,
      generatedAt: new Date().toISOString(),
      latestIngestedAt,
      pendingImportCount,
      status,
    });
  }

  private async orderRows(
    client: PoolClient,
    organizationId: string,
    query: SalesOrderQuery,
    limit: number,
  ): Promise<OrderRow[]> {
    const parameters = new SqlParameters();
    const filtered = filteredOrders(organizationId, query, parameters);
    const sort = sortColumns[query.sort];
    let cursorPredicate = '';
    if (query.cursor) {
      const cursor = decodeCursor(query.cursor, query);
      const operation = query.direction === 'desc' ? '<' : '>';
      cursorPredicate = `WHERE (page.${sort.column}, page.id) ${operation}
        (${parameters.add(cursor.value, sort.cast)}, ${parameters.add(cursor.id, 'uuid')})`;
    }
    const result = await client.query<OrderRow>(
      `WITH filtered AS (${filtered}), page AS (
         SELECT filtered.id, filtered.currency,
           filtered.order_number AS "orderNumber",
           lower(filtered.order_number) AS order_number_sort,
           filtered.status, filtered.total_minor AS "totalMinor",
           filtered.refunded_minor AS "refundedMinor",
           ${netRevenue} AS "netRevenueMinor",
           filtered.occurred_at AS "occurredAt",
           channel.id AS "channelId", channel.name AS "channelLabel",
           location.id AS "locationId", location.name AS "locationLabel",
           items.quantity AS "itemCount"
         FROM filtered
         JOIN channels channel
           ON channel.organization_id = filtered.organization_id
           AND channel.id = filtered.channel_id
         LEFT JOIN locations location
           ON location.organization_id = filtered.organization_id
           AND location.id = filtered.location_id
         LEFT JOIN LATERAL (
           SELECT coalesce(sum(quantity), 0)::bigint AS quantity
           FROM order_items
           WHERE organization_id = filtered.organization_id
             AND order_id = filtered.id
         ) items ON true
       )
       SELECT * FROM page ${cursorPredicate}
       ORDER BY page.${sort.column} ${query.direction}, page.id ${query.direction}
       LIMIT ${parameters.add(limit, 'integer')}`,
      parameters.values,
    );
    return result.rows;
  }
}

const sortColumns: Record<SalesSort, { cast: string; column: string }> = {
  occurredAt: { cast: 'timestamptz', column: '"occurredAt"' },
  orderNumber: { cast: 'text', column: 'order_number_sort' },
  revenue: { cast: 'bigint', column: '"netRevenueMinor"' },
  status: { cast: 'text', column: 'status' },
};

const orderSelect = `
  SELECT orders.id, orders.currency, orders.order_number AS "orderNumber",
    orders.status, orders.total_minor AS "totalMinor",
    coalesce(payment.refunded_minor, 0) AS "refundedMinor",
    CASE WHEN orders.status <> 'cancelled'
      THEN greatest(orders.total_minor - coalesce(payment.refunded_minor, 0), 0)
      ELSE 0 END AS "netRevenueMinor",
    orders.occurred_at AS "occurredAt",
    orders.discount_minor AS "discountMinor",
    orders.shipping_minor AS "shippingMinor",
    orders.subtotal_minor AS "subtotalMinor",
    orders.tax_minor AS "taxMinor",
    channel.id AS "channelId", channel.name AS "channelLabel",
    location.id AS "locationId", location.name AS "locationLabel",
    customer.external_id AS "customerReference",
    items.quantity AS "itemCount"
  FROM orders
  JOIN channels channel
    ON channel.organization_id = orders.organization_id
    AND channel.id = orders.channel_id
  LEFT JOIN locations location
    ON location.organization_id = orders.organization_id
    AND location.id = orders.location_id
  LEFT JOIN customer_references customer
    ON customer.organization_id = orders.organization_id
    AND customer.id = orders.customer_reference_id
  LEFT JOIN payment_summaries payment
    ON payment.organization_id = orders.organization_id
    AND payment.order_id = orders.id
  LEFT JOIN LATERAL (
    SELECT coalesce(sum(quantity), 0)::bigint AS quantity
    FROM order_items
    WHERE organization_id = orders.organization_id AND order_id = orders.id
  ) items ON true`;

function filteredOrders(
  organizationId: string,
  filters: SalesFilters,
  parameters: SqlParameters,
  options: { omitCurrency?: boolean } = {},
): string {
  const where = [
    `orders.organization_id = ${parameters.add(organizationId, 'uuid')}`,
    `orders.occurred_at >= ${parameters.add(`${filters.from}T00:00:00.000Z`, 'timestamptz')}`,
    `orders.occurred_at < ${parameters.add(`${filters.to}T00:00:00.000Z`, 'timestamptz')}`,
  ];
  if (filters.currency && !options.omitCurrency) {
    where.push(`orders.currency = ${parameters.add(filters.currency)}`);
  }
  if (filters.channelId) {
    where.push(
      `orders.channel_id = ${parameters.add(filters.channelId, 'uuid')}`,
    );
  }
  if (filters.locationId) {
    where.push(
      `orders.location_id = ${parameters.add(filters.locationId, 'uuid')}`,
    );
  }
  if (filters.status) {
    where.push(`orders.status = ${parameters.add(filters.status)}`);
  }
  if (filters.query) {
    const query = parameters.add(`%${filters.query}%`);
    where.push(
      `(orders.order_number ILIKE ${query} OR orders.external_id ILIKE ${query})`,
    );
  }
  if (filters.productId) {
    const product = parameters.add(filters.productId, 'uuid');
    where.push(`EXISTS (
      SELECT 1 FROM order_items selected_item
      WHERE selected_item.organization_id = orders.organization_id
        AND selected_item.order_id = orders.id
        AND selected_item.product_id = ${product}
    )`);
  }
  return `SELECT orders.*,
      coalesce(payment.refunded_minor, 0) AS refunded_minor
    FROM orders
    LEFT JOIN payment_summaries payment
      ON payment.organization_id = orders.organization_id
      AND payment.order_id = orders.id
    WHERE ${where.join('\n AND ')}`;
}

class SqlParameters {
  readonly values: unknown[] = [];

  add(value: unknown, cast?: string): string {
    this.values.push(value);
    return `$${this.values.length}${cast ? `::${cast}` : ''}`;
  }
}

function mapOrder(row: OrderRow): SalesOrderSummary {
  return compact({
    channel: { id: row.channelId, label: row.channelLabel },
    currency: row.currency,
    id: row.id,
    itemCount: Number(row.itemCount),
    location:
      row.locationId && row.locationLabel
        ? { id: row.locationId, label: row.locationLabel }
        : undefined,
    netRevenueMinor: row.netRevenueMinor,
    occurredAt: iso(row.occurredAt),
    orderNumber: row.orderNumber,
    refundedMinor: row.refundedMinor,
    status: row.status,
    totalMinor: row.totalMinor,
  });
}

function comparisons(current: MetricRow, previous: MetricRow): SalesKpis {
  return {
    averageOrderValueMinor: comparison(
      current.averageOrderValueMinor ?? '0',
      previous.averageOrderValueMinor ?? '0',
    ),
    itemsSold: comparison(current.itemsSold, previous.itemsSold),
    orderCount: comparison(current.orderCount, previous.orderCount),
    revenueMinor: comparison(current.revenueMinor, previous.revenueMinor),
  };
}

function comparison(current: string, previous: string) {
  const currentValue = BigInt(current);
  const previousValue = BigInt(previous);
  const changeBasisPoints =
    previousValue === 0n
      ? currentValue === 0n
        ? 0
        : null
      : Number(((currentValue - previousValue) * 10_000n) / previousValue);
  return { changeBasisPoints, current, previous };
}

function withShares(rows: SegmentRow[]): SalesSegment[] {
  const total = BigInt(rows[0]?.totalRevenueMinor ?? 0);
  return rows.map((row) =>
    compact({
      id: row.id ?? undefined,
      label: row.label,
      orderCount: Number(row.orderCount),
      revenueMinor: row.revenueMinor,
      shareBasisPoints:
        total === 0n ? 0 : Number((BigInt(row.revenueMinor) * 10_000n) / total),
    }),
  );
}

function previousPeriod(
  filters: SalesFilters,
): Pick<SalesFilters, 'from' | 'to'> {
  const from = Date.parse(`${filters.from}T00:00:00.000Z`);
  const to = Date.parse(`${filters.to}T00:00:00.000Z`);
  const duration = to - from;
  return {
    from: new Date(from - duration).toISOString().slice(0, 10),
    to: filters.from,
  };
}

function trendGranularity(
  filters: SalesFilters,
): SalesOverviewResponse['granularity'] {
  const days =
    (Date.parse(`${filters.to}T00:00:00.000Z`) -
      Date.parse(`${filters.from}T00:00:00.000Z`)) /
    86_400_000;
  return days <= 45 ? 'day' : days <= 180 ? 'week' : 'month';
}

function salesFilters(query: SalesOrderQuery): SalesFilters {
  return compact({
    channelId: query.channelId,
    currency: query.currency,
    from: query.from,
    locationId: query.locationId,
    productId: query.productId,
    query: query.query,
    status: query.status,
    to: query.to,
  });
}

function encodeCursor(row: OrderRow, query: SalesOrderQuery): string {
  const values: Record<SalesSort, string> = {
    occurredAt: iso(row.occurredAt),
    orderNumber: row.orderNumber.toLocaleLowerCase(),
    revenue: row.netRevenueMinor,
    status: row.status,
  };
  return Buffer.from(
    JSON.stringify({
      direction: query.direction,
      filterHash: filterHash(salesFilters(query)),
      id: row.id,
      sort: query.sort,
      value: values[query.sort],
    } satisfies CursorPayload),
  ).toString('base64url');
}

function decodeCursor(value: string, query: SalesOrderQuery): CursorPayload {
  try {
    const cursor = cursorSchema.parse(
      JSON.parse(Buffer.from(value, 'base64url').toString('utf8')),
    );
    if (
      cursor.direction !== query.direction ||
      cursor.sort !== query.sort ||
      cursor.filterHash !== filterHash(salesFilters(query))
    )
      throw new Error('Cursor context does not match');
    return cursor;
  } catch {
    throw new BadRequestException({
      code: 'SALES_CURSOR_INVALID',
      message: 'The order page cursor is invalid for these filters',
    });
  }
}

function filterHash(filters: SalesFilters): string {
  return createHash('sha256').update(stableJson(filters)).digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(',')}}`;
}

function ordersCsv(rows: SalesOrderSummary[]): string {
  const header = [
    'order_id',
    'order_number',
    'occurred_at',
    'status',
    'currency',
    'order_total_minor',
    'refunded_minor',
    'net_revenue_minor',
    'item_quantity',
    'channel',
    'location',
  ];
  return [
    header.join(','),
    ...rows.map((row) =>
      [
        row.id,
        row.orderNumber,
        row.occurredAt,
        row.status,
        row.currency,
        row.totalMinor,
        row.refundedMinor,
        row.netRevenueMinor,
        row.itemCount,
        row.channel.label,
        row.location?.label ?? '',
      ]
        .map(csvCell)
        .join(','),
    ),
  ].join('\n');
}

function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function iso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as T;
}

function required<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) {
    throw new Error(`Missing ${label}`);
  }
  return value;
}
