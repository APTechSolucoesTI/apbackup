import { expect, test } from 'vitest';
import { dockerSelectionSchema } from '@apbackup/contracts';
test('known Swarm group requires explicit unique role identities and migration review', () => {
  const selected = {
    serverId: crypto.randomUUID(),
    kind: 'swarm',
    identity: 'apbling',
    services: [
      { id: 'abc123', role: 'frontend', preserveEnvironmentKeys: [], startupReviewed: true },
      {
        id: 'def456',
        role: 'api',
        preserveEnvironmentKeys: ['DATABASE_URL'],
        startupReviewed: true,
      },
      {
        id: 'ghi789',
        role: 'worker',
        preserveEnvironmentKeys: ['DATABASE_URL', 'REDIS_URL'],
        startupReviewed: true,
      },
    ],
  };
  expect(dockerSelectionSchema.safeParse(selected).success).toBe(true);
  expect(
    dockerSelectionSchema.safeParse({
      ...selected,
      services: [...selected.services, selected.services[0]],
    }).success,
  ).toBe(false);
  expect(
    dockerSelectionSchema.safeParse({
      ...selected,
      services: [{ ...selected.services[0], startupReviewed: false }],
    }).success,
  ).toBe(false);
});
