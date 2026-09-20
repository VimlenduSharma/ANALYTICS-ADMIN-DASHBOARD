import { expect, test } from '@playwright/test';
import { signInAndCreateOrganization } from './test-helpers';

test('turns live operational signals into a responsive action queue', async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const workspace = await signInAndCreateOrganization(
    page,
    testInfo,
    'Operations',
  );
  const operationsUrl = `/organizations/${workspace.organizationId}/operations`;

  await page.goto(operationsUrl);
  await expect(page.getByText('No operational sources received')).toBeVisible();
  await expect(page.getByText('No matching issues')).toBeVisible();

  const fixture = operationalFixture();
  const statuses = await page.evaluate(
    async ({ csrfToken, fixture, organizationId }) => {
      const write = async (
        path: string,
        method: 'PATCH' | 'POST',
        body: unknown,
        idempotencyKey?: string,
      ) => {
        const response = await fetch(
          `/api/v1/organizations/${organizationId}/${path}`,
          {
            body: JSON.stringify(body),
            headers: {
              'Content-Type': 'application/json',
              ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
              'X-CSRF-Token': csrfToken,
            },
            method,
          },
        );
        return response.status;
      };
      return Promise.all([
        write('operations/thresholds', 'PATCH', fixture.thresholds),
        ...fixture.orders.map((order) =>
          write(
            'data/orders',
            'POST',
            order,
            `browser-operations-${order.externalId}`,
          ),
        ),
        write(
          'data/inventory',
          'POST',
          fixture.inventory,
          `browser-operations-${fixture.inventory.product.externalId}`,
        ),
      ]);
    },
    { ...workspace, fixture },
  );
  expect(statuses).toEqual([200, 201, 201, 201, 201, 201]);

  await page.goto(
    `${operationsUrl}?from=${fixture.range.from}&to=${fixture.range.to}`,
  );
  await expect(
    page.getByRole('heading', { name: 'See risk before it becomes delay.' }),
  ).toBeVisible();
  await expect(page.getByText('Operational sources are current')).toBeVisible();
  await expect(page.getByText('50.0%', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('6h', { exact: true }).first()).toBeVisible();
  await expect(page.locator('.risk-count')).toContainText('5');
  await expect(
    page.getByRole('row', { name: /critical-backlog.*waiting to ship/i }),
  ).toBeVisible();

  const layout = await page.evaluate(() => {
    document.documentElement.scrollLeft = 100;
    const horizontalScrollX = document.documentElement.scrollLeft;
    document.documentElement.scrollLeft = 0;
    return {
      bodyScrollWidth: document.body.scrollWidth,
      horizontalScrollX,
      offenders: [...document.querySelectorAll<HTMLElement>('*')]
        .filter(
          (element) =>
            element.getBoundingClientRect().right > innerWidth + 1 &&
            !element.closest('.table-scroll'),
        )
        .map(
          (element) => `${element.tagName.toLowerCase()}.${element.className}`,
        )
        .slice(0, 8),
      viewportWidth: innerWidth,
    };
  });
  expect(layout.offenders, JSON.stringify(layout)).toEqual([]);
  expect(layout.bodyScrollWidth, JSON.stringify(layout)).toBeLessThanOrEqual(
    layout.viewportWidth,
  );
  expect(layout.horizontalScrollX, JSON.stringify(layout)).toBe(0);
  await page.locator('.page-intro strong').evaluate((element) => {
    element.textContent = 'Operations workspace';
  });
  await expect(page).toHaveScreenshot('operations-control.png', {
    animations: 'disabled',
    mask: [
      page.locator('.user-chip'),
      page.getByLabel('Organization filter'),
      page.locator('.page-intro strong'),
      page.locator('.source small'),
    ],
    maskColor: '#dfe6e2',
    maxDiffPixels: 1_000,
  });

  await page.getByLabel('Issue type filter').selectOption('backlog');
  await expect(page).toHaveURL(/issueType=backlog/);
  await expect(
    page.getByRole('row', { name: /critical-backlog.*waiting to ship/i }),
  ).toBeVisible();
  await expect(page.getByRole('row', { name: /was cancelled/i })).toHaveCount(
    0,
  );

  const inspect = page.getByRole('button', { name: 'Inspect' }).first();
  await inspect.focus();
  await expect(inspect).toBeFocused();
  await page.keyboard.press('Enter');
  const issueDialog = page.getByRole('dialog', { name: /waiting to ship/i });
  await expect(issueDialog).toBeVisible();
  await expect(issueDialog).toContainText('Time exposure');
  await page.keyboard.press('Escape');
  await expect(issueDialog).toBeHidden();
  await expect(inspect).toBeFocused();
  const clearFilters = page.getByRole('button', { name: 'Clear filters' });
  await clearFilters.focus();
  await page.keyboard.press('Enter');

  const backlogAlert = page
    .locator('.alert-card')
    .filter({ hasText: 'Backlog risk at Operations hub' });
  const acknowledge = backlogAlert.getByRole('button', { name: 'Acknowledge' });
  await acknowledge.focus();
  await page.keyboard.press('Enter');
  await expect(backlogAlert).toContainText('Acknowledged');
  await backlogAlert.getByRole('button', { name: 'Reopen' }).focus();
  await page.keyboard.press('Enter');
  await expect(
    backlogAlert.getByRole('button', { name: 'Acknowledge' }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Configure thresholds' }).focus();
  await page.keyboard.press('Enter');
  const policyDialog = page.getByRole('dialog', {
    name: 'Operational thresholds',
  });
  await expect(policyDialog).toBeVisible();
  await policyDialog.getByLabel('Backlog warning (minutes)').fill('120');
  const savePolicy = policyDialog.getByRole('button', { name: 'Save policy' });
  await savePolicy.focus();
  await page.keyboard.press('Enter');
  await expect(policyDialog.getByText('Review threshold values')).toBeVisible();
  await policyDialog.getByLabel('Critical backlog (minutes)').fill('180');
  await savePolicy.focus();
  await page.keyboard.press('Enter');
  await expect(policyDialog).toBeHidden();
  await expect(
    page.getByText('Thresholds saved', { exact: true }),
  ).toBeVisible();
  for (const title of [
    'Alert reopened',
    'Thresholds need attention',
    'Thresholds saved',
  ]) {
    await page
      .getByRole('button', { name: `Dismiss ${title} notification` })
      .focus();
    await page.keyboard.press('Enter');
  }

  await page.route('**/operations/overview**', (route) => route.abort());
  await page.getByLabel('Severity filter').selectOption('warning');
  const refreshAlert = page
    .getByRole('alert')
    .filter({ hasText: 'Issue list may be out of date' });
  await expect(refreshAlert).toContainText('Issue list may be out of date');
  await page.unroute('**/operations/overview**');
  await refreshAlert.getByRole('button', { name: 'Try again' }).focus();
  await page.keyboard.press('Enter');
  await expect(refreshAlert).toHaveCount(0);
});

function operationalFixture() {
  const range = currentRange();
  const sourceUpdatedAt = new Date().toISOString();
  return {
    inventory: {
      location: location(),
      onHandQuantity: 7,
      product: {
        externalId: `operations-stock-${Date.now()}`,
        name: 'Replacement filter',
        sku: `OPS-STOCK-${Date.now()}`,
      },
      reorderPoint: 5,
      reservedQuantity: 1,
      sourceUpdatedAt,
    },
    orders: [
      order('late-shipment', daysAgo(3, 10), sourceUpdatedAt, {
        fulfilments: [fulfilment('late', daysAgo(3, 20))],
      }),
      order('critical-backlog', daysAgo(4, 9), sourceUpdatedAt),
      order('cancelled', daysAgo(2, 9), sourceUpdatedAt, {
        status: 'cancelled',
      }),
      order('returned', daysAgo(1, 10), sourceUpdatedAt, {
        fulfilments: [fulfilment('returned', daysAgo(1, 12))],
        returns: [
          {
            amountMinor: 2_500,
            externalId: `return-${Date.now()}`,
            requestedAt: daysAgo(1, 13),
            status: 'requested',
          },
        ],
      }),
    ],
    range,
    thresholds: {
      backlogCriticalMinutes: 120,
      backlogWarningMinutes: 60,
      cancellationWarningBasisPoints: 1_000,
      cutoffLocalTime: '17:00',
      dataStaleAfterMinutes: 1_440,
      fulfilmentTargetMinutes: 60,
      lowStockBufferQuantity: 2,
      returnWarningBasisPoints: 500,
      timezone: 'UTC',
    },
  };
}

interface OrderOptions {
  fulfilments?: ReturnType<typeof fulfilment>[];
  returns?: Array<{
    amountMinor: number;
    externalId: string;
    requestedAt: string;
    status: 'requested';
  }>;
  status?: 'cancelled' | 'confirmed';
}

function order(
  label: string,
  occurredAt: string,
  sourceUpdatedAt: string,
  options: OrderOptions = {},
) {
  const id = `${label}-${Date.now()}`;
  const cancelled = options.status === 'cancelled';
  return {
    channel: {
      externalId: 'operations-web',
      kind: 'storefront',
      name: 'Operations web',
    },
    currency: 'USD',
    externalId: id,
    fulfilments: options.fulfilments ?? [],
    items: [
      {
        externalId: `line-${id}`,
        name: `Operational item ${label}`,
        productExternalId: `product-${label}`,
        quantity: 1,
        sku: `OPS-${label.toUpperCase()}`,
        totalMinor: 5_000,
        unitPriceMinor: 5_000,
      },
    ],
    location: location(),
    occurredAt,
    orderNumber: `OPS-${label}-${Date.now()}`,
    payment: {
      authorizedMinor: 5_000,
      capturedMinor: cancelled ? 0 : 5_000,
      status: cancelled ? 'pending' : 'captured',
    },
    returns: options.returns ?? [],
    sourceUpdatedAt,
    status: options.status ?? 'confirmed',
    subtotalMinor: 5_000,
    totalMinor: 5_000,
  };
}

function location() {
  return {
    countryCode: 'US',
    externalId: 'operations-hub',
    kind: 'warehouse',
    name: 'Operations hub',
    timezone: 'UTC',
  };
}

function fulfilment(label: string, shippedAt: string) {
  return {
    externalId: `fulfilment-${label}-${Date.now()}`,
    locationExternalId: 'operations-hub',
    shippedAt,
    status: 'shipped' as const,
  };
}

function currentRange(): { from: string; to: string } {
  const to = new Date();
  to.setUTCDate(to.getUTCDate() + 1);
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - 7);
  return { from: day(from), to: day(to) };
}

function daysAgo(days: number, hour: number): string {
  const value = new Date();
  value.setUTCDate(value.getUTCDate() - days);
  value.setUTCHours(hour, 0, 0, 0);
  return value.toISOString();
}

function day(value: Date): string {
  return value.toISOString().slice(0, 10);
}
