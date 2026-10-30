import { readRepository } from './repository-context.js';
import pg from 'pg';
import { z } from 'zod';
import type { PlatformDatabase } from '@apbackup/db';
import {
  postgresConnectionSchema,
  postgresRuntimeSecretsSchema,
  type AgentCommand,
} from '@apbackup/contracts';
import { decryptSecret, type EncryptedSecret } from '../../security/src/vault.js';
export function assertApprovedPostgresHost(host: string) {
  const allowed = (process.env.POSTGRES_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  if (!allowed.includes(host)) throw new Error('PostgreSQL host is not approved');
}
export function postgresClient(
  config: Omit<z.infer<typeof postgresRuntimeSecretsSchema>['connection'], 'transport'> & {
    transport?: 'tcp' | 'docker_exec';
  },
  database: string,
) {
  if (config.transport === 'docker_exec')
    throw new Error('Docker-local PostgreSQL requires agent transport');
  if (config.sslMode === 'disable' && !['127.0.0.1', 'localhost'].includes(config.host))
    throw new Error('TLS required outside loopback');
  return new pg.Client({
    host: config.host,
    port: config.port,
    user: config.username,
    password: config.password,
    database,
    ssl: config.sslMode === 'verify-full' ? { rejectUnauthorized: true } : false,
    connectionTimeoutMillis: 10000,
    statement_timeout: 30000,
    application_name: 'apbackup-r1',
  });
}
export async function readSecret(
  db: PlatformDatabase,
  organizationId: string,
  reference: string,
  purpose: string,
) {
  const row = (
    await db.pool.query<{ ciphertext: string }>(
      'select ciphertext from secret_references where organization_id=$1 and id=$2',
      [organizationId, reference],
    )
  ).rows[0];
  if (!row) throw new Error('Secret unavailable');
  return decryptSecret(JSON.parse(row.ciphertext) as EncryptedSecret, {
    organizationId,
    reference,
    purpose,
  });
}
export async function readPostgresConnection(
  db: PlatformDatabase,
  organizationId: string,
  id: string,
) {
  const row = (
    await db.pool.query<{
      id: string;
      server_id: string;
      configuration: unknown;
      secret_reference_id: string | null;
    }>(
      "select id,server_id,configuration,secret_reference_id from connections where organization_id=$1 and id=$2 and kind='postgresql'",
      [organizationId, id],
    )
  ).rows[0];
  if (!row) return null;
  const config = postgresConnectionSchema.parse({
    ...(row.configuration as object),
    id: row.id,
    serverId: row.server_id,
  });
  return {
    ...config,
    password:
      config.transport === 'docker_exec'
        ? ''
        : await readSecret(
            db,
            organizationId,
            row.secret_reference_id ?? '',
            'postgresql-connection',
          ),
  };
}
export async function resolvePostgresCommand(db: PlatformDatabase, command: AgentCommand) {
  if (
    command.operation.kind !== 'postgresql_backup' &&
    command.operation.kind !== 'postgresql_restore'
  )
    throw new Error('Not a PostgreSQL command');
  const row = (
    await db.pool.query<{
      connection_id: string;
      database_name: string;
      schema_names: string[];
      root_path: string;
      credential_id: string;
    }>(
      `select b.connection_id,b.database_name,b.schema_names,d.root_path,d.credential_id from postgresql_bindings b join repositories r on r.organization_id=b.organization_id and r.id=$4 join destinations d on d.organization_id=r.organization_id and d.id=r.destination_id where b.organization_id=$1 and b.profile_version_id=$2 and b.resource_id=$3 and r.engine='restic' and d.status='ativo' and d.archived_at is null`,
      [
        command.organizationId,
        command.profileVersionId,
        command.resourceId,
        command.operation.repositoryId,
      ],
    )
  ).rows[0];
  if (!row) throw new Error('PostgreSQL binding unavailable');
  const connection = await readPostgresConnection(db, command.organizationId, row.connection_id);
  if (!connection) throw new Error('Connection unavailable');
  if (connection.transport !== 'docker_exec') assertApprovedPostgresHost(connection.host);
  const { host, port, username, password, sslMode, transport, container } = connection;
  const repository = z
    .object({ secret: z.string().min(1) })
    .parse(
      JSON.parse(
        await readSecret(db, command.organizationId, row.credential_id, 'destination-credential'),
      ),
    );
  return postgresRuntimeSecretsSchema.parse({
    connection: { host, port, username, password, sslMode, transport, container },
    database: row.database_name,
    schemas: row.schema_names,
    repositoryPath: /[^A-Za-z0-9_-]/.test(row.root_path)
      ? command.operation.repositoryId
      : row.root_path,
    repositoryPassword: repository.secret,
    repository: await readRepository(
      db,
      command.organizationId,
      command.operation.repositoryId,
      command.operation.kind === 'postgresql_backup'
        ? command.operation.repositoryRevisions?.[command.operation.repositoryId]
        : undefined,
    ),
  });
}
