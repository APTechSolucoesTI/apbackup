import { expect, test } from '@playwright/test';
import { consoleURL, disposableDatabase, fixture, login } from './support/fixtures.js';
test('catalog rejects foreign organizations, invalid sorting and revoked memberships', async ({
  page,
}) => {
  const account = await fixture(1),
    foreign = await fixture(2);
  await login(page, account);
  const current = await page.request.get(`${consoleURL}/api/console/catalog?kind=servers`);
  expect(current.status()).toBe(200);
  expect((await current.json()).total).toBe(1);
  const denied = await page.request.get(`${consoleURL}/api/console/catalog?kind=servers`, {
    headers: { 'x-organization-id': foreign.organizationId },
  });
  expect(denied.status()).toBe(403);
  expect(await denied.json()).not.toHaveProperty('items');
  expect(
    (
      await page.request.get(`${consoleURL}/api/console/catalog?kind=servers&sort=name%3Bdelete`)
    ).status(),
  ).toBe(400);
  expect(
    (
      await page.request.get(`${consoleURL}/api/console/catalog?kind=servers&pageSize=1000`)
    ).status(),
  ).toBe(400);
  const db = disposableDatabase();
  try {
    await db.pool.query(
      'update organization_memberships set revoked_at=now() where organization_id=$1 and user_id=$2',
      [account.organizationId, account.userId],
    );
  } finally {
    await db.close();
  }
  expect((await page.request.get(`${consoleURL}/api/console/catalog?kind=servers`)).status()).toBe(
    403,
  );
  await page.goto(`${consoleURL}/servers`);
  await expect(page.getByRole('heading', { name: 'Acesso restrito', exact: true })).toBeVisible();
  await expect(page.getByText('Servidor 01', { exact: true })).toHaveCount(0);
});
test('orders Portuguese names naturally before applying server pagination', async ({ page }) => {
  const account = await fixture(),
    db = disposableDatabase();
  try {
    for (const name of ['Servidor 10', 'Servidor 2', 'Árvore', 'Zebra'])
      await db.pool.query(
        'insert into servers(organization_id,name,external_identity) values($1,$2,$2)',
        [account.organizationId, name],
      );
  } finally {
    await db.close();
  }
  await login(page, account);
  const result = await page.request.get(
    `${consoleURL}/api/console/catalog?kind=servers&sort=name&direction=asc`,
  );
  expect(result.status()).toBe(200);
  const body: unknown = await result.json();
  expect(body).toMatchObject({
    items: [{ name: 'Árvore' }, { name: 'Servidor 2' }, { name: 'Servidor 10' }, { name: 'Zebra' }],
    total: 4,
    page: 1,
    pageSize: 10,
  });
});
