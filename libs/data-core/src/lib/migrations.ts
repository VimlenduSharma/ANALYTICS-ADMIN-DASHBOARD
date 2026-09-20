export interface Migration {
  down: string;
  id: string;
  up: string;
}

const identityMigration: Migration = {
  id: '20260903_001_identity',
  up: `
    CREATE TABLE identity_users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      issuer text NOT NULL,
      subject text NOT NULL,
      email text NOT NULL,
      email_normalized text GENERATED ALWAYS AS (lower(email)) STORED,
      display_name text NOT NULL,
      avatar_url text,
      last_login_at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT identity_users_issuer_subject_unique UNIQUE (issuer, subject),
      CONSTRAINT identity_users_email_unique UNIQUE (email_normalized),
      CONSTRAINT identity_users_email_length CHECK (char_length(email) BETWEEN 3 AND 320),
      CONSTRAINT identity_users_display_name_length CHECK (char_length(display_name) BETWEEN 1 AND 120)
    );

    CREATE TABLE organizations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      slug text NOT NULL UNIQUE,
      name text NOT NULL,
      status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
      created_by_user_id uuid NOT NULL REFERENCES identity_users(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT organizations_name_length CHECK (char_length(name) BETWEEN 2 AND 100),
      CONSTRAINT organizations_slug_format CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$')
    );

    CREATE TABLE organization_memberships (
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES identity_users(id) ON DELETE RESTRICT,
      role text NOT NULL CHECK (role IN ('OWNER', 'ADMIN', 'ANALYST', 'VIEWER')),
      joined_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      created_by_user_id uuid REFERENCES identity_users(id),
      PRIMARY KEY (organization_id, user_id)
    );
    CREATE INDEX organization_memberships_user_idx
      ON organization_memberships (user_id, organization_id);

    CREATE TABLE audit_events (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      organization_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
      actor_user_id uuid REFERENCES identity_users(id) ON DELETE SET NULL,
      event_type text NOT NULL,
      target_type text,
      target_id text,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX audit_events_organization_created_idx
      ON audit_events (organization_id, created_at DESC, id DESC);
    CREATE INDEX audit_events_actor_created_idx
      ON audit_events (actor_user_id, created_at DESC);
  `,
  down: `
    DROP TABLE audit_events;
    DROP TABLE organization_memberships;
    DROP TABLE organizations;
    DROP TABLE identity_users;
  `,
};

