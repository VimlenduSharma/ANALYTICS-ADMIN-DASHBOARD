export const dependencyNames = ['postgres', 'redis'] as const;

export type DependencyName = (typeof dependencyNames)[number];
export type ServiceStatus = 'ok' | 'degraded';
export type DependencyStatus = 'up' | 'down';

export interface DependencyHealth {
  latencyMs: number;
  status: DependencyStatus;
}

export interface HealthResponse {
  dependencies?: Record<DependencyName, DependencyHealth>;
  service: 'analytics-api';
  status: ServiceStatus;
  timestamp: string;
  uptimeSeconds: number;
  version: string;
}

export interface ApiError {
  code: string;
  details?: Record<string, unknown>;
  message: string;
  requestId: string;
}

export const organizationRoles = [
  'OWNER',
  'ADMIN',
  'ANALYST',
  'VIEWER',
] as const;

export type OrganizationRole = (typeof organizationRoles)[number];

export interface IdentityUser {
  avatarUrl?: string;
  displayName: string;
  email: string;
  id: string;
}

export interface OrganizationAccess {
  id: string;
  name: string;
  role: OrganizationRole;
  slug: string;
}

export type SessionResponse =
  | {
      authenticated: false;
      loginAvailable: boolean;
    }
  | {
      authenticated: true;
      csrfToken: string;
      organizations: OrganizationAccess[];
      user: IdentityUser;
    };

export interface CreateOrganizationRequest {
  name: string;
}

export interface AddTeamMemberRequest {
  email: string;
  role: Exclude<OrganizationRole, 'OWNER'>;
}

export interface UpdateTeamMemberRequest {
  role: OrganizationRole;
}

export interface TeamMember {
  displayName: string;
  email: string;
  joinedAt: string;
  role: OrganizationRole;
  userId: string;
}

export interface TeamResponse {
  members: TeamMember[];
  organization: Pick<OrganizationAccess, 'id' | 'name' | 'slug'>;
}

export interface AuditEventSummary {
  actorDisplayName?: string;
  createdAt: string;
  eventType: string;
  id: string;
  targetId?: string;
  targetType?: string;
}

export type GovernanceJobType =
  'privacy-delete' | 'privacy-export' | 'retention';
export type GovernanceJobStatus =
  'queued' | 'processing' | 'completed' | 'failed';

export interface UserProfile {
  displayName: string;
  email: string;
  locale: string;
  timezone: string;
}

export interface OrganizationGovernanceSettings {
  auditRetentionDays: number;
  exportRetentionHours: number;
  name: string;
  operationalDataRetentionDays: number;
  privacyExportRetentionHours: number;
  reportingTimezone: string;
  slug: string;
  updatedAt?: string;
  weekStartsOn: number;
}

export interface OrganizationInvitation {
  acceptedAt?: string;
  createdAt: string;
  email: string;
  expiresAt: string;
  id: string;
  role: Exclude<OrganizationRole, 'OWNER'>;
  status: 'accepted' | 'expired' | 'pending' | 'revoked';
}

export interface CreatedOrganizationInvitation extends OrganizationInvitation {
  acceptancePath: string;
}

export interface GovernanceDataSource {
  credentialRotatedAt?: string;
  eventCount: number;
  id: string;
  kind: 'csv' | 'inventory-api' | 'orders-api' | 'orders-webhook';
  lastReceivedAt?: string;
  name: string;
  status: 'active' | 'revoked' | 'waiting';
}

export interface CreatedIntegrationCredential {
  path: string;
  secret: string;
  source: GovernanceDataSource;
}

export interface GovernanceJob {
  completedAt?: string;
  createdAt: string;
  downloadReady: boolean;
  expiresAt?: string;
  failureCode?: string;
  id: string;
  processedCount: number;
  requestedByDisplayName: string;
  status: GovernanceJobStatus;
  subjectExternalId?: string;
  type: GovernanceJobType;
}

export interface GovernanceOverview {
  invitations: OrganizationInvitation[];
  jobs: GovernanceJob[];
  settings: OrganizationGovernanceSettings;
  sources: GovernanceDataSource[];
}

export interface GovernanceAuditEvent extends AuditEventSummary {
  metadata: Record<string, unknown>;
}

