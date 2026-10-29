import { expect, test } from '@playwright/test';
import { consoleURL, fixture, login, totp } from './support/fixtures.js';
test('protected console redirects to login and authenticates against persisted membership', async ({
  page,
}) => {
  await page.goto(`${consoleURL}/servers`);
  await expect(page).toHaveURL(/\/login/);
  const account = await fixture();
  await login(page, account);
  await expect(page.getByRole('heading', { name: 'Cobertura', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('Ambiente de validação', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Sair', exact: true }).click();
  await page.waitForURL('**/login');
  await expect(page).toHaveURL(/\/login/);
  await page.goto(`${consoleURL}/servers`);
  await expect(page).toHaveURL(/\/login/);
});
test('enrolls verified MFA, saves recovery codes, reauthenticates and signs in through both challenges', async ({
  page,
}) => {
  const account = await fixture();
  await login(page, account);
  await page.getByRole('link', { name: 'Segurança da conta' }).click();
  await page.getByLabel('Senha atual', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Configurar autenticador', exact: true }).click();
  const secret = await page.getByLabel('Chave de configuração').inputValue();
  expect(secret.length).toBeGreaterThan(10);
  const codes = (await page.getByLabel('Códigos de recuperação', { exact: true }).innerText())
    .trim()
    .split(/\s+/);
  await page.getByLabel('Guardei os códigos de recuperação em local seguro.').check();
  await page.getByLabel('Código do autenticador', { exact: true }).fill(totp(secret));
  await page.getByRole('button', { name: 'Confirmar ativação', exact: true }).click();
  await expect(page.getByText('Autenticação em duas etapas ativa', { exact: true })).toBeVisible();
  await page.getByLabel('Senha atual', { exact: true }).fill(account.password);
  await page.getByLabel('Código do autenticador', { exact: true }).fill(totp(secret));
  await page.getByRole('button', { name: 'Confirmar identidade', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Identidade confirmada' })).toBeVisible();
  await page.getByRole('button', { name: 'Sair', exact: true }).click();
  await page.waitForURL('**/login');
  await login(page, account);
  await expect(page.getByRole('heading', { name: 'Verifique sua identidade' })).toBeVisible();
  await page.getByLabel('Código do autenticador', { exact: true }).fill(totp(secret));
  await page.getByRole('button', { name: 'Verificar e entrar' }).click();
  await expect(page.getByRole('heading', { name: 'Cobertura', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Sair', exact: true }).click();
  await page.waitForURL('**/login');
  await login(page, account);
  await page.getByRole('button', { name: 'Usar código de recuperação' }).click();
  await page.getByLabel('Código de recuperação', { exact: true }).fill(codes[0]!);
  await page.getByRole('button', { name: 'Verificar e entrar' }).click();
  await expect(page.getByRole('heading', { name: 'Cobertura', exact: true })).toBeVisible();
});
