import { expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { dockerSelectionSchema } from '../../packages/contracts/src/docker.js';

const selection = () => ({
  serverId: randomUUID(),
  kind: 'compose',
  identity: 'mail-production',
  containers: [
    {
      id: 'a'.repeat(64),
      name: 'mail-api',
      service: 'api',
      role: 'api',
      preserveEnvironmentKeys: ['DATABASE_URL'],
      startupReviewed: true,
    },
    {
      id: 'b'.repeat(64),
      name: 'mail-worker',
      service: 'worker',
      role: 'worker',
      preserveEnvironmentKeys: ['REDIS_URL'],
      startupReviewed: true,
    },
  ],
});
test('Compose requires an explicit reviewed group with unique identities and roles', () => {
  expect(dockerSelectionSchema.safeParse(selection()).success).toBe(true);
  expect(dockerSelectionSchema.safeParse({ ...selection(), containers: [] }).success).toBe(false);
  const duplicate = selection();
  duplicate.containers[1]!.name = duplicate.containers[0]!.name;
  expect(dockerSelectionSchema.safeParse(duplicate).success).toBe(false);
  expect(dockerSelectionSchema.safeParse({ ...selection(), kind: 'container' }).success).toBe(
    false,
  );
  const unreviewed = selection();
  unreviewed.containers[0]!.startupReviewed = false;
  expect(dockerSelectionSchema.safeParse(unreviewed).success).toBe(false);
});
test('startup override is an explicit bounded argv, never arbitrary runtime configuration', () => {
  const value = selection();
  expect(
    dockerSelectionSchema.safeParse({
      ...value,
      containers: [{ ...value.containers[0], restoreStartup: { command: ['node', 'server.js'] } }],
    }).success,
  ).toBe(true);
  expect(
    dockerSelectionSchema.safeParse({
      ...value,
      containers: [{ ...value.containers[0], restoreStartup: { command: [], privileged: true } }],
    }).success,
  ).toBe(false);
});
test('reviewed ephemeral omissions accept known generated caches and reject application/config paths', () => {
  const value = selection();
  const valid = (path: string) =>
    dockerSelectionSchema.safeParse({
      ...value,
      containers: [{ ...value.containers[0], ephemeralPaths: [path] }],
    }).success;
  for (const path of [
    '/app/apps/web/.next/cache',
    '/root/.cache/checkpoint-nodejs',
    '/root/.cache/prisma',
    '/tmp/node-compile-cache',
  ])
    expect(valid(path)).toBe(true);
  for (const path of [
    '/app/apps/web',
    '/app/apps/web/.next/server',
    '/etc',
    '/root',
    '/../.next/cache',
  ])
    expect(valid(path)).toBe(false);
});
