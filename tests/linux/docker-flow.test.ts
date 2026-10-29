import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeFixture } from '../integration/runtime-fixture.js';
import { createDockerApi } from '../../apps/web/src/lib/docker.server.js';
import { createRuntimeApi } from '../../apps/web/src/lib/execution.server.js';
import { createConfigurationService } from '../../apps/web/src/lib/configuration.server.js';
import { coordinatorTick } from '../../apps/coordinator/src/coordinator.js';
import { reconcileExecution } from '../../apps/coordinator/src/reconciler.js';
import { createExecutor } from '../../apps/agent/src/executor.js';
import { openJournal } from '../../apps/agent/src/journal.js';
import { dockerClient } from '../../packages/connectors/src/docker-client.js';
import type { AgentCommand, AgentResult } from '@apbackup/contracts';
import type { SessionPrincipal } from '../../packages/security/src/authorization.js';
import { createExecutionStore } from '../../packages/db/src/repositories/jobs.js';
import { dispatchJob } from '../../apps/coordinator/src/dispatcher.js';
async function daemon(method: string, path: string, body?: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = request(
      {
        socketPath: '/var/run/docker.sock',
        path: '/v1.47' + path,
        method,
        headers: data ? { 'content-type': 'application/json', 'content-length': data.length } : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (b: Buffer) => chunks.push(b));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          if ((res.statusCode ?? 500) >= 300)
            reject(new Error(`${method} ${path} ${res.statusCode} ${text}`));
          else resolve(text ? (JSON.parse(text) as unknown) : null);
        });
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}
test('actual API/coordinator/journal/Docker/Restic restores new volume and historical running application without database or neighbor changes', async () => {
  const f = await runtimeFixture(),
    root = await mkdtemp(join(tmpdir(), 'docker-r2-')),
    prefix = 'apbackup-test-' + randomBytes(5).toString('hex'),
    volume = prefix + '-mail',
    neighbor = prefix + '-neighbor',
    target = prefix + '-recovered',
    application = prefix + '-app';
  process.env.VAULT_KEY_BASE64 = randomBytes(32).toString('base64');
  process.env.VAULT_KEY_REFERENCE = 'docker-linux-test';
  let actor: SessionPrincipal = {
    organizationId: f.org,
    userId: randomUUID(),
    membershipId: randomUUID(),
    sessionId: randomUUID(),
    role: 'administrator',
    reauthenticatedAt: new Date(),
    mfaVerifiedAt: new Date(),
  };
  await f.db.pool.query("insert into users(id,name,email) values($1,'Docker fixture',$2)", [
    actor.userId,
    `${actor.userId}@example.test`,
  ]);
  await f.db.pool.query(
    "insert into organization_memberships(organization_id,user_id,role) values($1,$2,'administrator')",
    [f.org, actor.userId],
  );
  const base = 'https://console.example.test',
    api = createDockerApi(f.db, async () => actor, base),
    runtime = createRuntimeApi(f.db, async () => actor, base);
  const call = async (path: string, value?: unknown, identity?: string) => {
    const res = await (path.startsWith('/api/docker') ? api : runtime)(
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
    const data = (await res.json()) as Record<string, unknown>;
    assert.ok(res.ok, `${path}: ${res.status} ${JSON.stringify(data)}`);
    return data;
  };
  const helperImage = process.env.DOCKER_HELPER_IMAGE!;
  assert.match(helperImage, /^sha256:[a-f0-9]{64}$/);
  const createdContainers: string[] = [],
    createdVolumes: string[] = [];
  let journal: Awaited<ReturnType<typeof openJournal>> | undefined;
  try {
    for (const name of [volume, neighbor]) {
      await daemon('POST', '/volumes/create', {
        Name: name,
        Labels: { 'apbackup.disposable-test': prefix },
      });
      createdVolumes.push(name);
    }
    const init = (await daemon('POST', '/containers/create', {
      Image: helperImage,
      Cmd: [
        'node',
        '-e',
        "const f=require('fs');for(const p of ['/mail','/neighbor']){f.mkdirSync(p+'/anexos',{recursive:true});f.writeFileSync(p+'/anexos/ação.txt','Olá, recuperação real!');f.chmodSync(p+'/anexos/ação.txt',0o640)}",
      ],
      Labels: { 'apbackup.disposable-test': prefix },
      HostConfig: {
        Mounts: [
          { Type: 'volume', Source: volume, Target: '/mail' },
          { Type: 'volume', Source: neighbor, Target: '/neighbor' },
        ],
      },
    })) as { Id: string };
    createdContainers.push(init.Id);
    await daemon('POST', `/containers/${init.Id}/start`);
    await daemon('POST', `/containers/${init.Id}/wait`);
    await daemon('DELETE', `/containers/${init.Id}?v=0`);
    createdContainers.pop();
    const app = (await daemon('POST', `/containers/create?name=${application}`, {
      Image: helperImage,
      Env: ['APPLICATION_SECRET=historical-do-not-expose'],
      Cmd: [
        'node',
        '-e',
        "require('http').createServer((q,r)=>r.end(require('fs').readFileSync('/mail/anexos/ação.txt'))).listen(8080,'0.0.0.0')",
      ],
      Healthcheck: {
        Test: [
          'CMD',
          'node',
          '-e',
          "fetch('http://127.0.0.1:8080').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))",
        ],
        Interval: 1000000000,
        Timeout: 1000000000,
        Retries: 5,
      },
      Labels: { 'apbackup.disposable-test': prefix },
      HostConfig: {
        Mounts: [{ Type: 'volume', Source: volume, Target: '/mail' }],
        PortBindings: { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '' }] },
        RestartPolicy: { Name: 'on-failure', MaximumRetryCount: 3 },
      },
    })) as { Id: string };
    createdContainers.push(app.Id);
    await daemon('POST', `/containers/${app.Id}/start`);
    await mkdir(join(root, 'artifacts'), { mode: 0o700 });
    await mkdir(join(root, 'repositories'), { mode: 0o700 });
    const daemonRoot = '/tmp/' + prefix;
    const directoryFixture = (await daemon('POST', '/containers/create', {
      Image: helperImage,
      Cmd: [
        'node',
        '-e',
        "const f=require('fs');f.mkdirSync('/data/'+process.argv[1],{mode:448});f.writeFileSync('/data/'+process.argv[1]+'/ação.txt','diretório preservado',{mode:416});",
        prefix,
      ],
      Labels: { 'apbackup.disposable-test': prefix },
      HostConfig: { Mounts: [{ Type: 'bind', Source: '/tmp', Target: '/data' }] },
    })) as { Id: string };
    createdContainers.push(directoryFixture.Id);
    await daemon('POST', `/containers/${directoryFixture.Id}/start`);
    assert.equal(
      ((await daemon('POST', `/containers/${directoryFixture.Id}/wait`)) as { StatusCode: number })
        .StatusCode,
      0,
    );
    const policy = {
      socketPath: '/var/run/docker.sock',
      helperImage,
      repositoryRoot: join(root, 'repositories'),
      directories: { attachments: daemonRoot },
    };
    const discovered = await dockerClient(policy, new AbortController().signal).discover();
    assert.ok(discovered.containers.some((c) => c.id === app.Id && !c.blockedReason));
    const invite = await call('/api/agents/invitations', { serverId: f.server }),
      agent = await call('/api/agents/enroll', {
        enrollment: invite.enrollment,
        externalIdentity: prefix,
      });
    await call('/api/agents/docker-catalog', discovered, agent.identity as string);
    const destination = await createConfigurationService(f.db, actor).destinations.create({
      name: prefix,
      kind: 'local',
      engine: 'restic',
      rootPath: prefix,
      status: 'ativo',
      credential: { secret: randomBytes(32).toString('base64url') },
    });
    journal = await openJournal(join(root, 'journal'));
    const executor = createExecutor(
      {
        agentId: agent.agentId as string,
        organizationId: f.org,
        artifactRoot: join(root, 'artifacts'),
        resources: {},
        docker: policy,
      },
      journal,
    );
    const run = async (
      id: string,
      late = false,
      expected: 'completed' | 'failed' | 'unknown' = 'completed',
      expire = false,
    ) => {
      await coordinatorTick(f.db, 'docker-flow');
      // Reclaim must adopt the exact same command, never manufacture another effect.
      await f.db.pool.query(
        "update execution_jobs set claim_until=now()-interval '1 second' where execution_id=$1",
        [id],
      );
      const job = (await createExecutionStore(f.db).claimJob('docker-flow', new Date()))!;
      assert.equal(job.executionId, id);
      await dispatchJob(f.db, job, new Date());
      const poll = await call('/api/agents/poll', {}, agent.identity as string),
        command = (poll.commands as AgentCommand[]).find((c) => c.executionId === id)!;
      assert.ok(command);
      const realNow = Date.now;
      let authorizationCount = 0;
      const context = {
        organizationId: f.org,
        executionId: id,
        profileVersionId: command.profileVersionId,
        agentId: command.agentId,
        fencingToken: command.fencingToken,
        signal: new AbortController().signal,
        authorizeEffect: async (c: AgentCommand) => {
          const allowed =
            (await call('/api/agents/authorize', c, agent.identity as string)).allowed === true;
          if (expire && ++authorizationCount === 2)
            Date.now = () => Date.parse(command.expiresAt) + 1;
          return allowed;
        },
        resolveDocker: async (c: AgentCommand) =>
          (await call('/api/agents/docker-context', c, agent.identity as string)) as never,
      };
      let result: AgentResult;
      try {
        result = await executor.runCommand(command, context);
      } finally {
        Date.now = realNow;
      }
      assert.equal(result.outcome, expected, JSON.stringify(result));
      assert.deepEqual(await executor.runCommand(command, context), result);
      if (late) {
        const now = Date.now;
        Date.now = () => Date.parse(command.expiresAt) + 1;
        try {
          assert.equal((await reconcileExecution(f.db, id, f.org)).state, 'exige_intervencao');
        } finally {
          Date.now = now;
        }
      }
      await call('/api/agents/results', result, agent.identity as string);
      await call('/api/agents/results', result, agent.identity as string);
      assert.equal(
        (await call(`/api/runtime/executions/${id}`)).status,
        expected === 'completed' ? 'concluida' : 'exige_intervencao',
      );
      return result;
    };
    const backup = async (kind: 'volume' | 'container' | 'directory', identity: string) => {
      await call(
        '/api/agents/docker-catalog',
        await dockerClient(policy, new AbortController().signal).discover(),
        agent.identity as string,
      );
      const binding = await call('/api/docker/select', { serverId: f.server, kind, identity }),
        plan = await call('/api/docker/plans', {
          profileVersionId: binding.profileVersionId,
          destinationId: destination.id,
          name: identity,
          scheduleEnabled: false,
        });
      const queued = await call('/api/runtime/execute', {
        planId: plan.id,
        idempotencyKey: randomUUID(),
      });
      await run(queued.executionId as string, true);
      return (
        await f.db.pool.query<{ id: string }>(
          'select id from recovery_points where execution_id=$1',
          [queued.executionId],
        )
      ).rows[0]!.id;
    };
    const volumePoint = await backup('volume', volume),
      restore = await call('/api/docker/restore', {
        recoveryPointId: volumePoint,
        targetName: target,
        idempotencyKey: randomUUID(),
      });
    createdVolumes.push(target);
    const proof: AgentResult = await run(restore.executionId as string, true);
    assert.equal(proof.dockerRestored?.kind, 'volume');
    const collision = await call('/api/docker/restore', {
      recoveryPointId: volumePoint,
      targetName: neighbor,
      idempotencyKey: randomUUID(),
    });
    await run(collision.executionId as string, false, 'failed');
    const directoryPoint = await backup('directory', 'attachments'),
      directoryRestore = await call('/api/docker/restore', {
        recoveryPointId: directoryPoint,
        targetName: 'recovered-files',
        idempotencyKey: randomUUID(),
      });
    assert.equal(
      (await run(directoryRestore.executionId as string, true)).dockerRestored?.kind,
      'directory',
    );
    const directoryCollision = await call('/api/docker/restore', {
      recoveryPointId: directoryPoint,
      targetName: 'recovered-files',
      idempotencyKey: randomUUID(),
    });
    await run(directoryCollision.executionId as string, false, 'unknown');
    const appPoint = await backup('container', application);
    // A newly mounted consumer must block return even after a prior successful binding.
    const shared = (await daemon('POST', '/containers/create', {
      Image: helperImage,
      Cmd: ['node', '-e', 'setInterval(()=>{},1000)'],
      Labels: { 'apbackup.disposable-test': prefix },
      HostConfig: { Mounts: [{ Type: 'volume', Source: volume, Target: '/shared' }] },
    })) as { Id: string };
    createdContainers.push(shared.Id);
    assert.match(
      (await dockerClient(policy, new AbortController().signal).discover()).containers.find(
        (c) => c.id === app.Id,
      )!.blockedReason!,
      /compartilhado/,
    );
    await daemon('DELETE', `/containers/${shared.Id}?force=1&v=0`);
    createdContainers.pop();
    actor = { ...actor, role: 'viewer' };
    const denied = await api(
      new Request(base + '/api/docker/restore', {
        method: 'POST',
        headers: { origin: base, 'content-type': 'application/json' },
        body: JSON.stringify({
          recoveryPointId: appPoint,
          targetName: application,
          replaceContainer: true,
          confirmation: application,
          idempotencyKey: 'viewer',
        }),
      }),
    );
    assert.equal(denied.status, 403);
    actor = { ...actor, role: 'administrator' };
    const appRestore = await call('/api/docker/restore', {
        recoveryPointId: appPoint,
        targetName: application,
        replaceContainer: true,
        confirmation: application,
        idempotencyKey: randomUUID(),
      }),
      returned = await run(appRestore.executionId as string, true);
    assert.equal(returned.dockerRestored?.health, 'healthy');
    assert.equal(returned.dockerRestored?.preservedContainerId, app.Id);
    const newId = returned.dockerRestored!.containerId!;
    createdContainers.push(newId);
    createdVolumes.push(...returned.dockerRestored!.targets);
    const old = await dockerClient(policy, new AbortController().signal).inspect(app.Id),
      current = await dockerClient(policy, new AbortController().signal).inspect(newId);
    assert.equal(old.State.Running, false);
    assert.equal(current.State.Running, true);
    assert.equal(current.Image, old.Image);
    assert.deepEqual(current.HostConfig.RestartPolicy, {
      Name: 'on-failure',
      MaximumRetryCount: 3,
    });
    assert.ok(current.Config.Env?.includes('APPLICATION_SECRET=historical-do-not-expose'));
    const inspect = (await daemon('GET', `/containers/${newId}/json`)) as {
      NetworkSettings: { Ports: Record<string, { HostPort: string }[]> };
    };
    const port = inspect.NetworkSettings.Ports['8080/tcp']![0]!.HostPort;
    // Node tests share the database container network; published target is reached through Docker's host gateway.
    const response = await fetch(`http://host.docker.internal:${port}`);
    assert.equal(await response.text(), 'Olá, recuperação real!');
    const reader = (await daemon('POST', '/containers/create', {
      Image: helperImage,
      Cmd: [
        'node',
        '-e',
        "const f=require('fs');for(const p of ['/source','/neighbor','/restored']){if(f.readFileSync(p+'/anexos/ação.txt','utf8')!=='Olá, recuperação real!'||(f.statSync(p+'/anexos/ação.txt').mode&511)!==416)process.exit(1)}",
      ],
      Labels: { 'apbackup.disposable-test': prefix },
      HostConfig: {
        Mounts: [
          { Type: 'volume', Source: volume, Target: '/source', ReadOnly: true },
          { Type: 'volume', Source: neighbor, Target: '/neighbor', ReadOnly: true },
          { Type: 'volume', Source: target, Target: '/restored', ReadOnly: true },
        ],
      },
    })) as { Id: string };
    createdContainers.push(reader.Id);
    await daemon('POST', `/containers/${reader.Id}/start`);
    assert.equal(
      ((await daemon('POST', `/containers/${reader.Id}/wait`)) as { StatusCode: number })
        .StatusCode,
      0,
    );
    const durable = JSON.stringify(
      (
        await f.db.pool.query('select body,result from agent_commands where organization_id=$1', [
          f.org,
        ])
      ).rows,
    );
    assert.ok(!durable.includes('historical-do-not-expose'));
    assert.equal(
      (
        await f.db.pool.query(
          'select count(*)::text n from recovery_points where organization_id=$1',
          [f.org],
        )
      ).rows[0]?.n,
      '3',
    );
    const timeout = await call('/api/docker/restore', {
      recoveryPointId: volumePoint,
      targetName: prefix + '-expired',
      idempotencyKey: randomUUID(),
    });
    await run(timeout.executionId as string, false, 'unknown', true);
    await dockerClient(policy, new AbortController().signal).volumeAbsent(prefix + '-expired');
    const directoryCheck = (await daemon('POST', '/containers/create', {
      Image: helperImage,
      Cmd: [
        'node',
        '-e',
        "const f=require('fs');for(const p of ['/data/ação.txt','/data/recovered-files/ação.txt'])if(f.readFileSync(p,'utf8')!=='diretório preservado'||(f.statSync(p).mode&511)!==416)process.exit(1);f.rmSync('/data/recovered-files',{recursive:true});f.unlinkSync('/data/ação.txt');",
      ],
      Labels: { 'apbackup.disposable-test': prefix },
      HostConfig: { Mounts: [{ Type: 'bind', Source: daemonRoot, Target: '/data' }] },
    })) as { Id: string };
    createdContainers.push(directoryCheck.Id);
    await daemon('POST', `/containers/${directoryCheck.Id}/start`);
    assert.equal(
      ((await daemon('POST', `/containers/${directoryCheck.Id}/wait`)) as { StatusCode: number })
        .StatusCode,
      0,
    );
  } finally {
    await journal?.close();
    for (const id of createdContainers.reverse())
      await daemon('DELETE', `/containers/${id}?force=1&v=0`).catch(() => {});
    // Only exact disposable-operation labels; no neighbor/production enumeration is mutated.
    const volumes = (await daemon('GET', '/volumes')) as {
      Volumes: { Name: string; Labels: Record<string, string> | null }[];
    };
    for (const v of volumes.Volumes ?? [])
      if (createdVolumes.includes(v.Name) || v.Labels?.['apbackup.restore']) {
        if (
          v.Name.startsWith(prefix) ||
          (v.Labels?.['apbackup.restore'] && createdVolumes.includes(v.Name))
        )
          await daemon('DELETE', `/volumes/${v.Name}`).catch(() => {});
      }
    await f.db.close();
    await rm(root, { recursive: true, force: true });
  }
});
