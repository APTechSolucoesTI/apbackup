import { expect, test } from '@playwright/test';
import { consoleURL, disposableDatabase, fixture, login } from './support/fixtures.js';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
test('destination details show assessed false limitations and invalidate them when configuration changes', async ({
  page,
}) => {
  const account = await fixture(),
    db = disposableDatabase();
  let destinationId: string;
  try {
    const destination = await db.pool.query<{ id: string }>(
      "insert into destinations(organization_id,name,kind,host) values($1,'Destino comum','google_drive','fixture.example.test') returning id",
      [account.organizationId],
    );
    destinationId = destination.rows[0]!.id;
    await db.pool.query(
      "insert into repositories(organization_id,destination_id,external_identity,engine) values($1,$2,'fixture:ordinary','restic')",
      [account.organizationId, destinationId],
    );
    await db.pool.query(
      'insert into connector_capabilities(organization_id,destination_id,connector_name,connector_version,capabilities,assessed_at) values($1,$2,$3,$4,$5,now())',
      [
        account.organizationId,
        destinationId,
        'fixture',
        '1.0.0',
        JSON.stringify({
          encrypted: true,
          platformRetention: true,
          restrictedDeletion: false,
          independentSnapshot: false,
          immutable: false,
        }),
      ],
    );
  } finally {
    await db.close();
  }
  await login(page, account);
  await page.goto(`${consoleURL}/destinations`);
  await page.getByRole('button', { name: 'Visualizar Destino comum', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Capacidades avaliadas do destino' });
  await expect(panel).toContainText('Criptografia: disponível');
  await expect(panel).toContainText('Exclusão restrita: não disponível');
  await expect(panel).toContainText('Snapshot independente: não disponível');
  await expect(panel).toContainText('Imutabilidade: não disponível');
  const evidence = resolve('../.superpowers/sdd/2026-10-28-backup-platform/task4-evidence');
  await mkdir(evidence, { recursive: true });
  await page.screenshot({
    path: resolve(evidence, 'destination-assessed-limitations.png'),
    animations: 'disabled',
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Fechar', exact: true }).click();
  const changed = disposableDatabase();
  try {
    await changed.pool.query(
      "update destinations set host='changed.example.test' where organization_id=$1 and id=$2",
      [account.organizationId, destinationId],
    );
  } finally {
    await changed.close();
  }
  await page.getByRole('button', { name: 'Visualizar Destino comum', exact: true }).click();
  await expect(panel).toContainText('Aguardando avaliação da configuração atual');
  await expect(panel).not.toContainText('Exclusão restrita: não disponível');
});