const dataCoreMigration: Migration = {
  id: '20260903_002_data_core',
  up: `
    CREATE FUNCTION app_current_organization_id() RETURNS uuid
    LANGUAGE sql STABLE PARALLEL SAFE
    RETURN nullif(current_setting('app.organization_id', true), '')::uuid;

    CREATE TABLE channels (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      external_id text NOT NULL CHECK (char_length(external_id) BETWEEN 1 AND 160),
      name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
      kind text NOT NULL CHECK (kind IN ('marketplace', 'storefront', 'pos', 'wholesale', 'other')),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (id, organization_id),
      CONSTRAINT channels_external_unique UNIQUE (organization_id, external_id)
    );

    CREATE TABLE locations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      external_id text NOT NULL CHECK (char_length(external_id) BETWEEN 1 AND 160),
      name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
      kind text NOT NULL DEFAULT 'warehouse' CHECK (kind IN ('warehouse', 'store', 'virtual', 'other')),
      timezone text NOT NULL DEFAULT 'UTC',
      country_code char(2) CHECK (country_code IS NULL OR country_code ~ '^[A-Z]{2}$'),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (id, organization_id),
      CONSTRAINT locations_external_unique UNIQUE (organization_id, external_id)
    );

    CREATE TABLE products (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      external_id text NOT NULL,
      sku text NOT NULL,
      name text NOT NULL,
      status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
      unit_cost_minor bigint CHECK (unit_cost_minor IS NULL OR unit_cost_minor >= 0),
      currency char(3) CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (id, organization_id),
      CONSTRAINT products_external_unique UNIQUE (organization_id, external_id),
      CONSTRAINT products_sku_unique UNIQUE (organization_id, sku)
    );

    CREATE TABLE inventory (
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      product_id uuid NOT NULL,
      location_id uuid NOT NULL,
      on_hand_quantity bigint NOT NULL DEFAULT 0 CHECK (on_hand_quantity >= 0),
      reserved_quantity bigint NOT NULL DEFAULT 0 CHECK (reserved_quantity >= 0),
      reorder_point bigint NOT NULL DEFAULT 0 CHECK (reorder_point >= 0),
      source_updated_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (organization_id, product_id, location_id),
      FOREIGN KEY (product_id, organization_id) REFERENCES products(id, organization_id) ON DELETE CASCADE,
      FOREIGN KEY (location_id, organization_id) REFERENCES locations(id, organization_id) ON DELETE CASCADE,
      CONSTRAINT inventory_reserved_within_stock CHECK (reserved_quantity <= on_hand_quantity)
    );
    CREATE INDEX inventory_location_idx
      ON inventory (organization_id, location_id, product_id);

    CREATE TABLE customer_references (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      external_id text NOT NULL,
      country_code char(2) CHECK (country_code IS NULL OR country_code ~ '^[A-Z]{2}$'),
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (id, organization_id),
      CONSTRAINT customer_references_external_unique UNIQUE (organization_id, external_id)
    );

    CREATE TABLE orders (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      channel_id uuid NOT NULL,
      location_id uuid,
      customer_reference_id uuid,
      external_id text NOT NULL,
      order_number text NOT NULL,
      status text NOT NULL CHECK (status IN ('pending', 'confirmed', 'fulfilled', 'cancelled', 'refunded')),
      currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
      subtotal_minor bigint NOT NULL CHECK (subtotal_minor >= 0),
      discount_minor bigint NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
      tax_minor bigint NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
      shipping_minor bigint NOT NULL DEFAULT 0 CHECK (shipping_minor >= 0),
      total_minor bigint NOT NULL CHECK (total_minor >= 0),
      occurred_at timestamptz NOT NULL,
      source_updated_at timestamptz,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (id, organization_id),
      CONSTRAINT orders_source_unique UNIQUE (organization_id, channel_id, external_id),
      FOREIGN KEY (channel_id, organization_id) REFERENCES channels(id, organization_id) ON DELETE RESTRICT,
      FOREIGN KEY (location_id, organization_id) REFERENCES locations(id, organization_id) ON DELETE RESTRICT,
      FOREIGN KEY (customer_reference_id, organization_id) REFERENCES customer_references(id, organization_id) ON DELETE RESTRICT,
      CONSTRAINT orders_total_matches CHECK (
        total_minor = subtotal_minor - discount_minor + tax_minor + shipping_minor
      )
    );
    CREATE INDEX orders_timeline_idx
      ON orders (organization_id, occurred_at DESC, id DESC);
    CREATE INDEX orders_status_timeline_idx
      ON orders (organization_id, status, occurred_at DESC);
    CREATE INDEX orders_customer_idx
      ON orders (organization_id, customer_reference_id, occurred_at DESC)
      WHERE customer_reference_id IS NOT NULL;

    CREATE TABLE order_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      order_id uuid NOT NULL,
      product_id uuid NOT NULL,
      external_id text NOT NULL,
      sku text NOT NULL,
      name text NOT NULL,
      quantity integer NOT NULL CHECK (quantity > 0),
      unit_price_minor bigint NOT NULL CHECK (unit_price_minor >= 0),
      discount_minor bigint NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
      tax_minor bigint NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
      total_minor bigint NOT NULL CHECK (total_minor >= 0),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (id, organization_id),
      CONSTRAINT order_items_source_unique UNIQUE (organization_id, order_id, external_id),
      FOREIGN KEY (order_id, organization_id) REFERENCES orders(id, organization_id) ON DELETE CASCADE,
      FOREIGN KEY (product_id, organization_id) REFERENCES products(id, organization_id) ON DELETE RESTRICT,
      CONSTRAINT order_items_total_matches CHECK (
        total_minor = quantity::bigint * unit_price_minor - discount_minor + tax_minor
      )
    );
    CREATE INDEX order_items_order_idx ON order_items (organization_id, order_id);
    CREATE INDEX order_items_product_idx ON order_items (organization_id, product_id, order_id);

    CREATE TABLE payment_summaries (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      order_id uuid NOT NULL,
      status text NOT NULL CHECK (status IN ('pending', 'authorized', 'captured', 'partially_refunded', 'refunded', 'failed')),
      currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
      authorized_minor bigint NOT NULL DEFAULT 0 CHECK (authorized_minor >= 0),
      captured_minor bigint NOT NULL DEFAULT 0 CHECK (captured_minor >= 0),
      refunded_minor bigint NOT NULL DEFAULT 0 CHECK (refunded_minor >= 0),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (id, organization_id),
      CONSTRAINT payment_summaries_order_unique UNIQUE (organization_id, order_id),
      FOREIGN KEY (order_id, organization_id) REFERENCES orders(id, organization_id) ON DELETE CASCADE,
      CONSTRAINT payment_refund_within_capture CHECK (refunded_minor <= captured_minor)
    );

    CREATE TABLE fulfilments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      order_id uuid NOT NULL,
      location_id uuid,
      external_id text NOT NULL,
      status text NOT NULL CHECK (status IN ('pending', 'processing', 'shipped', 'delivered', 'cancelled')),
      carrier text,
      tracking_reference text,
      shipped_at timestamptz,
      delivered_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (id, organization_id),
      CONSTRAINT fulfilments_source_unique UNIQUE (organization_id, order_id, external_id),
      FOREIGN KEY (order_id, organization_id) REFERENCES orders(id, organization_id) ON DELETE CASCADE,
      FOREIGN KEY (location_id, organization_id) REFERENCES locations(id, organization_id) ON DELETE RESTRICT,
      CONSTRAINT fulfilments_delivery_order CHECK (
        delivered_at IS NULL OR shipped_at IS NULL OR delivered_at >= shipped_at
      )
    );
    CREATE INDEX fulfilments_order_idx ON fulfilments (organization_id, order_id);

    CREATE TABLE returns (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      order_id uuid NOT NULL,
      external_id text NOT NULL,
      status text NOT NULL CHECK (status IN ('requested', 'approved', 'received', 'rejected', 'refunded')),
      amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
      currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
      requested_at timestamptz NOT NULL,
      received_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (id, organization_id),
      CONSTRAINT returns_source_unique UNIQUE (organization_id, order_id, external_id),
      FOREIGN KEY (order_id, organization_id) REFERENCES orders(id, organization_id) ON DELETE CASCADE,
      CONSTRAINT returns_received_order CHECK (received_at IS NULL OR received_at >= requested_at)
    );
    CREATE INDEX returns_order_idx ON returns (organization_id, order_id);

    CREATE TABLE data_imports (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      requested_by_user_id uuid NOT NULL REFERENCES identity_users(id) ON DELETE RESTRICT,
      idempotency_key text NOT NULL,
      filename text NOT NULL CHECK (char_length(filename) BETWEEN 1 AND 255),
      content_sha256 char(64) NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
      csv_payload text,
      status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
      total_rows integer NOT NULL DEFAULT 0 CHECK (total_rows >= 0),
      accepted_rows integer NOT NULL DEFAULT 0 CHECK (accepted_rows >= 0),
      rejected_rows integer NOT NULL DEFAULT 0 CHECK (rejected_rows >= 0),
      error_report jsonb NOT NULL DEFAULT '[]'::jsonb,
      attempts smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
      processing_started_at timestamptz,
      completed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (id, organization_id),
      CONSTRAINT data_imports_idempotency_unique UNIQUE (organization_id, idempotency_key),
      CONSTRAINT data_imports_payload_state CHECK (
        (status IN ('queued', 'processing') AND csv_payload IS NOT NULL)
        OR (status IN ('completed', 'failed') AND csv_payload IS NULL)
      )
    );
    CREATE INDEX data_imports_queue_idx
      ON data_imports (status, created_at, id)
      WHERE status IN ('queued', 'processing');
    CREATE INDEX data_imports_org_created_idx
      ON data_imports (organization_id, created_at DESC, id DESC);

    CREATE TABLE webhook_endpoints (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
      status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
      created_by_user_id uuid NOT NULL REFERENCES identity_users(id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      revoked_at timestamptz,
      UNIQUE (id, organization_id),
      CONSTRAINT webhook_endpoints_revocation_state CHECK (
        (status = 'active' AND revoked_at IS NULL)
        OR (status = 'revoked' AND revoked_at IS NOT NULL)
      )
    );
    CREATE INDEX webhook_endpoints_org_idx
      ON webhook_endpoints (organization_id, created_at DESC);

    CREATE TABLE ingestion_requests (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      source text NOT NULL CHECK (char_length(source) BETWEEN 1 AND 160),
      idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
      request_sha256 char(64) NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
      response jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      completed_at timestamptz,
      CONSTRAINT ingestion_requests_key_unique UNIQUE (organization_id, source, idempotency_key),
      CONSTRAINT ingestion_requests_completion_state CHECK (
        (response IS NULL AND completed_at IS NULL)
        OR (response IS NOT NULL AND completed_at IS NOT NULL)
      )
    );
    CREATE INDEX ingestion_requests_created_idx
      ON ingestion_requests (organization_id, created_at DESC);

    DO $policies$
    DECLARE secured_table text;
    BEGIN
      FOREACH secured_table IN ARRAY ARRAY[
        'channels', 'locations', 'products', 'inventory',
        'customer_references', 'orders', 'order_items', 'payment_summaries',
        'fulfilments', 'returns', 'data_imports', 'webhook_endpoints',
        'ingestion_requests'
      ] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', secured_table);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', secured_table);
        EXECUTE format(
          'CREATE POLICY %I ON %I USING (organization_id = app_current_organization_id()) WITH CHECK (organization_id = app_current_organization_id())',
          secured_table || '_tenant', secured_table
        );
      END LOOP;
    END
    $policies$;
  `,
  down: `
    DROP TABLE ingestion_requests;
    DROP TABLE webhook_endpoints;
    DROP TABLE data_imports;
    DROP TABLE returns;
    DROP TABLE fulfilments;
    DROP TABLE payment_summaries;
    DROP TABLE order_items;
    DROP TABLE orders;
    DROP TABLE customer_references;
    DROP TABLE inventory;
    DROP TABLE products;
    DROP TABLE locations;
    DROP TABLE channels;
    DROP FUNCTION app_current_organization_id();
  `,
};

