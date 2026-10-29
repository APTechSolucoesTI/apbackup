import { expect, test } from '@playwright/test';
import { consoleURL, disposableDatabase, fixture, login, totp } from './support/fixtures.js';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
test('operator enrolls MFA and configures a persistent origin through validated forms', async ({
  page,
}) => {
  test.setTimeout(150000);
  const account = await fixture();
  await login(page, account);
  await page.getByRole('link', { name: 'Servidores', exact: true }).click();
  await page.getByRole('link', { name: 'Confirmar identidade para configurar' }).click();
  await page.getByLabel('Senha atual', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Configurar autenticador', exact: true }).click();
  const secret = await page.getByLabel('Chave de configuração').inputValue();
  await page.getByLabel('Guardei os códigos de recuperação em local seguro.').check();
  await page.getByLabel('Código do autenticador', { exact: true }).fill(totp(secret));
  await page.getByRole('button', { name: 'Confirmar ativação', exact: true }).click();
  await expect(page.getByText('Autenticação em duas etapas ativa', { exact: true })).toBeVisible();
  await page.getByLabel('Senha atual', { exact: true }).fill(account.password);
  await page.getByLabel('Código do autenticador', { exact: true }).fill(totp(secret));
  await page.getByRole('button', { name: 'Confirmar identidade', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Identidade confirmada' })).toBeVisible();
  await page.getByRole('link', { name: 'Servidores', exact: true }).click();
  await page.getByRole('button', { name: 'Cadastrar servidor', exact: true }).click();
  await page.getByRole('button', { name: 'Salvar', exact: true }).click();
  await expect(page.getByText('Informe um nome.', { exact: true })).toBeVisible();
  await page.getByLabel('Nome', { exact: true }).fill('Origem de validação');
  await page
    .getByLabel('Identificação externa', { exact: true })
    .fill('host:fixture-configuration');
  await page.getByLabel('Hostname ou endereço', { exact: true }).fill('source.example.test');
  await page.getByRole('button', { name: 'Salvar', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('Origem de validação', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('Origem de validação', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Editar Origem de validação', exact: true }).click();
  await page.getByLabel('Nome', { exact: true }).fill('Origem revisada');
  await page.getByRole('button', { name: 'Salvar', exact: true }).click();
  await expect(page.getByText('Origem revisada', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Arquivar Origem revisada', exact: true }).click();
  await page.getByRole('button', { name: 'Confirmar arquivamento', exact: true }).click();
  await expect(page.getByText('Nenhum servidor cadastrado', { exact: true })).toBeVisible();
  await page.getByLabel('Filtrar estado').selectOption('arquivado');
  await expect(page.getByText('Origem revisada', { exact: true })).toBeVisible();
  await page.goto(`${consoleURL}/destinations`);
  await page.getByRole('button', { name: 'Cadastrar destino', exact: true }).click();
  await page.getByLabel('Nome', { exact: true }).fill('NAS aguardando preparação');
  await page.getByLabel('Hostname ou endereço', { exact: true }).fill('192.168.3.52');
  await page.getByRole('button', { name: 'Salvar', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(
    page.getByRole('cell', { name: 'Aguardando configuração', exact: true }),
  ).toBeVisible();
  await page.goto(`${consoleURL}/servers`);
  await page.getByLabel('Filtrar estado').selectOption('arquivado');
  await page.getByRole('button', { name: 'Restaurar Origem revisada', exact: true }).click();
  await page.getByRole('button', { name: 'Restaurar cadastro', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.goto(`${consoleURL}/resources`);
  await page.getByRole('button', { name: 'Cadastrar recurso', exact: true }).click();
  await page.getByLabel('Nome', { exact: true }).fill('Banco de validação');
  await page.getByLabel('Identificação externa', { exact: true }).fill('database:fixture');
  await page
    .getByLabel('Servidor', { exact: true })
    .selectOption({ label: 'Origem revisada · host:fixture-configuration' });
  await page.getByRole('button', { name: 'Salvar', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.goto(`${consoleURL}/systems`);
  await page.getByRole('button', { name: 'Cadastrar sistema', exact: true }).click();
  await page.getByLabel('Nome', { exact: true }).fill('Sistema de validação');
  await page.getByLabel('Identificação externa', { exact: true }).fill('system:fixture');
  await page
    .getByLabel('Servidor', { exact: true })
    .selectOption({ label: 'Origem revisada · host:fixture-configuration' });
  await page.getByRole('checkbox', { name: 'Selecionar Banco de validação', exact: true }).check();
  await page.getByLabel('Identificação do conector', { exact: true }).fill('postgresql');
  await page.getByLabel('Versão do conector', { exact: true }).fill('1.0.0');
  await page.getByLabel('Nível de consistência').selectOption('transactional');
  await page.getByRole('checkbox', { name: 'Banco de dados', exact: true }).check();
  await page.getByRole('button', { name: 'Salvar', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Editar Sistema de validação', exact: true }).click();
  await page.getByLabel('Nome', { exact: true }).fill('Sistema revisado');
  await page.getByRole('button', { name: 'Salvar', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.goto(`${consoleURL}/plans`);
  await page.getByRole('button', { name: 'Cadastrar plano', exact: true }).click();
  await page.getByLabel('Nome', { exact: true }).fill('Plano de validação');
  await page
    .getByLabel('Versão do sistema', { exact: true })
    .selectOption({ label: 'Sistema revisado · v2 · system:fixture' });
  await page
    .getByRole('checkbox', { name: 'Selecionar NAS aguardando preparação', exact: true })
    .check();
  await page.getByRole('button', { name: 'Salvar', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('cell', { name: 'Plano de validação', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Editar Plano de validação', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Habilitar plano e agenda', exact: true }).check();
  await page.getByRole('button', { name: 'Salvar', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('aguarda configuração');
  await page.getByRole('button', { name: 'Cancelar', exact: true }).click();
  const runImport = async () => {
    const child = spawn(
      process.execPath,
      ['node_modules/tsx/dist/cli.mjs', 'scripts/import-inventory.ts', '--stdin'],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let output = '',
      errors = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      errors += chunk.toString();
    });
    child.stdin.end(
      JSON.stringify({
        baseURL: consoleURL,
        organizationId: account.organizationId,
        email: account.email,
        password: account.password,
        code: totp(secret),
        server: {
          name: 'Origem importada',
          externalIdentity: 'fixture:import',
          hostname: '192.168.3.106',
        },
        destination: { name: 'NAS importado pendente', host: '192.168.3.52' },
      }),
    );
    const code = await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => resolve(code ?? 1));
    });
    expect(errors).toBe('');
    expect(code).toBe(0);
    return JSON.parse(output) as {
      serverId: string;
      destinationId: string;
      destinationStatus: string;
    };
  };
  const imported = await runImport();
  expect(imported.destinationStatus).toBe('aguardando_configuracao');
  const fixtureDb = disposableDatabase();
  try {
    await fixtureDb.pool.query('delete from auth_rate_limits where key=$1', [
      createHash('sha256').update(`${consoleURL}:mfa:user:${account.userId}:verify`).digest('hex'),
    ]);
  } finally {
    await fixtureDb.close();
  }
  expect(await runImport()).toEqual(imported);
  const evidence = resolve('../.superpowers/sdd/2026-10-28-backup-platform/task4-evidence');
  await mkdir(evidence, { recursive: true });
  for (const [name, width, height] of [
    ['desktop', 1440, 900],
    ['tablet', 768, 1024],
    ['mobile', 390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    for (const theme of ['light', 'dark'] as const) {
      if (theme === 'dark')
        await page.getByRole('button', { name: 'Usar tema escuro', exact: true }).click();
      await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /dark/ : /^$/);
      if (name === 'mobile') {
        await page
          .getByRole('button', { name: 'Mais ações: Plano de validação', exact: true })
          .click();
        await page.getByRole('menuitem', { name: 'Editar', exact: true }).click();
      } else
        await page.getByRole('button', { name: 'Editar Plano de validação', exact: true }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await expect(page.getByLabel('Nome', { exact: true })).toHaveValue('Plano de validação');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({
        animations: 'disabled',
        path: resolve(evidence, `plan-${name}-${theme}.png`),
        fullPage: true,
      });
      await page.getByRole('button', { name: 'Cancelar', exact: true }).click();
    }
    await page.getByRole('button', { name: 'Usar tema claro', exact: true }).click();
  }
});
