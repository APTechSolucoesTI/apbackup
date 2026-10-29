import type { PoolClient } from 'pg';
import type { PlatformDatabase } from '../client.js';
import { mutationVersionSchema } from '@apbackup/contracts';
export class ConfigurationError extends Error {
  constructor(
    public status: 400 | 403 | 404 | 409,
    message: string,
    public fields: Record<string, string> = {},
  ) {
    super(message);
  }
}
export interface VaultWriter {
  decryptSecret?: (
    envelope: import('../../../security/src/vault.js').EncryptedSecret,
    context: { organizationId: string; reference: string; purpose: string },
  ) => string;
  encryptSecret: (
    plaintext: string,
    context: { organizationId: string; reference: string; purpose: string },
  ) => {
    version: number;
    algorithm: string;
    keyReference: string;
    iv: string;
    tag: string;
    ciphertext: string;
  };
}
export interface RepositoryContext {
  db: PlatformDatabase;
  organizationId: string;
  actorId: string;
  vault: VaultWriter;
}
export type ConfigurationTable =
  'servers' | 'resources' | 'system_profiles' | 'destinations' | 'plans';
export const instantSQL = (column: string) =>
  `to_char(${column} at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
export const baseFields = (alias = 't') =>
  `${alias}.id,${alias}.organization_id as "organizationId",${alias}.name,${instantSQL(`${alias}.created_at`)} as "createdAt",${instantSQL(`${alias}.updated_at`)} as "updatedAt",${instantSQL(`${alias}.archived_at`)} as "archivedAt"`;
export async function transaction<T>(
  ctx: RepositoryContext,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await ctx.db.pool.connect();
  try {
    await client.query('begin');
    const result = await run(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    if (error && typeof error === 'object' && 'code' in error) {
      if (error.code === '23505')
        throw new ConfigurationError(409, 'Já existe um cadastro com essa identificação ou nome.');
      if (error.code === '23503')
        throw new ConfigurationError(
          409,
          'O cadastro está em uso ou uma referência não está disponível.',
        );
      if (error.code === '23514')
        throw new ConfigurationError(
          400,
          'A configuração não atende aos requisitos de integridade.',
        );
    }
    throw error;
  } finally {
    client.release();
  }
}
export async function lockRecord(
  client: PoolClient,
  ctx: RepositoryContext,
  table: ConfigurationTable,
  id: string,
  input: unknown,
  allowArchived = false,
) {
  const version = mutationVersionSchema.parse(input);
  const row = (
    await client.query<{ updatedAt: string; archivedAt: string | null }>(
      `select ${instantSQL('updated_at')} as "updatedAt",${instantSQL('archived_at')} as "archivedAt" from ${table} where organization_id=$1 and id=$2 for update`,
      [ctx.organizationId, id],
    )
  ).rows[0];
  if (!row) throw new ConfigurationError(404, 'Cadastro não encontrado.');
  if (row.updatedAt !== version.expectedUpdatedAt)
    throw new ConfigurationError(
      409,
      'Este cadastro foi alterado. Atualize os dados antes de salvar.',
    );
  if (row.archivedAt && !allowArchived)
    throw new ConfigurationError(409, 'Restaure o cadastro antes de editar.');
  return row;
}
export async function activeReference(
  client: PoolClient,
  ctx: RepositoryContext,
  table: ConfigurationTable,
  id: string,
) {
  const row = (
    await client.query<{ id: string; server_id?: string }>(
      `select id${table === 'resources' || table === 'system_profiles' || table === 'plans' ? ',server_id' : ''} from ${table} where organization_id=$1 and id=$2 and archived_at is null for share`,
      [ctx.organizationId, id],
    )
  ).rows[0];
  if (!row)
    throw new ConfigurationError(404, 'Uma referência não foi encontrada ou está arquivada.');
  return row;
}
export async function audit(
  client: PoolClient,
  ctx: RepositoryContext,
  kind: string,
  id: string,
  action: string,
) {
  await client.query(
    'insert into audit_events(organization_id,actor_id,action,subject_type,subject_id) values($1,$2,$3,$4,$5)',
    [ctx.organizationId, ctx.actorId, `configuration.${action}`, kind, id],
  );
}
export async function setArchived<T>(
  ctx: RepositoryContext,
  table: ConfigurationTable,
  id: string,
  input: unknown,
  archived: boolean,
  get: (id: string, client: PoolClient) => Promise<T>,
  guard?: (client: PoolClient) => Promise<void>,
) {
  return transaction(ctx, async (client) => {
    await lockRecord(client, ctx, table, id, input, true);
    if (guard) await guard(client);
    await client.query(
      `update ${table} set archived_at=${archived ? 'now()' : 'null'}${table === 'plans' ? ',enabled=false' : table === 'destinations' ? ",status='desabilitado'" : ''} where organization_id=$1 and id=$2`,
      [ctx.organizationId, id],
    );
    if (table === 'plans')
      await client.query(
        'update schedules set enabled=false where organization_id=$1 and plan_id=$2',
        [ctx.organizationId, id],
      );
    await audit(client, ctx, table, id, archived ? 'archive' : 'restore');
    return get(id, client);
  });
}