const salesMigration: Migration = {
  id: '20260909_003_sales',
  up: `
    CREATE INDEX orders_sales_currency_timeline_idx
      ON orders (organization_id, currency, occurred_at DESC, id DESC)
      INCLUDE (channel_id, location_id, status, total_minor, order_number, updated_at);
    CREATE INDEX orders_sales_channel_timeline_idx
      ON orders (organization_id, channel_id, occurred_at DESC, id DESC);
    CREATE INDEX orders_sales_location_timeline_idx
      ON orders (organization_id, location_id, occurred_at DESC, id DESC)
      WHERE location_id IS NOT NULL;

    CREATE TABLE sales_exports (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      requested_by_user_id uuid NOT NULL REFERENCES identity_users(id) ON DELETE RESTRICT,
      idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
      request_sha256 char(64) NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
      filters jsonb NOT NULL CHECK (jsonb_typeof(filters) = 'object'),
      status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
      row_count integer NOT NULL DEFAULT 0 CHECK (row_count >= 0),
      csv_payload text,
      failure_code text,
      attempts smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
      processing_started_at timestamptz,
      completed_at timestamptz,
      expires_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (id, organization_id),
      CONSTRAINT sales_exports_idempotency_unique
        UNIQUE (organization_id, requested_by_user_id, idempotency_key),
      CONSTRAINT sales_exports_payload_state CHECK (
        (status IN ('queued', 'processing') AND csv_payload IS NULL AND completed_at IS NULL)
        OR (status = 'completed' AND csv_payload IS NOT NULL AND completed_at IS NOT NULL AND failure_code IS NULL)
        OR (status = 'failed' AND csv_payload IS NULL AND completed_at IS NOT NULL AND failure_code IS NOT NULL)
      ),
      CONSTRAINT sales_exports_expiry_state CHECK (
        (status = 'completed' AND expires_at IS NOT NULL)
        OR (status <> 'completed' AND expires_at IS NULL)
      )
    );
    CREATE INDEX sales_exports_queue_idx
      ON sales_exports (status, created_at, id)
      WHERE status IN ('queued', 'processing');
    CREATE INDEX sales_exports_user_created_idx
      ON sales_exports (organization_id, requested_by_user_id, created_at DESC, id DESC);

    ALTER TABLE sales_exports ENABLE ROW LEVEL SECURITY;
    ALTER TABLE sales_exports FORCE ROW LEVEL SECURITY;
    CREATE POLICY sales_exports_tenant ON sales_exports
      USING (organization_id = app_current_organization_id())
      WITH CHECK (organization_id = app_current_organization_id());
  `,
  down: `
    DROP TABLE sales_exports;
    DROP INDEX orders_sales_location_timeline_idx;
    DROP INDEX orders_sales_channel_timeline_idx;
    DROP INDEX orders_sales_currency_timeline_idx;
  `,
};

