import { existsSync } from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { beforeAll, afterAll, expect, test } from 'vitest';
import { createDatabase, migrate } from '@apbackup/db';
import { bootstrapAdmin } from '../../packages/security/src/administration.js';
import { createVault } from '../../packages/security/src/vault.js';
import type { SessionPrincipal } from '../../packages/security/src/authorization.js';
const url = process.env.TEST_DATABASE_URL;
if (
  !url ||
  new URL(url).hostname !== '127.0.0.1' ||
  !/^apbackup_test_[a-f0-9]+$/.test(new URL(url).pathname.slice(1))
)
  throw new Error('Disposable PostgreSQL required');
const db = createDatabase(url),
  vault = createVault(randomBytes(32), 'configuration-test-v1');
let principal: SessionPrincipal;
async function service(actor = principal) {
  const path = new URL('../../apps/web/src/lib/configuration.server.ts', import.meta.url);
  const api: Record<string, unknown> = existsSync(path) ? await import(path.href) : {};
  expect(api.createConfigurationService, 'authorized configuration service must exist').toBeTypeOf(
    'function',
  );
  const { createConfigurationService } =
    await import('../../apps/web/src/lib/configuration.server.js');
  return createConfigurationService(db, actor, vault);
}
beforeAll(async () => {
  await migrate(db);
  const account = await bootstrapAdmin(db, {
    email: `configuration-${randomUUID()}@example.test`,
    password: randomBytes(24).toString('base64url'),
    name: 'Configuration test',
    organizationName: `Config ${randomUUID()}`,
  });
  const membership = (
    await db.pool.query<{ id: string }>(
      'select id from organization_memberships where organization_id=$1 and user_id=$2',
      [account.organizationId, account.userId],
    )
  ).rows[0]!;
  principal = {
    userId: account.userId,
    organizationId: account.organizationId,
    membershipId: membership.id,
    sessionId: randomUUID(),
    role: 'administrator',
    reauthenticatedAt: new Date(),
    mfaVerifiedAt: new Date(),
  };
});
afterAll(() => db.close());
const serverInput = () => ({
  name: `Origin ${randomUUID()}`,
  externalIdentity: `origin:${randomUUID()}`,
  hostname: 'origin.example.test',
});
test('creates, edits, archives and restores persisted origins; rejects duplicates and stale edits', async () => {
  const api = await service(),
    input = serverInput();
  const saved = await api.servers.create(input);
  expect((await api.servers.get(saved.id)).name).toBe(input.name);
  await expect(api.servers.create(input)).rejects.toMatchObject({ status: 409 });
  const edited = await api.servers.update(saved.id, {
    ...input,
    name: 'Renamed origin',
    expectedUpdatedAt: saved.updatedAt,
  });
  expect(edited.name).toBe('Renamed origin');
  await expect(
    api.servers.update(saved.id, { ...input, expectedUpdatedAt: saved.updatedAt }),
  ).rejects.toMatchObject({ status: 409 });
  const archived = await api.servers.archive(saved.id, { expectedUpdatedAt: edited.updatedAt });
  expect(archived.archivedAt).not.toBeNull();
  const restored = await api.servers.restore(saved.id, { expectedUpdatedAt: archived.updatedAt });
  expect(restored.archivedAt).toBeNull();
});
test('configuration requires recent password and MFA and rejects another tenant or missing reference', async () => {
  const viewer = await service({ ...principal, role: 'viewer' });
  await expect(viewer.servers.create(serverInput())).rejects.toMatchObject({ status: 403 });
  const stale = await service({ ...principal, reauthenticatedAt: new Date(0) });
  await expect(stale.servers.create(serverInput())).rejects.toMatchObject({ status: 403 });
  const api = await service();
  await expect(
    api.resources.create({
      serverId: randomUUID(),
      name: 'Missing',
      externalIdentity: 'db:missing',
      kind: 'postgresql',
      dependencies: [],
    }),
  ).rejects.toMatchObject({ status: 404 });
  const otherOrg = randomUUID();
  await db.pool.query('insert into organizations(id,name) values($1,$2)', [
    otherOrg,
    'Foreign organization',
  ]);
  const id = randomUUID();
  await db.pool.query(
    'insert into servers(id,organization_id,name,external_identity) values($1,$2,$3,$4)',
    [id, otherOrg, 'Foreign origin', 'foreign'],
  );
  await expect(api.servers.get(id)).rejects.toMatchObject({ status: 404 });
  await expect(
    api.resources.create({
      serverId: id,
      name: 'Cross tenant',
      externalIdentity: 'db:foreign',
      kind: 'postgresql',
      dependencies: [],
    }),
  ).rejects.toMatchObject({ status: 404 });
});
test('pending destination never invents protocol or coverage, and secret is write-only and encrypted', async () => {
  const api = await service();
  const pending = await api.destinations.create({
    name: `Pending NAS ${randomUUID()}`,
    host: '192.168.3.52',
    kind: null,
    engine: null,
    rootPath: null,
    status: 'aguardando_configuracao',
  });
  expect(pending).toMatchObject({
    kind: null,
    engine: null,
    status: 'aguardando_configuracao',
    hasCredential: false,
    coverage: false,
  });
  await expect(
    api.destinations.update(pending.id, {
      name: pending.name,
      host: pending.host,
      kind: pending.kind,
      engine: pending.engine,
      rootPath: pending.rootPath,
      status: 'ativo',
      expectedUpdatedAt: pending.updatedAt,
    }),
  ).rejects.toMatchObject({ status: 400 });
  const secret = `write-only-${randomUUID()}`;
  const configured = await api.destinations.update(pending.id, {
    name: pending.name,
    host: 'nas.example.test',
    kind: 'sftp',
    configuration: {
      backend: 'sftp',
      hostKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICJH5IvMLZkXUHDBcgjPHvY4WjSnnYLOSo5HUuFAhXbV',
    },
    engine: 'restic',
    rootPath: 'dedicated/apbackup',
    status: 'ativo',
    credential: { username: 'backup', secret, password: secret },
    expectedUpdatedAt: pending.updatedAt,
  });
  expect(configured).toMatchObject({ status: 'ativo', hasCredential: true, coverage: false });
  expect(JSON.stringify(await api.destinations.get(pending.id))).not.toContain(secret);
  const stored = (
    await db.pool.query<{ id: string; ciphertext: string }>(
      'select s.id,s.ciphertext from secret_references s join destinations d on d.credential_id=s.id where d.id=$1',
      [pending.id],
    )
  ).rows[0]!;
  expect(stored.ciphertext).not.toContain(secret);
  expect(
    JSON.parse(
      vault.decryptSecret(JSON.parse(stored.ciphertext), {
        organizationId: principal.organizationId,
        reference: stored.id,
        purpose: 'destination-credential',
      }),
    ),
  ).toEqual({ username: 'backup', secret, password: secret });
});
test('profile edits append immutable versions, execution keeps its original pinned version and pending destination blocks activation', async () => {
  const api = await service(),
    server = await api.servers.create(serverInput());
  const resource = await api.resources.create({
    serverId: server.id,
    name: 'Database',
    kind: 'postgresql',
    externalIdentity: `database:${randomUUID()}`,
    dependencies: [],
  });
  const input = {
    serverId: server.id,
    name: `System ${randomUUID()}`,
    externalIdentity: `system:${randomUUID()}`,
    adapter: { name: 'postgresql', version: '1.0.0' },
    consistency: 'transactional' as const,
    resources: [{ resourceId: resource.id, required: true }],
    restoreCapabilities: ['database' as const],
  };
  const profile = await api.profiles.create(input);
  const pending = await api.destinations.create({
    name: `Pending destination ${randomUUID()}`,
    host: '192.168.3.52',
    kind: null,
    engine: null,
    rootPath: null,
    status: 'aguardando_configuracao',
  });
  const planInput = {
    name: `Daily ${randomUUID()}`,
    profileVersionId: profile.versionId,
    destinations: [{ destinationId: pending.id, required: true }],
    retention: { days: 7, evidenceDays: 90, protectLastVerified: true as const },
    schedule: { localTime: '03:00', timezone: 'America/Sao_Paulo' },
    enabled: false,
  };
  const plan = await api.plans.create(planInput);
  await expect(
    api.plans.update(plan.id, { ...planInput, enabled: true, expectedUpdatedAt: plan.updatedAt }),
  ).rejects.toMatchObject({ status: 409 });
  expect((await api.getCoverage(server.id, principal.organizationId)).covered).toBe(false);
  const executionId = randomUUID();
  await db.pool.query(
    "insert into executions(id,organization_id,plan_id,kind,idempotency_key) values($1,$2,$3,'backup',$4)",
    [executionId, principal.organizationId, plan.id, `execution:${executionId}`],
  );
  const revised = await api.profiles.update(profile.id, {
    ...input,
    name: 'Revised system',
    expectedUpdatedAt: profile.updatedAt,
  });
  expect(revised.version).toBe(2);
  expect((await api.resolveProfile(profile.versionId, principal.organizationId)).version).toBe(1);
  await api.plans.update(plan.id, {
    ...planInput,
    profileVersionId: revised.versionId,
    expectedUpdatedAt: plan.updatedAt,
  });
  expect(
    (
      await db.pool.query<{ profile_version_id: string }>(
        'select profile_version_id from executions where id=$1',
        [executionId],
      )
    ).rows[0]!.profile_version_id,
  ).toBe(profile.versionId);
  await expect(
    db.pool.query("update profile_versions set definition='{}'::jsonb where id=$1", [
      profile.versionId,
    ]),
  ).rejects.toMatchObject({ code: '23514' });
  await expect(
    api.servers.archive(server.id, { expectedUpdatedAt: server.updatedAt }),
  ).rejects.toMatchObject({ status: 409 });
});
test('coverage refuses a complete flag without manifest/components and verifies an individual point and destination', async () => {
  const api = await service(),
    server = await api.servers.create(serverInput());
  const resource = await api.resources.create({
    serverId: server.id,
    name: 'Coverage database',
    kind: 'postgresql',
    externalIdentity: `coverage:${randomUUID()}`,
    dependencies: [],
  });
  const profile = await api.profiles.create({
    serverId: server.id,
    name: `Coverage ${randomUUID()}`,
    externalIdentity: `coverage-profile:${randomUUID()}`,
    adapter: { name: 'postgresql', version: '1.0.0' },
    consistency: 'transactional',
    resources: [{ resourceId: resource.id, required: true }],
    restoreCapabilities: ['database'],
  });
  const destination = await api.destinations.create({
    name: `Evidence ${randomUUID()}`,
    host: 'fixture.example.test',
    kind: 'sftp',
    configuration: {
      backend: 'sftp',
      hostKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICJH5IvMLZkXUHDBcgjPHvY4WjSnnYLOSo5HUuFAhXbV',
    },
    engine: 'restic',
    rootPath: 'isolated/apbackup',
    status: 'ativo',
    credential: {
      username: 'fixture',
      secret: randomBytes(24).toString('hex'),
      password: randomBytes(24).toString('hex'),
    },
  });
  const executionId = randomUUID(),
    pointId = randomUUID(),
    capturedAt = new Date().toISOString();
  await db.pool.query(
    "insert into executions(id,organization_id,kind,idempotency_key,profile_version_id) values($1,$2,'backup',$3,$4)",
    [executionId, principal.organizationId, `evidence:${executionId}`, profile.versionId],
  );
  await db.pool.query(
    "insert into recovery_points(id,organization_id,execution_id,server_id,profile_version_id,captured_at,status) values($1,$2,$3,$4,$5,$6,'complete')",
    [pointId, principal.organizationId, executionId, server.id, profile.versionId, capturedAt],
  );
  await db.pool.query(
    "insert into destination_results(organization_id,recovery_point_id,repository_id,status,verified_at,verification_scope) values($1,$2,$3,'concluida',now(),'artifact-integrity')",
    [principal.organizationId, pointId, destination.repositoryId],
  );
  expect((await api.getCoverage(server.id, principal.organizationId)).covered).toBe(false);
  expect((await api.destinations.get(destination.id)).coverage).toBe(false);
  const component = {
    id: 'database',
    resourceId: resource.id,
    kind: 'postgresql',
    artifactPath: 'db/database.dump',
    sha256: 'a'.repeat(64),
    sizeBytes: 42,
  };
  const body = {
    version: 1,
    organizationId: principal.organizationId,
    serverId: server.id,
    profileId: profile.id,
    profileVersion: 1,
    adapter: { name: 'postgresql', version: '1.0.0' },
    capturedAt,
    consistency: 'transactional',
    requiredComponentIds: ['database'],
    components: [component],
    images: [],
    encryptedConfiguration: {
      artifactPath: 'config/encrypted',
      sha256: 'b'.repeat(64),
      keyReference: 'test-custody',
    },
    dependencies: [],
    restoreCapabilities: ['database'],
  };
  function sortJson(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sortJson);
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, v]) => [k, sortJson(v)]),
      );
    return value;
  }
  const sha = createHash('sha256')
    .update(JSON.stringify(sortJson(body)))
    .digest('hex');
  await db.pool.query(
    'insert into manifests(organization_id,recovery_point_id,version,sha256,body) values($1,$2,1,$3,$4)',
    [principal.organizationId, pointId, '0'.repeat(64), JSON.stringify(body)],
  );
  await db.pool.query(
    'insert into components(organization_id,recovery_point_id,resource_id,component_key,artifact_path,sha256,size_bytes) values($1,$2,$3,$4,$5,$6,$7)',
    [
      principal.organizationId,
      pointId,
      resource.id,
      component.id,
      component.artifactPath,
      component.sha256,
      component.sizeBytes,
    ],
  );
  expect((await api.getCoverage(server.id, principal.organizationId)).covered).toBe(false);
  await db.pool.query(
    'update manifests set sha256=$3 where organization_id=$1 and recovery_point_id=$2',
    [principal.organizationId, pointId, sha],
  );
  expect(await api.getCoverage(server.id, principal.organizationId)).toMatchObject({
    covered: true,
    resourceCount: 1,
    protectedResourceCount: 1,
    verifiedPointCount: 1,
  });
  expect((await api.destinations.get(destination.id)).coverage).toBe(true);
});
test('plan activation requires assessed capabilities and blocks disabling or archiving a required destination', async () => {
  const api = await service(),
    server = await api.servers.create(serverInput());
  const resource = await api.resources.create({
    serverId: server.id,
    name: 'Plan database',
    kind: 'postgresql',
    externalIdentity: `plan:${randomUUID()}`,
    dependencies: [],
  });
  const profile = await api.profiles.create({
    serverId: server.id,
    name: `Plan profile ${randomUUID()}`,
    externalIdentity: `plan-profile:${randomUUID()}`,
    adapter: { name: 'postgresql', version: '1.0.0' },
    consistency: 'transactional',
    resources: [{ resourceId: resource.id, required: true }],
    restoreCapabilities: ['database'],
  });
  const destination = await api.destinations.create({
    name: `Required ${randomUUID()}`,
    host: 'fixture.example.test',
    kind: 'sftp',
    configuration: {
      backend: 'sftp',
      hostKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICJH5IvMLZkXUHDBcgjPHvY4WjSnnYLOSo5HUuFAhXbV',
    },
    engine: 'restic',
    rootPath: 'isolated/required',
    status: 'ativo',
    credential: {
      username: 'fixture',
      secret: randomBytes(24).toString('hex'),
      password: randomBytes(24).toString('hex'),
    },
  });
  const input = {
    name: `Assessed plan ${randomUUID()}`,
    profileVersionId: profile.versionId,
    destinations: [{ destinationId: destination.id, required: true }],
    retention: { days: 7, evidenceDays: 90, protectLastVerified: true },
    schedule: { localTime: '03:00', timezone: 'America/Sao_Paulo' },
    enabled: true,
  };
  await expect(api.plans.create(input)).rejects.toMatchObject({ status: 409 });
  await db.pool.query(
    'insert into connector_capabilities(organization_id,destination_id,connector_name,connector_version,capabilities,assessed_at) values($1,$2,$3,$4,$5,now())',
    [
      principal.organizationId,
      destination.id,
      'malformed-fixture',
      '0.9.0',
      JSON.stringify({
        encrypted: 'true',
        platformRetention: 'true',
        restrictedDeletion: true,
        independentSnapshot: true,
        immutable: false,
      }),
    ],
  );
  await expect(api.plans.create(input)).rejects.toMatchObject({ status: 409 });
  await db.pool.query(
    'insert into connector_capabilities(organization_id,destination_id,connector_name,connector_version,capabilities,assessed_at) values($1,$2,$3,$4,$5,now())',
    [
      principal.organizationId,
      destination.id,
      'fixture-connector',
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
  const plan = await api.plans.create(input);
  expect((await api.destinations.get(destination.id)).assessment).toMatchObject({
    capabilities: {
      encrypted: true,
      platformRetention: true,
      restrictedDeletion: false,
      independentSnapshot: false,
      immutable: false,
    },
  });
  expect(plan.enabled).toBe(true);
  expect(plan.schedule.enabled).toBe(true);
  await expect(
    api.destinations.archive(destination.id, { expectedUpdatedAt: destination.updatedAt }),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    api.destinations.update(destination.id, {
      name: destination.name,
      host: destination.host,
      kind: destination.kind,
      configuration: destination.configuration,
      engine: destination.engine,
      rootPath: destination.rootPath,
      status: 'desabilitado',
      expectedUpdatedAt: destination.updatedAt,
    }),
  ).rejects.toMatchObject({ status: 409 });
  const disabled = await api.plans.update(plan.id, {
    ...input,
    enabled: false,
    expectedUpdatedAt: plan.updatedAt,
  });
  const changed = await api.destinations.update(destination.id, {
    name: destination.name,
    host: destination.host,
    kind: destination.kind,
    configuration: destination.configuration,
    engine: destination.engine,
    rootPath: '/isolated/changed',
    status: 'ativo',
    expectedUpdatedAt: destination.updatedAt,
  });
  await expect(
    api.plans.update(plan.id, { ...input, enabled: true, expectedUpdatedAt: disabled.updatedAt }),
  ).rejects.toMatchObject({ status: 409 });
  const archived = await api.destinations.archive(destination.id, {
    expectedUpdatedAt: changed.updatedAt,
  });
  expect(archived.archivedAt).not.toBeNull();
  expect(archived.status).toBe('desabilitado');
});
