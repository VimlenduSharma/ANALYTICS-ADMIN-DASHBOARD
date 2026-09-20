import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { signInAndCreateOrganization } from './test-helpers';

const wcagTags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

test('governs access, credentials, policy, and profile without leaking secrets', async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const workspace = await signInAndCreateOrganization(
    page,
    testInfo,
    'Governance',
  );
  const governanceUrl = `/organizations/${workspace.organizationId}/governance`;

  await page.goto(governanceUrl);
  await expect(
    page.getByRole('heading', { name: 'Governance, without blind spots.' }),
  ).toBeVisible();
  await expect(page.locator('.mobile-navigation')).toHaveCSS(
    'display',
    testInfo.project.name === 'mobile-chromium' ? 'grid' : 'none',
  );
  await expect(page.getByText('AES-256-GCM', { exact: true })).toBeVisible();
  await expectWcag(page);

  await page.getByLabel('New orders webhook').fill('Primary commerce feed');
  await page.getByRole('button', { name: 'Create source' }).click();
  const credentialDialog = page.getByRole('dialog', {
    name: 'Copy this signing secret now',
  });
  await expect(credentialDialog).toBeVisible();
  const secret = await credentialDialog
    .getByLabel('Signing secret')
    .inputValue();
  expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const confirmCredential = credentialDialog.getByRole('button', {
    name: 'I stored the secret',
  });
  await confirmCredential.focus();
  await page.keyboard.press('Enter');
  await expect(credentialDialog).toBeHidden();
  await expect(
    page.getByText('Primary commerce feed', { exact: true }),
  ).toBeVisible();

  await page
    .getByLabel('Work email')
    .fill(`governance-${testInfo.project.name}@example.test`);
  await page.getByLabel('Starting role').selectOption('ANALYST');
  await page.getByRole('button', { name: 'Create invitation' }).click();
  const invitationDialog = page.getByRole('dialog', {
    name: 'Share the acceptance link securely',
  });
  await expect(invitationDialog).toBeVisible();
  const acceptanceLink = invitationDialog.getByLabel('Acceptance link');
  await expect(acceptanceLink).toHaveValue(/\/accept-invitation#token=/);
  const invitationUrl = await acceptanceLink.inputValue();
  await invitationDialog.getByRole('button', { name: 'Done' }).focus();
  await page.keyboard.press('Enter');

  await page.getByLabel('Reporting timezone').fill('Asia/Kolkata');
  await page.getByRole('button', { name: 'Save policy' }).click();
  await expect(
    page.getByText('Governance policy saved', { exact: true }),
  ).toBeVisible();

  await expect(page.locator('aad-toast-region .toast')).toHaveCount(0, {
    timeout: 6_000,
  });

  await page.evaluate(() => window.scrollTo(0, 0));
  await expectNoPageOverflow(page);
  await expect(page).toHaveScreenshot('governance-control.png', {
    animations: 'disabled',
    mask: [
      page.locator('.user-chip'),
      page.locator('.role-badge'),
      page.getByLabel('Organization filter'),
      page.locator('.source-card p'),
      page.locator('.source-card small'),
      page.locator('.invitation-list small'),
      page.locator('.audit-list'),
    ],
    maskColor: '#dfe6e2',
    maxDiffPixels: 1_000,
  });

  await page.reload();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText(secret, { exact: true })).toHaveCount(0);
  await expect(
    page.getByText('Primary commerce feed', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Switch to dark theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expectWcag(page);

  await page.goto('/profile');
  await expect(
    page.getByRole('heading', { name: 'Make the workspace feel local.' }),
  ).toBeVisible();
  await page.getByLabel('Timezone').fill('Europe/London');
  await page.getByLabel('Locale').fill('en-GB');
  const saveProfile = page.getByRole('button', { name: 'Save profile' });
  await saveProfile.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Profile saved', { exact: true })).toBeVisible();
  await expectWcag(page);

  await page.goto(invitationUrl);
  await expect(page).not.toHaveURL(/#token=/);
  await expect(
    page.getByRole('heading', { name: 'Accept team invitation' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(
    page.getByText('This invitation belongs to another email address'),
  ).toBeVisible();
  await expectWcag(page);
});

async function expectWcag(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(wcagTags).analyze();
  expect(
    results.violations.map(({ help, id, nodes }) => ({
      help,
      id,
      targets: nodes.map(({ target }) => target),
    })),
  ).toEqual([]);
}

async function expectNoPageOverflow(page: Page): Promise<void> {
  const layout = await page.evaluate(() => ({
    offenders: [...document.querySelectorAll<HTMLElement>('*')]
      .filter(
        (element) =>
          element.getBoundingClientRect().right > innerWidth + 1 &&
          !element.closest('.table-wrap'),
      )
      .map((element) => `${element.tagName.toLowerCase()}.${element.className}`)
      .slice(0, 8),
    scrollWidth: document.documentElement.scrollWidth,
    viewportWidth: innerWidth,
  }));
  expect(layout.offenders, JSON.stringify(layout)).toEqual([]);
  expect(layout.scrollWidth, JSON.stringify(layout)).toBeLessThanOrEqual(
    layout.viewportWidth,
  );
}
