import { expect, test } from '@playwright/test';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:https';
import { createRequire } from 'node:module';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';
import { coordinatorTick } from '../../apps/coordinator/src/coordinator.js';
import { consoleURL, fixture, login, totp, disposableDatabase } from './support/fixtures.js';
test('browser configures PostgreSQL, backs up and restores real data through TLS agent and persists across reload', async ({
  page,
}) => {
  test.setTimeout(180000);
  const db = disposableDatabase(),
    account = await fixture(1),
    databaseURL = new URL(process.env.TEST_DATABASE_URL!),
    name = 'browser_' + randomBytes(4).toString('hex'),
    target = name + '_recovered',
    workerName = 'apbackup-browser-worker-' + randomUUID(),
    directory = resolve('test-results/postgresql-browser'),
    evidence = resolve('../.superpowers/sdd/2026-10-28-backup-platform/resource-pg-evidence');
  await mkdir(directory, { recursive: true });
  await mkdir(evidence, { recursive: true });
  await db.pool.query(`create database "${name}"`);
  const sourceURL = new URL(databaseURL);
  sourceURL.pathname = '/' + name;
  const source = new pg.Client({ connectionString: sourceURL.href });
  await source.connect();
  await source.query(
    "create table records(id bigserial primary key, value text);insert into records(value) values('prova de recuperação'),('dados preservados')",
  );
  await source.end();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  let worker: ReturnType<typeof spawn> | undefined,
    tick: ReturnType<typeof setInterval> | undefined,
    proxy: ReturnType<typeof createServer> | undefined;
  try {
    await login(page, account);
    await page.goto(consoleURL + '/security');
    await page.getByLabel('Senha atual', { exact: true }).fill(account.password);
    await page.getByRole('button', { name: 'Configurar autenticador', exact: true }).click();
    const secret = await page.getByLabel('Chave de configuração').inputValue();
    await page.getByLabel('Guardei os códigos de recuperação em local seguro.').check();
    await page.getByLabel('Código do autenticador', { exact: true }).fill(totp(secret));
    await page.getByRole('button', { name: 'Confirmar ativação', exact: true }).click();
    await expect(
      page.getByText('Autenticação em duas etapas ativa', { exact: true }),
    ).toBeVisible();
    await page.getByLabel('Senha atual', { exact: true }).fill(account.password);
    await page.getByLabel('Código do autenticador', { exact: true }).fill(totp(secret));
    await page.getByRole('button', { name: 'Confirmar identidade', exact: true }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Identidade confirmada' }),
    ).toBeVisible();
    const server = (
      await db.pool.query<{ id: string }>('select id from servers where organization_id=$1', [
        account.organizationId,
      ])
    ).rows[0]!;
    const invite = await page.request.post(consoleURL + '/api/agents/invitations', {
      headers: { origin: consoleURL },
      data: { serverId: server.id },
    });
    expect(invite.ok()).toBe(true);
    const invitation = (await invite.json()) as { enrollment: string };
    const enroll = await page.request.post(consoleURL + '/api/agents/enroll', {
      data: { enrollment: invitation.enrollment, externalIdentity: workerName },
    });
    expect(enroll.ok()).toBe(true);
    const agent = (await enroll.json()) as {
      agentId: string;
      organizationId: string;
      identity: string;
    };
    const certResult = spawnSync(
      'docker',
      [
        'run',
        '--rm',
        '--entrypoint',
        'openssl',
        '--mount',
        `type=bind,source=${directory},target=/certs`,
        'apbackup-postgresql-runtime:17',
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-keyout',
        '/certs/key.pem',
        '-out',
        '/certs/cert.pem',
        '-subj',
        '/CN=host.docker.internal',
        '-addext',
        'subjectAltName=DNS:host.docker.internal',
      ],
      { encoding: 'utf8' },
    );
    expect(certResult.status, certResult.stderr).toBe(0);
    proxy = createServer(
      {
        key: await readFile(resolve(directory, 'key.pem')),
        cert: await readFile(resolve(directory, 'cert.pem')),
      },
      async (req, res) => {
        if (
          ![
            '/api/agents/poll',
            '/api/agents/results',
            '/api/agents/authorize',
            '/api/agents/postgresql-context',
          ].includes(req.url ?? '')
        ) {
          res.writeHead(404).end();
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const response = await fetch(consoleURL + req.url, {
          method: 'POST',
          headers: {
            authorization: req.headers.authorization ?? '',
            'content-type': 'application/json',
          },
          body: Buffer.concat(chunks),
        });
        res
          .writeHead(response.status, {
            'content-type': 'application/json',
            'cache-control': 'no-store',
          })
          .end(Buffer.from(await response.arrayBuffer()));
      },
    );
    await new Promise<void>((done) => proxy!.listen(0, '0.0.0.0', done));
    const address = proxy.address();
    if (!address || typeof address === 'string') throw new Error('TLS proxy unavailable');
    const require = createRequire(import.meta.url),
      { build } = createRequire(require.resolve('tsx'))('esbuild');
    await build({
      entryPoints: ['tests/e2e/support/postgresql-worker.ts'],
      outfile: resolve(directory, 'worker.mjs'),
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node24',
      external: ['pg-native'],
      banner: {
        js: "import {createRequire as _createRequire} from 'node:module';const require=_createRequire(import.meta.url);",
      },
    });
    const config = Buffer.from(
      JSON.stringify({
        ...agent,
        baseURL: `https://host.docker.internal:${address.port}`,
        forwardPort: Number(databaseURL.port),
      }),
    ).toString('base64');
    let workerError = '';
    worker = spawn(
      'docker',
      [
        'run',
        '--rm',
        '--name',
        workerName,
        '--label',
        'apbackup.disposable-test=true',
        '--network',
        `container:${process.env.TEST_POSTGRES_CONTAINER}`,
        '--mount',
        `type=bind,source=${directory},target=/tests,readonly`,
        '-e',
        `PG_BROWSER_WORKER=${config}`,
        '-e',
        'NODE_EXTRA_CA_CERTS=/tests/cert.pem',
        'apbackup-postgresql-runtime:17',
        '/tests/worker.mjs',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    worker.stderr?.on('data', (chunk) => {
      workerError += String(chunk);
    });
    let busy = false;
    tick = setInterval(() => {
      if (busy) return;
      busy = true;
      void coordinatorTick(db, 'pg-browser').finally(() => {
        busy = false;
      });
    }, 300);
    await page.goto(consoleURL + '/postgresql');
    await expect(page.getByRole('heading', { name: 'PostgreSQL', exact: true })).toBeVisible();
    await page.getByLabel('Servidor', { exact: true }).selectOption(server.id);
    await page.getByLabel('Host aprovado').fill('127.0.0.1');
    await page.getByLabel('Porta', { exact: true }).fill(databaseURL.port);
    await page.getByLabel('Usuário PostgreSQL').fill(databaseURL.username);
    await page.getByLabel('Senha PostgreSQL').fill(databaseURL.password);
    await page.getByLabel('Transporte').selectOption('disable');
    await page.getByRole('button', { name: 'Guardar conexão', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Testar e descobrir bancos' })).toBeEnabled();
    await page.getByRole('button', { name: 'Testar e descobrir bancos' }).click();
    await page.getByRole('button', { name, exact: true }).click();
    await page.getByText('Cadastrar destino local', { exact: true }).click();
    await page
      .getByLabel('Senha de criptografia Restic')
      .fill(randomBytes(24).toString('base64url'));
    await page.getByRole('button', { name: 'Guardar destino local', exact: true }).click();
    await expect(page.getByLabel('Destino local Restic')).not.toHaveValue('');
    await page.getByRole('button', { name: 'Criar plano de backup', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Executar backup', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Executar backup', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Restaurar em banco novo', exact: true }),
      workerError,
    ).toBeVisible({ timeout: 60000 });
    await page.reload();
    await expect(
      page.getByRole('button', { name: 'Restaurar em banco novo', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Restaurar em banco novo', exact: true }).click();
    await page.getByLabel('Nome do banco novo').fill(target);
    await page.getByRole('button', { name: 'Criar banco e restaurar', exact: true }).click();
    await expect(page.getByText('Última ação: Concluída', { exact: true })).toBeVisible({
      timeout: 60000,
    });
    await page.reload();
    await expect(page.getByText(target, { exact: true })).toBeVisible();
    const recoveredURL = new URL(databaseURL);
    recoveredURL.pathname = '/' + target;
    const recovered = new pg.Client({ connectionString: recoveredURL.href });
    await recovered.connect();
    expect((await recovered.query('select value from records order by id')).rows).toEqual([
      { value: 'prova de recuperação' },
      { value: 'dados preservados' },
    ]);
    expect(
      (await recovered.query("insert into records(value) values('sequence') returning id")).rows[0]
        ?.id,
    ).toBe('3');
    await recovered.end();
    for (const [viewport, width, height] of [
      ['desktop', 1440, 900],
      ['tablet', 768, 1024],
      ['mobile', 390, 844],
    ] as const) {
      await page.setViewportSize({ width, height });
      for (const dark of [false, true]) {
        await page.evaluate((value) => {
          document.documentElement.classList.toggle('dark', value);
          window.scrollTo(0, 0);
          (document.activeElement as HTMLElement)?.blur();
        }, dark);
        await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
        await expect(
          page.getByRole('button', { name: 'Executar backup', exact: true }),
        ).toBeEnabled();
        await expect(
          page.getByRole('button', { name: 'Restaurar em banco novo', exact: true }),
        ).toBeEnabled();
        expect(
          await page
            .locator('.skip-link')
            .evaluate((element) => element.getBoundingClientRect().bottom),
        ).toBeLessThan(0);
        if (width >= 640) expect((await page.locator('.sidebar').boundingBox())?.y).toBe(0);
        await page.screenshot({
          animations: 'disabled',
          path: resolve(evidence, `${viewport}-${dark ? 'dark' : 'light'}.png`),
          fullPage: true,
        });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
      }
    }
    expect(errors).toEqual([]);
  } finally {
    if (tick) clearInterval(tick);
    if (worker) {
      spawnSync('docker', ['stop', '-t', '1', workerName], { stdio: 'ignore' });
      worker.kill();
    }
    await new Promise<void>((done) => {
      if (proxy) proxy.close(() => done());
      else done();
    });
    for (const database of [name, target])
      await db.pool.query(`drop database if exists "${database}" with (force)`);
    await db.close();
    await rm(resolve(directory, 'key.pem'), { force: true });
  }
});
