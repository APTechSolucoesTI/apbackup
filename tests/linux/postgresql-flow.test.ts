import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watch } from 'node:fs';
import pg from 'pg';
import { runtimeFixture } from '../integration/runtime-fixture.js';
import { createPostgresApi } from '../../apps/web/src/lib/postgresql.server.js';
import { createConfigurationService } from '../../apps/web/src/lib/configuration.server.js';
import { createRuntimeApi } from '../../apps/web/src/lib/execution.server.js';
import { coordinatorTick } from '../../apps/coordinator/src/coordinator.js';
import { createExecutor } from '../../apps/agent/src/executor.js';
import { openJournal } from '../../apps/agent/src/journal.js';
import { createExecutionStore } from '../../packages/db/src/repositories/jobs.js';
import { dispatchJob } from '../../apps/coordinator/src/dispatcher.js';
import { reconcileExecution } from '../../apps/coordinator/src/reconciler.js';
import type { AgentCommand, AgentResult } from '@apbackup/contracts';
import type { SessionPrincipal } from '../../packages/security/src/authorization.js';
test('actual API → coordinator → journaled agent → pg_dump/Restic → verified point → NEW database restore preserves source and neighbor', async () => {
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
  let actor: SessionPrincipal = {
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
    const plan = await call('/api/postgresql/plans', {
      profileVersionId: selected.profileVersionId,
      destinationId: destination.id,
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
        postgresql: { allowedHosts: ['127.0.0.1'], repositoryRoot: join(root, 'repos') },
      },
      journal,
    );
    const run = async (id: string) => {
      await coordinatorTick(f.db, 'postgres-flow');
      const reclaim = async () => {
        await f.db.pool.query(
          "update execution_jobs set claim_until=now()-interval '1 second' where execution_id=$1",
          [id],
        );
        const job = (await createExecutionStore(f.db).claimJob('postgres-flow', new Date()))!;
        assert.equal(job.executionId, id);
        await dispatchJob(f.db, job, new Date());
        assert.equal(
          (await f.db.pool.query('select holder from leases where execution_id=$1', [id])).rows[0]
            ?.holder,
          job.holder,
          'reclaim must adopt the same command reservation',
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
      };
      await reclaim();
      const poll = await call('/api/agents/poll', {}, agent.identity as string);
      const commands = poll.commands as AgentCommand[];
      assert.equal(commands.length, 1);
      const command = commands[0]!;
      assert.equal(command.executionId, id);
      let authorizations = 0;
      const result = await executor.runCommand(command, {
        organizationId: f.org,
        executionId: id,
        profileVersionId: command.profileVersionId,
        agentId: command.agentId,
        fencingToken: command.fencingToken,
        signal: new AbortController().signal,
        authorizeEffect: async (c) => {
          authorizations++;
          if (c.operation.kind === 'postgresql_restore' && authorizations === 2) await reclaim();
          const allowed =
            (await call('/api/agents/authorize', c, agent.identity as string)).allowed === true;
          assert.equal(
            allowed,
            true,
            'existing command must remain authorized after restart, including pre-CREATE',
          );
          return allowed;
        },
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
      // Authoritative result is durably in the agent journal, but delivery crosses the
      // command deadline while the coordinator is still waiting for that result.
      const realNow = Date.now;
      Date.now = () => Date.parse(command.expiresAt) + 1;
      try {
        assert.equal((await reconcileExecution(f.db, id, f.org)).state, 'exige_intervencao');
        assert.equal(
          (await f.db.pool.query('select state from execution_jobs where execution_id=$1', [id]))
            .rows[0]?.state,
          'done',
        );
      } finally {
        Date.now = realNow;
      }
      await call('/api/agents/results', result, agent.identity as string);
      await call('/api/agents/results', result, agent.identity as string);
      await coordinatorTick(f.db, 'postgres-flow');
      const state = await call(`/api/runtime/executions/${id}`);
      assert.equal(state.status, 'concluida');
      assert.equal(
        (
          await f.db.pool.query(
            'select count(*)::text n from agent_commands where execution_id=$1',
            [id],
          )
        ).rows[0]?.n,
        '1',
      );
      const count =
        command.operation.kind === 'postgresql_backup'
          ? await f.db.pool.query(
              'select count(*)::text n from recovery_points where execution_id=$1',
              [id],
            )
          : await f.db.pool.query(
              'select count(*)::text n from restore_results r join restore_requests q on q.organization_id=r.organization_id and q.id=r.request_id where q.execution_id=$1',
              [id],
            );
      assert.equal(count.rows[0]?.n, '1', 'late repeated result finalizes exactly once');
      return result;
    };
    const queued = await call('/api/runtime/execute', {
      planId: plan.id,
      idempotencyKey: 'backup-one',
    });
    const backup = await run(queued.executionId as string);
    assert.ok(backup.postgres);
    const overview = await call('/api/postgresql/overview');
    const point = (overview.points as { id: string }[])[0]!;
    assert.ok(point.id);
    actor = { ...actor, role: 'viewer' };
    const denied = await runtime(
      new Request(base + '/api/runtime/restore-postgresql', {
        method: 'POST',
        headers: { origin: base, 'content-type': 'application/json' },
        body: JSON.stringify({
          recoveryPointId: point.id,
          targetDatabase: target,
          idempotencyKey: 'denied',
        }),
      }),
    );
    assert.equal(denied.status, 403);
    actor = { ...actor, role: 'administrator' };
    const restored = await call('/api/runtime/restore-postgresql', {
      recoveryPointId: point.id,
      targetDatabase: target,
      idempotencyKey: 'restore-one',
    });
    assert.equal(
      (
        await call('/api/runtime/restore-postgresql', {
          recoveryPointId: point.id,
          targetDatabase: target,
          idempotencyKey: 'restore-one',
        })
      ).executionId,
      restored.executionId,
    );
    const result: AgentResult = await run(restored.executionId as string);
    assert.equal(result.restored?.database, target);
    for (const name of [source, neighbor, target]) {
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
    const collision = await call('/api/runtime/restore-postgresql', {
      recoveryPointId: point.id,
      targetDatabase: neighbor,
      idempotencyKey: 'must-not-overwrite',
    });
    await coordinatorTick(f.db, 'postgres-flow');
    const poll = await call('/api/agents/poll', {}, agent.identity as string);
    const command = (poll.commands as AgentCommand[])[0]!;
    const rejected = await executor.runCommand(command, {
      organizationId: f.org,
      executionId: collision.executionId as string,
      profileVersionId: command.profileVersionId,
      agentId: command.agentId,
      fencingToken: command.fencingToken,
      signal: new AbortController().signal,
      authorizeEffect: async () => true,
      resolvePostgres: async (c) =>
        (await call('/api/agents/postgresql-context', c, agent.identity as string)) as never,
    });
    assert.notEqual(rejected.outcome, 'completed');
    await call('/api/agents/results', rejected, agent.identity as string);
    // A second real resource lets each timeout remain truthfully unknown without
    // clearing a reservation or making the next scenario replay its effect.
    const neighborBinding = await call('/api/postgresql/select', {
      connectionId: connection.id,
      database: neighbor,
    });
    const neighborPlan = await call('/api/postgresql/plans', {
      profileVersionId: neighborBinding.profileVersionId,
      destinationId: destination.id,
      name: 'Deadline fixture',
      scheduleEnabled: false,
    });
    const deadlineTarget = 'deadline_' + randomBytes(5).toString('hex');
    for (const kind of ['backup', 'restore'] as const) {
      const queued =
        kind === 'backup'
          ? await call('/api/runtime/execute', {
              planId: neighborPlan.id,
              idempotencyKey: 'deadline-backup',
            })
          : await call('/api/runtime/restore-postgresql', {
              recoveryPointId: point.id,
              targetDatabase: deadlineTarget,
              idempotencyKey: 'deadline-restore',
            });
      const executionId = queued.executionId as string;
      await coordinatorTick(f.db, 'postgres-flow');
      const polled = await call('/api/agents/poll', {}, agent.identity as string),
        command = (polled.commands as AgentCommand[]).find((c) => c.executionId === executionId)!;
      assert.ok(command);
      const realNow = Date.now;
      let crossed = false,
        authorizations = 0;
      const crossDeadline = () => {
        crossed = true;
        Date.now = () => Date.parse(command.expiresAt) + 1;
      };
      const watcher =
        kind === 'backup'
          ? watch(join(root, 'artifacts'), { recursive: true }, (_event, filename) => {
              if (String(filename) === `${executionId}/verified`) crossDeadline();
            })
          : null;
      let result: AgentResult;
      try {
        result = await executor.runCommand(command, {
          organizationId: f.org,
          executionId,
          profileVersionId: command.profileVersionId,
          agentId: command.agentId,
          fencingToken: command.fencingToken,
          signal: new AbortController().signal,
          authorizeEffect: async (c) => {
            const allowed =
              (await call('/api/agents/authorize', c, agent.identity as string)).allowed === true;
            if (kind === 'restore' && ++authorizations === 2) crossDeadline();
            return allowed;
          },
          resolvePostgres: async (c) =>
            (await call('/api/agents/postgresql-context', c, agent.identity as string)) as never,
        });
        assert.equal(
          crossed,
          true,
          `${kind} reaches its intended verification/pre-CREATE boundary`,
        );
        assert.equal(
          result.outcome,
          'unknown',
          `${kind} must not report success or replay after the overall deadline`,
        );
        assert.equal(
          (await reconcileExecution(f.db, executionId, f.org)).state,
          'exige_intervencao',
        );
      } finally {
        Date.now = realNow;
        watcher?.close();
      }
      await call('/api/agents/results', result!, agent.identity as string);
      assert.equal(
        (await call(`/api/runtime/executions/${executionId}`)).status,
        'exige_intervencao',
      );
      assert.equal(
        (
          await f.db.pool.query(
            'select count(*)::text n from recovery_points where execution_id=$1',
            [executionId],
          )
        ).rows[0]?.n,
        '0',
      );
      assert.equal(
        (
          await f.db.pool.query(
            'select count(*)::text n from agent_commands where execution_id=$1',
            [executionId],
          )
        ).rows[0]?.n,
        '1',
      );
      assert.equal(
        (
          await f.db.pool.query('select count(*)::text n from pg_database where datname=$1', [
            deadlineTarget,
          ])
        ).rows[0]?.n,
        '0',
        'expired restore never creates a target',
      );
    }
    const commandsJSON = JSON.stringify(
      (
        await f.db.pool.query('select body,result from agent_commands where organization_id=$1', [
          f.org,
        ])
      ).rows,
    );
    assert.ok(!commandsJSON.includes(databaseURL.password));
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
