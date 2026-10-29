import { expect, test } from 'vitest';
import {
  postgresConnectionInputSchema,
  postgresDatabaseNameSchema,
  agentCommandSchema,
  postgresSelectionSchema,
} from '@apbackup/contracts';
test('shared PostgreSQL supports an explicit schema scope or whole source database with an isolated target', () => {
  const connectionId = crypto.randomUUID();
  expect(
    postgresSelectionSchema.safeParse({ connectionId, database: 'postgres', schemas: ['apticket'] })
      .success,
  ).toBe(true);
  expect(postgresSelectionSchema.safeParse({ connectionId, database: 'postgres' }).success).toBe(
    true,
  );
  expect(
    postgresSelectionSchema.safeParse({ connectionId, database: 'shared', schemas: ['auth'] })
      .success,
  ).toBe(false);
});
test('PostgreSQL connections validate explicit transport and safe database identifiers', () => {
  expect(
    postgresConnectionInputSchema.safeParse({
      serverId: crypto.randomUUID(),
      name: 'Local',
      host: '127.0.0.1',
      port: 5432,
      username: 'backup',
      password: 'private',
      sslMode: 'disable',
    }).success,
  ).toBe(true);
  for (const name of [
    'postgres',
    'template0',
    'template1',
    '-options',
    'a=b',
    'a";drop database x;--',
  ])
    expect(postgresDatabaseNameSchema.safeParse(name).success).toBe(false);
  expect(postgresDatabaseNameSchema.parse('financeiro_2026')).toBe('financeiro_2026');
});
test('PostgreSQL durable commands contain references and reject embedded secrets', () => {
  const command = {
    version: 1,
    commandId: crypto.randomUUID(),
    organizationId: crypto.randomUUID(),
    executionId: crypto.randomUUID(),
    profileVersionId: crypto.randomUUID(),
    agentId: crypto.randomUUID(),
    resourceId: crypto.randomUUID(),
    fencingToken: '1',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    operation: { kind: 'postgresql_backup', repositoryId: crypto.randomUUID() },
  };
  expect(agentCommandSchema.safeParse(command).success).toBe(true);
  expect(
    agentCommandSchema.safeParse({
      ...command,
      operation: { ...command.operation, password: 'secret' },
    }).success,
  ).toBe(false);
});
