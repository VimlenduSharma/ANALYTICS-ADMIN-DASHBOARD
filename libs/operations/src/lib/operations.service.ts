import type {
  OperationsAlert,
  OperationsFilters,
  OperationsHealth,
  OperationsIssue,
  OperationsIssuesResponse,
  OperationsKpis,
  OperationsLocationSummary,
  OperationsOverviewResponse,
  OperationsSeverity,
  OperationsSourceHealth,
  OperationsThresholds,
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
import {
  defaultOperationsThresholds,
  type OperationsIssueQuery,
  type OperationsThresholdInput,
} from './operations-filter';

interface ThresholdRow {
  backlogCriticalMinutes: number;
  backlogWarningMinutes: number;
  cancellationWarningBasisPoints: number;
  cutoffLocalTime: string;
  dataStaleAfterMinutes: number;
  fulfilmentTargetMinutes: number;
  lowStockBufferQuantity: string;
  returnWarningBasisPoints: number;
  timezone: string;
  updatedAt: Date | null;
}

interface MetricsRow {
  averageFulfilmentLeadMinutes: number | null;
  backlogCount: string;
  cancellationRateBasisPoints: number;
  lowStockCount: string;
  returnRateBasisPoints: number;
  serviceLevelBasisPoints: number | null;
  stockOnHandQuantity: string;
}

interface LocationRow {
  averageFulfilmentLeadMinutes: number | null;
  backlogCount: string;
  criticalBacklogCount: string;
  id: string | null;
  label: string;
  lateCount: string;
  lowStockCount: string;
  outOfStockCount: string;
  overdueCount: string;
  serviceLevelBasisPoints: number | null;
  sourceLastReceivedAt: Date | null;
  timezone: string;
}

interface FreshnessRow {
  failedImportCount: string;
  fulfilmentsLastReceivedAt: Date | null;
  inventoryLastReceivedAt: Date | null;
  ordersLastReceivedAt: Date | null;
  pendingImportCount: string;
}

interface IssueRow {
  ageMinutes: number | null;
  detail: string;
  entityId: string;
  id: string;
  locationId: string | null;
  locationLabel: string | null;
  occurredAt: Date;
  quantity: string | null;
  severity: OperationsSeverity;
  severityRank: number;
  title: string;
  type: OperationsIssue['type'];
}

interface IssueCursor {
  filterHash: string;
  id: string;
  occurredAt: string;
  severityRank: number;
}

const issueCursorSchema = z.strictObject({
  filterHash: z.string().length(64),
  id: z.string().min(1).max(300),
  occurredAt: z.iso.datetime({ offset: true }),
  severityRank: z.number().int().min(1).max(3),
});

@Injectable()
export class OperationsService {
  constructor(private readonly database: DatabaseService) {}

  overview(
    organizationId: string,
    filters: OperationsFilters,
  ): Promise<OperationsOverviewResponse> {
    return this.database.tenantReadTransaction(
      organizationId,
      async (client) => {
        const generatedAt = await databaseNow(client);
        const thresholds = await this.thresholds(client, organizationId);
        const kpis = await this.metrics(
          client,
          organizationId,
          filters,
          thresholds,
          generatedAt,
        );
        const locationRows = await this.locations(
          client,
          organizationId,
          filters,
          thresholds,
          generatedAt,
        );
        const health = await this.health(
          client,
          organizationId,
          thresholds,
          generatedAt,
        );
        const acknowledgements = await client.query<{
          acknowledgedAt: Date;
          alertKey: string;
        }>(
          `SELECT alert_key AS "alertKey", acknowledged_at AS "acknowledgedAt"
           FROM operations_alert_acknowledgements
           WHERE organization_id = $1`,
          [organizationId],
        );
        return {
          alerts: buildAlerts(
            kpis,
            locationRows,
            thresholds,
            new Map(
              acknowledgements.rows.map((row) => [
                row.alertKey,
                iso(row.acknowledgedAt),
              ]),
            ),
          ),
          filters,
          health,
          kpis,
          locations: locationRows.map((row) =>
            mapLocation(row, thresholds, generatedAt),
          ),
          thresholds,
        };
      },
    );
  }

  issues(
    organizationId: string,
    query: OperationsIssueQuery,
  ): Promise<OperationsIssuesResponse> {
    return this.database.tenantReadTransaction(
      organizationId,
      async (client) => {
        const generatedAt = await databaseNow(client);
        const thresholds = await this.thresholds(client, organizationId);
        const rows = await this.issueRows(
          client,
          organizationId,
          query,
          thresholds,
          generatedAt,
        );
        const hasNextPage = rows.length > query.pageSize;
        const visible = rows.slice(0, query.pageSize);
        const last = visible.at(-1);
        return {
          filters: issueFilters(query),
          items: visible.map(mapIssue),
          pageInfo: {
            hasNextPage,
            nextCursor:
              hasNextPage && last ? encodeCursor(last, query) : undefined,
            pageSize: query.pageSize,
          },
        };
      },
    );
  }

  async updateThresholds(
    actorUserId: string,
    organizationId: string,
    input: OperationsThresholdInput,
  ): Promise<OperationsThresholds> {
    return this.database.tenantTransaction(organizationId, async (client) => {
      const validTimezone = await client.query<{ valid: boolean }>(
        'SELECT app_valid_timezone($1) AS valid',
        [input.timezone],
      );
      if (!validTimezone.rows[0]?.valid) {
        throw new Error('Timezone validation changed after request parsing');
      }
      const result = await client.query<ThresholdRow>(
        `INSERT INTO operations_thresholds (
           organization_id, timezone, cutoff_local_time,
           fulfilment_target_minutes, backlog_warning_minutes,
           backlog_critical_minutes, cancellation_warning_basis_points,
           return_warning_basis_points, low_stock_buffer_quantity,
           data_stale_after_minutes, updated_by_user_id
         ) VALUES ($1, $2, $3::time, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (organization_id) DO UPDATE SET
           timezone = EXCLUDED.timezone,
           cutoff_local_time = EXCLUDED.cutoff_local_time,
           fulfilment_target_minutes = EXCLUDED.fulfilment_target_minutes,
           backlog_warning_minutes = EXCLUDED.backlog_warning_minutes,
           backlog_critical_minutes = EXCLUDED.backlog_critical_minutes,
           cancellation_warning_basis_points = EXCLUDED.cancellation_warning_basis_points,
           return_warning_basis_points = EXCLUDED.return_warning_basis_points,
           low_stock_buffer_quantity = EXCLUDED.low_stock_buffer_quantity,
           data_stale_after_minutes = EXCLUDED.data_stale_after_minutes,
           updated_by_user_id = EXCLUDED.updated_by_user_id,
           updated_at = now()
         RETURNING
           timezone, to_char(cutoff_local_time, 'HH24:MI') AS "cutoffLocalTime",
           fulfilment_target_minutes AS "fulfilmentTargetMinutes",
           backlog_warning_minutes AS "backlogWarningMinutes",
           backlog_critical_minutes AS "backlogCriticalMinutes",
           cancellation_warning_basis_points AS "cancellationWarningBasisPoints",
           return_warning_basis_points AS "returnWarningBasisPoints",
           low_stock_buffer_quantity AS "lowStockBufferQuantity",
           data_stale_after_minutes AS "dataStaleAfterMinutes",
           updated_at AS "updatedAt"`,
        [
          organizationId,
          input.timezone,
          input.cutoffLocalTime,
          input.fulfilmentTargetMinutes,
          input.backlogWarningMinutes,
          input.backlogCriticalMinutes,
          input.cancellationWarningBasisPoints,
          input.returnWarningBasisPoints,
          input.lowStockBufferQuantity,
          input.dataStaleAfterMinutes,
          actorUserId,
        ],
      );
      await client.query(
        `INSERT INTO audit_events (
         organization_id, actor_user_id, event_type, target_type, target_id, metadata
       ) VALUES ($1, $2, 'operations.thresholds_updated',
           'operations_thresholds', $1::uuid::text, $3)`,
        [organizationId, actorUserId, input],
      );
      return mapThreshold(required(result.rows[0], 'operations thresholds'));
    });
  }

  async acknowledgeAlert(
    actorUserId: string,
    organizationId: string,
    alertKey: string,
    filters: OperationsFilters,
  ): Promise<void> {
    const current = await this.overview(organizationId, filters);
    if (!current.alerts.some(({ key }) => key === alertKey)) {
      throw new NotFoundException('Active operations alert not found');
    }
    await this.database.tenantTransaction(organizationId, async (client) => {
      await client.query(
        `INSERT INTO operations_alert_acknowledgements (
           organization_id, alert_key, acknowledged_by_user_id
         ) VALUES ($1, $2, $3)
         ON CONFLICT (organization_id, alert_key) DO UPDATE SET
           acknowledged_by_user_id = EXCLUDED.acknowledged_by_user_id,
           acknowledged_at = now()`,
        [organizationId, alertKey, actorUserId],
      );
      await auditAlert(
        client,
        organizationId,
        actorUserId,
        alertKey,
        'acknowledged',
      );
    });
  }

  async reopenAlert(
    actorUserId: string,
    organizationId: string,
    alertKey: string,
  ): Promise<void> {
    await this.database.tenantTransaction(organizationId, async (client) => {
      const deleted = await client.query(
        `DELETE FROM operations_alert_acknowledgements
         WHERE organization_id = $1 AND alert_key = $2`,
        [organizationId, alertKey],
      );
      if (!deleted.rowCount) {
        throw new NotFoundException('Acknowledged operations alert not found');
      }
      await auditAlert(
        client,
        organizationId,
        actorUserId,
        alertKey,
        'reopened',
      );
    });
  }

  private async thresholds(
    client: PoolClient,
    organizationId: string,
  ): Promise<OperationsThresholds> {
    const result = await client.query<ThresholdRow>(
      `SELECT timezone,
         to_char(cutoff_local_time, 'HH24:MI') AS "cutoffLocalTime",
         fulfilment_target_minutes AS "fulfilmentTargetMinutes",
         backlog_warning_minutes AS "backlogWarningMinutes",
         backlog_critical_minutes AS "backlogCriticalMinutes",
         cancellation_warning_basis_points AS "cancellationWarningBasisPoints",
         return_warning_basis_points AS "returnWarningBasisPoints",
         low_stock_buffer_quantity AS "lowStockBufferQuantity",
         data_stale_after_minutes AS "dataStaleAfterMinutes",
         updated_at AS "updatedAt"
       FROM operations_thresholds WHERE organization_id = $1`,
      [organizationId],
    );
    return result.rows[0]
      ? mapThreshold(result.rows[0])
      : defaultOperationsThresholds();
  }

  private async metrics(
    client: PoolClient,
    organizationId: string,
    filters: OperationsFilters,
    thresholds: OperationsThresholds,
    generatedAt: Date,
  ): Promise<OperationsKpis> {
    const parameters = commonParameters(
      organizationId,
      filters,
      thresholds,
      generatedAt,
    );
    const location = locationPredicate(filters, parameters);
    const result = await client.query<MetricsRow>(
      `WITH scoped AS (${operationalOrders(parameters, location)}),
       order_metrics AS (
         SELECT
           round(avg(extract(epoch FROM (shipped_at - occurred_at)) / 60)
             FILTER (WHERE shipped_at >= occurred_at))::integer
             AS "averageFulfilmentLeadMinutes",
           count(*) FILTER (WHERE commercial AND shipped_at IS NULL) AS "backlogCount",
           coalesce(round(10000.0 * count(*) FILTER (WHERE status = 'cancelled') /
             nullif(count(*), 0)), 0)::integer AS "cancellationRateBasisPoints",
           coalesce(round(10000.0 * count(*) FILTER (WHERE has_return) /
             nullif(count(*) FILTER (WHERE commercial), 0)), 0)::integer
             AS "returnRateBasisPoints",
           round(10000.0 * count(*) FILTER (WHERE commercial AND shipped_at <= due_at) /
             nullif(count(*) FILTER (WHERE commercial AND shipped_at IS NOT NULL), 0)
           )::integer AS "serviceLevelBasisPoints"
         FROM scoped
       ), inventory_metrics AS (
         SELECT
           coalesce(sum(inventory.on_hand_quantity), 0) AS "stockOnHandQuantity",
           count(*) FILTER (WHERE
             inventory.on_hand_quantity - inventory.reserved_quantity <=
             inventory.reorder_point + ${parameters.buffer}
           ) AS "lowStockCount"
         FROM inventory
         WHERE inventory.organization_id = ${parameters.organization}
           ${filters.locationId ? `AND inventory.location_id = ${parameters.location}` : ''}
       )
       SELECT order_metrics.*, inventory_metrics.*
       FROM order_metrics CROSS JOIN inventory_metrics`,
      parameters.values,
    );
    const row = required(result.rows[0], 'operations metrics');
    return {
      averageFulfilmentLeadMinutes: row.averageFulfilmentLeadMinutes,
      backlogCount: Number(row.backlogCount),
      cancellationRateBasisPoints: row.cancellationRateBasisPoints,
      lowStockCount: Number(row.lowStockCount),
      returnRateBasisPoints: row.returnRateBasisPoints,
      serviceLevelBasisPoints: row.serviceLevelBasisPoints,
      stockOnHandQuantity: row.stockOnHandQuantity,
    };
  }

  private async locations(
    client: PoolClient,
    organizationId: string,
    filters: OperationsFilters,
    thresholds: OperationsThresholds,
    generatedAt: Date,
  ): Promise<LocationRow[]> {
    const parameters = commonParameters(
      organizationId,
      filters,
      thresholds,
      generatedAt,
    );
    const location = locationPredicate(filters, parameters);
    const result = await client.query<LocationRow>(
      `WITH scoped AS (${operationalOrders(parameters, location)}),
       order_rollup AS (
         SELECT location_id,
           round(avg(extract(epoch FROM (shipped_at - occurred_at)) / 60)
             FILTER (WHERE shipped_at >= occurred_at))::integer
             AS "averageFulfilmentLeadMinutes",
           count(*) FILTER (WHERE commercial AND shipped_at IS NULL) AS "backlogCount",
           count(*) FILTER (WHERE commercial AND shipped_at IS NULL AND
             extract(epoch FROM (${parameters.now} - occurred_at)) / 60 >=
               ${parameters.critical}) AS "criticalBacklogCount",
           count(*) FILTER (WHERE commercial AND shipped_at IS NULL AND
             due_at <= ${parameters.now}) AS "overdueCount",
           count(*) FILTER (WHERE commercial AND shipped_at > due_at) AS "lateCount",
           round(10000.0 * count(*) FILTER (WHERE commercial AND shipped_at <= due_at) /
             nullif(count(*) FILTER (WHERE commercial AND shipped_at IS NOT NULL), 0)
           )::integer AS "serviceLevelBasisPoints"
         FROM scoped GROUP BY location_id
       ), inventory_rollup AS (
         SELECT location_id,
           count(*) FILTER (WHERE on_hand_quantity - reserved_quantity <=
             reorder_point + ${parameters.buffer}) AS "lowStockCount",
           count(*) FILTER (WHERE on_hand_quantity - reserved_quantity <= 0)
             AS "outOfStockCount",
           max(coalesce(source_updated_at, updated_at)) AS "sourceLastReceivedAt"
         FROM inventory
         WHERE organization_id = ${parameters.organization}
           ${filters.locationId ? `AND location_id = ${parameters.location}` : ''}
         GROUP BY location_id
       ), dimensions AS (
         SELECT id, name AS label, timezone FROM locations
         WHERE organization_id = ${parameters.organization}
           ${filters.locationId ? `AND id = ${parameters.location}` : ''}
         UNION ALL
         SELECT NULL, 'Unassigned', ${parameters.timezone}
         WHERE EXISTS (SELECT 1 FROM scoped WHERE location_id IS NULL)
       )
       SELECT dimensions.id, dimensions.label, dimensions.timezone,
         order_rollup."averageFulfilmentLeadMinutes",
         coalesce(order_rollup."backlogCount", 0) AS "backlogCount",
         coalesce(order_rollup."criticalBacklogCount", 0) AS "criticalBacklogCount",
         coalesce(order_rollup."overdueCount", 0) AS "overdueCount",
         coalesce(order_rollup."lateCount", 0) AS "lateCount",
         order_rollup."serviceLevelBasisPoints",
         coalesce(inventory_rollup."lowStockCount", 0) AS "lowStockCount",
         coalesce(inventory_rollup."outOfStockCount", 0) AS "outOfStockCount",
         inventory_rollup."sourceLastReceivedAt"
       FROM dimensions
       LEFT JOIN order_rollup ON order_rollup.location_id IS NOT DISTINCT FROM dimensions.id
       LEFT JOIN inventory_rollup ON inventory_rollup.location_id = dimensions.id
       ORDER BY coalesce(order_rollup."overdueCount", 0) DESC,
         coalesce(inventory_rollup."lowStockCount", 0) DESC,
         lower(dimensions.label), dimensions.id`,
      parameters.values,
    );
    return result.rows;
  }

  private async health(
    client: PoolClient,
    organizationId: string,
    thresholds: OperationsThresholds,
    generatedAt: Date,
  ): Promise<OperationsHealth> {
    const result = await client.query<FreshnessRow>(
      `SELECT
         (SELECT max(coalesce(source_updated_at, updated_at)) FROM orders
          WHERE organization_id = $1) AS "ordersLastReceivedAt",
         (SELECT max(updated_at) FROM fulfilments
          WHERE organization_id = $1) AS "fulfilmentsLastReceivedAt",
         (SELECT max(coalesce(source_updated_at, updated_at)) FROM inventory
          WHERE organization_id = $1) AS "inventoryLastReceivedAt",
         (SELECT count(*) FROM data_imports WHERE organization_id = $1
          AND status IN ('queued', 'processing')) AS "pendingImportCount",
         (SELECT count(*) FROM data_imports WHERE organization_id = $1
          AND status = 'failed'
          AND created_at >= $2::timestamptz - interval '24 hours')
          AS "failedImportCount"`,
      [organizationId, generatedAt],
    );
    const row = required(result.rows[0], 'operations freshness');
    const sources: OperationsSourceHealth[] = [
      sourceHealth('orders', row.ordersLastReceivedAt, generatedAt, thresholds),
      sourceHealth(
        'fulfilments',
        row.fulfilmentsLastReceivedAt,
        generatedAt,
        thresholds,
      ),
      sourceHealth(
        'inventory',
        row.inventoryLastReceivedAt,
        generatedAt,
        thresholds,
      ),
    ];
    const pendingImportCount = Number(row.pendingImportCount);
    const failedImportCount = Number(row.failedImportCount);
    const statuses = new Set(sources.map(({ status }) => status));
    const status: OperationsHealth['status'] =
      statuses.size === 1 && statuses.has('missing')
        ? 'empty'
        : pendingImportCount || failedImportCount
          ? 'partial'
          : statuses.has('missing')
            ? 'missing'
            : statuses.has('delayed')
              ? 'delayed'
              : 'healthy';
    return {
      failedImportCount,
      generatedAt: iso(generatedAt),
      pendingImportCount,
      sources,
      status,
    };
  }

  private async issueRows(
    client: PoolClient,
    organizationId: string,
    query: OperationsIssueQuery,
    thresholds: OperationsThresholds,
    generatedAt: Date,
  ): Promise<IssueRow[]> {
    if (query.issueType === 'backlog') {
      return this.backlogIssueRows(
        client,
        organizationId,
        query,
        thresholds,
        generatedAt,
      );
    }
    const parameters = commonParameters(
      organizationId,
      query,
      thresholds,
      generatedAt,
    );
    const location = locationPredicate(query, parameters);
    const typeFilter = query.issueType
      ? `AND issues.type = ${parameters.add(query.issueType)}`
      : '';
    const severityFilter = query.severity
      ? `AND issues.severity = ${parameters.add(query.severity)}`
      : '';
    const cursorFilter = issueCursorPredicate(query, parameters);
    const result = await client.query<IssueRow>(
      `WITH scoped AS (${operationalOrders(parameters, location)}), issues AS (
         SELECT 'backlog:' || scoped.id AS id, scoped.id AS entity_id,
           'backlog'::text AS type,
           CASE WHEN extract(epoch FROM (${parameters.now} - scoped.occurred_at)) / 60 >=
             ${parameters.critical} THEN 'critical' ELSE 'warning' END AS severity,
           CASE WHEN extract(epoch FROM (${parameters.now} - scoped.occurred_at)) / 60 >=
             ${parameters.critical} THEN 3 ELSE 2 END AS severity_rank,
           'Order ' || scoped.order_number || ' is waiting to ship' AS title,
           'No shipment has been recorded before its service deadline.' AS detail,
           scoped.occurred_at, scoped.location_id, scoped.location_label,
           floor(extract(epoch FROM (${parameters.now} - scoped.occurred_at)) / 60)::integer
             AS age_minutes,
           NULL::bigint AS quantity
         FROM scoped
         WHERE scoped.commercial AND scoped.shipped_at IS NULL
           AND extract(epoch FROM (${parameters.now} - scoped.occurred_at)) / 60 >=
             ${parameters.warning}

         UNION ALL
         SELECT 'late-fulfilment:' || scoped.id, scoped.id, 'late-fulfilment',
           'warning', 2, 'Order ' || scoped.order_number || ' missed service level',
           'The first shipment was recorded after the deterministic service deadline.',
           scoped.shipped_at, scoped.location_id, scoped.location_label,
           floor(extract(epoch FROM (scoped.shipped_at - scoped.due_at)) / 60)::integer,
           NULL::bigint
         FROM scoped
         WHERE scoped.commercial AND scoped.shipped_at > scoped.due_at

         UNION ALL
         SELECT 'low-stock:' || inventory.product_id || ':' || inventory.location_id,
           inventory.product_id, 'low-stock',
           CASE WHEN inventory.on_hand_quantity - inventory.reserved_quantity <= 0
             THEN 'critical' ELSE 'warning' END,
           CASE WHEN inventory.on_hand_quantity - inventory.reserved_quantity <= 0
             THEN 3 ELSE 2 END,
           product.name || ' is at stock risk',
           'Available stock is at or below its reorder point and configured buffer.',
           coalesce(inventory.source_updated_at, inventory.updated_at),
           inventory.location_id, location.name, NULL::integer,
           inventory.on_hand_quantity - inventory.reserved_quantity
         FROM inventory
         JOIN products product ON product.organization_id = inventory.organization_id
           AND product.id = inventory.product_id
         JOIN locations location ON location.organization_id = inventory.organization_id
           AND location.id = inventory.location_id
         WHERE inventory.organization_id = ${parameters.organization}
           AND inventory.on_hand_quantity - inventory.reserved_quantity <=
             inventory.reorder_point + ${parameters.buffer}
           ${query.locationId ? `AND inventory.location_id = ${parameters.location}` : ''}

         UNION ALL
         SELECT 'cancellation:' || scoped.id, scoped.id, 'cancellation', 'warning', 2,
           'Order ' || scoped.order_number || ' was cancelled',
           'Review channel, inventory, and fulfilment context for the cancellation.',
           scoped.occurred_at, scoped.location_id, scoped.location_label,
           NULL::integer, NULL::bigint
         FROM scoped WHERE scoped.status = 'cancelled'

         UNION ALL
         SELECT 'return:' || returned.id, returned.id, 'return', 'info', 1,
           'Return requested for order ' || orders.order_number,
           'Track the return through receipt, rejection, or refund.',
           returned.requested_at, orders.location_id, location.name,
           floor(extract(epoch FROM (${parameters.now} - returned.requested_at)) / 60)::integer,
           NULL::bigint
         FROM returns returned
         JOIN orders ON orders.organization_id = returned.organization_id
           AND orders.id = returned.order_id
         LEFT JOIN locations location ON location.organization_id = orders.organization_id
           AND location.id = orders.location_id
         WHERE returned.organization_id = ${parameters.organization}
           AND returned.requested_at >= ${parameters.from}
           AND returned.requested_at < ${parameters.to}
           AND returned.status <> 'rejected'
           ${query.locationId ? `AND orders.location_id = ${parameters.location}` : ''}
       )
       SELECT id, entity_id AS "entityId", type, severity,
         severity_rank AS "severityRank", title, detail,
         occurred_at AS "occurredAt", location_id AS "locationId",
         location_label AS "locationLabel", age_minutes AS "ageMinutes", quantity
       FROM issues
       WHERE true ${typeFilter} ${severityFilter} ${cursorFilter}
       ORDER BY severity_rank DESC, occurred_at, id
       LIMIT ${parameters.add(query.pageSize + 1, 'integer')}`,
      parameters.values,
    );
    return result.rows;
  }

  private async backlogIssueRows(
    client: PoolClient,
    organizationId: string,
    query: OperationsIssueQuery,
    thresholds: OperationsThresholds,
    generatedAt: Date,
  ): Promise<IssueRow[]> {
    const parameters = new SqlParameters();
    const organization = parameters.add(organizationId, 'uuid');
    const from = parameters.add(`${query.from}T00:00:00.000Z`, 'timestamptz');
    const to = parameters.add(`${query.to}T00:00:00.000Z`, 'timestamptz');
    const warning = parameters.add(thresholds.backlogWarningMinutes, 'integer');
    const critical = parameters.add(
      thresholds.backlogCriticalMinutes,
      'integer',
    );
    const now = parameters.add(generatedAt, 'timestamptz');
    const locationFilter = query.locationId
      ? `AND orders.location_id = ${parameters.add(query.locationId, 'uuid')}`
      : '';
    const severityFilter = query.severity
      ? `AND issues.severity = ${parameters.add(query.severity)}`
      : '';
    const cursorFilter = issueCursorPredicate(query, parameters);
    const result = await client.query<IssueRow>(
      `WITH issues AS (
         SELECT 'backlog:' || orders.id AS id, orders.id AS entity_id,
           'backlog'::text AS type,
           CASE WHEN orders.occurred_at <= ${now} -
             ${critical} * interval '1 minute'
             THEN 'critical' ELSE 'warning' END AS severity,
           CASE WHEN orders.occurred_at <= ${now} -
             ${critical} * interval '1 minute'
             THEN 3 ELSE 2 END AS severity_rank,
           'Order ' || orders.order_number || ' is waiting to ship' AS title,
           'No shipment has been recorded before its service deadline.' AS detail,
           orders.occurred_at, orders.location_id,
           location.name AS location_label,
           floor(extract(epoch FROM (${now} - orders.occurred_at)) / 60)::integer
             AS age_minutes,
           NULL::bigint AS quantity
         FROM orders
         LEFT JOIN locations location
           ON location.organization_id = orders.organization_id
           AND location.id = orders.location_id
         WHERE orders.organization_id = ${organization}
           AND orders.occurred_at >= ${from}
           AND orders.occurred_at < ${to}
           AND orders.occurred_at <= ${now} -
             ${warning} * interval '1 minute'
           AND orders.status NOT IN ('cancelled', 'refunded')
           AND NOT EXISTS (
             SELECT 1 FROM fulfilments
             WHERE fulfilments.organization_id = orders.organization_id
               AND fulfilments.order_id = orders.id
               AND fulfilments.status <> 'cancelled'
               AND fulfilments.shipped_at IS NOT NULL
           )
           ${locationFilter}
       )
       SELECT id, entity_id AS "entityId", type, severity,
         severity_rank AS "severityRank", title, detail,
         occurred_at AS "occurredAt", location_id AS "locationId",
         location_label AS "locationLabel", age_minutes AS "ageMinutes", quantity
       FROM issues
       WHERE true ${severityFilter} ${cursorFilter}
       ORDER BY severity_rank DESC, occurred_at, id
       LIMIT ${parameters.add(query.pageSize + 1, 'integer')}`,
      parameters.values,
    );
    return result.rows;
  }
}

function operationalOrders(
  parameters: CommonParameters,
  locationPredicateSql: string,
): string {
  return `SELECT orders.id, orders.order_number, orders.status,
      orders.occurred_at, orders.location_id, location.name AS location_label,
      ${parameters.warning}::integer AS warning_minutes,
      ${parameters.critical}::integer AS critical_minutes,
      ${parameters.buffer}::bigint AS low_stock_buffer,
      ${parameters.now}::timestamptz AS generated_at,
      orders.status NOT IN ('cancelled', 'refunded') AS commercial,
      shipment.shipped_at,
      (
        ((orders.occurred_at AT TIME ZONE coalesce(zone.name, ${parameters.timezone}))::date
          + CASE WHEN (orders.occurred_at AT TIME ZONE
              coalesce(zone.name, ${parameters.timezone}))::time > ${parameters.cutoff}::time
            THEN 1 ELSE 0 END
          + ${parameters.cutoff}::time)
          AT TIME ZONE coalesce(zone.name, ${parameters.timezone})
        + ${parameters.target} * interval '1 minute'
      ) AS due_at,
      EXISTS (
        SELECT 1 FROM returns returned
        WHERE returned.organization_id = orders.organization_id
          AND returned.order_id = orders.id AND returned.status <> 'rejected'
      ) AS has_return
    FROM orders
    LEFT JOIN locations location ON location.organization_id = orders.organization_id
      AND location.id = orders.location_id
    LEFT JOIN pg_timezone_names zone ON zone.name = location.timezone
    LEFT JOIN LATERAL (
      SELECT min(shipped_at) AS shipped_at FROM fulfilments
      WHERE organization_id = orders.organization_id AND order_id = orders.id
        AND status <> 'cancelled' AND shipped_at IS NOT NULL
    ) shipment ON true
    WHERE orders.organization_id = ${parameters.organization}
      AND orders.occurred_at >= ${parameters.from}
      AND orders.occurred_at < ${parameters.to}
      ${locationPredicateSql}`;
}

class SqlParameters {
  readonly values: unknown[] = [];

  add(value: unknown, cast?: string): string {
    this.values.push(value);
    return `$${this.values.length}${cast ? `::${cast}` : ''}`;
  }
}

interface CommonParameters extends SqlParameters {
  buffer: string;
  critical: string;
  cutoff: string;
  from: string;
  location?: string;
  now: string;
  organization: string;
  target: string;
  timezone: string;
  to: string;
  warning: string;
}

function commonParameters(
  organizationId: string,
  filters: OperationsFilters,
  thresholds: OperationsThresholds,
  generatedAt: Date,
): CommonParameters {
  const parameters = new SqlParameters() as CommonParameters;
  parameters.organization = parameters.add(organizationId, 'uuid');
  parameters.from = parameters.add(
    `${filters.from}T00:00:00.000Z`,
    'timestamptz',
  );
  parameters.to = parameters.add(`${filters.to}T00:00:00.000Z`, 'timestamptz');
  parameters.timezone = parameters.add(thresholds.timezone);
  parameters.cutoff = parameters.add(thresholds.cutoffLocalTime);
  parameters.target = parameters.add(
    thresholds.fulfilmentTargetMinutes,
    'integer',
  );
  parameters.warning = parameters.add(
    thresholds.backlogWarningMinutes,
    'integer',
  );
  parameters.critical = parameters.add(
    thresholds.backlogCriticalMinutes,
    'integer',
  );
  parameters.buffer = parameters.add(
    thresholds.lowStockBufferQuantity,
    'bigint',
  );
  parameters.now = parameters.add(generatedAt, 'timestamptz');
  if (filters.locationId) {
    parameters.location = parameters.add(filters.locationId, 'uuid');
  }
  return parameters;
}

function locationPredicate(
  filters: OperationsFilters,
  parameters: CommonParameters,
): string {
  return filters.locationId && parameters.location
    ? `AND orders.location_id = ${parameters.location}`
    : '';
}

function issueCursorPredicate(
  query: OperationsIssueQuery,
  parameters: SqlParameters,
): string {
  if (!query.cursor) return '';
  const cursor = decodeCursor(query.cursor, query);
  const rank = parameters.add(cursor.severityRank, 'integer');
  const occurredAt = parameters.add(cursor.occurredAt, 'timestamptz');
  const id = parameters.add(cursor.id);
  return `AND (
    issues.severity_rank < ${rank}
    OR (issues.severity_rank = ${rank} AND issues.occurred_at > ${occurredAt})
    OR (issues.severity_rank = ${rank} AND issues.occurred_at = ${occurredAt}
      AND issues.id > ${id})
  )`;
}

function mapThreshold(row: ThresholdRow): OperationsThresholds {
  return compact({
    backlogCriticalMinutes: row.backlogCriticalMinutes,
    backlogWarningMinutes: row.backlogWarningMinutes,
    cancellationWarningBasisPoints: row.cancellationWarningBasisPoints,
    cutoffLocalTime: row.cutoffLocalTime.slice(0, 5),
    dataStaleAfterMinutes: row.dataStaleAfterMinutes,
    fulfilmentTargetMinutes: row.fulfilmentTargetMinutes,
    lowStockBufferQuantity: row.lowStockBufferQuantity,
    returnWarningBasisPoints: row.returnWarningBasisPoints,
    timezone: row.timezone,
    updatedAt: row.updatedAt ? iso(row.updatedAt) : undefined,
  });
}

function mapLocation(
  row: LocationRow,
  thresholds: OperationsThresholds,
  generatedAt: Date,
): OperationsLocationSummary {
  return compact({
    averageFulfilmentLeadMinutes: row.averageFulfilmentLeadMinutes,
    backlogCount: Number(row.backlogCount),
    id: row.id ?? undefined,
    label: row.label,
    lowStockCount: Number(row.lowStockCount),
    overdueCount: Number(row.overdueCount),
    serviceLevelBasisPoints: row.serviceLevelBasisPoints,
    sourceStatus: sourceStatus(
      row.sourceLastReceivedAt,
      generatedAt,
      thresholds.dataStaleAfterMinutes,
    ),
    timezone: row.timezone,
  });
}

function mapIssue(row: IssueRow): OperationsIssue {
  return compact({
    ageMinutes: row.ageMinutes ?? undefined,
    detail: row.detail,
    entityId: row.entityId,
    id: row.id,
    location:
      row.locationId && row.locationLabel
        ? { id: row.locationId, label: row.locationLabel }
        : undefined,
    occurredAt: iso(row.occurredAt),
    quantity: row.quantity ?? undefined,
    severity: row.severity,
    title: row.title,
    type: row.type,
  });
}

function buildAlerts(
  kpis: OperationsKpis,
  rows: LocationRow[],
  thresholds: OperationsThresholds,
  acknowledgements: Map<string, string>,
): OperationsAlert[] {
  const alerts: OperationsAlert[] = [];
  for (const row of rows) {
    const location = row.id ? { id: row.id, label: row.label } : undefined;
    const suffix = row.id ?? 'unassigned';
    const critical = Number(row.criticalBacklogCount);
    const backlog = Number(row.backlogCount);
    if (backlog) {
      alerts.push(
        alert({
          acknowledgements,
          actionLabel: 'Review backlog',
          count: backlog,
          key: `backlog:${suffix}:${critical ? 'critical' : 'warning'}`,
          location,
          message: critical
            ? `${critical} orders have exceeded the critical backlog age.`
            : 'Orders are waiting beyond the configured warning age.',
          severity: critical ? 'critical' : 'warning',
          title: `Backlog risk at ${row.label}`,
          type: 'backlog',
        }),
      );
    }
    const lowStock = Number(row.lowStockCount);
    if (lowStock) {
      const out = Number(row.outOfStockCount);
      alerts.push(
        alert({
          acknowledgements,
          actionLabel: 'Review stock risk',
          count: lowStock,
          key: `low-stock:${suffix}:${out ? 'critical' : 'warning'}`,
          location,
          message: out
            ? `${out} stock positions have no available quantity.`
            : 'Available stock is at or below its configured reorder risk.',
          severity: out ? 'critical' : 'warning',
          title: `Low-stock risk at ${row.label}`,
          type: 'low-stock',
        }),
      );
    }
    const late = Number(row.lateCount);
    if (late) {
      alerts.push(
        alert({
          acknowledgements,
          actionLabel: 'Review service misses',
          count: late,
          key: `late-fulfilment:${suffix}:warning`,
          location,
          message: 'Shipments crossed their timezone-aware service deadline.',
          severity: 'warning',
          title: `Service-level misses at ${row.label}`,
          type: 'late-fulfilment',
        }),
      );
    }
  }
  if (
    kpis.cancellationRateBasisPoints >=
    thresholds.cancellationWarningBasisPoints
  ) {
    alerts.push(
      alert({
        acknowledgements,
        actionLabel: 'Review cancellations',
        count: kpis.cancellationRateBasisPoints,
        key: 'cancellation:organization:warning',
        message: `Cancellation rate is ${percent(kpis.cancellationRateBasisPoints)}, at or above the configured threshold.`,
        severity: 'warning',
        title: 'Cancellation rate needs attention',
        type: 'cancellation',
      }),
    );
  }
  if (kpis.returnRateBasisPoints >= thresholds.returnWarningBasisPoints) {
    alerts.push(
      alert({
        acknowledgements,
        actionLabel: 'Review returns',
        count: kpis.returnRateBasisPoints,
        key: 'return:organization:warning',
        message: `Return rate is ${percent(kpis.returnRateBasisPoints)}, at or above the configured threshold.`,
        severity: 'warning',
        title: 'Return rate needs attention',
        type: 'return',
      }),
    );
  }
  return alerts.sort(
    (left, right) => severityRank(right.severity) - severityRank(left.severity),
  );
}

function alert(
  input: Omit<OperationsAlert, 'acknowledgedAt' | 'query' | 'status'> & {
    acknowledgements: Map<string, string>;
  },
): OperationsAlert {
  const acknowledgedAt = input.acknowledgements.get(input.key);
  return compact({
    acknowledgedAt,
    actionLabel: input.actionLabel,
    count: input.count,
    key: input.key,
    location: input.location,
    message: input.message,
    query: {
      issueType: input.type,
      locationId: input.location?.id,
      severity: input.severity,
    },
    severity: input.severity,
    status: acknowledgedAt ? ('acknowledged' as const) : ('active' as const),
    title: input.title,
    type: input.type,
  });
}

function sourceHealth(
  source: OperationsSourceHealth['source'],
  lastReceivedAt: Date | null,
  generatedAt: Date,
  thresholds: OperationsThresholds,
): OperationsSourceHealth {
  return compact({
    lastReceivedAt: lastReceivedAt ? iso(lastReceivedAt) : undefined,
    source,
    status: sourceStatus(
      lastReceivedAt,
      generatedAt,
      thresholds.dataStaleAfterMinutes,
    ),
  });
}

function sourceStatus(
  lastReceivedAt: Date | null,
  generatedAt: Date,
  staleMinutes: number,
): OperationsSourceHealth['status'] {
  if (!lastReceivedAt) return 'missing';
  return generatedAt.getTime() - lastReceivedAt.getTime() >
    staleMinutes * 60_000
    ? 'delayed'
    : 'current';
}

function issueFilters(query: OperationsIssueQuery): OperationsFilters {
  return compact({
    from: query.from,
    issueType: query.issueType,
    locationId: query.locationId,
    severity: query.severity,
    to: query.to,
  });
}

function encodeCursor(row: IssueRow, query: OperationsIssueQuery): string {
  return Buffer.from(
    JSON.stringify({
      filterHash: filterHash(issueFilters(query)),
      id: row.id,
      occurredAt: iso(row.occurredAt),
      severityRank: row.severityRank,
    } satisfies IssueCursor),
  ).toString('base64url');
}

function decodeCursor(value: string, query: OperationsIssueQuery): IssueCursor {
  try {
    const cursor = issueCursorSchema.parse(
      JSON.parse(Buffer.from(value, 'base64url').toString('utf8')),
    );
    if (cursor.filterHash !== filterHash(issueFilters(query))) {
      throw new Error('Cursor context changed');
    }
    return cursor;
  } catch {
    throw new BadRequestException({
      code: 'OPERATIONS_CURSOR_INVALID',
      message: 'The issue page cursor is invalid for these filters',
    });
  }
}

function filterHash(filters: OperationsFilters): string {
  const entries = Object.entries(filters).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return createHash('sha256')
    .update(JSON.stringify(Object.fromEntries(entries)))
    .digest('hex');
}

function severityRank(severity: OperationsSeverity): number {
  return { critical: 3, info: 1, warning: 2 }[severity];
}

function percent(basisPoints: number): string {
  return `${(basisPoints / 100).toFixed(1)}%`;
}

async function databaseNow(client: PoolClient): Promise<Date> {
  const result = await client.query<{ now: Date }>(
    'SELECT transaction_timestamp() AS now',
  );
  return required(result.rows[0], 'database clock').now;
}

function auditAlert(
  client: PoolClient,
  organizationId: string,
  actorUserId: string,
  alertKey: string,
  action: 'acknowledged' | 'reopened',
): Promise<unknown> {
  return client.query(
    `INSERT INTO audit_events (
       organization_id, actor_user_id, event_type, target_type, target_id
     ) VALUES ($1, $2, $3, 'operations_alert', $4)`,
    [organizationId, actorUserId, `operations.alert_${action}`, alertKey],
  );
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
  if (value === null || value === undefined)
    throw new Error(`Missing ${label}`);
  return value;
}
