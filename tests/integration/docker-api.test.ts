import { expect, test } from 'vitest';
import { randomUUID, randomBytes } from 'node:crypto';
import { runtimeFixture } from './runtime-fixture.js';
import { createDockerApi } from '../../apps/web/src/lib/docker.server.js';
import { createRuntimeApi } from '../../apps/web/src/lib/execution.server.js';
import type { SessionPrincipal } from '../../packages/security/src/authorization.js';
import { dockerEvidenceSchema } from '@apbackup/contracts';
test('agent catalogs are scoped, selected resources immutable and viewer/foreign selections denied', async () => {
  const f = await runtimeFixture();
  process.env.VAULT_KEY_BASE64 = randomBytes(32).toString('base64');
  process.env.VAULT_KEY_REFERENCE = 'docker-test';
  let actor: SessionPrincipal = {
    organizationId: f.org,
    userId: randomUUID(),
    membershipId: randomUUID(),
    sessionId: randomUUID(),
    role: 'administrator',
    reauthenticatedAt: new Date(),
    mfaVerifiedAt: new Date(),
  };
  const base = 'https://console.example.test',
    api = createDockerApi(f.db, async () => actor, base),
    runtime = createRuntimeApi(f.db, async () => actor, base);
  const call = (path: string, value?: unknown, identity?: string) =>
    (path.startsWith('/api/docker') ? api : runtime)(
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
  try {
    const invite = (await (
      await call('/api/agents/invitations', { serverId: f.server })
    ).json()) as { enrollment: string };
    const agent = (await (
      await call('/api/agents/enroll', {
        enrollment: invite.enrollment,
        externalIdentity: randomUUID(),
      })
    ).json()) as { identity: string };
    expect(
      (
        await call(
          '/api/agents/docker-catalog',
          {
            capturedAt: new Date().toISOString(),
            containers: [],
            services: [],
            directories: [{ name: 'attachments' }],
            volumes: [{ name: 'emails', owners: [], databaseHint: false }],
          },
          agent.identity,
        )
      ).status,
    ).toBe(200);
    expect((await call(`/api/docker/catalog?serverId=${f.server}`)).status).toBe(200);
    const selected = await call('/api/docker/select', {
      serverId: f.server,
      kind: 'volume',
      identity: 'emails',
    });
    expect(selected.status).toBe(201);
    const binding = (await selected.json()) as { profileVersionId: string };
    expect(
      await (
        await call('/api/docker/select', { serverId: f.server, kind: 'volume', identity: 'emails' })
      ).json(),
    ).toEqual(binding);
    await expect(
      f.db.pool.query('update docker_bindings set selection=selection where organization_id=$1', [
        f.org,
      ]),
    ).rejects.toThrow(/immutable/);
    actor = { ...actor, role: 'viewer' };
    expect(
      (await call('/api/docker/select', { serverId: f.server, kind: 'volume', identity: 'emails' }))
        .status,
    ).toBe(403);
    actor = { ...actor, role: 'administrator', organizationId: randomUUID() };
    expect((await call(`/api/docker/catalog?serverId=${f.server}`)).status).toBe(409);
  } finally {
    await f.db.close();
  }
});

test('Docker overview scopes component plans, points and restores and lists one surviving copy per point', async () => {
  const f = await runtimeFixture(),
    actor: SessionPrincipal = {
      organizationId: f.org,
      userId: randomUUID(),
      membershipId: randomUUID(),
      sessionId: randomUUID(),
      role: 'viewer',
      reauthenticatedAt: null,
      mfaVerifiedAt: null,
    },
    base = 'https://console.example.test',
    api = createDockerApi(f.db, async () => actor, base);
  const get = (search = '') => api(new Request(base + '/api/docker/overview' + search));
  try {
    await f.db.pool.query('insert into users(id,name,email) values($1,$2,$3)', [
      actor.userId,
      'Fixture reader',
      actor.userId + '@fixture.example.test',
    ]);
    await f.db.pool.query(
      "insert into organization_memberships(id,organization_id,user_id,role) values($1,$2,$3,'viewer')",
      [actor.membershipId, f.org, actor.userId],
    );
    const secondVersion = randomUUID(),
      secondPlan = randomUUID();
    await f.db.pool.query(
      'insert into profile_versions(id,organization_id,profile_id,version,definition) values($1,$2,$3,2,$4)',
      [
        secondVersion,
        f.org,
        f.profile,
        JSON.stringify({
          profileId: f.profile,
          version: 2,
          adapter: { name: 'files', version: '1' },
          consistency: 'file_consistent',
          resources: [{ resourceId: f.resource, required: true }],
          dependencies: [],
          restoreCapabilities: ['files'],
        }),
      ],
    );
    await f.db.pool.query(
      'insert into plans(id,organization_id,server_id,profile_version_id,name,enabled) values($1,$2,$3,$4,$5,true)',
      [secondPlan, f.org, f.server, secondVersion, 'Second component'],
    );
    const pointIds: string[] = [],
      restoreIds: string[] = [];
    for (const [i, version] of [f.version, secondVersion].entries()) {
      const selection = { serverId: f.server, kind: 'volume', identity: 'component-' + i },
        execution = randomUUID(),
        point = randomUUID();
      pointIds.push(point);
      await f.db.pool.query(
        'insert into docker_bindings(organization_id,profile_version_id,resource_id,server_id,selection) values($1,$2,$3,$4,$5)',
        [f.org, version, f.resource, f.server, JSON.stringify(selection)],
      );
      await f.db.pool.query(
        "insert into executions(id,organization_id,kind,idempotency_key,profile_version_id) values($1::uuid,$2,'backup',$1::text,$3)",
        [execution, f.org, version],
      );
      await f.db.pool.query(
        "insert into recovery_points(id,organization_id,execution_id,server_id,profile_version_id,captured_at,status) values($1,$2,$3,$4,$5,now(),'complete')",
        [point, f.org, execution, f.server, version],
      );
      for (let copy = 0; copy < 3; copy++) {
        const destination = randomUUID(),
          repository = randomUUID();
        await f.db.pool.query(
          'insert into destinations(id,organization_id,name,kind) values($1::uuid,$2,$1::text,null)',
          [destination, f.org],
        );
        await f.db.pool.query(
          'insert into repositories(id,organization_id,destination_id,external_identity,engine) values($1::uuid,$2,$3,$1::text,null)',
          [repository, f.org, destination],
        );
        const proof = dockerEvidenceSchema.parse({
          repositoryId: repository,
          nativeRepositoryId: 'a'.repeat(64),
          snapshotId: 'b'.repeat(64),
          capturedAt: new Date().toISOString(),
          sha256: 'c'.repeat(64),
          sizeBytes: '1',
          selection,
          components: ['data-0.tar'],
          consistency: 'crash_consistent',
          imageId: null,
          totalSizeBytes: '2',
          artifacts: [{ name: 'data-0.tar', sha256: 'd'.repeat(64), sizeBytes: '1' }],
        });
        await f.db.pool.query(
          "insert into destination_results(organization_id,recovery_point_id,repository_id,status,verified_at,docker_evidence) values($1,$2,$3,'concluida',now(),$4)",
          [f.org, point, repository, JSON.stringify(proof)],
        );
      }
      const restore = randomUUID();
      restoreIds.push(restore);
      await f.db.pool.query(
        "insert into executions(id,organization_id,kind,idempotency_key,profile_version_id) values($1::uuid,$2,'restore',$1::text,$3)",
        [restore, f.org, version],
      );
      await f.db.pool.query(
        "insert into restore_requests(organization_id,execution_id,recovery_point_id,requested_by,scope,production,status) values($1,$2,$3,$4,$5,false,'aguardando')",
        [
          f.org,
          restore,
          point,
          actor.userId,
          JSON.stringify({ kind: 'docker_restore', targetName: 'restored-' + i }),
        ],
      );
    }
    const flat = (await (await get()).json()) as {
      plans: { id: string }[];
      points: { id: string }[];
      restores: { id: string }[];
    };
    expect(flat.plans).toHaveLength(2);
    expect(flat.points).toHaveLength(2);
    expect(flat.restores).toHaveLength(2);
    const scoped = (await (await get('?profileVersionId=' + secondVersion)).json()) as typeof flat;
    expect(scoped.plans.map((p) => p.id)).toEqual([secondPlan]);
    expect(scoped.points.map((p) => p.id)).toEqual([pointIds[1]]);
    expect(scoped.restores.map((p) => p.id)).toEqual([restoreIds[1]]);
    await f.db.pool.query(
      'update destination_results set removed_at=now() where organization_id=$1 and recovery_point_id=$2',
      [f.org, pointIds[1]],
    );
    expect(
      ((await (await get('?profileVersionId=' + secondVersion)).json()) as typeof flat).points,
    ).toHaveLength(0);
    await f.db.pool.query(
      'update destination_results set removed_at=null,retention_pending=true where organization_id=$1 and recovery_point_id=$2',
      [f.org, pointIds[1]],
    );
    expect(
      ((await (await get('?profileVersionId=' + secondVersion)).json()) as typeof flat).points,
    ).toHaveLength(0);
    expect((await get('?profileVersionId=invalid')).status).toBe(400);
  } finally {
    await f.db.close();
  }
});
