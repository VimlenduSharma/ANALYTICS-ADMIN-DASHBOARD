import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { createClient } from 'redis';

const databaseUrl = requiredEnvironment('DATABASE_URL');
const redisUrl = requiredEnvironment('REDIS_URL');
const port = 35_000 + Math.floor(Math.random() * 1_000);
const baseUrl = `http://127.0.0.1:${port}`;
const webOrigin = 'http://localhost:4200';
const runId = randomBytes(8).toString('hex');
const pool = new Pool({ connectionString: databaseUrl, max: 3 });
const redis = createClient({ url: redisUrl });
const organizationIds = [];
const userIds = [];
const sessionTokens = [];
const processOutput = [];
const childEnvironment = {
  ...process.env,
  API_HOST: '127.0.0.1',
  API_PORT: String(port),
  APP_VERSION: 'governance-integration',
  GOVERNANCE_JOB_POLL_MS: '500',
  NODE_ENV: 'test',
  OIDC_CLIENT_ID: '',
  OIDC_CLIENT_SECRET: '',
  OIDC_ISSUER_URL: '',
  OIDC_REDIRECT_URI: '',
  WEB_ORIGIN: webOrigin,
};
const api = startProcess('dist/apps/api/main.js');
let worker;

try {
  await redis.connect();
  await waitForApi();

  const ownerA = await createUser('Governance Owner A');
  const ownerB = await createUser('Governance Owner B');
  const admin = await createUser('Governance Admin');
  const viewer = await createUser('Governance Viewer');
  const invited = await createUser('Governance Invitee');
  const wrongInvitee = await createUser('Governance Wrong Invitee');
  const organizationA = await createOrganization(
    ownerA.id,
    'Governance Gate A',
  );
  const organizationB = await createOrganization(
    ownerB.id,
    'Governance Gate B',
  );
  await addMembership(organizationA, admin.id, 'ADMIN', ownerA.id);
  await addMembership(organizationA, viewer.id, 'VIEWER', ownerA.id);

  const ownerSession = await createSession(ownerA.id);
  const adminSession = await createSession(admin.id);
  const viewerSession = await createSession(viewer.id);
  const invitedSession = await createSession(invited.id);
  const wrongSession = await createSession(wrongInvitee.id);
  const governancePath = `/api/v1/organizations/${organizationA}/governance`;

  await expectStatus(
    'anonymous governance access fails closed',
    await request(governancePath),
    401,
  );
  await expectStatus(
    'viewer governance access fails closed',
    await authenticatedRequest(governancePath, viewerSession),
    403,
  );
  await expectStatus(
    'cross-tenant governance access fails closed',
    await authenticatedRequest(
      `/api/v1/organizations/${organizationB}/governance`,
      ownerSession,
    ),
    403,
  );
  await expectStatus(
    'admin cannot change owner-controlled retention policy',
    await authenticatedRequest(`${governancePath}/settings`, adminSession, {
      body: governancePolicy(),
      method: 'PATCH',
    }),
    403,
  );
  await expectStatus(
    'invalid reporting timezone is rejected',
    await authenticatedRequest(`${governancePath}/settings`, ownerSession, {
      body: { ...governancePolicy(), reportingTimezone: 'Mars/Olympus' },
      method: 'PATCH',
    }),
    400,
  );
  const settings = await expectJson(
    'owner persists organization-scoped governance policy',
    await authenticatedRequest(`${governancePath}/settings`, ownerSession, {
      body: governancePolicy(),
      method: 'PATCH',
    }),
    200,
  );
  assert.equal(settings.reportingTimezone, 'Asia/Kolkata');
  assert.equal(settings.operationalDataRetentionDays, 30);

  await expectStatus(
    'admin cannot invite another administrator',
    await authenticatedRequest(`${governancePath}/invitations`, adminSession, {
      body: { email: wrongInvitee.email, role: 'ADMIN' },
      method: 'POST',
    }),
    403,
  );
  const invitation = await expectJson(
    'owner creates a scoped invitation with one-time acceptance path',
    await authenticatedRequest(`${governancePath}/invitations`, ownerSession, {
      body: { email: invited.email, role: 'ANALYST' },
      method: 'POST',
    }),
    201,
  );
  const invitationUrl = new URL(invitation.acceptancePath, webOrigin);
  const invitationToken = new URLSearchParams(invitationUrl.hash.slice(1)).get(
    'token',
  );
  assert.ok(invitationToken);
  assert.equal(invitationUrl.searchParams.has('token'), false);
  const storedInvitation = await pool.query(
    `SELECT token_sha256 FROM organization_invitations WHERE id = $1`,
    [invitation.id],
  );
  assert.notEqual(storedInvitation.rows[0].token_sha256, invitationToken);
  assert.equal(
    storedInvitation.rows[0].token_sha256,
    createHash('sha256').update(invitationToken).digest('hex'),
  );
  const invitations = await expectJson(
    'invitation listings never return acceptance credentials',
    await authenticatedRequest(`${governancePath}/invitations`, adminSession),
    200,
  );
  assert.equal(JSON.stringify(invitations).includes(invitationToken), false);
  assert.equal('acceptancePath' in invitations[0], false);
  await expectStatus(
    'invitation cannot be accepted by another email',
    await authenticatedRequest(
      `/api/v1/organizations/${organizationA}/invitations/accept`,
      wrongSession,
      { body: { token: invitationToken }, method: 'POST' },
    ),
    403,
  );
  const accepted = await expectJson(
    'matching signed-in identity accepts the invitation',
    await authenticatedRequest(
      `/api/v1/organizations/${organizationA}/invitations/accept`,
      invitedSession,
      { body: { token: invitationToken }, method: 'POST' },
    ),
    201,
  );
  assert.equal(accepted.role, 'ANALYST');

  const profile = await expectJson(
    'authenticated user updates only their profile preferences',
    await authenticatedRequest('/api/v1/profile', viewerSession, {
      body: {
        displayName: 'Governance Viewer Updated',
        locale: 'en-IN',
        timezone: 'Asia/Kolkata',
      },
      method: 'PATCH',
    }),
    200,
  );
  assert.equal(profile.locale, 'en-IN');
  await expectStatus(
    'profile updates cannot smuggle privilege fields',
    await authenticatedRequest('/api/v1/profile', viewerSession, {
      body: {
        displayName: 'Governance Viewer Updated',
        locale: 'en-IN',
        role: 'OWNER',
        timezone: 'Asia/Kolkata',
      },
      method: 'PATCH',
    }),
    400,
  );

  const source = await expectJson(
    'owner creates an encrypted integration credential',
    await authenticatedRequest(
      `/api/v1/organizations/${organizationA}/data/webhooks`,
      ownerSession,
      { body: { name: 'Governance orders' }, method: 'POST' },
    ),
    201,
  );
  assert.equal(typeof source.secret, 'string');
  const storedCredential = await pool.query(
    `SELECT credential_ciphertext, credential_iv, credential_auth_tag,
       credential_version FROM webhook_endpoints WHERE id = $1`,
    [source.id],
  );
  const credentialRow = storedCredential.rows[0];
  assert.equal(credentialRow.credential_version, 1);
  assert.equal(credentialRow.credential_iv.length, 12);
  assert.equal(credentialRow.credential_auth_tag.length, 16);
  assert.equal(
    credentialRow.credential_ciphertext.includes(Buffer.from(source.secret)),
    false,
  );
  const sourceList = await expectJson(
    'credential listings omit the secret',
    await authenticatedRequest(
      `/api/v1/organizations/${organizationA}/data/webhooks`,
      adminSession,
    ),
    200,
  );
  assert.equal('secret' in sourceList[0], false);
  const rotated = await expectJson(
    'credential rotation returns a new secret once',
    await authenticatedRequest(
      `/api/v1/organizations/${organizationA}/data/webhooks/${source.id}/credential`,
      ownerSession,
      { body: {}, method: 'PUT' },
    ),
    200,
  );
  assert.notEqual(rotated.secret, source.secret);
  await assertCredentialRotation(
    organizationA,
    source.id,
    source.secret,
    rotated.secret,
  );

  await expectStatus(
    'admin cannot queue owner-only privacy jobs',
    await authenticatedRequest(`${governancePath}/jobs`, adminSession, {
      body: {
        subjectExternalId: 'customer-governance',
        type: 'privacy-export',
      },
      headers: { 'idempotency-key': `admin-export-${runId}` },
      method: 'POST',
    }),
    403,
  );
  await ingestCustomerOrder(organizationA, ownerSession, 'current', new Date());
  await ingestCustomerOrder(
    organizationA,
    ownerSession,
    'old',
    new Date(Date.now() - 45 * 86_400_000),
    'fulfilled',
    'customer-retention',
  );

  const exportKey = `privacy-export-${runId}`;
  const exportJob = await expectJson(
    'owner queues a privacy export',
    await authenticatedRequest(`${governancePath}/jobs`, ownerSession, {
      body: {
        subjectExternalId: 'customer-governance',
        type: 'privacy-export',
      },
      headers: { 'idempotency-key': exportKey },
      method: 'POST',
    }),
    202,
  );
  const replay = await expectJson(
    'governance job enqueue is idempotent',
    await authenticatedRequest(`${governancePath}/jobs`, ownerSession, {
      body: {
        subjectExternalId: 'customer-governance',
        type: 'privacy-export',
      },
      headers: { 'idempotency-key': exportKey },
      method: 'POST',
    }),
    202,
  );
  assert.equal(replay.id, exportJob.id);
  await expectStatus(
    'idempotency key cannot be reused for a different workflow',
    await authenticatedRequest(`${governancePath}/jobs`, ownerSession, {
      body: { subjectExternalId: 'another-customer', type: 'privacy-export' },
      headers: { 'idempotency-key': exportKey },
      method: 'POST',
    }),
    409,
  );
  const retentionJob = await expectJson(
    'owner queues policy retention',
    await authenticatedRequest(`${governancePath}/jobs`, ownerSession, {
      body: { type: 'retention' },
      headers: { 'idempotency-key': `retention-${runId}` },
      method: 'POST',
    }),
    202,
  );
  await pool.query(
    `UPDATE governance_jobs SET status = 'processing', attempts = 1,
       processing_started_at = now() - interval '6 minutes',
       checkpoint = '{"phase": 2}'::jsonb
     WHERE id = $1`,
    [retentionJob.id],
  );
  worker = startProcess('dist/apps/worker/main.js');
  const completedExport = await waitForJob(
    organizationA,
    exportJob.id,
    ownerSession,
  );
  assert.equal(completedExport.status, 'completed');
  const exportResponse = await authenticatedRequest(
    `${governancePath}/jobs/${exportJob.id}/download`,
    ownerSession,
  );
  const exportPayload = await expectJson(
    'encrypted privacy artifact is downloadable while valid',
    exportResponse,
    200,
  );
  assert.equal(exportPayload.customer.externalId, 'customer-governance');
  const artifact = await pool.query(
    `SELECT ciphertext FROM governance_job_artifacts WHERE job_id = $1`,
    [exportJob.id],
  );
  assert.ok(artifact.rowCount > 0);
  assert.equal(
    artifact.rows.some((row) =>
      row.ciphertext.includes(Buffer.from('customer-governance')),
    ),
    false,
  );
  const completedRetention = await waitForJob(
    organizationA,
    retentionJob.id,
    ownerSession,
  );
  assert.equal(completedRetention.status, 'completed');
  assert.ok(completedRetention.processedCount > 0);
  const oldOrder = await pool.query(
    `SELECT 1 FROM orders WHERE organization_id = $1 AND external_id = $2`,
    [organizationA, `governance-old-${runId}`],
  );
  assert.equal(oldOrder.rowCount, 0);

  const deletion = await expectJson(
    'owner queues privacy deletion',
    await authenticatedRequest(`${governancePath}/jobs`, ownerSession, {
      body: {
        subjectExternalId: 'customer-governance',
        type: 'privacy-delete',
      },
      headers: { 'idempotency-key': `privacy-delete-${runId}` },
      method: 'POST',
    }),
    202,
  );
  const completedDeletion = await waitForJob(
    organizationA,
    deletion.id,
    ownerSession,
  );
  assert.equal(completedDeletion.status, 'completed');
  const erased = await pool.query(
    `SELECT customer_reference_id, metadata FROM orders
     WHERE organization_id = $1 AND external_id = $2`,
    [organizationA, `governance-current-${runId}`],
  );
  assert.equal(erased.rows[0].customer_reference_id, null);
  assert.deepEqual(erased.rows[0].metadata, {});

  const auditPage = await expectJson(
    'audit explorer provides a filter-bound cursor',
    await authenticatedRequest(
      `${governancePath}/audit-events?pageSize=2`,
      ownerSession,
    ),
    200,
  );
  assert.equal(auditPage.items.length, 2);
  assert.equal(auditPage.pageInfo.hasNextPage, true);
  await expectStatus(
    'audit cursor fails closed when filters change',
    await authenticatedRequest(
      `${governancePath}/audit-events?pageSize=2&eventType=profile.updated&cursor=${encodeURIComponent(auditPage.pageInfo.nextCursor)}`,
      ownerSession,
    ),
    400,
  );
  await verifyRowSecurity(organizationA, organizationB);

  const specification = await expectJson(
    'governance routes are published in OpenAPI',
    await request('/api/openapi.json'),
    200,
  );
  assert.ok(
    specification.paths[
      '/api/v1/organizations/{organizationId}/governance/jobs'
    ],
  );
  assert.ok(specification.paths['/api/v1/profile']);

  console.log(
    'Governance integration gate passed: 28 authorization, invitation, profile, encryption, rotation, idempotency, resume, privacy, retention, audit, RLS, and contract checks.',
  );
} catch (error) {
  console.error(error);
  const diagnostics = processOutput.join('').trim();
  if (diagnostics) console.error(diagnostics);
  throw error;
} finally {
  await cleanup();
  for (const child of [worker, api]) {
    if (!child) continue;
    child.kill('SIGTERM');
    await Promise.race([onceExited(child), delay(2_000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  if (redis.isOpen) redis.destroy();
  await pool.end();
}

function governancePolicy() {
  return {
    auditRetentionDays: 365,
    exportRetentionHours: 24,
    name: `Governance Gate A ${runId}`,
    operationalDataRetentionDays: 30,
    privacyExportRetentionHours: 12,
    reportingTimezone: 'Asia/Kolkata',
    weekStartsOn: 1,
  };
}

async function assertCredentialRotation(
  organizationId,
  endpointId,
  oldSecret,
  newSecret,
) {
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const body = '{}';
  const path = `/api/v1/organizations/${organizationId}/webhooks/orders/${endpointId}`;
  const headers = (secret, eventId) => ({
    'content-type': 'application/json',
    'x-webhook-event-id': eventId,
    'x-webhook-signature': `v1=${createHmac(
      'sha256',
      Buffer.from(secret, 'base64url'),
    )
      .update(`${timestamp}.${body}`)
      .digest('hex')}`,
    'x-webhook-timestamp': timestamp,
  });
  await expectStatus(
    'rotated credential rejects the previous secret',
    await request(path, {
      body: {},
      headers: headers(oldSecret, `old-${runId}`),
      method: 'POST',
    }),
    401,
  );
  await expectStatus(
    'rotated credential authenticates the new secret',
    await request(path, {
      body: {},
      headers: headers(newSecret, `new-${runId}`),
      method: 'POST',
    }),
    400,
  );
}

async function ingestCustomerOrder(
  organizationId,
  session,
  label,
  occurredAt,
  status = 'confirmed',
  customerExternalId = 'customer-governance',
) {
  await expectStatus(
    `customer order ${label} is accepted`,
    await authenticatedRequest(
      `/api/v1/organizations/${organizationId}/data/orders`,
      session,
      {
        body: {
          channel: {
            externalId: 'governance-web',
            kind: 'storefront',
            name: 'Governance web',
          },
          currency: 'USD',
          customerReference: {
            externalId: customerExternalId,
            metadata: { consentSource: 'checkout' },
          },
          externalId: `governance-${label}-${runId}`,
          items: [
            {
              externalId: `line-${label}`,
              name: 'Governance product',
              productExternalId: `product-${label}`,
              quantity: 1,
              sku: `GOV-${label.toUpperCase()}`,
              totalMinor: 2_500,
              unitPriceMinor: 2_500,
            },
          ],
          metadata: { deliveryNote: 'private-note' },
          occurredAt: occurredAt.toISOString(),
          orderNumber: `GOV-${label}-${runId}`,
          status,
          subtotalMinor: 2_500,
          totalMinor: 2_500,
        },
        headers: { 'idempotency-key': `governance-order-${label}-${runId}` },
        method: 'POST',
      },
    ),
    201,
  );
}

async function waitForJob(organizationId, jobId, session) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const response = await authenticatedRequest(
      `/api/v1/organizations/${organizationId}/governance/jobs/${jobId}`,
      session,
    );
    const job = await expectJson(
      'governance job status is readable',
      response,
      200,
    );
    if (job.status === 'completed' || job.status === 'failed') return job;
    await delay(150);
  }
  throw new Error(`Governance job ${jobId} did not finish within 15 seconds`);
}

async function verifyRowSecurity(organizationA, organizationB) {
  const role = `phase7_rls_${runId}`;
  const client = await pool.connect();
  try {
    await client.query(`CREATE ROLE ${role} NOLOGIN`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await client.query(
      `GRANT SELECT ON organization_governance_settings,
       organization_invitations, governance_jobs,
       governance_job_artifacts TO ${role}`,
    );
    await client.query(`SET ROLE ${role}`);
    const hidden = await client.query(
      'SELECT count(*)::int AS count FROM governance_jobs',
    );
    assert.equal(hidden.rows[0].count, 0);
    await client.query("SELECT set_config('app.organization_id', $1, false)", [
      organizationA,
    ]);
    const visible = await client.query(
      'SELECT organization_id FROM governance_jobs',
    );
    assert.ok(visible.rows.length > 0);
    assert.ok(
      visible.rows.every((row) => row.organization_id === organizationA),
    );
    assert.ok(
      visible.rows.every((row) => row.organization_id !== organizationB),
    );
  } finally {
    try {
      await client.query('RESET ROLE');
      await client.query(`DROP OWNED BY ${role}`);
      await client.query(`DROP ROLE IF EXISTS ${role}`);
    } catch {
      // Cleanup must not mask the assertion failure.
    }
    client.release();
  }
}

function startProcess(entry) {
  const child = spawn(process.execPath, [entry], {
    cwd: process.cwd(),
    env: childEnvironment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => {
      processOutput.push(String(chunk));
      if (processOutput.length > 80) processOutput.shift();
    });
  }
  return child;
}

async function createUser(label) {
  const result = await pool.query(
    `INSERT INTO identity_users (issuer, subject, email, display_name)
     VALUES ($1, $2, $3, $4) RETURNING id, email`,
    [
      `urn:analytics-admin:governance:${runId}`,
      `${label}-${runId}`,
      `${label.toLowerCase().replaceAll(' ', '.')}+${runId}@integration.test`,
      label,
    ],
  );
  const user = result.rows[0];
  assert.ok(user);
  userIds.push(user.id);
  return user;
}

async function createOrganization(userId, label) {
  const result = await pool.query(
    `INSERT INTO organizations (slug, name, created_by_user_id)
     VALUES ($1, $2, $3) RETURNING id`,
    [`${label.toLowerCase().replaceAll(' ', '-')}-${runId}`, label, userId],
  );
  const organization = result.rows[0];
  assert.ok(organization);
  organizationIds.push(organization.id);
  await addMembership(organization.id, userId, 'OWNER', userId);
  return organization.id;
}

function addMembership(organizationId, userId, role, actorId) {
  return pool.query(
    `INSERT INTO organization_memberships (
       organization_id, user_id, role, created_by_user_id
     ) VALUES ($1, $2, $3, $4)`,
    [organizationId, userId, role, actorId],
  );
}

async function createSession(userId) {
  const token = randomBytes(32).toString('base64url');
  const csrf = randomBytes(32).toString('base64url');
  const now = Math.floor(Date.now() / 1_000);
  const key = sessionKey(token);
  await redis.set(
    key,
    JSON.stringify({
      absoluteExpiresAt: now + 86_400,
      createdAt: now,
      csrfToken: csrf,
      rotatedAt: now,
      userId,
    }),
    { EX: 28_800 },
  );
  await redis.sAdd(userSessionsKey(userId), key);
  await redis.expire(userSessionsKey(userId), 28_800);
  sessionTokens.push(token);
  return { csrf, token };
}

function authenticatedRequest(path, session, options = {}) {
  return request(path, {
    ...options,
    csrf: session.csrf,
    token: session.token,
  });
}

function request(path, options = {}) {
  const headers = { accept: 'application/json', ...options.headers };
  if (options.token) headers.cookie = `aad_session=${options.token}`;
  if (options.csrf) headers['x-csrf-token'] = options.csrf;
  if (options.method && options.method !== 'GET' && options.token) {
    headers.origin = webOrigin;
  }
  if (options.body !== undefined && !headers['content-type']) {
    headers['content-type'] = 'application/json';
  }
  return fetch(`${baseUrl}${path}`, {
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    headers,
    method: options.method ?? 'GET',
    redirect: 'manual',
  });
}

async function expectJson(label, response, status) {
  const text = await expectStatus(label, response, status);
  assert.notEqual(text, '', `${label}: expected a JSON response body`);
  return JSON.parse(text);
}

async function expectStatus(label, response, status) {
  const text = await response.text();
  assert.equal(
    response.status,
    status,
    `${label}: expected ${status}, received ${response.status}: ${text}`,
  );
  return text;
}

async function waitForApi() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (api.exitCode !== null) {
      throw new Error(`Governance API exited early: ${api.exitCode}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/v1/health/ready`);
      if (response.ok) return;
    } catch {
      // Startup is still in progress.
    }
    await delay(150);
  }
  throw new Error('Governance API did not become ready within 15 seconds');
}

async function cleanup() {
  if (redis.isOpen) {
    if (sessionTokens.length) await redis.del(sessionTokens.map(sessionKey));
    if (userIds.length) await redis.del(userIds.map(userSessionsKey));
  }
  if (organizationIds.length) {
    await pool.query(
      'DELETE FROM audit_events WHERE organization_id = ANY($1::uuid[])',
      [organizationIds],
    );
    await pool.query('DELETE FROM organizations WHERE id = ANY($1::uuid[])', [
      organizationIds,
    ]);
  }
  if (userIds.length) {
    await pool.query('DELETE FROM identity_users WHERE id = ANY($1::uuid[])', [
      userIds,
    ]);
  }
}

function sessionKey(token) {
  return `identity:session:${createHash('sha256').update(token).digest('hex')}`;
}

function userSessionsKey(userId) {
  return `identity:user-sessions:${userId}`;
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for governance integration`);
  return value;
}

function onceExited(child) {
  return new Promise((resolve) => child.once('exit', resolve));
}
