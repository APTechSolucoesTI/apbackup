import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, rename, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { runtimeFixture } from '../integration/runtime-fixture.js';
import { createPostgresApi } from '../../apps/web/src/lib/postgresql.server.js';
import { createConfigurationService } from '../../apps/web/src/lib/configuration.server.js';
import { createRuntimeApi } from '../../apps/web/src/lib/execution.server.js';
import { coordinatorTick } from '../../apps/coordinator/src/coordinator.js';
import { createExecutor } from '../../apps/agent/src/executor.js';
import { openJournal } from '../../apps/agent/src/journal.js';
import type { AgentCommand, AgentResult } from '@apbackup/contracts';
import type { SessionPrincipal } from '../../packages/security/src/authorization.js';
test('one actual PG capture copies independently, retries the same snapshot and restores with primary offline', async () => {
  process.env.VAULT_KEY_BASE64 = randomBytes(32).toString('base64');
  process.env.VAULT_KEY_REFERENCE = 'pg-flow-fixture';
  process.env.POSTGRES_ALLOWED_HOSTS = '127.0.0.1';
  const f = await runtimeFixture(),
    root = await mkdtemp(join(tmpdir(), 'apbackup-pg-')),
    source = 'source_' + randomBytes(5).toString('hex'),
    neighbor = 'neighbor_' + randomBytes(5).toString('hex'),
    target = 'recovered_' + randomBytes(5).toString('hex');
  const user = randomUUID();
  await f.db.pool.query("insert into users(id,name,email) values($1,'Fixture',$2)", [
    user,
    `${user}@example.test`,
  ]);
  await f.db.pool.query(
    "insert into organization_memberships(organization_id,user_id,role) values($1,$2,'administrator')",
    [f.org, user],
  );
  const actor: SessionPrincipal = {
    organizationId: f.org,
    userId: user,
    membershipId: randomUUID(),
    sessionId: randomUUID(),
    role: 'administrator',
    reauthenticatedAt: new Date(),
    mfaVerifiedAt: new Date(),
  };
  const base = 'https://console.example.test',
    pgApi = createPostgresApi(f.db, async () => actor, base),
    runtime = createRuntimeApi(f.db, async () => actor, base);
  const call = async (path: string, value?: unknown, identity?: string) => {
    const response = await (path.startsWith('/api/postgresql') ? pgApi : runtime)(
      new Request(base + path, {
        method: value ? 'POST' : 'GET',
        headers: {
          origin: base,
          'content-type': 'application/json',
          ...(identity ? { authorization: `Bearer ${identity}` } : {}),
        },
        ...(value ? { body: JSON.stringify(value) } : {}),
      }),
    );
    const data = (await response.json()) as Record<string, unknown>;
    assert.ok(response.ok, `${path}: ${response.status} ${JSON.stringify(data)}`);
    return data;
  };
  const databaseURL = new URL(process.env.TEST_DATABASE_URL!);
  const client = async (database: string) => {
    const url = new URL(databaseURL);
    url.pathname = '/' + database;
    const c = new pg.Client({ connectionString: url.href });
    await c.connect();
    return c;
  };
  let journal: Awaited<ReturnType<typeof openJournal>> | undefined;
  try {
    for (const name of [source, neighbor]) await f.db.pool.query(`create database "${name}"`);
    for (const name of [source, neighbor]) {
      const c = await client(name);
      await c.query(
        "create table invoices(id bigserial primary key, description text not null, amount numeric not null); insert into invoices(description,amount) values ('ação & saúde',42.19),('second',8.1)",
      );
      await c.end();
    }
    const connection = await call('/api/postgresql/connections', {
      serverId: f.server,
      name: 'Disposable source',
      host: '127.0.0.1',
      port: Number(databaseURL.port),
      username: databaseURL.username,
      password: databaseURL.password,
      sslMode: 'disable',
    });
    const discovered = await call(`/api/postgresql/connections/${connection.id}/discover`, {});
    assert.ok((discovered.databases as { name: string }[]).some((d) => d.name === source));
    const selected = await call('/api/postgresql/select', {
      connectionId: connection.id,
      database: source,
    });
    const config = createConfigurationService(f.db, actor),
      destination = await config.destinations.create({
        name: 'Local fixture',
        kind: 'local',
        engine: 'restic',
        rootPath: 'fixture_repository',
        status: 'ativo',
        credential: { secret: randomBytes(32).toString('base64url') },
      });
    const good = await config.destinations.create({
      name: 'Independent copy',
      kind: 'local',
      engine: 'restic',
      rootPath: 'independent',
      status: 'ativo',
      credential: { secret: randomBytes(32).toString('base64url') },
    });
    const offlinePath = join(root, 'offline', 'dedicated');
    const offline = await config.destinations.create({
      name: 'Offline mounted folder',
      kind: 'local',
      engine: 'restic',
      rootPath: offlinePath,
      configuration: { backend: 'mounted' },
      status: 'ativo',
      credential: { secret: randomBytes(32).toString('base64url') },
    });
    const plan = await call('/api/postgresql/plans', {
      profileVersionId: selected.profileVersionId,
      destinationId: destination.id,
      destinationIds: [destination.id, good.id, offline.id],
      name: 'Database fixture',
      scheduleEnabled: false,
    });
    const invitation = await call('/api/agents/invitations', { serverId: f.server });
    const agent = await call('/api/agents/enroll', {
      enrollment: invitation.enrollment,
      externalIdentity: randomUUID(),
    });
    await mkdir(join(root, 'artifacts'), { mode: 0o700 });
    await mkdir(join(root, 'repos'), { mode: 0o700 });
    journal = await openJournal(join(root, 'journal'));
    const executor = createExecutor(
      {
        agentId: agent.agentId as string,
        organizationId: f.org,
        artifactRoot: join(root, 'artifacts'),
        resources: {},
        repositories: {
          repositoryRoot: join(root, 'repos'),
          mountedRoots: [offlinePath],
          allowedHosts: ['127.0.0.1'],
        },
        postgresql: { allowedHosts: ['127.0.0.1'], repositoryRoot: join(root, 'repos') },
      },
      journal,
    );
    const run = async (id: string) => {
      await coordinatorTick(f.db, 'postgres-flow');
      const poll = await call('/api/agents/poll', {}, agent.identity as string);
      const commands = poll.commands as AgentCommand[];
      assert.equal(commands.length, 1);
      const command = commands[0]!;
      assert.equal(command.executionId, id);

      const result = await executor.runCommand(command, {
        organizationId: f.org,
        executionId: id,
        profileVersionId: command.profileVersionId,
        agentId: command.agentId,
        fencingToken: command.fencingToken,
        signal: new AbortController().signal,
        authorizeEffect: async (c) => {
          const allowed =
            (await call('/api/agents/authorize', c, agent.identity as string)).allowed === true;
          assert.equal(
            allowed,
            true,
            'existing command must remain authorized after restart, including pre-CREATE',
          );
          return allowed;
        },
        resolveRepositories: async (c) =>
          (await call('/api/agents/repository-context', c, agent.identity as string)) as never,
        resolvePostgres: async (c) =>
          (await call('/api/agents/postgresql-context', c, agent.identity as string)) as never,
      });
      assert.equal(result.outcome, 'completed', JSON.stringify(result));
      assert.deepEqual(
        await executor.runCommand(command, {
          organizationId: f.org,
          executionId: id,
          profileVersionId: command.profileVersionId,
          agentId: command.agentId,
          fencingToken: command.fencingToken,
          signal: new AbortController().signal,
        }),
        result,
        'journal replays stored result without repeated host effects',
      );
      await call('/api/agents/results', result, agent.identity as string);
      await call('/api/agents/results', result, agent.identity as string);
      await coordinatorTick(f.db, 'postgres-flow');
      const state = await call(`/api/runtime/executions/${id}`);
      assert.equal(
        state.status,
        result.replications?.some((r) => r.status === 'falhou') ? 'falhas_parciais' : 'concluida',
      );
      assert.equal(
        (
          await f.db.pool.query(
            'select count(*)::text n from agent_commands where execution_id=$1',
            [id],
          )
        ).rows[0]?.n,
        '1',
      );
      return result;
    };
    const queued = await call('/api/runtime/execute', {
      planId: plan.id,
      idempotencyKey: 'backup-one',
    });
    const backup = await run(queued.executionId as string);
    assert.ok(backup.postgres);
    assert.deepEqual(backup.replications?.map((r) => r.status).sort(), ['concluida', 'falhou']);
    assert.equal(backup.staging, 'retained');
    const sourceClient = await client(source);
    await sourceClient.query(
      "insert into invoices(description,amount) values('newer source state',9)",
    );
    await sourceClient.end();
    const overview = await call('/api/postgresql/overview');
    const point = (overview.points as { id: string }[])[0]!;
    assert.ok(point.id);
    await mkdir(offlinePath, { recursive: true, mode: 0o700 });
    const retry = await call('/api/runtime/replicate', {
      recoveryPointId: point.id,
      repositoryId: offline.repositoryId,
      idempotencyKey: 'same-capture-retry',
    });
    const retried = await run(retry.executionId as string);
    assert.equal(retried.replications?.[0]?.status, 'concluida');
    const tested = await call('/api/runtime/test-destination', {
      destinationId: good.id,
      profileVersionId: selected.profileVersionId,
      idempotencyKey: 'real-repository-test',
    });
    assert.equal(
      (await run(tested.executionId as string)).repository?.repositoryId,
      good.repositoryId,
    );
    const destinations = await call('/api/runtime/points/' + point.id + '/destinations');
    assert.equal(
      (destinations.items as { status: string }[]).filter((r) => r.status === 'concluida').length,
      3,
    );
    assert.equal(
      (
        await f.db.pool.query(
          'select count(*)::text n from recovery_points where organization_id=$1',
          [f.org],
        )
      ).rows[0]?.n,
      '1',
      'retry never captures a second point',
    );
    await rename(join(root, 'repos', 'fixture_repository'), join(root, 'repos', 'primary-offline'));
    const restored = await call('/api/runtime/restore-postgresql', {
      recoveryPointId: point.id,
      repositoryId: offline.repositoryId,
      targetDatabase: target,
      idempotencyKey: 'restore-one',
    });
    assert.equal(
      (
        await call('/api/runtime/restore-postgresql', {
          recoveryPointId: point.id,
          repositoryId: offline.repositoryId,
          targetDatabase: target,
          idempotencyKey: 'restore-one',
        })
      ).executionId,
      restored.executionId,
    );
    const result: AgentResult = await run(restored.executionId as string);
    assert.equal(result.restored?.database, target);
    for (const name of [neighbor, target]) {
      const c = await client(name);
      assert.deepEqual(
        (await c.query('select description,amount::text from invoices order by id')).rows,
        [
          { description: 'ação & saúde', amount: '42.19' },
          { description: 'second', amount: '8.1' },
        ],
      );
      if (name === target) {
        assert.equal(
          (
            await c.query(
              "insert into invoices(description,amount) values ('restored sequence',1) returning id",
            )
          ).rows[0]?.id,
          '3',
        );
      }
      await c.end();
    }
    await rename(join(root, 'repos', 'primary-offline'), join(root, 'repos', 'fixture_repository'));
    const additional: string[] = [];
    for (const key of ['second', 'third']) {
      const q = await call('/api/runtime/execute', { planId: plan.id, idempotencyKey: key });
      const b = await run(q.executionId as string);
      assert.equal(
        b.replications?.every((r) => r.status === 'concluida'),
        true,
      );
      assert.equal(b.staging, 'cleaned');
      additional.push(
        (
          await f.db.pool.query<{ id: string }>(
            'select id from recovery_points where execution_id=$1',
            [q.executionId],
          )
        ).rows[0]!.id,
      );
    }
    await f.db.pool.query(
      "update recovery_points set captured_at=now()-interval '40 days' where id=$1",
      [point.id],
    );
    await f.db.pool.query(
      "update recovery_points set captured_at=now()-interval '30 days' where id=$1",
      [additional[0]],
    );
    await f.db.pool.query(
      "update recovery_points set captured_at=now()-interval '20 days' where id=$1",
      [additional[1]],
    );
    await f.db.pool.query(
      'insert into return_points(organization_id,request_id,recovery_point_id) select organization_id,id,recovery_point_id from restore_requests where execution_id=$1',
      [restored.executionId],
    );
    const retention = await call('/api/runtime/retention', {
      repositoryId: offline.repositoryId,
      idempotencyKey: 'guarded-seven-calendar-days',
    });
    const retainedResult = await run(retention.executionId as string);
    assert.equal(
      retainedResult.retention?.forgotten.length,
      1,
      'only old unused point is forgotten',
    );
    assert.equal(
      retainedResult.retention?.protected.length,
      2,
      'last verified at20 days and in-use at40 days protected',
    );
    assert.equal(retainedResult.retention?.pruned, true);
    const after = await call('/api/runtime/points/' + additional[0] + '/destinations');
    assert.equal(
      (after.items as { repositoryId: string; status: string }[]).find(
        (r) => r.repositoryId === offline.repositoryId,
      )?.status,
      'expirado',
    );
    await assert.rejects(
      readdir(join(root, 'artifacts', queued.executionId as string)),
      'successful final retry cleans the owned capture staging',
    );
    const commandRows = await f.db.pool.query(
      'select body,result from agent_commands where organization_id=$1',
      [f.org],
    );
    assert.ok(!JSON.stringify(commandRows.rows).includes(databaseURL.password));
  } finally {
    await journal?.close();
    for (const name of [source, neighbor, target])
      await f.db.pool.query(`drop database if exists "${name}" with (force)`);
    await f.db.pool.query("update execution_jobs set state='done' where organization_id=$1", [
      f.org,
    ]);
    await f.db.close();
    await rm(root, { recursive: true, force: true });
  }
});
