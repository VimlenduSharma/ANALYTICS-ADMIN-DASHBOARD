import { expect, type Page, type TestInfo } from '@playwright/test';

export interface TestWorkspace {
  csrfToken: string;
  name: string;
  organizationId: string;
}

export async function signInAndCreateOrganization(
  page: Page,
  testInfo: TestInfo,
  purpose: string,
): Promise<TestWorkspace> {
  await page.goto('/');
  await page.getByRole('link', { name: 'Sign in securely' }).click();
  await page.getByRole('link', { name: 'Continue as test identity' }).click();
  await expect(
    page.getByRole('heading', { name: 'Workspace overview' }),
  ).toBeVisible();

  const name = ['Workspace', purpose, testInfo.project.name, Date.now()].join(
    ' ',
  );
  await page.getByLabel('Organization name').fill(name);
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

  const session = await page.evaluate(async () => {
    const response = await fetch('/api/v1/auth/session');
    return response.json() as Promise<{
      csrfToken: string;
      organizations: Array<{ id: string }>;
    }>;
  });
  const organizationId = session.organizations[0]?.id;
  if (!organizationId) throw new Error('Test workspace was not returned');
  return { csrfToken: session.csrfToken, name, organizationId };
}
