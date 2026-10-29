import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fixture, login, disposableDatabase, consoleURL } from './support/fixtures.js';
test('schema, Swarm and Dokploy screens send explicit selections and honest native status', async ({
  page,
}) => {
  test.setTimeout(90000);
  const account = await fixture(),
    db = disposableDatabase(),
    serverId = randomUUID(),
    connectionId = randomUUID(),
    profileVersionId = randomUUID(),
    resourceId = randomUUID(),
    localDestination = randomUUID(),
    remoteDestination = randomUUID(),
    localRepository = randomUUID(),
    remoteRepository = randomUUID(),
    pointId = randomUUID(),
    jobId = randomUUID();
  await login(page, account);
  try {
    await db.pool.query('update users set two_factor_enabled=true where id=$1', [account.userId]);
    await db.pool.query(
      'update auth_sessions set reauthenticated_at=now(),mfa_verified_at=now() where user_id=$1',
      [account.userId],
    );
  } finally {
    await db.close();
  }
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  let pgSelection: unknown, dockerSelection: unknown, nativeSelection: unknown;
  let pgPlan: unknown,
    restoreSelection: unknown,
    copySelection: unknown,
    showPoint = false;
  await page.route('**/api/runtime/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/destinations'))
      return route.fulfill({
        json: {
          capturedAt: new Date().toISOString(),
          items: [
            {
              repositoryId: localRepository,
              name: 'Principal indisponível',
              status: 'falhou',
              verifiedAt: null,
              snapshotId: null,
            },
            {
              repositoryId: remoteRepository,
              name: 'Cópia externa',
              status: 'concluida',
              verifiedAt: new Date().toISOString(),
              snapshotId: 'a'.repeat(64),
            },
          ],
        },
      });
    if (path.includes('/executions/'))
      return route.fulfill({ json: { status: 'concluida', events: [] } });
    if (path.endsWith('/restore-postgresql')) restoreSelection = route.request().postDataJSON();
    if (path.endsWith('/replicate')) copySelection = route.request().postDataJSON();
    return route.fulfill({ json: { executionId: jobId } });
  });
  await page.route('**/api/configuration/options?**', (route) =>
    route.fulfill({
      json: {
        items:
          new URL(route.request().url()).searchParams.get('kind') === 'destinations'
            ? [
                {
                  id: localDestination,
                  label: 'Local privado',
                  detail: 'local',
                  serverId: null,
                  destinationKind: 'local',
                  localCapture: true,
                },
                {
                  id: remoteDestination,
                  label: 'Drive externo',
                  detail: 'google_drive',
                  serverId: null,
                  destinationKind: 'google_drive',
                },
              ]
            : [
                {
                  id: serverId,
                  label: 'Servidor de teste',
                  detail: 'Origem aprovada',
                  serverId: null,
                },
              ],
        total: 1,
      },
    }),
  );
  await page.route('**/api/postgresql/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/connections'))
      return route.fulfill({
        json: {
          items: [
            {
              id: connectionId,
              serverId,
              name: 'Banco compartilhado',
              host: '127.0.0.1',
              port: 5432,
              username: 'backup',
              sslMode: 'disable',
            },
          ],
        },
      });
    if (path.endsWith('/discover'))
      return route.fulfill({ json: { databases: [{ name: 'postgres' }], serverMajor: 17 } });
    if (path.endsWith('/schemas'))
      return route.fulfill({
        json: {
          schemas: [
            { name: 'apbling', selectable: true },
            { name: 'auth', selectable: false },
          ],
          limitation: 'Schemas gerenciados exigem revisão de dependências.',
        },
      });
    if (path.endsWith('/select')) {
      pgSelection = route.request().postDataJSON();
      return route.fulfill({ json: { profileVersionId, resourceId } });
    }
    if (path.endsWith('/plans')) {
      pgPlan = route.request().postDataJSON();
      showPoint = true;
      return route.fulfill({ json: { id: randomUUID() } });
    }
    return route.fulfill({
      json: {
        plans: [],
        points: showPoint
          ? [
              {
                id: pointId,
                database: 'postgres',
                capturedAt: new Date().toISOString(),
                snapshotId: 'a'.repeat(64),
                verification: 'verified',
              },
            ]
          : [],
        restores: [],
      },
    });
  });
  await page.goto(consoleURL + '/postgresql');
  await page.getByLabel('Conexão guardada', { exact: true }).selectOption(connectionId);
  await page.getByRole('button', { name: 'Testar e descobrir bancos', exact: true }).click();
  await page.getByRole('button', { name: 'postgres', exact: true }).click();
  await page.getByLabel('apbling', { exact: true }).check();
  await expect(page.getByLabel('auth (global ou dependente)', { exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Usar schemas selecionados', exact: true }).click();
  await expect(page.getByLabel('Nome do plano')).toHaveValue('Backup postgres · apbling');
  expect(pgSelection).toMatchObject({ connectionId, database: 'postgres', schemas: ['apbling'] });
  await page.getByLabel('Destino local Restic', { exact: true }).selectOption(localDestination);
  await expect(
    page.getByLabel('Destino local Restic', { exact: true }).locator('option'),
  ).toHaveCount(2);
  await page.getByLabel('Drive externo google_drive', { exact: true }).check();
  await page.getByRole('button', { name: 'Criar plano de backup', exact: true }).click();
  await expect
    .poll(() => pgPlan)
    .toMatchObject({
      destinationId: localDestination,
      destinationIds: [localDestination, remoteDestination],
    });
  await page.getByText('Cópias e resultados por destino', { exact: true }).click();
  await expect(page.getByText('Cópia verificada', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Repetir cópia', exact: true }).click();
  await expect
    .poll(() => copySelection)
    .toMatchObject({ recoveryPointId: pointId, repositoryId: localRepository });
  await page.getByRole('button', { name: 'Restaurar em banco novo', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Criar banco e restaurar', exact: true }),
  ).toBeDisabled();
  await page
    .getByLabel('Cópia verificada para restaurar', { exact: true })
    .selectOption(remoteRepository);
  await page.getByRole('button', { name: 'Criar banco e restaurar', exact: true }).click();
  await expect
    .poll(() => restoreSelection)
    .toMatchObject({
      recoveryPointId: pointId,
      repositoryId: remoteRepository,
      targetDatabase: 'postgres_recuperado',
    });
  await expect(
    page.getByRole('button', { name: 'Restaurar em banco novo', exact: true }),
  ).toBeFocused();
  const evidence = resolve(
    '../.superpowers/sdd/2026-10-28-backup-platform/resource-destinations-evidence',
  );
  await mkdir(evidence, { recursive: true });
  for (const [name, width, height] of [
    ['desktop', 1440, 900],
    ['tablet', 768, 1024],
    ['mobile', 390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBe(true);
    await page.screenshot({
      path: resolve(evidence, `${name}-copies.png`),
      fullPage: true,
      animations: 'disabled',
    });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route('**/api/docker/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/catalog'))
      return route.fulfill({
        json: {
          capturedAt: new Date().toISOString(),
          containers: [],
          volumes: [],
          directories: [],
          services: [
            { id: 'abcdef123', name: 'Grupo API', version: 4, environmentKeys: ['DATABASE_URL'] },
          ],
        },
      });
    if (path.endsWith('/select')) {
      dockerSelection = route.request().postDataJSON();
      return route.fulfill({ json: { profileVersionId, resourceId } });
    }
    return route.fulfill({ json: { plans: [], points: [], restores: [] } });
  });
  await page.goto(consoleURL + '/docker');
  await page.getByLabel('Servidor com agente Docker').selectOption(serverId);
  await page.getByLabel('Tipo de recurso').selectOption('swarm');
  await page.getByLabel('Nome do grupo').fill('apbling');
  await page.getByLabel('Grupo API', { exact: true }).check();
  await page.getByLabel(/Revisei o comando de inicialização/).check();
  await page.getByRole('button', { name: 'Selecionar grupo Swarm', exact: true }).click();
  await expect(page.getByRole('heading', { name: '2. Proteger apbling' })).toBeVisible();
  expect(dockerSelection).toMatchObject({
    serverId,
    kind: 'swarm',
    identity: 'apbling',
    services: [
      {
        id: 'abcdef123',
        role: 'api',
        preserveEnvironmentKeys: ['DATABASE_URL'],
        startupReviewed: true,
      },
    ],
  });
  await page.route('**/api/dokploy/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/connections'))
      return route.fulfill({
        json: {
          items: [
            {
              id: connectionId,
              serverId,
              name: 'Dokploy teste',
              endpoint: 'https://dokploy.example.test/',
            },
          ],
        },
      });
    if (path.endsWith('/discover'))
      return route.fulfill({
        json: {
          version: '0.29.13',
          supported: true,
          resources: [
            {
              id: 'pg-fixture',
              kind: 'postgres',
              name: 'PostgreSQL nativo',
              appName: 'postgres-fixture',
              project: 'Projeto',
              environment: 'Produção',
              mounts: [],
            },
          ],
          limitations: ['Restore nativo exige administração Dokploy nesta versão.'],
        },
      });
    if (path.endsWith('/configurations'))
      return route.fulfill({
        json: {
          items: [
            {
              id: 'native-fixture',
              kind: 'postgres',
              resourceId: 'pg-fixture',
              resourceType: 'postgres',
              name: 'Backup nativo S3',
              destinationId: 's3-fixture',
              prefix: 'isolated',
              enabled: false,
              schedule: '0 3 * * *',
              volumeName: null,
              turnOff: false,
            },
          ],
        },
      });
    if (path.endsWith('/run')) {
      nativeSelection = route.request().postDataJSON();
      return route.fulfill({
        status: 202,
        json: { id: randomUUID(), status: 'pending_observation' },
      });
    }
    return route.fulfill({ json: { items: [] } });
  });
  await page.goto(consoleURL + '/dokploy');
  await page.getByLabel('Conexão guardada', { exact: true }).selectOption(connectionId);
  await page.getByRole('button', { name: 'Descobrir recursos', exact: true }).click();
  await page.getByRole('button', { name: 'Ver backups configurados', exact: true }).click();
  await page.getByRole('button', { name: 'Executar backup nativo', exact: true }).click();
  await expect(
    page.getByText('Solicitação registrada. Acompanhe o arquivo e o resultado.', { exact: true }),
  ).toBeVisible();
  expect(nativeSelection).toMatchObject({
    connectionId,
    kind: 'postgres',
    configurationId: 'native-fixture',
    resourceId: 'pg-fixture',
    resourceType: 'postgres',
  });
  await expect(
    page.getByText(
      'Arquivo encontrado no destino não comprova integridade nem ensaio de restauração.',
    ),
  ).toBeVisible();
  // Real catalog persistence: this uses disposable SMB credentials, not the company NAS.
  await page.goto(consoleURL + '/destinations');
  await expect(page.getByRole('button', { name: 'Usar tema escuro', exact: true })).toBeEnabled({
    timeout: 30000,
  });
  await page.getByRole('button', { name: 'Cadastrar destino', exact: true }).click();
  await page.getByLabel('Nome', { exact: true }).fill('Storage preparado para instalação');
  await page.getByLabel('Hostname ou endereço', { exact: true }).fill('192.168.3.52');
  await page.getByRole('combobox', { name: 'Protocolo', exact: true }).selectOption('smb');
  await expect(
    page.getByRole('combobox', { name: 'Protocolo', exact: true }).locator('option[value="pbs"]'),
  ).toHaveCount(0);
  await page
    .getByRole('combobox', { name: 'Mecanismo de backup', exact: true })
    .selectOption('restic');
  await page.getByLabel('Pasta dedicada', { exact: true }).fill('Sistemas/APBackup');
  await page.getByLabel('Compartilhamento SMB', { exact: true }).fill('01 - Backup Remotos');
  await page.getByLabel('Porta (0 usa o padrão)', { exact: true }).fill('445');
  await page.getByLabel('Usuário de acesso', { exact: true }).fill('fixture-only');
  await page.getByLabel('Senha de acesso', { exact: true }).fill('disposable-access-password');
  await page
    .getByLabel('Senha de criptografia do repositório Restic', { exact: true })
    .fill('disposable-repository-password');
  await page.getByRole('button', { name: 'Salvar', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Usar tema escuro', exact: true })).toBeEnabled({
    timeout: 30000,
  });
  await page
    .getByRole('button', { name: 'Editar Storage preparado para instalação', exact: true })
    .click();
  await expect(page.getByLabel('Compartilhamento SMB', { exact: true })).toHaveValue(
    '01 - Backup Remotos',
  );
  await expect(page.getByLabel('Pasta dedicada', { exact: true })).toHaveValue('Sistemas/APBackup');
  await expect(page.getByLabel('Senha de acesso', { exact: true })).toHaveValue('');
  await expect(
    page.getByLabel('Senha de criptografia do repositório Restic', { exact: true }),
  ).toHaveValue('');
  await page.getByRole('button', { name: 'Cancelar', exact: true }).click();
  expect(errors).toEqual([]);
});
