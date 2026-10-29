import { createAgentRegistry } from '../../apps/agent/src/enrollment.js';
import { runtimeFixture } from '../integration/runtime-fixture.js';
import { createDestinationsRepository } from '../../packages/db/src/repositories/destinations.js';
import { encryptSecret } from '../../packages/security/src/vault.js';
import { readRepository } from '../../packages/connectors/src/repository-context.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, generateKeyPairSync } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, cp, chmod, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import {
  repositoryHandle,
  runRepositoryCommand,
  cleanupStaging,
  ownStaging,
} from '../../packages/connectors/src/repository-runtime.js';
import type { AgentCommand, ExecutionContext, RepositoryRuntime } from '@apbackup/contracts';
test('official Restic native S3 and Rclone SFTP copy the captured snapshot; restored bytes match and corruption is refused', async () => {
  process.env.VAULT_KEY_BASE64 = randomBytes(32).toString('base64');
  process.env.VAULT_KEY_REFERENCE = 'transport-renewal-fixture';
  const fixture = await runtimeFixture();
  const root = await mkdtemp(join(tmpdir(), 'apbackup-backends-'));
  await cp('/tools/rclone', '/usr/local/bin/rclone');
  await chmod('/usr/local/bin/rclone', 0o755);
  const artifactRoot = join(root, 'artifacts'),
    repositoryRoot = join(root, 'repos'),
    s3root = join(root, 's3'),
    sftproot = join(root, 'sftp');
  for (const p of [artifactRoot, repositoryRoot, s3root, sftproot]) await mkdir(p, { mode: 0o700 });
  const { privateKey, publicKey } = generateKeyPairSync('ed25519'),
    keyPath = join(root, 'host-key');
  await writeFile(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const publicBytes = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32),
    kind = Buffer.from('ssh-ed25519'),
    a = Buffer.alloc(4),
    b = Buffer.alloc(4);
  a.writeUInt32BE(kind.length);
  b.writeUInt32BE(32);
  const hostKey = 'ssh-ed25519 ' + Buffer.concat([a, kind, b, publicBytes]).toString('base64');
  const fixtureUser = 'fixture',
    fixturePassword = randomBytes(24).toString('hex'),
    access = randomBytes(16).toString('hex'),
    secret = randomBytes(32).toString('hex');
  const servers = [
    spawn(
      '/usr/local/bin/rclone',
      ['serve', 's3', s3root, '--addr', '127.0.0.1:19430', '--auth-key', access + ',' + secret],
      { stdio: 'ignore' },
    ),
    spawn(
      '/usr/local/bin/rclone',
      [
        'serve',
        'sftp',
        sftproot,
        '--addr',
        '127.0.0.1:19422',
        '--user',
        fixtureUser,
        '--pass',
        fixturePassword,
        '--key',
        keyPath,
      ],
      { stdio: 'ignore' },
    ),
  ];
  const source: RepositoryRuntime = {
    repositoryId: randomUUID(),
    destinationId: randomUUID(),
    configurationRevision: 1,
    kind: 'local',
    host: null,
    rootPath: 'capture',
    configuration: null,
    credential: { secret: randomBytes(24).toString('hex') },
    nativeRepositoryId: null,
  };
  const s3: RepositoryRuntime = {
    ...source,
    repositoryId: randomUUID(),
    destinationId: randomUUID(),
    kind: 's3',
    rootPath: 'dedicated',
    configuration: { backend: 's3', endpoint: 'http://127.0.0.1:19430', bucket: 'backups' },
    credential: { secret: randomBytes(24).toString('hex'), accessKey: access, secretKey: secret },
  };
  const sftp: RepositoryRuntime = {
    ...source,
    repositoryId: randomUUID(),
    destinationId: randomUUID(),
    kind: 'sftp',
    host: '127.0.0.1',
    rootPath: 'dedicated',
    configuration: { backend: 'sftp', port: 19422, hostKey },
    credential: {
      secret: randomBytes(24).toString('hex'),
      username: fixtureUser,
      password: fixturePassword,
    },
  };
  const actor = randomUUID();
  await fixture.db.pool.query("insert into users(id,name,email) values($1,'Fixture',$2)", [
    actor,
    actor + '@example.test',
  ]);
  const destinations = createDestinationsRepository({
    db: fixture.db,
    organizationId: fixture.org,
    actorId: actor,
    vault: { encryptSecret },
  });
  const stored = await destinations.create({
    name: 'Renewable SFTP',
    kind: 'sftp',
    engine: 'restic',
    host: sftp.host,
    rootPath: sftp.rootPath,
    configuration: sftp.configuration,
    status: 'ativo',
    credential: sftp.credential,
  });
  sftp.repositoryId = stored.repositoryId;
  sftp.destinationId = stored.id;
  const command: AgentCommand = {
    version: 1,
    organizationId: fixture.org,
    commandId: randomUUID(),
    executionId: randomUUID(),
    agentId: randomUUID(),
    profileVersionId: randomUUID(),
    resourceId: randomUUID(),
    fencingToken: '1',
    expiresAt: new Date(Date.now() + 180000).toISOString(),
    operation: {
      kind: 'postgresql_backup',
      repositoryId: source.repositoryId,
      repositoryIds: [source.repositoryId, s3.repositoryId, sftp.repositoryId],
    },
  };
  const context: ExecutionContext = {
    ...command,
    signal: new AbortController().signal,
    authorizeEffect: async () => true,
    resolveRepositories: async () => ({ repositories: [source, s3, sftp], files: [] }),
  };
  const policy = { repositoryRoot, allowedHosts: ['127.0.0.1'] };
  try {
    await delay(500);
    const stage = join(artifactRoot, command.executionId);
    await mkdir(stage, { mode: 0o700 });
    const bytes = Buffer.from('captura única · ação/saúde\n' + randomBytes(48).toString('hex'));
    await writeFile(join(stage, 'database.dump'), bytes, { mode: 0o600 });
    const from = await repositoryHandle(source, policy, stage, command, context);
    source.nativeRepositoryId = await from.initialize();
    const output = await from.run(['backup', '--json', '--', 'database.dump']);
    const summary = output
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { message_type: string; snapshot_id?: string })
      .find((v) => v.message_type === 'summary')!;
    const { createHash } = await import('node:crypto');
    const result = await runRepositoryCommand(command, context, policy, artifactRoot, {
      repositoryId: source.repositoryId,
      nativeRepositoryId: source.nativeRepositoryId,
      snapshotId: summary.snapshot_id!,
      database: 'fixture',
      schemas: [],
      serverMajor: 17,
      capturedAt: new Date().toISOString(),
      sha256: createHash('sha256').update(bytes).digest('hex'),
      sizeBytes: String(bytes.length),
    });
    assert.deepEqual(
      result.replications?.map((r) => r.status),
      ['concluida', 'concluida'],
    );
    for (const target of [s3, sftp]) {
      const evidence = result.replications!.find((r) => r.repositoryId === target.repositoryId)!;
      const check = await repositoryHandle(
        { ...target, nativeRepositoryId: evidence.nativeRepositoryId! },
        policy,
        stage,
        command,
        context,
      );
      const restored = join(root, 'restored-' + target.kind);
      await mkdir(restored, { mode: 0o700 });
      try {
        await check.run(['restore', evidence.snapshotId!, '--target', restored]);
        assert.deepEqual(await readFile(join(restored, 'database.dump')), bytes);
      } finally {
        await check.close();
      }
    }
    const evidence = result.replications!.find((r) => r.repositoryId === sftp.repositoryId)!;
    await fixture.db.pool.query('update repositories set native_repository_id=$2 where id=$1', [
      sftp.repositoryId,
      evidence.nativeRepositoryId,
    ]);
    const point = randomUUID(),
      execution = randomUUID();
    await fixture.db.pool.query(
      "insert into executions(id,organization_id,kind,idempotency_key,profile_version_id) values($1::uuid,$2,'backup',$1::text,$3)",
      [execution, fixture.org, fixture.version],
    );
    await fixture.db.pool.query(
      "insert into recovery_points(id,organization_id,execution_id,server_id,profile_version_id,captured_at,status) values($1,$2,$3,$4,$5,now(),'complete')",
      [point, fixture.org, execution, fixture.server, fixture.version],
    );
    await fixture.db.pool.query(
      "insert into destination_results(organization_id,recovery_point_id,repository_id,status,native_snapshot_id,verified_at,verification_scope) values($1,$2,$3,'concluida',$4,now(),'fixture-real-copy')",
      [fixture.org, point, sftp.repositoryId, evidence.snapshotId],
    );
    const updatedInput = {
      name: stored.name,
      host: stored.host,
      kind: stored.kind,
      engine: stored.engine,
      rootPath: stored.rootPath,
      configuration: stored.configuration,
      status: stored.status,
      expectedUpdatedAt: stored.updatedAt,
    };
    await assert.rejects(
      destinations.update(stored.id, {
        ...updatedInput,
        credential: { ...sftp.credential, secret: 'changed-encryption-password' },
      }),
      { status: 409 },
    );
    const registry = createAgentRegistry(fixture.db);
    const agent = await registry.enroll(
      await registry.invite(fixture.org, fixture.server, new Date(Date.now() + 60000)),
      randomUUID(),
    );
    const inFlight = {
      ...command,
      commandId: randomUUID(),
      executionId: execution,
      organizationId: fixture.org,
      agentId: agent.agentId,
      resourceId: fixture.resource,
      profileVersionId: fixture.version,
      operation: {
        kind: 'repository_test',
        repositoryId: sftp.repositoryId,
        repositoryRevisions: { [sftp.repositoryId]: 1 },
      },
    };
    await fixture.db.pool.query(
      'insert into agent_commands(id,organization_id,execution_id,agent_id,resource_id,profile_version_id,fencing_token,body,expires_at) values($1,$2,$3,$4,$5,$6,1,$7,$8)',
      [
        inFlight.commandId,
        fixture.org,
        execution,
        agent.agentId,
        fixture.resource,
        fixture.version,
        JSON.stringify(inFlight),
        command.expiresAt,
      ],
    );
    for (const state of ['queued', 'unknown']) {
      await fixture.db.pool.query('update agent_commands set state=$2 where id=$1', [
        inFlight.commandId,
        state,
      ]);
      await assert.rejects(
        destinations.update(stored.id, { ...updatedInput, credential: sftp.credential }),
        { status: 409 },
      );
    }
    await fixture.db.pool.query("update agent_commands set state='completed' where id=$1", [
      inFlight.commandId,
    ]);
    const renewedPassword = randomBytes(24).toString('hex');
    const oldServer = servers.pop()!;
    oldServer.kill('SIGTERM');
    await new Promise<void>((resolve) => oldServer.once('close', () => resolve()));
    servers.push(
      spawn(
        '/usr/local/bin/rclone',
        [
          'serve',
          'sftp',
          sftproot,
          '--addr',
          '127.0.0.1:19422',
          '--user',
          fixtureUser,
          '--pass',
          renewedPassword,
          '--key',
          keyPath,
        ],
        { stdio: 'ignore' },
      ),
    );
    await delay(300);
    const renewed = await destinations.update(stored.id, {
      ...updatedInput,
      credential: { ...sftp.credential, password: renewedPassword },
    });
    assert.equal(renewed.repositoryId, sftp.repositoryId);
    assert.ok(!JSON.stringify(renewed).includes(renewedPassword));
    const runtime = await readRepository(fixture.db, fixture.org, sftp.repositoryId);
    assert.equal(runtime.configurationRevision, 2);
    assert.equal(runtime.nativeRepositoryId, evidence.nativeRepositoryId);
    await assert.rejects(
      readRepository(fixture.db, fixture.org, sftp.repositoryId, 1),
      'old fenced revision refused after renewal',
    );
    const afterRenewal = await repositoryHandle(runtime, policy, stage, command, context),
      returnPath = join(root, 'after-transport-renewal');
    await mkdir(returnPath, { mode: 0o700 });
    try {
      await afterRenewal.run(['restore', evidence.snapshotId!, '--target', returnPath]);
      assert.deepEqual(await readFile(join(returnPath, 'database.dump')), bytes);
    } finally {
      await afterRenewal.close();
    }
    assert.equal(
      (
        await fixture.db.pool.query(
          'select native_snapshot_id from destination_results where recovery_point_id=$1',
          [point],
        )
      ).rows[0]?.native_snapshot_id,
      evidence.snapshotId,
    );
    const shards = await readdir(join(s3root, 'backups', 'dedicated', 'data'));
    const packdir = join(s3root, 'backups', 'dedicated', 'data', shards[0]!);
    await writeFile(join(packdir, (await readdir(packdir))[0]!), Buffer.from('corrupted'));
    const broken = await repositoryHandle(s3, policy, stage, command, context);
    try {
      await assert.rejects(broken.run(['check', '--read-data']));
    } finally {
      await broken.close();
    }
    assert.equal(
      (await readdir(stage)).some((n) => n.endsWith('.conf')),
      false,
      'private Rclone config removed',
    );
    await assert.rejects(cleanupStaging(artifactRoot, { ...command, executionId: '../outside' }));
    await ownStaging(artifactRoot, command);
    await assert.rejects(
      cleanupStaging(artifactRoot, { ...command, organizationId: randomUUID() }),
    );
    await cleanupStaging(artifactRoot, command);
    await assert.rejects(readFile(join(stage, '.apbackup-owner')));
  } finally {
    for (const server of servers) server.kill('SIGTERM');
    await Promise.all(
      servers.map(
        (s) =>
          new Promise<void>((resolve) => {
            if (s.exitCode !== null) resolve();
            else s.once('close', () => resolve());
          }),
      ),
    );
    await fixture.db.close();
    await rm(root, { recursive: true, force: true });
  }
});
