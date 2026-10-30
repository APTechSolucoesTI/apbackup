import { expect, test } from 'vitest';
import {
  postgresConnectionInputSchema,
  postgresDatabaseNameSchema,
  agentCommandSchema,
  postgresSelectionSchema,
  postgresRuntimeSecretsSchema,
} from '@apbackup/contracts';
import { postgresClient } from '../../packages/connectors/src/postgresql-connection.js';

test('Docker-local PostgreSQL accepts no password and requires an exact safe container identity', () => {
  const input = {
    serverId: crypto.randomUUID(),
    name: 'Shared local',
    transport: 'docker_exec',
    container: 'supabase-db',
    username: 'postgres',
  };
  expect(postgresConnectionInputSchema.safeParse(input).success).toBe(true);
  for (const container of ['', '/supabase-db', '-options', 'db;id', 'db/name'])
    expect(postgresConnectionInputSchema.safeParse({ ...input, container }).success).toBe(false);
  expect(
    postgresRuntimeSecretsSchema.safeParse({
      connection: { transport: 'docker_exec', container: 'supabase-db', username: 'postgres' },
      database: 'postgres',
      repositoryPath: 'repo',
      repositoryPassword: 'secret',
    }).success,
  ).toBe(true);
  expect(
    postgresConnectionInputSchema.safeParse({
      ...input,
      transport: 'tcp',
      container: undefined,
      host: 'localhost',
    }).success,
  ).toBe(false);
});

test('Docker-local configuration never enters TCP and remote TCP still requires verified TLS', () => {
  const local = postgresConnectionInputSchema.parse({
    serverId: crypto.randomUUID(),
    name: 'Local',
    transport: 'docker_exec',
    container: 'supabase-db',
    username: 'postgres',
  });
  expect(() => postgresClient(local, 'postgres')).toThrow(/Docker/);
  expect(() =>
    postgresClient(
      {
        host: 'remote.example.test',
        port: 5432,
        username: 'postgres',
        password: 'private',
        sslMode: 'disable',
      },
      'postgres',
    ),
  ).toThrow(/TLS/);
});
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
