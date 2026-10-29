import { existsSync } from 'node:fs';
import { expect, test } from 'vitest';

const org = '14e52208-85a0-4a48-80e7-79a09d8e5178';
const fixture = {
  version: 1,
  organizationId: org,
  serverId: org,
  profileId: org,
  profileVersion: 1,
  adapter: { name: 'postgres-files', version: '1.0.0' },
  capturedAt: '2026-10-28T06:00:00Z',
  consistency: 'application_consistent',
  requiredComponentIds: ['database', 'files'],
  components: [
    {
      id: 'database',
      resourceId: org,
      kind: 'postgresql',
      artifactPath: 'database.dump',
      sha256: 'a'.repeat(64),
      sizeBytes: 12,
    },
    {
      id: 'files',
      resourceId: org,
      kind: 'files',
      artifactPath: 'files.tar',
      sha256: 'b'.repeat(64),
      sizeBytes: 24,
    },
  ],
  images: [
    { reference: 'example/app@sha256:' + 'c'.repeat(64), digest: 'sha256:' + 'c'.repeat(64) },
  ],
  encryptedConfiguration: {
    artifactPath: 'configuration.enc',
    sha256: 'd'.repeat(64),
    keyReference: 'external-custody-v1',
  },
  dependencies: [],
  restoreCapabilities: ['system', 'database', 'files'],
};

test('accepts a complete recovery manifest and rejects missing required components and public credentials', async () => {
  // Removing required-component, path, digest, credential or unknown-key validation must fail this test.
  const modulePath = new URL('../../packages/contracts/src/index.ts', import.meta.url);
  const api: Record<string, unknown> = existsSync(modulePath) ? await import(modulePath.href) : {};
  expect(api.manifestSchema, 'manifestSchema must be implemented').toBeDefined();
  const { manifestSchema } = await import('../../packages/contracts/src/index.js');
  expect(manifestSchema.safeParse(fixture).success).toBe(true);
  const incomplete = { ...fixture, components: fixture.components.slice(0, 1) };
  expect(manifestSchema.safeParse(incomplete).success).toBe(false);
  for (const value of [
    { ...fixture, password: 'must-not-be-public' },
    { ...fixture, adapter: { ...fixture.adapter, token: 'secret' } },
    {
      ...fixture,
      components: [{ ...fixture.components[0], artifactPath: '../escape' }, fixture.components[1]],
    },
    {
      ...fixture,
      encryptedConfiguration: {
        ...fixture.encryptedConfiguration,
        keyReference: 'postgresql://user:password@host/db',
      },
    },
    {
      ...fixture,
      components: [fixture.components[0], fixture.components[0], fixture.components[1]],
    },
    { ...fixture, images: [{ reference: 'example/app:latest', digest: 'latest' }] },
  ])
    expect(manifestSchema.safeParse(value).success).toBe(false);
});
