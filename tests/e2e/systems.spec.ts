import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fixture, login, disposableDatabase, consoleURL } from './support/fixtures.js';

test('system folders show persisted components and manual backup at desktop, tablet and mobile', async ({
  page,
}) => {
  test.setTimeout(90000);
  const account = await fixture(),
    db = disposableDatabase(),
    org = account.organizationId,
    server = randomUUID(),
    resource = randomUUID(),
    profile = randomUUID(),
    version = randomUUID(),
    plan = randomUUID(),
    system = randomUUID();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await db.pool.query(
      'insert into servers(id,organization_id,name,external_identity) values($1,$2,$3,$3)',
      [server, org, 'Servidor de validação'],
    );
    await db.pool.query(
      "insert into resources(id,organization_id,server_id,kind,name,external_identity) values($1,$2,$3,'files','Anexos','test-files')",
      [resource, org, server],
    );
    await db.pool.query(
      "insert into system_profiles(id,organization_id,server_id,name,external_identity) values($1,$2,$3,'APMail','test-system')",
      [profile, org, server],
    );
    await db.pool.query(
      'insert into profile_versions(id,organization_id,profile_id,version,definition) values($1,$2,$3,1,$4)',
      [
        version,
        org,
        profile,
        JSON.stringify({
          profileId: profile,
          version: 1,
          adapter: { name: 'docker-resource', version: '1.0.0' },
          consistency: 'crash_consistent',
          resources: [{ resourceId: resource, required: true }],
          dependencies: [],
          restoreCapabilities: ['files'],
        }),
      ],
    );
    await db.pool.query(
      'insert into profile_resources(organization_id,profile_version_id,resource_id) values($1,$2,$3)',
      [org, version, resource],
    );
    await db.pool.query(
      "insert into plans(id,organization_id,server_id,profile_version_id,name,enabled) values($1,$2,$3,$4,'Aplicação e anexos',true)",
      [plan, org, server, version],
    );
    await db.pool.query(
      'insert into schedules(organization_id,plan_id,enabled) values($1,$2,true)',
      [org, plan],
    );
    await db.pool.query(
      "insert into backup_systems(id,organization_id,server_id,name,description,scope_notes) values($1,$2,$3,'APMail','Aplicação e arquivos do sistema de e-mail.','Banco externo: exige recuperação independente. Nenhum dado de produção é usado nesta validação.')",
      [system, org, server],
    );
    for (const [kind, label] of [
      ['application', 'Aplicação APMail'],
      ['files', 'Anexos de e-mail'],
    ])
      await db.pool.query(
        'insert into system_plan_links(organization_id,server_id,system_id,plan_id,component_kind,label) values($1,$2,$3,$4,$5,$6)',
        [org, server, system, plan, kind, label],
      );
    await login(page, account);
    await page.goto(`${consoleURL}/systems`);
    await expect(page.getByRole('heading', { name: 'Sistemas', exact: true })).toBeVisible();
    await page.getByRole('button', { name: /APMail.*Servidor de validação/ }).click();
    await expect(page.getByRole('heading', { name: 'Escopo de proteção' })).toBeVisible();
    await expect(
      page.getByText('Banco externo: exige recuperação independente.', { exact: false }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Aplicação APMail', exact: true }),
    ).toBeVisible();
    await expect(page.getByText('Diário · 03:00 · America/Sao_Paulo').first()).toBeVisible();
    await page.getByRole('button', { name: 'Backup agora', exact: true }).click();
    await expect
      .poll(async () =>
        Number(
          (await db.pool.query('select count(*) from executions where organization_id=$1', [org]))
            .rows[0]?.count,
        ),
      )
      .toBe(1);
    await page.reload();
    await expect(page.getByText('Aplicação · Aguardando', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: /APMail.*Servidor de validação/ }).click();
    const directory = resolve('test-results', 'systems-visual');
    await mkdir(directory, { recursive: true });
    for (const [name, width, height] of [
      ['desktop', 1440, 900],
      ['tablet', 768, 1024],
      ['mobile', 390, 844],
    ] as const) {
      await page.setViewportSize({ width, height });
      await expect(page.getByRole('heading', { name: 'Sistemas', exact: true })).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.screenshot({
        path: resolve(directory, `${name}.png`),
        fullPage: true,
        animations: 'disabled',
      });
    }
    await page.getByRole('button', { name: 'Usar tema escuro' }).click();
    await page.screenshot({
      path: resolve(directory, 'mobile-dark.png'),
      fullPage: true,
      animations: 'disabled',
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.screenshot({
      path: resolve(directory, 'desktop-dark.png'),
      fullPage: true,
      animations: 'disabled',
    });
    await page.getByLabel('Buscar nome ou servidor').fill('não existe');
    await expect(
      page.getByRole('heading', { name: 'Nenhum resultado para os filtros' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Limpar filtros' }).click();
    await expect(page.getByRole('heading', { name: 'Sistemas', exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await db.close();
  }
});
