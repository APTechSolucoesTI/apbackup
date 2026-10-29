import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import pg from 'pg';

const url = process.env.TEST_DATABASE_URL;
if (
  !url ||
  !/^apbackup_test_[a-f0-9]+$/.test(new URL(url).pathname.slice(1)) ||
  new URL(url).hostname !== '127.0.0.1'
) {
  throw new Error('Integration tests require an isolated loopback apbackup_test_* database.');
}

test('persists a server and its plan across connections; enforces catalog integrity and reapplies migrations once', async () => {
  // Removing the database factory, persistence, unique identity, or tenant FK must fail this test.
  const modulePath = new URL('../../packages/db/src/index.ts', import.meta.url);
  const api: Record<string, unknown> = existsSync(modulePath) ? await import(modulePath.href) : {};
  expect(api.createDatabase, 'createDatabase must be implemented').toBeTypeOf('function');
  const { createDatabase, migrate, schema } = await import('../../packages/db/src/index.js');
  const orgId = randomUUID();
  let db = createDatabase(url);
  try {
    await Promise.all([migrate(db), migrate(db)]);
    await migrate(db);
    const migrationCount = (
      await db.pool.query<{ count: string }>('select count(*) from platform_migrations')
    ).rows[0];
    const versioned = (
      await readdir(new URL('../../packages/db/migrations/', import.meta.url))
    ).filter((name) => /^\d+_[a-z0-9_]+\.sql$/.test(name));
    expect(migrationCount?.count).toBe(String(versioned.length));
    await db.orm.insert(schema.organizations).values({ id: orgId, name: 'Test operations' });
    const [saved] = await db.orm
      .insert(schema.servers)
      .values({ organizationId: orgId, name: 'Origin', externalIdentity: 'vm:101' })
      .returning();
    expect(saved).toBeDefined();
    const [plan] = await db.orm
      .insert(schema.plans)
      .values({ organizationId: orgId, serverId: saved!.id, name: 'Daily origin' })
      .returning();
    expect(plan?.enabled).toBe(false);
    await db.close();
    db = createDatabase(url);
    const reloaded = await db.orm.query.servers.findFirst({
      where: (table, { eq }) => eq(table.id, saved!.id),
    });
    expect(reloaded?.id).toBe(saved!.id);
    const reloadedPlan = await db.orm.query.plans.findFirst({
      where: (table, { eq }) => eq(table.id, plan!.id),
    });
    expect(reloadedPlan?.serverId).toBe(saved!.id);
    const duplicateExternalIdentity = db.orm
      .insert(schema.servers)
      .values({ organizationId: orgId, name: 'Duplicate', externalIdentity: 'vm:101' });
    await expect(duplicateExternalIdentity).rejects.toThrow();
    const otherOrg = randomUUID();
    await db.orm.insert(schema.organizations).values({ id: otherOrg, name: 'Other tenant' });
    await expect(
      db.orm
        .insert(schema.plans)
        .values({ organizationId: otherOrg, serverId: saved!.id, name: 'Cross tenant' }),
    ).rejects.toThrow();
    await db.orm
      .insert(schema.servers)
      .values({ organizationId: otherOrg, name: 'Separate origin', externalIdentity: 'vm:101' });
    const [schedule] = await db.orm
      .insert(schema.schedules)
      .values({ organizationId: orgId, planId: plan!.id })
      .returning();
    expect(schedule?.localTime).toBe('03:00:00');
    expect(schedule?.timezone).toBe('America/Sao_Paulo');
    expect(schedule?.enabled).toBe(false);
    await expect(
      db.orm.insert(schema.schedules).values({ organizationId: orgId, planId: plan!.id }),
    ).rejects.toThrow();
    await expect(
      db.orm
        .insert(schema.schedules)
        .values({ organizationId: orgId, planId: plan!.id, localTime: '25:00' }),
    ).rejects.toThrow();
    await expect(
      db.orm.insert(schema.schedules).values({
        organizationId: orgId,
        planId: plan!.id,
        localTime: '04:00',
        timezone: 'Invalid/Zone',
      }),
    ).rejects.toThrow();
    const [retention] = await db.orm
      .insert(schema.retentionPolicies)
      .values({ organizationId: orgId, name: 'Default' })
      .returning();
    expect(retention?.days).toBe(7);
    expect(retention?.evidenceDays).toBe(90);
    expect(retention?.protectLastVerified).toBe(true);
    await expect(
      db.orm
        .insert(schema.retentionPolicies)
        .values({ organizationId: orgId, name: 'Invalid', days: 0 }),
    ).rejects.toThrow();
    const [destination] = await db.orm
      .insert(schema.destinations)
      .values({
        organizationId: orgId,
        name: 'Pending storage',
        host: '192.168.3.52',
        kind: 'sftp',
      })
      .returning();
    expect(destination?.status).toBe('aguardando_configuracao');
    expect(destination?.rootPath).toBeNull();
    expect(destination?.credentialId).toBeNull();
    await expect(
      db.orm
        .insert(schema.destinations)
        .values({ organizationId: orgId, name: 'Unsafe active', kind: 'sftp', status: 'ativo' }),
    ).rejects.toThrow();
    const execution = {
      organizationId: orgId,
      planId: plan!.id,
      idempotencyKey: 'schedule:2026-10-28',
      kind: 'backup' as const,
    };
    await db.orm.insert(schema.executions).values(execution);
    await expect(db.orm.insert(schema.executions).values(execution)).rejects.toThrow();
    // No demo seed, scheduled job, or external backup is created by migrations.
    const native = new pg.Client({ connectionString: url });
    await native.connect();
    try {
      const result = await native.query<{ enabled: boolean }>(
        'select enabled from schedules where organization_id=$1',
        [orgId],
      );
      expect(result.rows.every((row) => !row.enabled)).toBe(true);
      expect(
        (await native.query('select * from secret_references where organization_id=$1', [orgId]))
          .rowCount,
      ).toBe(0);
    } finally {
      await native.end();
    }
  } finally {
    await db.close();
  }
});

