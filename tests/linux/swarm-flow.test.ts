import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { dockerClient } from '../../packages/connectors/src/docker-client.js';
import {
  runDockerCommand,
  DockerStageError,
} from '../../packages/connectors/src/docker-runtime.js';
import { dockerRuntimeSchema, type AgentCommand } from '@apbackup/contracts';
test('real isolated Swarm return recovers crashed scaled-up service to historical replica count, config and files without changing source or neighbor', async () => {
  const socketPath = '/daemon/docker.sock',
    root = await mkdtemp(join(tmpdir(), 'swarm-flow-')),
    image = process.env.FIXTURE_HELPER_IMAGE!;
  await mkdir(join(root, 'repo'), { mode: 0o700 });
  await mkdir(join(root, 'artifacts'), { mode: 0o700 });
  const controller = new AbortController(),
    policy = {
      socketPath,
      helperImage: image,
      repositoryRoot: join(root, 'repo'),
      directories: {},
    },
    docker = dockerClient(policy, controller.signal);
  const api = (method: string, path: string, body?: unknown): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const r = httpRequest(
        {
          socketPath,
          method,
          path: '/v1.47' + path,
          headers: body ? { 'content-type': 'application/json' } : {},
        },
        (res) => {
          let output = '';
          res.on('data', (b) => (output += String(b)));
          res.on('end', () =>
            res.statusCode && res.statusCode < 300
              ? resolve(output ? (JSON.parse(output) as unknown) : null)
              : reject(new Error(output)),
          );
        },
      );
      r.on('error', reject);
      r.end(body ? JSON.stringify(body) : undefined);
    });
  await api('POST', '/swarm/init', { ListenAddr: '0.0.0.0:2377', AdvertiseAddr: '127.0.0.1' });
  const node = await docker.nodeId();
  await docker.createVolume('owned-files', 'fixture');
  await docker.createVolume('neighbor-files', 'fixture');
  const write = async (volume: string, text: string) => {
    const id = await docker.createContainer('write-' + randomUUID(), {
      Image: image,
      Cmd: ['node', '-e', `require('fs').writeFileSync('/data/value.txt',${JSON.stringify(text)})`],
      HostConfig: { Mounts: [{ Type: 'volume', Source: volume, Target: '/data' }] },
    });
    await docker.start(id);
    await api('POST', `/containers/${id}/wait?condition=not-running`);
    await api('DELETE', `/containers/${id}?v=0`);
  };
  await write('owned-files', 'ação histórica');
  await write('neighbor-files', 'neighbor unchanged');
  const roles = ['frontend', 'api', 'worker'] as const,
    ids: string[] = [];
  for (const [i] of roles.entries()) {
    const value = (await api('POST', '/services/create', {
      Name: ['misleading-api', 'misleading-frontend', 'worker'][i],
      Mode: { Replicated: { Replicas: 1 } },
      TaskTemplate: {
        ContainerSpec: {
          Image: image,
          Command: ['node'],
          Args: ['-e', 'setInterval(()=>{},10000)'],
          Env: ['VERSION=historical', 'DATABASE_URL=old-database', 'REDIS_URL=old-queue'],
          Mounts: i ? [{ Type: 'volume', Source: 'owned-files', Target: '/data' }] : [],
        },
        Placement: { Constraints: [`node.id==${node}`] },
      },
    })) as { ID: string };
    ids.push(value.ID);
  }
  const wait = async () => {
    for (let i = 0; i < 60; i++) {
      if (
        (
          await Promise.all(
            ids.map(async (id) =>
              (await docker.tasks(id)).some(
                (t) => t.DesiredState === 'running' && t.Status.State === 'running',
              ),
            ),
          )
        ).every(Boolean)
      )
        return;
      await delay(500);
    }
    throw new Error('Fixture services unavailable');
  };
  await wait();
  const scoped = dockerRuntimeSchema.parse({
    selection: {
      serverId: randomUUID(),
      kind: 'swarm',
      identity: 'known-app',
      services: ids.map((id, i) => ({
        id,
        role: roles[i],
        preserveEnvironmentKeys: ['DATABASE_URL', 'REDIS_URL'],
        startupReviewed: true,
      })),
    },
    repositoryPath: 'swarm-test',
    repositoryPassword: 'private-swarm-password',
  });
  const command = (operation: AgentCommand['operation']): AgentCommand => ({
      version: 1,
      commandId: randomUUID(),
      organizationId: randomUUID(),
      executionId: randomUUID(),
      profileVersionId: randomUUID(),
      resourceId: randomUUID(),
      agentId: randomUUID(),
      fencingToken: '1',
      expiresAt: new Date(Date.now() + 300000).toISOString(),
      operation,
    }),
    ctx = (c: AgentCommand) => ({
      ...c,
      signal: controller.signal,
      resolveDocker: async () => scoped,
      authorizeEffect: async () => true,
    });
  const backup = command({ kind: 'docker_backup', repositoryId: randomUUID() }),
    proof = await runDockerCommand(backup, ctx(backup), policy, join(root, 'artifacts'));
  assert.ok(proof.docker);
  assert.equal(proof.docker.artifacts.filter((f) => f.name.startsWith('image-')).length, 3);
  assert.equal(proof.docker.artifacts.filter((f) => f.name.startsWith('data-')).length, 1);
  await write('owned-files', 'new live source');
  for (const id of ids) {
    const s = await docker.service(id);
    const spec = s.Spec as {
      Mode: { Replicated: { Replicas: number } };
      TaskTemplate: { ContainerSpec: { Env: string[]; Args: string[] } };
    };
    spec.TaskTemplate.ContainerSpec.Env = [
      'VERSION=current',
      'DATABASE_URL=current-database',
      'REDIS_URL=current-queue',
    ];
    if (id === ids[1]) {
      spec.Mode.Replicated.Replicas = 2;
      spec.TaskTemplate.ContainerSpec.Args = ['-e', 'process.exit(42)'];
    }
    await docker.updateService(id, s.Version.Index, spec);
  }
  let broken = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    const tasks = await docker.tasks(ids[1]!);
    if (
      tasks.some((t) => t.Status.State === 'failed') &&
      !tasks.some((t) => t.Status.State === 'running')
    ) {
      broken = true;
      break;
    }
    await delay(500);
  }
  assert.equal(broken, true, 'The current API service must actually fail before historical return');
  // The documented operator guard resolves in-flight native deployments first.
  // A paused failed rollout is settled; a healthy current app is not required.
  let settled = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    const states = await Promise.all(
      ids.map(
        async (id) =>
          ((await api('GET', `/services/${id}`)) as { UpdateStatus?: { State: string } })
            .UpdateStatus?.State,
      ),
    );
    if (
      states.every(
        (state) =>
          !state ||
          ['completed', 'paused', 'rollback_completed', 'rollback_paused'].includes(state),
      )
    ) {
      settled = true;
      break;
    }
    await delay(500);
  }
  assert.equal(
    settled,
    true,
    'Native deployments must settle before confirming exact target versions',
  );
  const targetServices = await Promise.all(
    ids.map(async (id) => {
      const s = await docker.service(id);
      return { id, version: s.Version.Index };
    }),
  );
  const operation = {
    kind: 'docker_restore' as const,
    repositoryId: proof.docker.repositoryId,
    recoveryPointId: randomUUID(),
    snapshotId: proof.docker.snapshotId,
    nativeRepositoryId: proof.docker.nativeRepositoryId,
    sha256: proof.docker.sha256,
    targetName: 'known-app',
    replaceContainer: true,
    targetContainerId: null,
    targetServices,
    redeployGuardConfirmed: true,
  };
  const denied = command({ ...operation, redeployGuardConfirmed: false });
  await assert.rejects(
    () => runDockerCommand(denied, ctx(denied), policy, join(root, 'artifacts')),
    DockerStageError,
  );
  const stale = command({
    ...operation,
    targetServices: targetServices.map((s) => ({ ...s, version: s.version - 1 })),
  });
  await assert.rejects(
    () => runDockerCommand(stale, ctx(stale), policy, join(root, 'artifacts')),
    DockerStageError,
  );
  const restore = command(operation),
    result = await runDockerCommand(restore, ctx(restore), policy, join(root, 'artifacts'));
  assert.equal(result.dockerRestored?.kind, 'swarm');
  assert.equal(result.dockerRestored?.running, true);
  for (const id of ids) {
    const s = await docker.service(id),
      spec = s.Spec as {
        Mode: { Replicated: { Replicas: number } };
        TaskTemplate: {
          ContainerSpec: { Env: string[]; Image: string; Mounts: { Source: string }[] };
        };
      };
    assert.ok(spec.TaskTemplate.ContainerSpec.Env.includes('VERSION=historical'));
    assert.ok(spec.TaskTemplate.ContainerSpec.Env.includes('DATABASE_URL=current-database'));
    assert.ok(spec.TaskTemplate.ContainerSpec.Env.includes('REDIS_URL=current-queue'));
    assert.equal(spec.TaskTemplate.ContainerSpec.Image, image);
    assert.equal(spec.Mode.Replicated.Replicas, 1);
    assert.equal(
      (await docker.tasks(id)).filter(
        (t) => t.DesiredState === 'running' && t.Status.State === 'running',
      ).length,
      1,
    );
  }
  const read = async (volume: string) => {
    const id = await docker.createContainer('read-' + randomUUID(), {
      Image: image,
      Cmd: ['node', '-e', 'process.stdout.write(require("fs").readFileSync("/data/value.txt"))'],
      HostConfig: { Mounts: [{ Type: 'volume', Source: volume, Target: '/data', ReadOnly: true }] },
    });
    await docker.start(id);
    await api('POST', `/containers/${id}/wait?condition=not-running`);
    const raw = await new Promise<Buffer>((resolve, reject) => {
      const r = httpRequest(
        { socketPath, path: `/v1.47/containers/${id}/logs?stdout=1` },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (b) => chunks.push(Buffer.from(b)));
          res.on('end', () => resolve(Buffer.concat(chunks)));
        },
      );
      r.on('error', reject);
      r.end();
    });
    return raw.subarray(8).toString();
  };
  assert.equal(await read(result.dockerRestored!.targets[0]!), 'ação histórica');
  assert.equal(await read('owned-files'), 'new live source');
  assert.equal(await read('neighbor-files'), 'neighbor unchanged');
});
