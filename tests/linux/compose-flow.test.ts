import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dockerClient } from '../../packages/connectors/src/docker-client.js';
import { inspectDataTar } from '../../packages/connectors/src/docker-archive.js';
import {
  runDockerCommand,
  DockerStageError,
} from '../../packages/connectors/src/docker-runtime.js';
import { dockerRuntimeSchema, type AgentCommand } from '@apbackup/contracts';

test('isolated Compose captures exact code, shared files and RO file config, fences redeploy, restores group onto fresh data with original containers retained', async () => {
  const socketPath = '/daemon/docker.sock',
    root = await mkdtemp(join(tmpdir(), 'compose-flow-')),
    image = process.env.FIXTURE_HELPER_IMAGE!,
    project = 'mail-fixture',
    bindRoot = '/tmp/compose-fixture';
  await mkdir(join(root, 'repo'), { mode: 0o700 });
  await mkdir(join(root, 'artifacts'), { mode: 0o700 });
  const policy = {
      socketPath,
      helperImage: image,
      repositoryRoot: join(root, 'repo'),
      directories: { nginx: bindRoot + '/nginx.conf', metrics: bindRoot + '/metrics' },
      dynamicOverlayNetworks: {} as Record<string, string>,
    },
    controller = new AbortController(),
    docker = dockerClient(policy, controller.signal);
  const api = (method: string, path: string, body?: unknown): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const r = request(
        {
          socketPath,
          method,
          path: '/v1.47' + path,
          headers: body ? { 'content-type': 'application/json' } : {},
        },
        (res) => {
          let out = '';
          res.on('data', (b) => (out += String(b)));
          res.on('end', () =>
            res.statusCode && res.statusCode < 300
              ? resolve(out ? (JSON.parse(out) as unknown) : null)
              : reject(new Error(out)),
          );
        },
      );
      r.on('error', reject);
      r.end(body ? JSON.stringify(body) : undefined);
    });
  await api('POST', '/networks/create', {
    Name: project + '_default',
    Driver: 'bridge',
    Labels: { 'com.docker.compose.project': project },
  });
  await api('POST', '/swarm/init', { ListenAddr: '0.0.0.0:2377', AdvertiseAddr: '127.0.0.1' });
  const overlay = (await api('POST', '/networks/create', {
    Name: 'external-dokploy-fixture',
    Driver: 'overlay',
    Attachable: true,
  })) as { Id: string };
  policy.dynamicOverlayNetworks['external-dokploy-fixture'] = overlay.Id;
  await docker.createVolume('mail-files', 'fixture');
  const seed = async (text: string) => {
    const id = await docker.createContainer('seed-' + randomUUID(), {
      Image: image,
      Cmd: [
        'node',
        '-e',
        `const fs=require('fs');fs.writeFileSync('/files/mail.txt',${JSON.stringify(text)});fs.writeFileSync('/config/nginx.conf','historical config');fs.chmodSync('/config/nginx.conf',0o640);fs.chownSync('/config/nginx.conf',1234,2345);fs.mkdirSync('/config/metrics',{recursive:true});fs.writeFileSync('/config/metrics/not-backed-up','ephemeral metric')`,
      ],
      HostConfig: {
        Mounts: [{ Type: 'volume', Source: 'mail-files', Target: '/files' }],
        Binds: [bindRoot + ':/config'],
      },
    });
    await docker.start(id);
    await api('POST', `/containers/${id}/wait?condition=not-running`);
    await api('DELETE', `/containers/${id}?v=0`);
  };
  await seed('historical attachment');
  const roles = ['frontend', 'api', 'worker'] as const,
    ids: string[] = [];
  const create = async (i: number, env: string) => {
    const name = 'mail-' + roles[i],
      network = project + '_default';
    const id = await docker.createContainer(name, {
      Image: image,
      Cmd:
        i === 1
          ? ['sh', '-c', "node -e 'setInterval(()=>{},10000)' # migration"]
          : [
              'node',
              '-e',
              i === 0
                ? "const fs=require('fs');fs.mkdirSync('/app/apps/web/.next/cache',{recursive:true});fs.writeFileSync('/app/apps/web/.next/cache/image.webp','discarded cache');setInterval(()=>{},10000)"
                : "const fs=require('fs');for(const p of ['/root/.cache/checkpoint-nodejs','/root/.cache/prisma/master']){fs.mkdirSync(p,{recursive:true});fs.writeFileSync(p+'/generated','discarded cache')}setInterval(()=>{},10000)",
            ],
      Env: ['DATABASE_URL=' + env, 'RELEASE=historical'],
      Labels: { 'com.docker.compose.project': project, 'com.docker.compose.service': roles[i] },
      Healthcheck: {
        Test: [
          'CMD',
          'node',
          '-e',
          i === 0
            ? "const fs=require('fs'),s=fs.statSync('/etc/nginx.conf');process.exit(fs.readFileSync('/etc/nginx.conf','utf8')==='historical config'&&s.isFile()&&(s.mode&511)===416&&s.uid===1234&&s.gid===2345?0:1)"
            : `process.exit(require('fs').readFileSync('${i === 2 ? '/app/files/documents' : '/files'}/mail.txt','utf8')==='historical attachment'?0:1)`,
        ],
        Interval: 1000000000,
      },
      HostConfig: {
        NetworkMode: network,
        Init: i > 0,
        Mounts: i
          ? [
              {
                Type: 'volume',
                Source: 'mail-files',
                Target: i === 2 ? '/app/files/documents' : '/files',
              },
              ...(i === 2
                ? [
                    {
                      Type: 'bind',
                      Source: bindRoot + '/metrics',
                      Target: '/data/metrics',
                      ReadOnly: true,
                    },
                  ]
                : []),
            ]
          : [
              {
                Type: 'bind',
                Source: bindRoot + '/nginx.conf',
                Target: '/etc/nginx.conf',
                ReadOnly: true,
              },
            ],
      },
      NetworkingConfig: {
        EndpointsConfig: {
          [network]: { Aliases: [roles[i]] },
          'external-dokploy-fixture': { Aliases: [roles[i]] },
        },
      },
    });
    await docker.start(id);
    return id;
  };
  for (let i = 0; i < 3; i++) ids.push(await create(i, 'old-source-db'));
  const neighbor = await docker.createContainer('source-database', {
    Image: image,
    Cmd: ['node', '-e', 'setInterval(()=>{},10000)'],
    HostConfig: { NetworkMode: project + '_default' },
  });
  await docker.start(neighbor);
  const scoped = dockerRuntimeSchema.parse({
    selection: {
      serverId: randomUUID(),
      kind: 'compose',
      identity: project,
      containers: ids.map((id, i) => ({
        id: i === 0 ? '0'.repeat(64) : id,
        name: 'mail-' + roles[i],
        service: roles[i],
        role: roles[i],
        preserveEnvironmentKeys: ['DATABASE_URL'],
        startupReviewed: true,
        ...(i === 0
          ? { ephemeralPaths: ['/app/apps/web/.next/cache'] }
          : i === 2
            ? { ephemeralPaths: ['/root/.cache/checkpoint-nodejs', '/root/.cache/prisma'] }
            : {}),
        ...(i === 1
          ? { restoreStartup: { command: ['node', '-e', 'setInterval(()=>{},10000)'] } }
          : {}),
        ...(i === 2 ? { emptyReadOnlyMounts: ['/data/metrics'] } : {}),
      })),
    },
    repositoryPath: 'compose-test',
    repositoryPassword: 'private-compose-password',
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
  });
  const ctx = (c: AgentCommand) => ({
    ...c,
    signal: controller.signal,
    resolveDocker: async () => scoped,
    authorizeEffect: async () => true,
  });
  const backup = command({ kind: 'docker_backup', repositoryId: randomUUID() });
  const reviewedOverlay = policy.dynamicOverlayNetworks['external-dokploy-fixture']!;
  delete policy.dynamicOverlayNetworks['external-dokploy-fixture'];
  const unreviewed = command({ kind: 'docker_backup', repositoryId: randomUUID() });
  await assert.rejects(
    () => runDockerCommand(unreviewed, ctx(unreviewed), policy, join(root, 'artifacts')),
    DockerStageError,
  );
  policy.dynamicOverlayNetworks['external-dokploy-fixture'] = reviewedOverlay;
  const outsider = await docker.createContainer('outsider', {
    Image: image,
    Cmd: ['node', '-e', 'setInterval(()=>{},10000)'],
    HostConfig: { Mounts: [{ Type: 'volume', Source: 'mail-files', Target: '/files' }] },
  });
  const shared = command({ kind: 'docker_backup', repositoryId: randomUUID() });
  await assert.rejects(
    () => runDockerCommand(shared, ctx(shared), policy, join(root, 'artifacts')),
    DockerStageError,
  );
  await api('DELETE', `/containers/${outsider}?v=0`);
  for (const [name, extra, cmd] of [
    ['unsafe', { Privileged: true }, ['node', '-e', 'setInterval(()=>{},10000)']],
    [
      'writable',
      {},
      [
        'node',
        '-e',
        "require('fs').writeFileSync('/unexpected','must reject');setInterval(()=>{},10000)",
      ],
    ],
  ] as const) {
    const id = await docker.createContainer(name, {
      Image: image,
      Cmd: cmd,
      Labels: { 'com.docker.compose.project': project, 'com.docker.compose.service': 'frontend' },
      HostConfig: { NetworkMode: project + '_default', ...extra },
    });
    await docker.start(id);
    for (let attempt = 0; attempt < 30 && name === 'writable'; attempt++) {
      if ((await docker.changes(id)).some((c) => c.Path === '/unexpected')) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const invalid = command({ kind: 'docker_backup', repositoryId: randomUUID() }),
      altered = structuredClone(scoped);
    altered.selection.containers![0]!.name = name;
    await assert.rejects(
      () =>
        runDockerCommand(
          invalid,
          { ...ctx(invalid), resolveDocker: async () => altered },
          policy,
          join(root, 'artifacts'),
        ),
      DockerStageError,
    );
    await docker.stop(id);
    await api('DELETE', `/containers/${id}?v=0`);
  }
  const removeMetrics = await docker.createContainer('remove-metrics', {
    Image: image,
    Cmd: ['node', '-e', "require('fs').rmSync('/config/metrics',{recursive:true})"],
    HostConfig: { Binds: [bindRoot + ':/config'] },
  });
  await docker.start(removeMetrics);
  await api('POST', `/containers/${removeMetrics}/wait?condition=not-running`);
  await api('DELETE', `/containers/${removeMetrics}?v=0`);
  const proof = await runDockerCommand(backup, ctx(backup), policy, join(root, 'artifacts'));
  assert.ok(proof.docker);
  assert.equal(
    proof.docker.artifacts.filter((f) => f.name.startsWith('data-')).length,
    2,
    'Shared mount captured once and file config captured',
  );
  assert.equal(
    (await Promise.all(ids.map(async (id) => (await docker.inspect(id)).State.Running))).every(
      Boolean,
    ),
    true,
  );
  const indexText = await readFile(join(root, 'artifacts', backup.executionId, 'set.json'), 'utf8');
  assert.equal(
    indexText.includes('old-source-db'),
    false,
    'No environment secrets in public index',
  );
  await seed('new live attachment');
  await docker.capture(
    { Type: 'volume', Source: 'mail-files', Target: '/data', ReadOnly: true },
    'source-check',
    join(root, 'source-before.tar'),
  );
  const sourceFingerprint = (
    await inspectDataTar(join(root, 'source-before.tar'), controller.signal)
  ).fingerprint;
  const targets: { id: string; name: string }[] = [];
  for (let i = 0; i < 3; i++) {
    await docker.stop(ids[i]!);
    await api('DELETE', `/containers/${ids[i]}?v=0`);
    targets.push({ id: await create(i, 'current-source-db'), name: 'mail-' + roles[i] });
  }
  const operation = {
    kind: 'docker_restore' as const,
    repositoryId: proof.docker.repositoryId,
    recoveryPointId: randomUUID(),
    snapshotId: proof.docker.snapshotId,
    nativeRepositoryId: proof.docker.nativeRepositoryId,
    sha256: proof.docker.sha256,
    targetName: project,
    replaceContainer: true,
    targetContainerId: null,
    targetContainers: targets,
    redeployGuardConfirmed: true,
  };
  const stale = command({
    ...operation,
    targetContainers: targets.map((t, i) => (i ? t : { ...t, id: ids[0]! })),
  });
  await assert.rejects(
    () => runDockerCommand(stale, ctx(stale), policy, join(root, 'artifacts')),
    DockerStageError,
  );
  const restore = command(operation),
    result = await runDockerCommand(restore, ctx(restore), policy, join(root, 'artifacts'));
  assert.equal(result.dockerRestored?.kind, 'compose');
  assert.equal(result.dockerRestored?.running, true);
  for (let i = 0; i < 3; i++) {
    assert.equal(
      (await docker.inspect(targets[i]!.id)).State.Running,
      false,
      'Original preserved stopped',
    );
    const restored = await docker.inspect('mail-' + roles[i]);
    assert.ok(restored.Config.Env?.includes('DATABASE_URL=current-source-db'));
    assert.equal(restored.Image, image);
    assert.equal(restored.HostConfig.Init, i > 0, 'Daemon init behavior retained');
    if (i === 1)
      assert.deepEqual(
        restored.Config.Cmd,
        ['node', '-e', 'setInterval(()=>{},10000)'],
        'Reviewed override skips migration startup',
      );
    const restoredMount = restored.Mounts.find(
      (m) =>
        m.Destination ===
        (i === 0 ? '/etc/nginx.conf' : i === 2 ? '/app/files/documents' : '/files'),
    )!;
    assert.equal(restoredMount.Type, 'volume');
    if (i === 0) assert.equal(restoredMount.RW, false, 'Single file subpath retained read-only');
    else assert.notEqual(restoredMount.Name, 'mail-files');
  }
  const apiContainer = await docker.inspect('mail-api'),
    worker = await docker.inspect('mail-worker');
  assert.equal(
    apiContainer.Mounts.find((m) => m.Destination === '/files')!.Name,
    worker.Mounts.find((m) => m.Destination === '/app/files/documents')!.Name,
    'Group sharing retained on one fresh volume',
  );
  assert.equal(
    (await docker.inspect(neighbor)).State.Running,
    true,
    'External source DB unaffected',
  );
  const metrics = worker.Mounts.find((m) => m.Destination === '/data/metrics')!;
  assert.equal(metrics.RW, false);
  await docker.capture(
    { Type: 'volume', Source: metrics.Name!, Target: '/data', ReadOnly: true },
    'metrics-check',
    join(root, 'metrics-after.tar'),
  );
  assert.equal(
    (await inspectDataTar(join(root, 'metrics-after.tar'), controller.signal)).entries,
    1,
    'Omitted metrics explicitly restored as empty directory',
  );
  await docker.capture(
    { Type: 'volume', Source: 'mail-files', Target: '/data', ReadOnly: true },
    'source-check',
    join(root, 'source-after.tar'),
  );
  assert.equal(
    (await inspectDataTar(join(root, 'source-after.tar'), controller.signal)).fingerprint,
    sourceFingerprint,
    'Original live source bytes and metadata unchanged',
  );
  const again = command({ kind: 'docker_backup', repositoryId: proof.docker.repositoryId });
  const againProof = await runDockerCommand(again, ctx(again), policy, join(root, 'artifacts'));
  assert.ok(againProof.docker);
  const againIndex = JSON.parse(
    await readFile(join(root, 'artifacts', again.executionId, 'set.json'), 'utf8'),
  ) as { data: { rootKind: string }[] };
  assert.equal(
    againIndex.data.filter((d) => d.rootKind === 'file').length,
    1,
    'Restored file subpath stays a file in the next recovery set',
  );
  const againTargets = await Promise.all(
    roles.map(async (role) => {
      const c = await docker.inspect('mail-' + role);
      return { id: c.Id, name: c.Name.slice(1) };
    }),
  );
  const againReturn = command({
    ...operation,
    snapshotId: againProof.docker.snapshotId,
    sha256: againProof.docker.sha256,
    targetContainers: againTargets,
  });
  const againResult = await runDockerCommand(
    againReturn,
    ctx(againReturn),
    policy,
    join(root, 'artifacts'),
  );
  assert.equal(
    againResult.dockerRestored?.health,
    'healthy',
    'Second return keeps nginx file bytes, UID/GID/mode, shared files and group health',
  );
  const nginxAgain = await docker.inspect('mail-frontend');
  assert.equal(
    nginxAgain.HostConfig.Mounts?.find((m) => m.Target === '/etc/nginx.conf')?.VolumeOptions
      ?.Subpath,
    'data',
  );
  for (const t of againTargets)
    assert.equal(
      (await docker.inspect(t.id)).State.Running,
      false,
      'First returned generation remains preserved',
    );
  const bad = structuredClone(scoped);
  bad.selection.containers![0]!.name = 'source-database';
  const invalid = command({ kind: 'docker_backup', repositoryId: randomUUID() });
  await assert.rejects(
    () =>
      runDockerCommand(
        invalid,
        { ...ctx(invalid), resolveDocker: async () => bad },
        policy,
        join(root, 'artifacts'),
      ),
    DockerStageError,
  );
});
