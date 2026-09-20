import { expect, test } from '@playwright/test';
import { signInAndCreateOrganization } from './test-helpers';

test('keeps public routes findable to people, but not indexable', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto('/sign-in');
  await expect(page).toHaveTitle('Sign in | Analytics Admin');
  await expect(page.locator('meta[name="description"]')).toHaveAttribute(
    'content',
    'Sign in to your private Analytics Admin workspace.',
  );
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
    'content',
    'noindex, nofollow, noarchive',
  );
  await expect(
    page.getByRole('link', { name: 'Sign in securely' }),
  ).toBeInViewport();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(320);

  await page.goto('/this-page-does-not-exist');
  await expect(page).toHaveTitle('Page not found | Analytics Admin');
  await expect(
    page.getByRole('heading', { name: "We couldn't find that page." }),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Return to your workspace' }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(320);

  expect((await page.request.get('/favicon.svg')).ok()).toBe(true);
  expect((await page.request.get('/favicon.ico')).ok()).toBe(true);
  expect(await (await page.request.get('/robots.txt')).text()).toContain(
    'Disallow: /',
  );
  await page.getByRole('link', { name: 'Return to your workspace' }).click();
  await expect(page).toHaveTitle('Sign in | Analytics Admin');
});

test('keeps every critical workspace route usable at narrow mobile widths', async ({
  page,
}, testInfo) => {
  const { organizationId } = await signInAndCreateOrganization(
    page,
    testInfo,
    'Narrow mobile',
  );
  const routes = [
    ['/', 'Overview | Analytics Admin'],
    [`/organizations/${organizationId}/sales`, 'Sales | Analytics Admin'],
    [
      `/organizations/${organizationId}/operations`,
      'Operations | Analytics Admin',
    ],
    [`/organizations/${organizationId}/team`, 'Team access | Analytics Admin'],
    [
      `/organizations/${organizationId}/governance`,
      'Governance | Analytics Admin',
    ],
    ['/profile', 'Profile | Analytics Admin'],
    ['/workspace/components', 'Interface patterns | Analytics Admin'],
  ] as const;

  for (const width of [320, 393]) {
    await page.setViewportSize({ width, height: 844 });
    for (const [path, title] of routes) {
      await page.goto(path);
      await expect(page).toHaveTitle(title);
      await expect(page.getByRole('main')).toBeVisible();
      await expect(
        page.locator('meta[name="description"]'),
      ).not.toHaveAttribute('content', '');
      await expect(page.locator('img:not([alt])')).toHaveCount(0);
      const overflow = await page.evaluate(() => ({
        width: document.documentElement.scrollWidth,
        elements: [...document.querySelectorAll('*')]
          .filter(
            (element) => element.getBoundingClientRect().right > innerWidth + 1,
          )
          .slice(0, 12)
          .map((element) => ({
            name: `${element.tagName.toLowerCase()}.${element.className}`,
            right: Math.round(element.getBoundingClientRect().right),
          })),
      }));
      expect(
        overflow.width,
        `Page-wide overflow at ${width}px on ${path}: ${JSON.stringify(overflow.elements)}`,
      ).toBeLessThanOrEqual(width);
    }
  }

  await page.goto('/');
  const mobileNavigation = page.getByRole('navigation', {
    name: 'Mobile navigation',
  });
  for (const [name, title] of [
    ['Sales', 'Sales | Analytics Admin'],
    ['Operations', 'Operations | Analytics Admin'],
    ['Overview', 'Overview | Analytics Admin'],
  ] as const) {
    await mobileNavigation.getByRole('link', { name }).click();
    await expect(page).toHaveTitle(title);
  }

  const moreButton = mobileNavigation.getByRole('button', { name: 'More' });
  await moreButton.click();
  const moreDialog = page.getByRole('dialog', { name: 'More destinations' });
  await expect(moreDialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(moreDialog).toBeHidden();
  await expect(moreButton).toBeFocused();

  for (const [name, title] of [
    ['Team access', 'Team access | Analytics Admin'],
    ['Governance', 'Governance | Analytics Admin'],
    ['Interface patterns', 'Interface patterns | Analytics Admin'],
    ['Profile', 'Profile | Analytics Admin'],
  ] as const) {
    await moreButton.click();
    await moreDialog.getByRole('link', { name }).click();
    await expect(page).toHaveTitle(title);
    await expect(moreDialog).toBeHidden();
  }

  await mobileNavigation.getByRole('button', { name: 'Search' }).click();
  const commandSearch = page.getByRole('combobox', {
    name: 'Search workspace',
  });
  await expect(commandSearch).toBeFocused();
  await page.keyboard.press('Escape');

  await page.goto('/profile');
  await expect(page.locator('.identity-card a[href^="mailto:"]')).toBeVisible();
  await page.goto('/organizations/00000000-0000-4000-8000-000000000001/sales');
  await expect(page).toHaveURL(/\/access-denied$/);
  await expect(
    page.getByRole('heading', { name: 'This workspace is outside your role.' }),
  ).toBeVisible();
});