export interface GovernanceAuditResponse {
  filters: {
    actorUserId?: string;
    eventType?: string;
    from?: string;
    to?: string;
  };
  items: GovernanceAuditEvent[];
  pageInfo: {
    hasNextPage: boolean;
    nextCursor?: string;
    pageSize: number;
  };
}

export const salesOrderStatuses = [
  'pending',
  'confirmed',
  'fulfilled',
  'cancelled',
  'refunded',
] as const;

export type SalesOrderStatus = (typeof salesOrderStatuses)[number];
export type SalesSort = 'occurredAt' | 'orderNumber' | 'revenue' | 'status';
export type SortDirection = 'asc' | 'desc';

export interface SalesFilters {
  channelId?: string;
  currency?: string;
  from: string;
  locationId?: string;
  productId?: string;
  query?: string;
  status?: SalesOrderStatus;
  to: string;
}

export interface SalesMetricComparison {
  changeBasisPoints: number | null;
  current: string;
  previous: string;
}

export interface SalesKpis {
  averageOrderValueMinor: SalesMetricComparison;
  itemsSold: SalesMetricComparison;
  orderCount: SalesMetricComparison;
  revenueMinor: SalesMetricComparison;
}

export interface SalesTrendPoint {
  averageOrderValueMinor: string;
  bucketStart: string;
  orderCount: number;
  revenueMinor: string;
}

export interface SalesSegment {
  id?: string;
  label: string;
  orderCount: number;
  revenueMinor: string;
  shareBasisPoints: number;
}

export interface ProductSalesSegment extends SalesSegment {
  sku: string;
}

export type SalesFreshnessStatus = 'empty' | 'fresh' | 'partial' | 'stale';

export interface SalesFreshness {
  dataThrough?: string;
  failedImportCount: number;
  generatedAt: string;
  latestIngestedAt?: string;
  pendingImportCount: number;
  status: SalesFreshnessStatus;
}

export interface MetricDefinition {
  description: string;
  id: 'average-order-value' | 'items-sold' | 'net-revenue' | 'orders';
  label: string;
}

export interface SalesOverviewResponse {
  channels: SalesSegment[];
  currency?: string;
  definitions: MetricDefinition[];
  filters: SalesFilters;
  freshness: SalesFreshness;
  granularity: 'day' | 'month' | 'week';
  kpis: SalesKpis;
  locations: SalesSegment[];
  products: ProductSalesSegment[];
  trend: SalesTrendPoint[];
}

export interface SalesFilterOption {
  id: string;
  label: string;
}

export interface ProductFilterOption extends SalesFilterOption {
  sku: string;
}

export interface SalesFilterOptionsResponse {
  channels: SalesFilterOption[];
  currencies: string[];
  locations: SalesFilterOption[];
  products: ProductFilterOption[];
}

export interface SalesOrderSummary {
  channel: SalesFilterOption;
  currency: string;
  id: string;
  itemCount: number;
  location?: SalesFilterOption;
  netRevenueMinor: string;
  occurredAt: string;
  orderNumber: string;
  refundedMinor: string;
  status: SalesOrderStatus;
  totalMinor: string;
}

export interface SalesOrdersResponse {
  filters: SalesFilters;
  items: SalesOrderSummary[];
  pageInfo: {
    hasNextPage: boolean;
    nextCursor?: string;
    pageSize: number;
  };
  sort: {
    direction: SortDirection;
    field: SalesSort;
  };
}

export interface SalesOrderItem {
  id: string;
  name: string;
  quantity: number;
  sku: string;
  totalMinor: string;
  unitPriceMinor: string;
}

export interface SalesOrderDetail extends SalesOrderSummary {
  customerReference?: string;
  discountMinor: string;
  fulfilments: Array<{
    carrier?: string;
    deliveredAt?: string;
    id: string;
    shippedAt?: string;
    status: string;
    trackingReference?: string;
  }>;
  items: SalesOrderItem[];
  payment?: {
    capturedMinor: string;
    refundedMinor: string;
    status: string;
  };
  returns: Array<{
    amountMinor: string;
    id: string;
    requestedAt: string;
    status: string;
  }>;
  shippingMinor: string;
  subtotalMinor: string;
  taxMinor: string;
}

