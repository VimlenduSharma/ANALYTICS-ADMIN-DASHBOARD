import { expect, test } from '@playwright/test';

test('completes OIDC sign-in and protects tenant administration', async ({
  page,
}, testInfo) => {
  await page.goto('/');

  await expect(page).toHaveTitle('Sign in | Analytics Admin');
  await expect(
    page.getByRole('heading', { name: 'Sales and operations, in context.' }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Switch to dark theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  await page.getByRole('link', { name: 'Sign in securely' }).click();
  await expect(
    page.getByRole('heading', { name: 'Confirm test identity' }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Continue as test identity' }).click();

  await expect(
    page.getByRole('heading', { name: 'Workspace overview' }),
  ).toBeVisible();
  await expect(
    page.getByText('The API and data services responded to the live check.'),
  ).toBeVisible();

  await page
    .getByLabel('Organization name')
    .fill(`Browser Gate ${testInfo.project.name} ${Date.now()}`);
  const creationResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().endsWith('/api/v1/organizations'),
  );
  await page.getByRole('button', { name: 'Create workspace' }).click();
  expect((await creationResponse).status()).toBe(201);

  await expect(
    page.getByRole('heading', { name: 'Team access' }),
  ).toBeVisible();
  await expect(page.getByText('Your role · OWNER')).toBeVisible();
  await expect(
    page.getByText('Identity Test Owner', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Recent access events' }),
  ).toBeVisible();
  const authorizedTeamUrl = page.url();

  await page.goto('/organizations/00000000-0000-4000-8000-000000000001/team');
  await expect(
    page.getByRole('heading', {
      name: 'This workspace is outside your role.',
    }),
  ).toBeVisible();

  await page.goto(authorizedTeamUrl);
  await expect(
    page.getByRole('heading', { name: 'Team access' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(
    page.getByRole('heading', { name: 'Sales and operations, in context.' }),
  ).toBeVisible();

  await page.goto(authorizedTeamUrl);
  await expect(
    page.getByRole('heading', { name: 'Sales and operations, in context.' }),
  ).toBeVisible();
});

test('shows a predictable recovery state for an invalid callback', async ({
  page,
}) => {
  await page.goto('/api/v1/auth/callback?state=invalid');

  await expect(
    page.getByRole('alert').filter({
      hasText: 'The identity provider response could not be verified.',
    }),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Sign in securely' }),
  ).toBeVisible();
});
