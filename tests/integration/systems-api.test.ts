import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { backupSystemsOverviewSchema, systemBackupResultSchema } from '@apbackup/contracts';
import { runtimeFixture } from './runtime-fixture.js';
import { createSystemsApi } from '../../apps/web/src/lib/systems.server.js';
import type { SessionPrincipal } from '../../packages/security/src/authorization.js';

test('system folders persist and atomically enqueue distinct linked plans; retries and tenant boundaries are enforced', async () => {
  const f = await runtimeFixture(),
    base = 'https://console.example.test';
  let actor: SessionPrincipal = {
    organizationId: f.org,
    userId: randomUUID(),
    sessionId: randomUUID(),
    membershipId: randomUUID(),
    role: 'administrator',
    reauthenticatedAt: new Date(),
    mfaVerifiedAt: new Date(),
  };
  const api = createSystemsApi(f.db, async () => actor, base);
  const call = (path: string, body?: unknown, origin = base) =>
    api(
      new Request(base + path, {
        method: body ? 'POST' : 'GET',
        headers: { origin, 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    );
  const input = {
    serverId: f.server,
    name: 'APMail',
    scopeNotes: 'Banco externo: recuperação independente.',
    components: [
      { planId: f.plan, kind: 'application', label: 'Aplicação APMail' },
      { planId: f.plan, kind: 'files', label: 'Anexos' },
    ],
  };
  try {
    actor = { ...actor, mfaVerifiedAt: null };
    expect((await call('/api/systems/save', input)).status).toBe(403);
    actor = { ...actor, mfaVerifiedAt: new Date() };
    expect((await call('/api/systems/save', input, 'https://other.example.test')).status).toBe(403);
    const created = await call('/api/systems/save', input);
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    const overview = backupSystemsOverviewSchema.parse(
      await (await call('/api/systems/overview')).json(),
    );
    expect(overview.items).toHaveLength(1);
    expect(overview.items[0]?.components).toHaveLength(2);
    expect(overview.items[0]?.components[0]?.latest).toBeNull();
    expect(overview.items[0]?.scopeNotes).toBe(input.scopeNotes);
    actor = { ...actor, role: 'viewer' };
    expect(
      (await call(`/api/systems/${id}/backup`, { idempotencyKey: 'one-request' })).status,
    ).toBe(403);
    actor = { ...actor, role: 'backup_operator', mfaVerifiedAt: null, reauthenticatedAt: null };
    const response = await call(`/api/systems/${id}/backup`, { idempotencyKey: 'one-request' });
    expect(response.status).toBe(200);
    const run = systemBackupResultSchema.parse(await response.json());
    expect(run.executions).toHaveLength(1);
    const destination = randomUUID(),
      repository = randomUUID(),
      point = randomUUID();
    await f.db.pool.query(
      "insert into destinations(id,organization_id,name,kind) values($1,$2,'NAS ainda em configuração',null)",
      [destination, f.org],
    );
    await f.db.pool.query(
      'insert into repositories(id,organization_id,destination_id,external_identity,engine) values($1::uuid,$2,$3,$1::text,null)',
      [repository, f.org, destination],
    );
    await f.db.pool.query(
      'insert into plan_destinations(organization_id,plan_id,repository_id) values($1,$2,$3)',
      [f.org, f.plan, repository],
    );
    await f.db.pool.query(
      "insert into recovery_points(id,organization_id,execution_id,server_id,profile_version_id,captured_at,status) values($1,$2,$3,$4,$5,now(),'incomplete')",
      [point, f.org, run.executions[0]!.executionId, f.server, f.version],
    );
    await f.db.pool.query(
      "insert into destination_results(organization_id,recovery_point_id,repository_id,status) values($1,$2,$3,'falhou')",
      [f.org, point, repository],
    );
    const current = backupSystemsOverviewSchema.parse(
      await (await call('/api/systems/overview')).json(),
    ).items[0]!.components[0]!;
    expect(current.destinations[0]).toMatchObject({
      repositoryId: repository,
      name: 'NAS ainda em configuração',
      kind: null,
      status: 'falhou',
      verifiedAt: null,
    });
    expect(current.points[0]).toMatchObject({ id: point, status: 'incomplete' });
    expect(current.points[0]?.destinations[0]?.status).toBe('falhou');
    // A completed job is returned, never moved back to ready by a retry.
    await f.db.pool.query(
      "update execution_jobs set state='done' where organization_id=$1 and execution_id=$2",
      [f.org, run.executions[0]!.executionId],
    );
    const secondPlan = randomUUID();
    await f.db.pool.query(
      'insert into plans(id,organization_id,server_id,profile_version_id,name,enabled) values($1,$2,$3,$4,$5,true)',
      [secondPlan, f.org, f.server, f.version, 'Outra captura'],
    );
    await f.db.pool.query(
      "insert into system_plan_links(organization_id,server_id,system_id,plan_id,component_kind,label) values($1,$2,$3,$4,'database','Banco adicional')",
      [f.org, f.server, id, secondPlan],
    );
    expect(
      await (await call(`/api/systems/${id}/backup`, { idempotencyKey: 'one-request' })).json(),
    ).toEqual(run);
    expect(
      (
        await f.db.pool.query(
          'select state from execution_jobs where organization_id=$1 and execution_id=$2',
          [f.org, run.executions[0]!.executionId],
        )
      ).rows[0]?.state,
    ).toBe('done');
    expect(
      (
        await f.db.pool.query(
          "select 1 from audit_events where organization_id=$1 and action='system_backup_queued'",
          [f.org],
        )
      ).rowCount,
    ).toBe(1);
    const foreignOrg = randomUUID();
    actor = { ...actor, organizationId: foreignOrg };
    expect(
      backupSystemsOverviewSchema.parse(await (await call('/api/systems/overview')).json()).items,
    ).toEqual([]);
    expect((await call(`/api/systems/${id}/backup`, { idempotencyKey: 'foreign' })).status).toBe(
      404,
    );
    actor = {
      ...actor,
      organizationId: f.org,
      role: 'administrator',
      reauthenticatedAt: new Date(),
      mfaVerifiedAt: new Date(),
    };
    const server2 = randomUUID();
    await f.db.pool.query(
      'insert into servers(id,organization_id,name,external_identity) values($1,$2,$3,$3)',
      [server2, f.org, 'Outro servidor'],
    );
    expect(
      (await call('/api/systems/save', { ...input, serverId: server2, name: 'Inválido' })).status,
    ).toBe(400);
    await expect(
      f.db.pool.query(
        "insert into system_plan_links(organization_id,server_id,system_id,plan_id,component_kind,label) values($1,$2,$3,$4,'database','errado')",
        [f.org, server2, id, f.plan],
      ),
    ).rejects.toThrow();
    const security = (
      await f.db.pool.query(
        "select relname,relrowsecurity,exists(select 1 from aclexplode(coalesce(relacl,acldefault('r',relowner))) a where a.grantee=0 and a.privilege_type='SELECT') as public_read from pg_class where relname=any($1)",
        [['backup_systems', 'system_plan_links', 'backup_system_runs']],
      )
    ).rows;
    expect(security).toHaveLength(3);
    expect(security.every((r) => r.relrowsecurity === true && r.public_read === false)).toBe(true);
  } finally {
    await f.db.close();
  }
});

test('a disabled component rejects the full manual batch without partial jobs', async () => {
  const f = await runtimeFixture(),
    base = 'https://console.example.test';
  const actor: SessionPrincipal = {
    organizationId: f.org,
    userId: randomUUID(),
    sessionId: randomUUID(),
    membershipId: randomUUID(),
    role: 'administrator',
    reauthenticatedAt: new Date(),
    mfaVerifiedAt: new Date(),
  };
  const api = createSystemsApi(f.db, async () => actor, base);
  const call = (path: string, body: unknown) =>
    api(
      new Request(base + path, {
        method: 'POST',
        headers: { origin: base, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
  try {
    const other = randomUUID();
    await f.db.pool.query(
      'insert into plans(id,organization_id,server_id,profile_version_id,name,enabled) values($1,$2,$3,$4,$5,false)',
      [other, f.org, f.server, f.version, 'Desativado'],
    );
    const saved = await call('/api/systems/save', {
      serverId: f.server,
      name: 'Grupo',
      components: [
        { planId: f.plan, kind: 'application', label: 'Aplicação' },
        { planId: other, kind: 'database', label: 'Banco' },
      ],
    });
    const { id } = (await saved.json()) as { id: string };
    expect((await call(`/api/systems/${id}/backup`, { idempotencyKey: 'atomic' })).status).toBe(
      409,
    );
    expect(
      (await f.db.pool.query('select 1 from executions where organization_id=$1', [f.org]))
        .rowCount,
    ).toBe(0);
    expect(
      (await f.db.pool.query('select 1 from backup_system_runs where organization_id=$1', [f.org]))
        .rowCount,
    ).toBe(0);
    await f.db.pool.query(
      'update plans set enabled=true,archived_at=now() where organization_id=$1 and id=$2',
      [f.org, other],
    );
    const response = await api(new Request(base + '/api/systems/overview'));
    const components = backupSystemsOverviewSchema.parse(await response.json()).items[0]!
      .components;
    expect(components.find((c) => c.planId === other)?.enabled).toBe(false);
    expect(
      (await call(`/api/systems/${id}/backup`, { idempotencyKey: 'archived-atomic' })).status,
    ).toBe(409);
    expect(
      (await f.db.pool.query('select 1 from executions where organization_id=$1', [f.org]))
        .rowCount,
    ).toBe(0);
  } finally {
    await f.db.close();
  }
});
