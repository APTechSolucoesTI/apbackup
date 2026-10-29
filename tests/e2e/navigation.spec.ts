import { expect, test } from '@playwright/test';
import { consoleURL, fixture, login } from './support/fixtures.js';
test('real empty catalog and recoverable network failure keep context', async ({ page }) => {
  await login(page, await fixture());
  await page.getByRole('link', { name: 'Servidores', exact: true }).click();
  await expect(page.getByText('Nenhum servidor cadastrado', { exact: true })).toBeVisible();
  await page.route('**/api/console/catalog*', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: '{"error":"Falha temporária"}',
    }),
  );
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Servidores', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Tentar novamente', exact: true })).toBeVisible();
  await page.unroute('**/api/console/catalog*');
  await page.getByRole('button', { name: 'Tentar novamente', exact: true }).click();
  await expect(page.getByText('Nenhum servidor cadastrado', { exact: true })).toBeVisible();
});
test('server paging, filters and column draft enforce a visible identifier and persist by list', async ({
  page,
}) => {
  const account = await fixture(12);
  await login(page, account);
  await page.goto(`${consoleURL}/servers`);
  await expect(page.getByText('1–10 de 12', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Próxima', exact: true }).first().click();
  await expect(page.getByText('11–12 de 12', { exact: true }).first()).toBeVisible();
  await page.getByLabel('Buscar nome ou identificação').fill('Servidor 01');
  await expect(page.getByText('1–1 de 1', { exact: true }).first()).toBeVisible();
  await expect(page).toHaveURL(/page=1/);
  await page.getByRole('button', { name: 'Colunas', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'Nome', exact: true })).toBeDisabled();
  await page.getByRole('checkbox', { name: 'Identificação', exact: true }).uncheck();
  await page.getByLabel('Registros por página').selectOption('20');
  await page.getByRole('button', { name: 'Aplicar', exact: true }).click();
  await expect(page.getByRole('columnheader', { name: 'Identificação' })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('columnheader', { name: 'Identificação' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Recursos', exact: true }).click();
  await expect(page.getByRole('columnheader', { name: /Identificação/ })).toBeVisible();
  await page.getByRole('link', { name: 'Servidores', exact: true }).click();
  await expect(page).toHaveURL(/pageSize=20/);
});
