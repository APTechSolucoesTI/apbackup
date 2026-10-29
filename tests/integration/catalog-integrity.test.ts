import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createDatabase, migrate, schema } from '../../packages/db/src/index.js';

const url = process.env.TEST_DATABASE_URL;
if (
  !url ||
  !/^apbackup_test_[a-f0-9]+$/.test(new URL(url).pathname.slice(1)) ||
  new URL(url).hostname !== '127.0.0.1'
)
  throw new Error('Isolated test database required');
const db = createDatabase(url);
beforeAll(async () => {
  await migrate(db);
});
afterAll(async () => {
  await db.close();
});

async function restoreFixture() {
  const organizationId = randomUUID();
  const otherOrganizationId = randomUUID();
  const localUserId = randomUUID();
  const foreignUserId = randomUUID();
  await db.orm.insert(schema.organizations).values([
    { id: organizationId, name: 'Restore integrity' },
    { id: otherOrganizationId, name: 'Separate organization' },
  ]);
  await db.orm.insert(schema.users).values([
    { id: localUserId, name: 'Local operator', email: `${localUserId}@example.test` },
    { id: foreignUserId, name: 'Foreign operator', email: `${foreignUserId}@example.test` },
  ]);
  const membershipId = randomUUID();
  await db.orm.insert(schema.organizationMemberships).values([
    { id: membershipId, organizationId, userId: localUserId },
    { organizationId: otherOrganizationId, userId: foreignUserId },
  ]);
  const serverId = randomUUID();
  const executionId = randomUUID();
  const recoveryPointId = randomUUID();
  const requestId = randomUUID();
  await db.orm
    .insert(schema.servers)
    .values({ id: serverId, organizationId, name: 'Origin', externalIdentity: 'vm:integrity' });
  await db.orm
    .insert(schema.executions)
    .values({ id: executionId, organizationId, kind: 'restore', idempotencyKey: randomUUID() });
  await db.orm.insert(schema.recoveryPoints).values({
    id: recoveryPointId,
    organizationId,
    executionId,
    serverId,
    capturedAt: new Date('2026-10-28T06:00:00Z'),
  });
  const scope = {
    recoveryPointId,
    capability: 'database' as const,
    resourceIds: [randomUUID()],
    isolated: true,
  };
  await db.orm.insert(schema.restoreRequests).values({
    id: requestId,
    organizationId,
    executionId,
    recoveryPointId,
    requestedBy: localUserId,
    scope,
  });
  return {
    organizationId,
    localUserId,
    foreignUserId,
    membershipId,
    recoveryPointId,
    requestId,
    scope,
  };
}

type HumanRecord = 'request' | 'confirmation' | 'approval';
async function insertHumanRecord(
  kind: HumanRecord,
  fixture: Awaited<ReturnType<typeof restoreFixture>>,
  actorId: string,
) {
  if (kind === 'request') {
    const executionId = randomUUID();
    await db.orm.insert(schema.executions).values({
      id: executionId,
      organizationId: fixture.organizationId,
      kind: 'restore',
      idempotencyKey: randomUUID(),
    });
    return db.orm
      .insert(schema.restoreRequests)
      .values({
        organizationId: fixture.organizationId,
        executionId,
        recoveryPointId: fixture.recoveryPointId,
        requestedBy: actorId,
        scope: fixture.scope,
      })
      .returning({ id: schema.restoreRequests.id });
  }
  if (kind === 'confirmation')
    return db.orm
      .insert(schema.restoreConfirmations)
      .values({
        organizationId: fixture.organizationId,
        requestId: fixture.requestId,
        actorId,
        systemName: 'Isolated system',
        impact: 'Restore database',
        confirmedAt: new Date('2026-10-28T06:00:00Z'),
        reauthenticatedAt: new Date('2026-10-28T05:59:00Z'),
      })
      .returning({ id: schema.restoreConfirmations.id });
  return db.orm
    .insert(schema.operationalApprovals)
    .values({
      organizationId: fixture.organizationId,
      requestId: fixture.requestId,
      actorId,
      action: 'restore',
      approvedAt: new Date('2026-10-28T06:00:00Z'),
      expiresAt: new Date('2026-10-28T06:05:00Z'),
    })
    .returning({ id: schema.operationalApprovals.id });
}

test.each(['request', 'confirmation', 'approval'] as const)(
  '%s rejects an actor whose identity does not exist',
  async (kind) => {
    const fixture = await restoreFixture();
    await expect(insertHumanRecord(kind, fixture, randomUUID())).rejects.toMatchObject({
      cause: { code: '23503' },
    });
  },
);

test.each(['request', 'confirmation', 'approval'] as const)(
  '%s rejects an existing user who belongs only to another organization',
  async (kind) => {
    const fixture = await restoreFixture();
    await expect(insertHumanRecord(kind, fixture, fixture.foreignUserId)).rejects.toMatchObject({
      cause: { code: '23503' },
    });
  },
);

test.each(['request', 'confirmation', 'approval'] as const)(
  '%s accepts an existing member of the same organization',
  async (kind) => {
    const fixture = await restoreFixture();
    await expect(insertHumanRecord(kind, fixture, fixture.localUserId)).resolves.toHaveLength(1);
  },
);

test('preserves referenced human membership history instead of deleting identity attribution', async () => {
  const fixture = await restoreFixture();
  await expect(
    db.orm
      .delete(schema.organizationMemberships)
      .where(eq(schema.organizationMemberships.id, fixture.membershipId)),
  ).rejects.toMatchObject({ cause: { code: '23503' } });
});

async function eventFixture() {
  const organizationId = randomUUID();
  const executionA = randomUUID();
  const executionB = randomUUID();
  const stepA = randomUUID();
  const stepB = randomUUID();
  await db.orm.insert(schema.organizations).values({ id: organizationId, name: 'Event integrity' });
  await db.orm.insert(schema.executions).values([
    { id: executionA, organizationId, kind: 'verify', idempotencyKey: randomUUID() },
    { id: executionB, organizationId, kind: 'verify', idempotencyKey: randomUUID() },
  ]);
  await db.orm.insert(schema.executionSteps).values([
    { id: stepA, organizationId, executionId: executionA, key: 'verify', position: 0 },
    { id: stepB, organizationId, executionId: executionB, key: 'verify', position: 0 },
  ]);
  return {
    stepA,
    stepB,
    event: {
      organizationId,
      executionId: executionA,
      level: 'info',
      code: 'verification_started',
      message: 'Verification started',
    },
  };
}

test('rejects an event that points to a step in another execution of the same organization', async () => {
  const { stepB, event } = await eventFixture();
  await expect(
    db.orm.insert(schema.executionEvents).values({ ...event, stepId: stepB }),
  ).rejects.toMatchObject({ cause: { code: '23503' } });
});

test('accepts an event whose step belongs to its own execution', async () => {
  const { stepA, event } = await eventFixture();
  await expect(
    db.orm
      .insert(schema.executionEvents)
      .values({ ...event, stepId: stepA })
      .returning(),
  ).resolves.toHaveLength(1);
});

test('accepts an execution event without a step', async () => {
  const { event } = await eventFixture();
  const [saved] = await db.orm.insert(schema.executionEvents).values(event).returning();
  expect(saved?.stepId).toBeNull();
});
