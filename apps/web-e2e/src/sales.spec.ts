import { expect, test } from '@playwright/test';
import { signInAndCreateOrganization } from './test-helpers';

test('keeps sales filters, cards, chart, rows, and drill-down consistent', async ({
  page,
}, testInfo) => {
  const chartWarnings: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'warning' && message.text().includes('[ECharts]'))
      chartWarnings.push(message.text());
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const workspace = await signInAndCreateOrganization(page, testInfo, 'Sales');
  const salesUrl = `/organizations/${workspace.organizationId}/sales`;

  await page.goto(salesUrl);
  await expect(page.getByRole('status')).toContainText(
    'No committed sales yet',
  );

  const sources = [
    order('online', 10_000, recentDate(2)),
    order('pos', 6_000, recentDate(1), 1_000),
  ];
  const statuses = await page.evaluate(
    async ({ csrfToken, organizationId, sources }) =>
      Promise.all(
        sources.map(async (source) => {
          const response = await fetch(
            `/api/v1/organizations/${organizationId}/data/orders`,
            {
              body: JSON.stringify(source),
              headers: {
                'Content-Type': 'application/json',
                'Idempotency-Key': `browser-${source.externalId}`,
                'X-CSRF-Token': csrfToken,
              },
              method: 'POST',
            },
          );
          return response.status;
        }),
      ),
    { ...workspace, sources },
  );
  expect(statuses).toEqual([201, 201]);

  const range = currentRange();
  await page.goto(`${salesUrl}?from=${range.from}&to=${range.to}&currency=USD`);
  await expect(
    page.getByRole('heading', { name: 'Sales performance' }),
  ).toBeVisible();
  await expect(
    page.getByText('$150.00', { exact: true }).first(),
  ).toBeVisible();
  await expect(page.locator('.chart svg')).toBeVisible();
  expect(chartWarnings).toEqual([]);
  await page.getByRole('button', { exact: true, name: 'Orders' }).click();
  await expect(page.getByRole('img', { name: /order volume/ })).toBeVisible();
  await page.getByRole('button', { exact: true, name: 'AOV' }).click();
  await expect(
    page.getByRole('img', { name: /average order value/ }),
  ).toBeVisible();
  await page.getByRole('button', { exact: true, name: 'Revenue' }).click();
  await expect(page.getByRole('row', { name: /ORDER-online/ })).toBeVisible();
  await expect(page.getByRole('row', { name: /ORDER-pos/ })).toBeVisible();

  await page
    .getByLabel('Sales channel')
    .selectOption({ label: 'Point of sale' });
  await expect(page).toHaveURL(/channelId=/);
  await expect(page.getByText('$50.00', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('row', { name: /ORDER-online/ })).toHaveCount(0);
  await expect(page.getByRole('row', { name: /ORDER-pos/ })).toBeVisible();

  const openOrder = page.getByRole('button', { name: /Open order ORDER-pos/ });
  await openOrder.scrollIntoViewIfNeeded();
  await openOrder.click();
  const dialog = page.getByRole('dialog', { name: /ORDER-pos/ });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('$50.00', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  const horizontalLayout = await page.evaluate(() => ({
    offenders: [...document.querySelectorAll<HTMLElement>('*')]
      .filter(
        (element) => element.getBoundingClientRect().right > innerWidth + 1,
      )
      .map((element) => `${element.tagName.toLowerCase()}.${element.className}`)
      .slice(0, 8),
    scrollWidth: document.documentElement.scrollWidth,
    viewportWidth: innerWidth,
  }));
  expect(horizontalLayout.offenders, JSON.stringify(horizontalLayout)).toEqual(
    [],
  );
  await expect(page).toHaveScreenshot('sales-analytics.png', {
    animations: 'disabled',
    mask: [
      page.locator('.user-chip'),
      page.getByLabel('Organization filter'),
      page.locator('.sales-heading strong'),
      page.locator('.chart text'),
      page.locator('.chart-card > header > p'),
      page.locator('tbody td:nth-child(2)'),
    ],
    maskColor: '#dfe6e2',
    maxDiffPixels: 1_000,
  });

  await page.route('**/sales/overview**', (route) => route.abort());
  await page.getByLabel('Order status').selectOption('fulfilled');
  await expect(page.getByRole('alert')).toContainText('Sales refresh failed');
  await page.unroute('**/sales/overview**');
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

function order(
  channel: 'online' | 'pos',
  totalMinor: number,
  occurredAt: string,
  refundedMinor = 0,
) {
  const id = `${channel}-${Date.now()}`;
  return {
    channel: {
      externalId: channel,
      kind: channel === 'pos' ? 'pos' : 'storefront',
      name: channel === 'pos' ? 'Point of sale' : 'Online store',
    },
    currency: 'USD',
    externalId: id,
    fulfilments: [],
    items: [
      {
        externalId: `line-${id}`,
        name: channel === 'pos' ? 'Studio lamp' : 'Standing desk',
        productExternalId: `product-${channel}`,
        quantity: 1,
        sku: `SKU-${channel.toUpperCase()}`,
        totalMinor,
        unitPriceMinor: totalMinor,
      },
    ],
    location: {
      externalId: `location-${channel}`,
      kind: 'store',
      name: channel === 'pos' ? 'Flagship store' : 'Online fulfilment',
      timezone: 'UTC',
    },
    occurredAt,
    orderNumber: `ORDER-${channel}-${id}`,
    payment: {
      authorizedMinor: totalMinor,
      capturedMinor: totalMinor,
      refundedMinor,
      status: refundedMinor ? 'partially_refunded' : 'captured',
    },
    returns: [],
    status: channel === 'pos' ? 'fulfilled' : 'confirmed',
    subtotalMinor: totalMinor,
    totalMinor,
  };
}

function currentRange(): { from: string; to: string } {
  const tomorrow = new Date();
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const from = new Date(tomorrow);
  from.setUTCDate(from.getUTCDate() - 7);
  return { from: day(from), to: day(tomorrow) };
}

function recentDate(daysAgo: number): string {
  const value = new Date();
  value.setUTCDate(value.getUTCDate() - daysAgo);
  value.setUTCHours(10, 0, 0, 0);
  return value.toISOString();
}

function day(value: Date): string {
  return value.toISOString().slice(0, 10);
}
