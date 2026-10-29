import { expect, test } from 'vitest';
import {
  destinationInputSchema,
  destinationConfigurationSchema,
  destinationCredentialSchema,
  pointDestinationsResultSchema,
  postgresPlanSchema,
} from '@apbackup/contracts';
import { randomUUID } from 'node:crypto';
test('imports only typed provider data and write-only OAuth fields; no executable Rclone config or authenticated endpoint', () => {
  expect(
    destinationConfigurationSchema.safeParse({
      backend: 's3',
      endpoint: 'https://user:pass@storage.example.test',
      bucket: 'backups',
    }).success,
  ).toBe(false);
  expect(
    destinationConfigurationSchema.safeParse({ backend: 'sftp', command: 'curl evil' }).success,
  ).toBe(false);
  expect(
    destinationCredentialSchema.safeParse({ secret: 'repository', rcloneConfig: '[x]\ntype=local' })
      .success,
  ).toBe(false);
  expect(
    destinationCredentialSchema.safeParse({
      secret: 'repository',
      username: 'x\nconfig = dangerous',
    }).success,
  ).toBe(false);
  expect(
    destinationCredentialSchema.safeParse({
      secret: 'repository',
      driveToken: {
        access_token: 'access',
        refresh_token: 'refresh',
        token_type: 'Bearer',
        expiry: '2026-10-29T20:00:00Z',
      },
    }).success,
  ).toBe(true);
  expect(
    destinationInputSchema.parse({
      name: 'Drive pending',
      kind: 'google_drive',
      engine: 'restic',
      rootPath: 'dedicated',
    }).status,
  ).toBe('aguardando_configuracao');
  expect(
    postgresPlanSchema.parse({
      profileVersionId: randomUUID(),
      destinationId: randomUUID(),
      destinationIds: [randomUUID()],
      name: 'Independent copies',
    }).destinationIds,
  ).toHaveLength(1);
  expect(
    pointDestinationsResultSchema.safeParse({
      capturedAt: '2026-10-29T20:00:00Z',
      items: [
        {
          repositoryId: randomUUID(),
          name: 'Unavailable copy',
          status: 'falhou',
          verifiedAt: null,
          snapshotId: null,
        },
      ],
    }).success,
  ).toBe(true);
});