test('updates modification timestamps when a record changes', async () => {
  const { createDatabase, migrate, schema } = await import('../../packages/db/src/index.js');
  const db = createDatabase(url);
  try {
    await migrate(db);
    const [organization] = await db.orm
      .insert(schema.organizations)
      .values({ name: 'Evidence tests', updatedAt: new Date('2020-01-01T00:00:00Z') })
      .returning();
    const orgId = organization!.id;
    await db.pool.query('update organizations set name = $1 where id = $2', [
      'Updated organization',
      orgId,
    ]);
    const current = await db.orm.query.organizations.findFirst({
      where: (table, { eq }) => eq(table.id, orgId),
    });
    expect(current!.updatedAt.getTime()).toBeGreaterThan(
      new Date('2020-01-01T00:00:00Z').getTime(),
    );
  } finally {
    await db.close();
  }
});

test('rejects credentials in public evidence while allowing opaque references', async () => {
  const { createDatabase, migrate, schema } = await import('../../packages/db/src/index.js');
  const db = createDatabase(url);
  try {
    await migrate(db);
    const orgId = randomUUID();
    await db.orm.insert(schema.organizations).values({ id: orgId, name: 'Secret boundary tests' });
    const evidence = { organizationId: orgId, action: 'test', subjectType: 'server' };
    await expect(
      db.orm
        .insert(schema.auditEvents)
        .values({ ...evidence, details: { token: 'must-not-persist' } }),
    ).rejects.toThrow();
    await expect(
      db.orm
        .insert(schema.auditEvents)
        .values({ ...evidence, details: { nested: { password: 'must-not-persist' } } }),
    ).rejects.toThrow();
    await expect(
      db.orm
        .insert(schema.auditEvents)
        .values({ ...evidence, details: { endpoint: 'postgresql://user:password@host/db' } }),
    ).rejects.toThrow();
    await db.orm.insert(schema.auditEvents).values({
      ...evidence,
      details: { result: 'captured', reference: 'opaque-secret-reference-id' },
    });
  } finally {
    await db.close();
  }
});

test('uses one normalized user identity with organization membership and no implicit elevated role', async () => {
  const { createDatabase, migrate, schema } = await import('../../packages/db/src/index.js');
  const db = createDatabase(url);
  try {
    await migrate(db);
    const [organization] = await db.orm
      .insert(schema.organizations)
      .values({ name: 'Identity tests' })
      .returning();
    const [user] = await db.orm
      .insert(schema.users)
      .values({ name: 'Operator', email: 'operator@example.test' })
      .returning();
    expect(user?.emailVerified).toBe(false);
    expect(user?.image).toBeNull();
    await expect(
      db.orm.insert(schema.users).values({ name: 'Duplicate', email: 'operator@example.test' }),
    ).rejects.toThrow();
    await expect(
      db.orm
        .insert(schema.users)
        .values({ name: 'Unnormalized', email: ' Operator@example.test ' }),
    ).rejects.toThrow();
    const [membership] = await db.orm
      .insert(schema.organizationMemberships)
      .values({ organizationId: organization!.id, userId: user!.id })
      .returning();
    expect(membership?.role).toBe('viewer');
    await expect(
      db.orm
        .insert(schema.organizationMemberships)
        .values({ organizationId: organization!.id, userId: randomUUID() }),
    ).rejects.toThrow();
  } finally {
    await db.close();
  }
});

test('refuses a migration whose applied checksum differs instead of silently rewriting history', async () => {
  const { createDatabase, migrate } = await import('../../packages/db/src/index.js');
  const db = createDatabase(url);
  try {
    await migrate(db);
    const row = (
      await db.pool.query<{ name: string; sha256: string }>(
        'select name, sha256 from platform_migrations limit 1',
      )
    ).rows[0]!;
    await db.pool.query('update platform_migrations set sha256 = $1 where name = $2', [
      '0'.repeat(64),
      row.name,
    ]);
    try {
      await expect(migrate(db)).rejects.toThrow('changed; create a new migration');
    } finally {
      await db.pool.query('update platform_migrations set sha256 = $1 where name = $2', [
        row.sha256,
        row.name,
      ]);
    }
    await migrate(db);
  } finally {
    await db.close();
  }
});
