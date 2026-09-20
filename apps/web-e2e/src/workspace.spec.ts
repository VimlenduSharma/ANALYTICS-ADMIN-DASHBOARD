import { expect, test } from '@playwright/test';
import { signInAndCreateOrganization } from './test-helpers';

const preferenceKey = 'aad-workspace-preferences-v1';
interface NavigationDisplay {
  mobile: string;
  sidebar: string;
}

const navigationDisplay: Record<string, NavigationDisplay> = {
  chromium: { mobile: 'none', sidebar: 'flex' },
  'mobile-chromium': { mobile: 'grid', sidebar: 'none' },
  'tablet-chromium': { mobile: 'none', sidebar: 'flex' },
};

test('supports keyboard navigation and private preference persistence', async ({
  page,
}, testInfo) => {
  const { name: organizationName } = await signInAndCreateOrganization(
    page,
    testInfo,
    'Command',
  );

  await page.keyboard.press('Control+K');
  const commandSearch = page.getByRole('combobox', {
    name: 'Search workspace',
  });
  await expect(commandSearch).toBeFocused();
  await commandSearch.fill('interface');
  await expect(commandSearch).toHaveValue('interface');
  await commandSearch.press('Enter');
  await expect(
    page.getByRole('heading', { name: 'One language for every state.' }),
  ).toBeVisible();

  await page.getByLabel('Date range filter').selectOption('quarter-to-date');
  await page.keyboard.press('Control+K');
  await expect(commandSearch).toBeFocused();
  await commandSearch.fill('appearance');
  await expect(commandSearch).toHaveValue('appearance');
  await commandSearch.press('Enter');
  await expect(
    page.getByRole('heading', { name: 'Make the workspace yours' }),
  ).toBeVisible();
  await page.getByRole('radio', { name: /Dark/ }).check();
  await page.getByRole('radio', { name: /Reduce motion/ }).check();
  await page
    .getByRole('button', { name: 'Close appearance preferences' })
    .click();

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduced');
  await expect(page.getByLabel('Date range filter')).toHaveValue(
    'quarter-to-date',
  );

  const stored = await page.evaluate(
    (key) => localStorage.getItem(key),
    preferenceKey,
  );
  expect(Object.keys(JSON.parse(stored ?? '{}')).sort()).toEqual([
    'datePreset',
    'motion',
    'theme',
  ]);
  expect(stored).not.toContain(organizationName);
  expect(stored).not.toContain('Identity Test Owner');
  expect(stored).not.toContain('appearance');
});

test('documents states in a responsive, landmark-safe shell', async ({
  page,
}, testInfo) => {
  await signInAndCreateOrganization(page, testInfo, 'Visual');
  await page.goto('/workspace/components');
  await expect(
    page.getByRole('heading', { name: 'One language for every state.' }),
  ).toBeVisible();

  await expect(page.getByRole('main')).toBeVisible();
  const expectedDisplay = navigationDisplay[
    testInfo.project.name
  ] as NavigationDisplay;
  await expect(page.locator('.sidebar')).toHaveCSS(
    'display',
    expectedDisplay.sidebar,
  );
  await expect(page.locator('.mobile-navigation')).toHaveCSS(
    'display',
    expectedDisplay.mobile,
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);

  await expect(page).toHaveScreenshot('workspace-patterns.png', {
    animations: 'disabled',
    mask: [page.locator('aad-workspace-filter-bar .context-field')],
    maskColor: '#dfe6e2',
  });

  await expect(
    page.getByRole('alert').filter({ hasText: 'Action failed' }),
  ).toBeVisible();

  const email = page.getByLabel('Work email');
  await email.fill('not-an-email');
  await page.getByRole('button', { name: 'Validate field' }).click();
  await expect(email).toHaveAttribute('aria-invalid', 'true');
  await expect(
    page.getByText('Enter a valid work email address.'),
  ).toBeVisible();

  const dialogTrigger = page.getByRole('button', { name: 'Open dialog' });
  await dialogTrigger.click();
  const dialog = page.getByRole('dialog', {
    name: 'Confirm a focused decision',
  });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(dialogTrigger).toBeFocused();
});