export type SalesExportStatus =
  'queued' | 'processing' | 'completed' | 'failed';

export interface SalesExportJob {
  completedAt?: string;
  createdAt: string;
  downloadReady: boolean;
  expiresAt?: string;
  failureCode?: string;
  id: string;
  rowCount: number;
  status: SalesExportStatus;
}

export const operationsIssueTypes = [
  'backlog',
  'late-fulfilment',
  'low-stock',
  'cancellation',
  'return',
] as const;

export const operationsSeverities = ['critical', 'warning', 'info'] as const;

export type OperationsIssueType = (typeof operationsIssueTypes)[number];
export type OperationsSeverity = (typeof operationsSeverities)[number];
export type OperationsSourceStatus = 'current' | 'delayed' | 'missing';

export interface OperationsFilters {
  from: string;
  issueType?: OperationsIssueType;
  locationId?: string;
  severity?: OperationsSeverity;
  to: string;
}

export interface OperationsThresholds {
  backlogCriticalMinutes: number;
  backlogWarningMinutes: number;
  cancellationWarningBasisPoints: number;
  cutoffLocalTime: string;
  dataStaleAfterMinutes: number;
  fulfilmentTargetMinutes: number;
  lowStockBufferQuantity: string;
  returnWarningBasisPoints: number;
  timezone: string;
  updatedAt?: string;
}

export interface OperationsSourceHealth {
  lastReceivedAt?: string;
  source: 'fulfilments' | 'inventory' | 'orders';
  status: OperationsSourceStatus;
}

export interface OperationsHealth {
  failedImportCount: number;
  generatedAt: string;
  pendingImportCount: number;
  sources: OperationsSourceHealth[];
  status: 'delayed' | 'empty' | 'healthy' | 'missing' | 'partial';
}

export interface OperationsKpis {
  averageFulfilmentLeadMinutes: number | null;
  backlogCount: number;
  cancellationRateBasisPoints: number;
  lowStockCount: number;
  returnRateBasisPoints: number;
  serviceLevelBasisPoints: number | null;
  stockOnHandQuantity: string;
}

export interface OperationsAlert {
  acknowledgedAt?: string;
  actionLabel: string;
  count: number;
  key: string;
  location?: SalesFilterOption;
  message: string;
  query: Pick<OperationsFilters, 'issueType' | 'locationId' | 'severity'>;
  severity: OperationsSeverity;
  status: 'acknowledged' | 'active';
  title: string;
  type: OperationsIssueType;
}

export interface OperationsLocationSummary {
  averageFulfilmentLeadMinutes: number | null;
  backlogCount: number;
  id?: string;
  label: string;
  lowStockCount: number;
  overdueCount: number;
  serviceLevelBasisPoints: number | null;
  sourceStatus: OperationsSourceStatus;
  timezone: string;
}

export interface OperationsOverviewResponse {
  alerts: OperationsAlert[];
  filters: OperationsFilters;
  health: OperationsHealth;
  kpis: OperationsKpis;
  locations: OperationsLocationSummary[];
  thresholds: OperationsThresholds;
}

export interface OperationsIssue {
  ageMinutes?: number;
  detail: string;
  entityId: string;
  id: string;
  location?: SalesFilterOption;
  occurredAt?: string;
  quantity?: string;
  severity: OperationsSeverity;
  title: string;
  type: OperationsIssueType;
}

export interface OperationsIssuesResponse {
  filters: OperationsFilters;
  items: OperationsIssue[];
  pageInfo: {
    hasNextPage: boolean;
    nextCursor?: string;
    pageSize: number;
  };
}

export interface InventorySnapshotRequest {
  location: {
    countryCode?: string;
    externalId: string;
    kind?: 'other' | 'store' | 'virtual' | 'warehouse';
    name: string;
    timezone?: string;
  };
  onHandQuantity: number;
  product: {
    externalId: string;
    name: string;
    sku: string;
  };
  reorderPoint: number;
  reservedQuantity?: number;
  sourceUpdatedAt: string;
}

export interface InventoryIngestionResult {
  locationId: string;
  productId: string;
  status: 'accepted';
}