const salesQueueMigration: Migration = {
  id: '20260909_004_sales_export_dispatch',
  up: `
    CREATE TABLE sales_export_dispatch (
      organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
      available_at timestamptz NOT NULL DEFAULT now(),
      leased_until timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX sales_export_dispatch_available_idx
      ON sales_export_dispatch (available_at, organization_id)
      WHERE leased_until IS NULL;
  `,
  down: `
    DROP TABLE sales_export_dispatch;
  `,
};

const operationsMigration: Migration = {
  id: '20260912_005_operations',
  up: `
    CREATE FUNCTION app_valid_timezone(value text) RETURNS boolean
    LANGUAGE sql STABLE PARALLEL SAFE
    RETURN EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = value);

    CREATE TABLE operations_thresholds (
      organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
      timezone text NOT NULL DEFAULT 'UTC' CHECK (app_valid_timezone(timezone)),
      cutoff_local_time time NOT NULL DEFAULT '17:00',
      fulfilment_target_minutes integer NOT NULL DEFAULT 1440
        CHECK (fulfilment_target_minutes BETWEEN 60 AND 10080),
      backlog_warning_minutes integer NOT NULL DEFAULT 1440
        CHECK (backlog_warning_minutes BETWEEN 60 AND 43200),
      backlog_critical_minutes integer NOT NULL DEFAULT 2880
        CHECK (backlog_critical_minutes BETWEEN 120 AND 86400),
      cancellation_warning_basis_points integer NOT NULL DEFAULT 1000
        CHECK (cancellation_warning_basis_points BETWEEN 0 AND 10000),
      return_warning_basis_points integer NOT NULL DEFAULT 500
        CHECK (return_warning_basis_points BETWEEN 0 AND 10000),
      low_stock_buffer_quantity bigint NOT NULL DEFAULT 0
        CHECK (low_stock_buffer_quantity BETWEEN 0 AND 1000000000),
      data_stale_after_minutes integer NOT NULL DEFAULT 1440
        CHECK (data_stale_after_minutes BETWEEN 15 AND 43200),
      updated_by_user_id uuid REFERENCES identity_users(id) ON DELETE SET NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT operations_backlog_threshold_order
        CHECK (backlog_critical_minutes > backlog_warning_minutes)
    );

    CREATE TABLE operations_alert_acknowledgements (
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      alert_key text NOT NULL CHECK (char_length(alert_key) BETWEEN 3 AND 240),
      acknowledged_by_user_id uuid NOT NULL REFERENCES identity_users(id) ON DELETE RESTRICT,
      acknowledged_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (organization_id, alert_key)
    );
    CREATE INDEX operations_alert_acknowledgements_time_idx
      ON operations_alert_acknowledgements (organization_id, acknowledged_at DESC);

    CREATE INDEX orders_operations_location_status_idx
      ON orders (organization_id, location_id, status, occurred_at, id);
    CREATE INDEX fulfilments_operations_shipment_idx
      ON fulfilments (organization_id, order_id, shipped_at, status)
      INCLUDE (location_id, updated_at);
    CREATE INDEX returns_operations_requested_idx
      ON returns (organization_id, requested_at, order_id);
    CREATE INDEX inventory_operations_risk_idx
      ON inventory (
        organization_id,
        location_id,
        ((on_hand_quantity - reserved_quantity) - reorder_point),
        product_id
      );

    ALTER TABLE operations_thresholds ENABLE ROW LEVEL SECURITY;
    ALTER TABLE operations_thresholds FORCE ROW LEVEL SECURITY;
    CREATE POLICY operations_thresholds_tenant ON operations_thresholds
      USING (organization_id = app_current_organization_id())
      WITH CHECK (organization_id = app_current_organization_id());

    ALTER TABLE operations_alert_acknowledgements ENABLE ROW LEVEL SECURITY;
    ALTER TABLE operations_alert_acknowledgements FORCE ROW LEVEL SECURITY;
    CREATE POLICY operations_alert_acknowledgements_tenant
      ON operations_alert_acknowledgements
      USING (organization_id = app_current_organization_id())
      WITH CHECK (organization_id = app_current_organization_id());
  `,
  down: `
    DROP INDEX inventory_operations_risk_idx;
    DROP INDEX returns_operations_requested_idx;
    DROP INDEX fulfilments_operations_shipment_idx;
    DROP INDEX orders_operations_location_status_idx;
    DROP TABLE operations_alert_acknowledgements;
    DROP TABLE operations_thresholds;
    DROP FUNCTION app_valid_timezone(text);
  `,
};

