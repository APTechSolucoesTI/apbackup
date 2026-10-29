import { existsSync } from 'node:fs';
import { expect, test } from 'vitest';

test('validates resource identities, schedule defaults and inactive destination configuration at the public boundary', async () => {
  const path = new URL('../../packages/contracts/src/index.ts', import.meta.url);
  const api: Record<string, unknown> = existsSync(path) ? await import(path.href) : {};
  expect(api.scheduleSchema, 'scheduleSchema must be implemented').toBeDefined();
  const { scheduleSchema, resourceSchema, destinationSchema, profileVersionSchema } =
    await import('../../packages/contracts/src/index.js');
  const id = '14e52208-85a0-4a48-80e7-79a09d8e5178';
  expect(scheduleSchema.parse({ planId: id })).toEqual({
    planId: id,
    localTime: '03:00',
    timezone: 'America/Sao_Paulo',
    enabled: false,
  });
  expect(scheduleSchema.safeParse({ planId: id, timezone: 'Fake/Zone' }).success).toBe(false);
  expect(scheduleSchema.safeParse({ planId: id, localTime: '24:00' }).success).toBe(false);
  const resource = {
    id,
    organizationId: id,
    serverId: id,
    name: 'Database',
    kind: 'postgresql',
    externalIdentity: 'db:primary',
  };
  expect(resourceSchema.safeParse(resource).success).toBe(true);
  expect(
    resourceSchema.safeParse({ ...resource, externalIdentity: 'postgresql://user:pass@host/db' })
      .success,
  ).toBe(false);
  const destination = {
    id,
    organizationId: id,
    name: 'Storage',
    kind: 'sftp',
    host: '192.168.3.52',
  };
  expect(destinationSchema.parse(destination).status).toBe('aguardando_configuracao');
  expect(destinationSchema.safeParse({ ...destination, status: 'ativo' }).success).toBe(false);
  expect(destinationSchema.safeParse({ ...destination, credential: 'secret' }).success).toBe(false);
  const profile = {
    profileId: id,
    version: 1,
    adapter: { name: 'postgres-files', version: '1.0.0' },
    consistency: 'application_consistent',
    resources: [{ resourceId: id, required: true }],
    dependencies: [],
    restoreCapabilities: ['database'],
  };
  expect(profileVersionSchema.safeParse(profile).success).toBe(true);
  expect(profileVersionSchema.safeParse({ ...profile, resources: [] }).success).toBe(false);
});
