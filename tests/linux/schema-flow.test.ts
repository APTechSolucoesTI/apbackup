import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import pg from 'pg';
import {
  runPostgresCommand,
  PostgresStageError,
} from '../../packages/connectors/src/postgresql-runtime.js';
import { inspectPostgresSchemaScope } from '../../packages/connectors/src/postgresql-schemas.js';
import { postgresRuntimeSecretsSchema, type AgentCommand } from '@apbackup/contracts';
test('real selected-schema dump and isolated return retain selected rows and leave neighbor data unchanged; cross-schema dependency blocks capture', async () => {
  const url = new URL(process.env.TEST_DATABASE_URL!),
    root = await mkdtemp(join(tmpdir(), 'schema-flow-'));
  await mkdir(join(root, 'repo'), { mode: 0o700 });
  await mkdir(join(root, 'artifacts'), { mode: 0o700 });
  const client = new pg.Client({ connectionString: url.href });
  await client.connect();
  const own = 'own_' + randomUUID().replaceAll('-', '').slice(0, 10),
    neighbor = 'neighbor_' + randomUUID().replaceAll('-', '').slice(0, 10),
    target = 'schema_return_' + randomUUID().replaceAll('-', '').slice(0, 10);
  await client.query(
    `create schema ${own}; create schema ${neighbor}; create table ${own}.invoices(id bigint primary key,description text); insert into ${own}.invoices values(1,'ação histórica'); create table ${neighbor}.records(id bigint primary key,value text); insert into ${neighbor}.records values(1,'neighbor preserved')`,
  );
  const scoped = postgresRuntimeSecretsSchema.parse({
      connection: {
        host: '127.0.0.1',
        port: Number(url.port || 5432),
        username: url.username,
        password: url.password,
        sslMode: 'disable',
      },
      database: url.pathname.slice(1),
      schemas: [own],
      repositoryPath: 'schema-test',
      repositoryPassword: 'private-schema-password',
    }),
    controller = new AbortController();
  const command = (operation: AgentCommand['operation']): AgentCommand => ({
    version: 1,
    commandId: randomUUID(),
    organizationId: randomUUID(),
    executionId: randomUUID(),
    profileVersionId: randomUUID(),
    resourceId: randomUUID(),
    agentId: randomUUID(),
    fencingToken: '1',
    expiresAt: new Date(Date.now() + 120000).toISOString(),
    operation,
  });
  const backup = command({ kind: 'postgresql_backup', repositoryId: randomUUID() }),
    ctx = (c: AgentCommand) => ({
      ...c,
      signal: controller.signal,
      resolvePostgres: async () => scoped,
      authorizeEffect: async () => true,
    });
  try {
    assert.equal((await inspectPostgresSchemaScope(client, [own])).isolated, true);
    const proof = await runPostgresCommand(
      backup,
      ctx(backup),
      { allowedHosts: ['127.0.0.1'], repositoryRoot: join(root, 'repo') },
      join(root, 'artifacts'),
    );
    assert.ok(proof.postgres);
    assert.deepEqual(proof.postgres.schemas, [own]);
    await client.query(`update ${own}.invoices set description='new live data'`);
    const restore = command({
      kind: 'postgresql_restore',
      repositoryId:
        backup.operation.kind === 'postgresql_backup'
          ? backup.operation.repositoryId
          : randomUUID(),
      recoveryPointId: randomUUID(),
      snapshotId: proof.postgres.snapshotId,
      nativeRepositoryId: proof.postgres.nativeRepositoryId,
      sha256: proof.postgres.sha256,
      targetDatabase: target,
    });
    const returned = await runPostgresCommand(
      restore,
      ctx(restore),
      { allowedHosts: ['127.0.0.1'], repositoryRoot: join(root, 'repo') },
      join(root, 'artifacts'),
    );
    assert.equal(returned.restored?.tables.length, 1);
    const targetURL = new URL(url);
    targetURL.pathname = '/' + target;
    const recovered = new pg.Client({ connectionString: targetURL.href });
    await recovered.connect();
    try {
      assert.equal(
        (await recovered.query(`select description from ${own}.invoices`)).rows[0].description,
        'ação histórica',
      );
      assert.equal(
        (await recovered.query('select 1 from pg_namespace where nspname=$1', [neighbor])).rowCount,
        0,
      );
    } finally {
      await recovered.end();
    }
    assert.equal(
      (await client.query(`select description from ${own}.invoices`)).rows[0].description,
      'new live data',
    );
    assert.equal(
      (await client.query(`select value from ${neighbor}.records`)).rows[0].value,
      'neighbor preserved',
    );
    await client.query(
      `alter table ${own}.invoices add column other_id bigint references ${neighbor}.records(id)`,
    );
    const dependency = await inspectPostgresSchemaScope(client, [own]);
    assert.equal(dependency.isolated, false);
    assert.ok(dependency.dependencies.some((d) => d.includes(neighbor)));
    const blocked = command({ kind: 'postgresql_backup', repositoryId: randomUUID() });
    await assert.rejects(
      () =>
        runPostgresCommand(
          blocked,
          ctx(blocked),
          { allowedHosts: ['127.0.0.1'], repositoryRoot: join(root, 'repo') },
          join(root, 'artifacts'),
        ),
      PostgresStageError,
    );
  } finally {
    await client.end();
  }
});
