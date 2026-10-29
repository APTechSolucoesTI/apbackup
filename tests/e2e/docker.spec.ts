import { expect, test } from '@playwright/test';
import { randomUUID, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:https';
import { createRequire } from 'node:module';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { coordinatorTick } from '../../apps/coordinator/src/coordinator.js';
import { consoleURL, fixture, login, totp, disposableDatabase } from './support/fixtures.js';
function docker(args: string[]) {
  const result = spawnSync('docker', args, { encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}
test('browser backs up actual container image/config/files, confirms scoped return and persists successful runtime across reload', async ({
  page,
}) => {
  test.setTimeout(240000);
  const db = disposableDatabase(),
    account = await fixture(1),
    workerName = 'apbackup-docker-browser-' + randomUUID(),
    name = 'apbackup-browser-' + randomBytes(4).toString('hex'),
    volume = name + '-data',
    directory = resolve('test-results/docker-browser'),
    evidence = resolve('../.superpowers/sdd/2026-10-28-backup-platform/resource-docker-evidence'),
    helperImage = docker(['image', 'inspect', 'node:24.21.0-bookworm-slim', '--format', '{{.Id}}']);
  await mkdir(directory, { recursive: true });
  await mkdir(evidence, { recursive: true });
  docker(['volume', 'create', '--label', 'apbackup.disposable-test=true', volume]);
  docker([
    'run',
    '--rm',
    '--mount',
    `type=volume,source=${volume},target=/data`,
    helperImage,
    'node',
    '-e',
    "require('fs').writeFileSync('/data/ação.txt','conteúdo histórico do anexo',{mode:416})",
  ]);
  const original = docker([
    'run',
    '-d',
    '--name',
    name,
    '--label',
    'apbackup.disposable-test=true',
    '--mount',
    `type=volume,source=${volume},target=/data`,
    '-p',
    '127.0.0.1::8080',
    helperImage,
    'node',
    '-e',
    "require('http').createServer((q,r)=>r.end(require('fs').readFileSync('/data/ação.txt'))).listen(8080,'0.0.0.0')",
  ]);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
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
            '/api/agents/docker-context',
            '/api/agents/docker-catalog',
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
      entryPoints: ['tests/e2e/support/docker-worker.ts'],
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
        helperImage,
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
        `DOCKER_BROWSER_WORKER=${config}`,
        '-e',
        'NODE_EXTRA_CA_CERTS=/tests/cert.pem',
        '--mount',
        'type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock',
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

    const destination = await page.request.post(consoleURL + '/api/configuration/destinations', {
      headers: { origin: consoleURL },
      data: {
        name: 'Docker browser local',
        kind: 'local',
        host: null,
        engine: 'restic',
        rootPath: 'docker_browser_' + randomBytes(4).toString('hex'),
        status: 'ativo',
        credential: { secret: randomBytes(24).toString('base64url') },
      },
    });
    expect(destination.ok()).toBe(true);
    const destinationData = (await destination.json()) as { id: string };
    await expect
      .poll(
        async () => {
          if (worker?.exitCode !== null && worker?.exitCode !== undefined)
            throw new Error(`Docker fixture worker exited: ${workerError}`);
          return (
            await db.pool.query(
              'select count(*)::int n from docker_catalogs where organization_id=$1',
              [account.organizationId],
            )
          ).rows[0]?.n;
        },
        { timeout: 30000 },
      )
      .toBe(1);
    await page.goto(consoleURL + '/docker');
    await expect(
      page.getByRole('heading', { name: 'Docker e arquivos', exact: true }),
    ).toBeVisible();
    await page.getByLabel('Servidor com agente Docker').selectOption(server.id);
    await expect(
      page.getByRole('button', { name: `Selecionar ${name}`, exact: true }),
      workerError,
    ).toBeVisible({ timeout: 30000 });
    await page.getByLabel('Buscar nome do recurso').fill(name);
    await page.getByRole('button', { name: `Selecionar ${name}`, exact: true }).click();
    await page.getByLabel('Destino local Restic').selectOption(destinationData.id);
    await page.getByRole('button', { name: 'Criar plano de backup', exact: true }).click();
    const backup = page.getByRole('button', { name: `Executar backup ${name}`, exact: true });
    await expect(backup).toBeVisible();
    await backup.click();
    await expect(
      page.getByRole('button', { name: 'Voltar aplicação sem banco', exact: true }),
      workerError,
    ).toBeVisible({ timeout: 90000 });
    // Prove a historical file return instead of cloning already-identical source data.
    docker([
      'exec',
      original,
      'node',
      '-e',
      "require('fs').writeFileSync('/data/ação.txt','versão atual preservada')",
    ]);
    await page.reload();
    await page.getByRole('button', { name: 'Voltar aplicação sem banco', exact: true }).click();
    await page.getByLabel('Digite o nome exato para confirmar a parada e o retorno').fill(name);
    await page.getByRole('button', { name: 'Confirmar restauração', exact: true }).click();
    await expect(page.getByText(/Container em execução/), workerError).toBeVisible({
      timeout: 90000,
    });
    await page.reload();
    await expect(page.getByText(/Container em execução/)).toBeVisible();
    const current = JSON.parse(docker(['inspect', name])) as {
      Id: string;
      State: { Running: boolean };
      NetworkSettings: { Ports: Record<string, { HostPort: string }[]> };
      Mounts: { Name: string }[];
    }[];
    expect(current[0]!.Id).not.toBe(original);
    expect(current[0]!.State.Running).toBe(true);
    const port = current[0]!.NetworkSettings.Ports['8080/tcp']![0]!.HostPort;
    expect(await (await fetch(`http://127.0.0.1:${port}`)).text()).toBe(
      'conteúdo histórico do anexo',
    );
    expect(
      docker([
        'run',
        '--rm',
        '--mount',
        `type=volume,source=${volume},target=/data,readonly`,
        helperImage,
        'node',
        '-e',
        "process.stdout.write(require('fs').readFileSync('/data/ação.txt'))",
      ]),
    ).toBe('versão atual preservada');
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
    // Exact disposable container IDs and their operation-labeled replacement only.
    const list = docker(['ps', '-aq', '--filter', 'label=apbackup.disposable-test=true'])
      .split(/\s+/)
      .filter(Boolean);
    for (const id of list) {
      const item = JSON.parse(docker(['inspect', id])) as {
        Id: string;
        Name: string;
        Mounts: { Name: string }[];
        Config: { Labels: Record<string, string> };
      }[];
      if (item[0]!.Id === original || item[0]!.Name === '/' + name) {
        const mounts = item[0]!.Mounts;
        docker(['rm', '-f', id]);
        for (const m of mounts)
          if (m.Name && m.Name !== volume && m.Name.startsWith('apbackup-'))
            spawnSync('docker', ['volume', 'rm', m.Name], { stdio: 'ignore' });
      }
    }
    spawnSync('docker', ['volume', 'rm', volume], { stdio: 'ignore' });
    await db.close();
    await rm(resolve(directory, 'key.pem'), { force: true });
  }
});
