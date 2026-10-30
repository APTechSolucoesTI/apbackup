import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  agentCommandSchema,
  postgresRuntimeSecretsSchema,
  type ExecutionContext,
} from '@apbackup/contracts';
import { dockerPostgresTransport } from '../../packages/connectors/src/postgresql-docker.js';
import {
  discoverPostgresSchemas,
  inspectPostgresSchemaScope,
} from '../../packages/connectors/src/postgresql-schemas.js';
import {
  runPostgresCommand,
  PostgresStageError,
} from '../../packages/connectors/src/postgresql-runtime.js';
import {
  withCommandDeadline,
  CommandDeadlineError,
} from '../../packages/connectors/src/runtime/command-deadline.js';

test(
  'isolated Docker PG17 logical dump preserves shared schemas, restores only a new database and cancels SQL',
  { timeout: 120000 },
  async () => {
    const container = process.env.TEST_PG_CONTAINER!;
    assert.match(container, /^apbackup-pg-local-test-/);
    const root = await mkdtemp('/tmp/apbackup-pg-local-');
    const policy = {
      allowedHosts: [],
      allowedDockerContainers: [container],
      dockerSocketPath: '/var/run/docker.sock',
      repositoryRoot: join(root, 'repos'),
    };
    await mkdir(policy.repositoryRoot, { mode: 0o700 });
    await mkdir(join(root, 'artifacts'), { mode: 0o700 });
    const connection = { transport: 'docker_exec' as const, container, username: 'postgres' };
    const transport = dockerPostgresTransport(
      connection,
      policy,
      randomUUID(),
      new AbortController().signal,
      Date.now() + 120000,
    );
    const admin = transport.client('postgres');
    const source = 'shared_source',
      neighbor = 'untouched_neighbor',
      target = 'isolated_return';
    try {
      await admin.connect();
      assert.equal(
        (
          await admin.query<{ version: string }>(
            "select current_setting('server_version_num') as version",
          )
        ).rows[0]!.version.slice(0, 2),
        '17',
      );
      await admin.query(`create database ${source}`);
      await admin.query(`create database ${neighbor}`);
      const src = transport.client(source),
        other = transport.client(neighbor);
      for (const schema of ['auth', 'storage', 'apticket', 'apfiscal', 'appintura2'])
        await src.query(
          `create schema ${schema}; create table ${schema}.records(id bigserial primary key, note text not null); insert into ${schema}.records(note) values ('ação saúde € 中文'),('second')`,
        );
      await other.query(
        "create table sentinel(value text); insert into sentinel values ('untouched')",
      );
      const schemas = await discoverPostgresSchemas(src);
      assert.equal(schemas.find((s) => s.name === 'auth')?.selectable, false);
      assert.equal(schemas.find((s) => s.name === 'apticket')?.selectable, true);
      assert.equal((await inspectPostgresSchemaScope(src, ['apticket'])).isolated, true);
      const make = (operation: object) =>
        agentCommandSchema.parse({
          version: 1,
          commandId: randomUUID(),
          organizationId: randomUUID(),
          executionId: randomUUID(),
          profileVersionId: randomUUID(),
          agentId: randomUUID(),
          resourceId: randomUUID(),
          fencingToken: '1',
          expiresAt: new Date(Date.now() + 90000).toISOString(),
          operation,
        });
      const backupCommand = make({ kind: 'postgresql_backup', repositoryId: randomUUID() });
      const scoped = postgresRuntimeSecretsSchema.parse({
        connection,
        database: source,
        schemas: [],
        repositoryPath: 'logical',
        repositoryPassword: 'disposable-repository-secret',
      });
      const context = (c: typeof backupCommand): ExecutionContext => ({
        organizationId: c.organizationId,
        executionId: c.executionId,
        profileVersionId: c.profileVersionId,
        agentId: c.agentId,
        fencingToken: c.fencingToken,
        signal: new AbortController().signal,
        resolvePostgres: async () => scoped,
        authorizeEffect: async () => true,
      });
      const backup = await withCommandDeadline(backupCommand, context(backupCommand), (ctx) =>
        runPostgresCommand(backupCommand, ctx, policy, join(root, 'artifacts')),
      );
      assert.ok(backup.postgres);
      assert.ok(Number(backup.postgres.sizeBytes) > 0);
      const restoreCommand = make({
        kind: 'postgresql_restore',
        recoveryPointId: randomUUID(),
        repositoryId: backup.postgres.repositoryId,
        nativeRepositoryId: backup.postgres.nativeRepositoryId,
        snapshotId: backup.postgres.snapshotId,
        sha256: backup.postgres.sha256,
        targetDatabase: target,
      });
      const restored = await withCommandDeadline(restoreCommand, context(restoreCommand), (ctx) =>
        runPostgresCommand(restoreCommand, ctx, policy, join(root, 'artifacts')),
      );
      assert.equal(restored.restored?.database, target);
      assert.equal(restored.restored?.tables.length, 5);
      assert.ok(restored.restored?.tables.every((t) => t.rows === '2'));
      for (const name of [source, target]) {
        const c = transport.client(name);
        for (const schema of ['auth', 'storage', 'apticket', 'apfiscal', 'appintura2'])
          assert.deepEqual(
            (await c.query<{ note: string }>(`select note from ${schema}.records order by id`))
              .rows,
            [{ note: 'ação saúde € 中文' }, { note: 'second' }],
          );
      }
      assert.deepEqual((await other.query<{ value: string }>('select value from sentinel')).rows, [
        { value: 'untouched' },
      ]);
      for (const database of [source, neighbor, target]) {
        const collision = make({ ...restoreCommand.operation, targetDatabase: database });
        await assert.rejects(
          runPostgresCommand(collision, context(collision), policy, join(root, 'artifacts')),
          PostgresStageError,
        );
      }
      const denied = make(restoreCommand.operation);
      await assert.rejects(
        runPostgresCommand(
          denied,
          context(denied),
          { ...policy, allowedDockerContainers: [] },
          join(root, 'artifacts'),
        ),
        /approved/,
      );
      const expiredTarget = 'must_never_exist';
      const preCreate = make({ ...restoreCommand.operation, targetDatabase: expiredTarget });
      const preCreateContext = context(preCreate);
      preCreateContext.authorizeEffect = async () => {
        preCreate.expiresAt = new Date(Date.now() - 1).toISOString();
        return true;
      };
      await assert.rejects(
        withCommandDeadline(preCreate, preCreateContext, (ctx) =>
          runPostgresCommand(preCreate, ctx, policy, join(root, 'artifacts')),
        ),
        CommandDeadlineError,
      );
      assert.equal(
        (await admin.query('select datname from pg_database where datname=$1', [expiredTarget]))
          .rowCount,
        0,
      );
      const cancellation = new AbortController();
      const cancelledId = randomUUID();
      const cancelled = dockerPostgresTransport(
        connection,
        policy,
        cancelledId,
        cancellation.signal,
        Date.now() + 30000,
      );
      const query = cancelled.client(source).query('select pg_sleep(20)');
      setTimeout(() => cancellation.abort(), 300);
      await assert.rejects(query);
      await cancelled.close();
      assert.equal(
        (
          await admin.query<{ count: string }>(
            'select count(*)::text as count from pg_stat_activity where application_name=$1',
            [`apbackup:${cancelledId}`],
          )
        ).rows[0]!.count,
        '0',
      );
      const expired = {
        ...make({ kind: 'postgresql_backup', repositoryId: backup.postgres.repositoryId }),
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      };
      await assert.rejects(
        runPostgresCommand(expired, context(expired), policy, join(root, 'artifacts')),
        CommandDeadlineError,
      );
    } finally {
      await transport.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