const governanceMigration: Migration = {
  id: '20260912_006_governance',
  up: `
    ALTER TABLE identity_users
      ADD COLUMN timezone text NOT NULL DEFAULT 'UTC' CHECK (app_valid_timezone(timezone)),
      ADD COLUMN locale text NOT NULL DEFAULT 'en-US'
        CHECK (locale ~ '^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$');

    CREATE TABLE organization_governance_settings (
      organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
      reporting_timezone text NOT NULL DEFAULT 'UTC'
        CHECK (app_valid_timezone(reporting_timezone)),
      week_starts_on smallint NOT NULL DEFAULT 1 CHECK (week_starts_on BETWEEN 0 AND 6),
      operational_data_retention_days integer NOT NULL DEFAULT 730
        CHECK (operational_data_retention_days BETWEEN 30 AND 3650),
      audit_retention_days integer NOT NULL DEFAULT 730
        CHECK (audit_retention_days BETWEEN 30 AND 3650),
      export_retention_hours integer NOT NULL DEFAULT 24
        CHECK (export_retention_hours BETWEEN 1 AND 168),
      privacy_export_retention_hours integer NOT NULL DEFAULT 24
        CHECK (privacy_export_retention_hours BETWEEN 1 AND 168),
      updated_by_user_id uuid REFERENCES identity_users(id) ON DELETE SET NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE organization_invitations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      email text NOT NULL CHECK (char_length(email) BETWEEN 3 AND 320),
      email_normalized text GENERATED ALWAYS AS (lower(email)) STORED,
      role text NOT NULL CHECK (role IN ('ADMIN', 'ANALYST', 'VIEWER')),
      token_sha256 char(64) NOT NULL UNIQUE CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
      status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
      created_by_user_id uuid NOT NULL REFERENCES identity_users(id) ON DELETE RESTRICT,
      accepted_by_user_id uuid REFERENCES identity_users(id) ON DELETE SET NULL,
      revoked_by_user_id uuid REFERENCES identity_users(id) ON DELETE SET NULL,
      expires_at timestamptz NOT NULL,
      accepted_at timestamptz,
      revoked_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (id, organization_id),
      CONSTRAINT organization_invitations_terminal_state CHECK (
        (status = 'pending' AND accepted_at IS NULL AND revoked_at IS NULL)
        OR (status = 'accepted' AND accepted_at IS NOT NULL AND revoked_at IS NULL)
        OR (status = 'revoked' AND accepted_at IS NULL AND revoked_at IS NOT NULL)
        OR (status = 'expired' AND accepted_at IS NULL AND revoked_at IS NULL)
      )
    );
    CREATE UNIQUE INDEX organization_invitations_pending_email_idx
      ON organization_invitations (organization_id, email_normalized)
      WHERE status = 'pending';
    CREATE INDEX organization_invitations_org_created_idx
      ON organization_invitations (organization_id, created_at DESC, id DESC);

    ALTER TABLE webhook_endpoints
      ADD COLUMN credential_ciphertext bytea,
      ADD COLUMN credential_iv bytea,
      ADD COLUMN credential_auth_tag bytea,
      ADD COLUMN credential_version integer NOT NULL DEFAULT 0 CHECK (credential_version >= 0),
      ADD COLUMN credential_rotated_at timestamptz,
      ADD COLUMN last_received_at timestamptz,
      ADD CONSTRAINT webhook_endpoints_credential_state CHECK (
        (credential_version = 0 AND credential_ciphertext IS NULL
          AND credential_iv IS NULL AND credential_auth_tag IS NULL)
        OR (credential_version > 0 AND credential_ciphertext IS NOT NULL
          AND credential_iv IS NOT NULL AND credential_auth_tag IS NOT NULL
          AND credential_rotated_at IS NOT NULL)
      );

    CREATE TABLE governance_jobs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      type text NOT NULL CHECK (type IN ('retention', 'privacy-export', 'privacy-delete')),
      status text NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
      requested_by_user_id uuid NOT NULL REFERENCES identity_users(id) ON DELETE RESTRICT,
      subject_external_id text,
      idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
      request_sha256 char(64) NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
      checkpoint jsonb NOT NULL DEFAULT '{}'::jsonb,
      processed_count bigint NOT NULL DEFAULT 0 CHECK (processed_count >= 0),
      attempts smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
      processing_started_at timestamptz,
      completed_at timestamptz,
      failure_code text,
      expires_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (id, organization_id),
      CONSTRAINT governance_jobs_idempotency_unique
        UNIQUE (organization_id, requested_by_user_id, idempotency_key),
      CONSTRAINT governance_jobs_subject CHECK (
        (type = 'retention' AND subject_external_id IS NULL)
        OR (type IN ('privacy-export', 'privacy-delete')
          AND subject_external_id IS NOT NULL
          AND char_length(subject_external_id) BETWEEN 1 AND 160)
      ),
      CONSTRAINT governance_jobs_completion CHECK (
        (status IN ('queued', 'processing') AND completed_at IS NULL)
        OR (status IN ('completed', 'failed') AND completed_at IS NOT NULL)
      )
    );
    CREATE INDEX governance_jobs_org_created_idx
      ON governance_jobs (organization_id, created_at DESC, id DESC);
    CREATE INDEX governance_jobs_processing_idx
      ON governance_jobs (organization_id, status, processing_started_at, created_at, id)
      WHERE status IN ('queued', 'processing');
    CREATE UNIQUE INDEX governance_jobs_active_privacy_idx
      ON governance_jobs (organization_id, type, subject_external_id)
      WHERE type IN ('privacy-export', 'privacy-delete')
        AND status IN ('queued', 'processing');

    CREATE TABLE governance_job_artifacts (
      job_id uuid NOT NULL,
      organization_id uuid NOT NULL,
      chunk_index integer NOT NULL CHECK (chunk_index >= 0),
      ciphertext bytea NOT NULL,
      iv bytea NOT NULL CHECK (octet_length(iv) = 12),
      auth_tag bytea NOT NULL CHECK (octet_length(auth_tag) = 16),
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (job_id, chunk_index),
      FOREIGN KEY (job_id, organization_id)
        REFERENCES governance_jobs(id, organization_id) ON DELETE CASCADE
    );

    CREATE TABLE governance_job_dispatch (
      organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
      available_at timestamptz NOT NULL DEFAULT now(),
      leased_until timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    DO $policies$
    DECLARE secured_table text;
    BEGIN
      FOREACH secured_table IN ARRAY ARRAY[
        'organization_governance_settings', 'organization_invitations',
        'governance_jobs', 'governance_job_artifacts'
      ] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', secured_table);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', secured_table);
        EXECUTE format(
          'CREATE POLICY %I ON %I USING (organization_id = app_current_organization_id()) WITH CHECK (organization_id = app_current_organization_id())',
          secured_table || '_tenant', secured_table
        );
      END LOOP;
    END
    $policies$;
  `,
  down: `
    DROP TABLE governance_job_dispatch;
    DROP TABLE governance_job_artifacts;
    DROP TABLE governance_jobs;
    ALTER TABLE webhook_endpoints
      DROP CONSTRAINT webhook_endpoints_credential_state,
      DROP COLUMN last_received_at,
      DROP COLUMN credential_rotated_at,
      DROP COLUMN credential_version,
      DROP COLUMN credential_auth_tag,
      DROP COLUMN credential_iv,
      DROP COLUMN credential_ciphertext;
    DROP TABLE organization_invitations;
    DROP TABLE organization_governance_settings;
    ALTER TABLE identity_users DROP COLUMN locale, DROP COLUMN timezone;
  `,
};

export const migrations: readonly Migration[] = [
  identityMigration,
  dataCoreMigration,
  salesMigration,
  salesQueueMigration,
  operationsMigration,
  governanceMigration,
];
