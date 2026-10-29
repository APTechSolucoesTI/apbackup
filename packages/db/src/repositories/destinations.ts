import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { decryptSecret, type EncryptedSecret } from '../../../security/src/vault.js';
import { z } from 'zod';
import {
  destinationInputSchema,
  destinationUpdateSchema,
  destinationReadSchema,
  connectorCapabilitiesSchema,
  type DestinationInput,
} from '@apbackup/contracts';
import type { PoolClient } from 'pg';
import { verifiedPoints } from './coverage.js';
import {
  baseFields,
  transaction,
  lockRecord,
  audit,
  setArchived,
  ConfigurationError,
  type RepositoryContext,
} from './shared.js';
export function createDestinationsRepository(ctx: RepositoryContext) {
  async function get(id: string, client: PoolClient | typeof ctx.db.pool = ctx.db.pool) {
    const row = (
      await client.query(
        `select ${baseFields()},t.host,t.kind,t.root_path as "rootPath",t.status,t.configuration,(t.credential_id is not null) as "hasCredential",r.id as "repositoryId",r.engine,false as coverage from destinations t join lateral(select id,engine from repositories where organization_id=t.organization_id and destination_id=t.id order by created_at,id limit 1) r on true where t.organization_id=$1 and t.id=$2`,
        [ctx.organizationId, id],
      )
    ).rows[0];
    if (!row) throw new ConfigurationError(404, 'Destino não encontrado.');
    const current = (
      await client.query<{
        configuration_revision: number;
        assessed_at: Date;
        capabilities: unknown;
      }>(
        'select c.configuration_revision,c.assessed_at,c.capabilities from connector_capabilities c join destinations d on d.organization_id=c.organization_id and d.id=c.destination_id and d.configuration_revision=c.configuration_revision where d.organization_id=$1 and d.id=$2 order by c.assessed_at desc,c.id desc limit 1',
        [ctx.organizationId, id],
      )
    ).rows[0];
    const capabilities = connectorCapabilitiesSchema.safeParse(current?.capabilities);
    const assessment =
      current && capabilities.success
        ? {
            configurationRevision: current.configuration_revision,
            assessedAt: current.assessed_at,
            capabilities: capabilities.data,
          }
        : null;
    const parsed = destinationReadSchema.parse({ ...row, assessment });
    return {
      ...parsed,
      coverage:
        (await verifiedPoints(ctx, { repositoryId: parsed.repositoryId }, client)).length > 0,
    };
  }
  function validate(v: DestinationInput, hasCredential: boolean) {
    if (v.kind === 'pbs' && v.status === 'ativo')
      throw new ConfigurationError(400, 'PBS não está disponível nesta etapa.');
    if (v.rootPath && /[\r\n\0]/.test(v.rootPath))
      throw new ConfigurationError(400, 'Pasta inválida.');
    if (
      v.configuration?.backend === 'mounted' &&
      (v.kind !== 'local' ||
        !v.rootPath?.startsWith('/') ||
        v.rootPath.split('/').filter(Boolean).length < 2)
    )
      throw new ConfigurationError(
        400,
        'Selecione uma pasta montada dedicada, explicitamente aprovada no agente.',
      );
    if (v.kind && v.kind !== 'local' && v.kind !== 'pbs' && v.status === 'ativo') {
      if (v.configuration?.backend !== v.kind)
        throw new ConfigurationError(400, 'Configure o backend antes da ativação.');
      const c = v.configuration,
        credential = v.credential;
      if (
        v.kind === 's3' &&
        (!c.bucket ||
          !c.endpoint ||
          (credential && (!credential.accessKey || !credential.secretKey)))
      )
        throw new ConfigurationError(400, 'Informe endpoint, bucket e credenciais S3.');
      if (
        v.kind === 'sftp' &&
        (!v.host || !c.hostKey || (credential && (!credential.username || !credential.password)))
      )
        throw new ConfigurationError(400, 'Informe host, chave SSH fixada e credenciais SFTP.');
      if (
        v.kind === 'smb' &&
        (!v.host || !c.share || (credential && (!credential.username || !credential.password)))
      )
        throw new ConfigurationError(400, 'Informe host, compartilhamento e credenciais SMB.');
      if (v.kind === 'google_drive' && credential && !credential.driveToken)
        throw new ConfigurationError(400, 'Importe o token OAuth autorizado pelo Rclone.');
    }
    if (
      v.kind === 'local' &&
      v.configuration?.backend !== 'mounted' &&
      (!v.rootPath ||
        !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(v.rootPath) ||
        v.host ||
        v.engine !== 'restic')
    )
      throw new ConfigurationError(
        400,
        'O destino local exige Restic e uma pasta relativa dedicada, sem host.',
        { rootPath: 'Use letras, números, hífen ou sublinhado; até 100 caracteres.' },
      );
    if (
      v.rootPath &&
      (/[\\/]\.\.([\\/]|$)/.test(v.rootPath) || ['/', '\\', '\\\\'].includes(v.rootPath))
    )
      throw new ConfigurationError(400, 'Informe uma pasta dedicada; a raiz não pode ser usada.', {
        rootPath: 'Informe uma pasta dedicada.',
      });
    if (
      (v.kind === 'pbs' && v.engine && v.engine !== 'pbs') ||
      (v.kind && v.kind !== 'pbs' && v.engine === 'pbs')
    )
      throw new ConfigurationError(400, 'O mecanismo selecionado não corresponde ao protocolo.', {
        engine: 'Selecione um mecanismo compatível.',
      });
    if (v.status === 'ativo' && (!v.kind || !v.engine || !v.rootPath || !hasCredential))
      throw new ConfigurationError(
        400,
        'Configure protocolo, mecanismo, pasta dedicada e credencial antes de habilitar o destino.',
        { status: 'A configuração ainda está incompleta.' },
      );
    if (v.credential && ['sftp', 'smb'].includes(v.kind ?? '') && !v.credential.username)
      throw new ConfigurationError(
        400,
        'Informe o usuário ou identificador de acesso da credencial.',
        { credential: 'Informe os dados completos da credencial.' },
      );
  }
  async function credential(client: PoolClient, id: string, v: DestinationInput) {
    if (!v.credential) return null;
    const reference = randomUUID();
    const envelope = ctx.vault.encryptSecret(JSON.stringify(v.credential), {
      organizationId: ctx.organizationId,
      reference,
      purpose: 'destination-credential',
    });
    await client.query(
      'insert into secret_references(id,organization_id,name,ciphertext,key_reference,algorithm,version) values($1,$2,$3,$4,$5,$6,$7)',
      [
        reference,
        ctx.organizationId,
        `destination:${id}:${reference}`,
        JSON.stringify(envelope),
        envelope.keyReference,
        envelope.algorithm,
        envelope.version,
      ],
    );
    return reference;
  }
  return {
    get,
    async create(input: unknown) {
      const v = destinationInputSchema.parse(input);
      validate(v, Boolean(v.credential));
      return transaction(ctx, async (client) => {
        const id = randomUUID(),
          secret = await credential(client, id, v);
        await client.query(
          'insert into destinations(id,organization_id,name,host,kind,root_path,status,credential_id,configuration) values($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [
            id,
            ctx.organizationId,
            v.name,
            v.host,
            v.kind,
            v.rootPath,
            v.status,
            secret,
            v.configuration,
          ],
        );
        await client.query(
          'insert into repositories(organization_id,destination_id,external_identity,engine) values($1,$2,$3,$4)',
          [ctx.organizationId, id, `destination:${id}`, v.engine],
        );
        await audit(client, ctx, 'destination', id, 'create');
        return get(id, client);
      });
    },
    async update(id: string, input: unknown) {
      const v = destinationUpdateSchema.parse(input);
      return transaction(ctx, async (client) => {
        await client.query('select id from organizations where id=$1 for update', [
          ctx.organizationId,
        ]);
        await lockRecord(client, ctx, 'destinations', id, {
          expectedUpdatedAt: v.expectedUpdatedAt,
        });
        const old = await get(id, client);
        if (v.credential) {
          const busy = await client.query(
            `select id from agent_commands where organization_id=$1 and (state in('queued','delivered','unknown') or result->>'outcome'='unknown') limit 1`,
            [ctx.organizationId],
          );
          const pending = await client.query(
            `select t.execution_id from repository_tasks t join executions e on e.organization_id=t.organization_id and e.id=t.execution_id where t.organization_id=$1 and (t.scope->>'repositoryId'=$2 or t.scope->>'sourceRepositoryId'=$2) and e.status not in('concluida','falhou','falhas_parciais','cancelada') limit 1`,
            [ctx.organizationId, old.repositoryId],
          );
          if (busy.rowCount || pending.rowCount)
            throw new ConfigurationError(
              409,
              'Aguarde a operação em andamento ou reconcilie o resultado desconhecido antes de renovar a credencial.',
            );
          const previous = (
            await client.query<{ credential_id: string; ciphertext: string }>(
              `select d.credential_id,s.ciphertext from repositories r join destinations d on d.organization_id=r.organization_id and d.id=r.destination_id join secret_references s on s.organization_id=d.organization_id and s.id=d.credential_id where r.organization_id=$1 and r.id=$2 and r.native_repository_id is not null`,
              [ctx.organizationId, old.repositoryId],
            )
          ).rows[0];
          if (previous) {
            const raw = (ctx.vault.decryptSecret ?? decryptSecret)(
              JSON.parse(previous.ciphertext) as EncryptedSecret,
              {
                organizationId: ctx.organizationId,
                reference: previous.credential_id,
                purpose: 'destination-credential',
              },
            );
            const oldSecret = z.object({ secret: z.string() }).parse(JSON.parse(raw)).secret;
            const digest = (value: string) => createHash('sha256').update(value).digest();
            if (!timingSafeEqual(digest(oldSecret), digest(v.credential.secret)))
              throw new ConfigurationError(
                409,
                'A senha pertence ao repositório Restic existente. Crie outro destino para usar uma nova senha.',
              );
          }
        }
        if (v.status === 'ativo' && old.status !== 'ativo' && v.kind !== 'local' && !v.credential)
          throw new ConfigurationError(
            400,
            'Informe novamente a credencial completa ou execute a avaliação real pelo agente.',
          );
        validate(v, old.hasCredential || Boolean(v.credential));
        if (old.kind !== v.kind && old.hasCredential && !v.credential)
          throw new ConfigurationError(400, 'Informe uma nova credencial ao mudar o protocolo.', {
            credential: 'Informe a credencial do novo protocolo.',
          });
        if (v.status !== 'ativo') {
          const active = await client.query(
            'select p.id from plans p join plan_destinations d on d.organization_id=p.organization_id and d.plan_id=p.id where p.organization_id=$1 and d.repository_id=$2 and d.required and p.enabled and p.archived_at is null limit 1',
            [ctx.organizationId, old.repositoryId],
          );
          if (active.rowCount)
            throw new ConfigurationError(
              409,
              'Desabilite os planos que exigem este destino antes de desabilitá-lo.',
            );
        }
        if (
          old.kind !== v.kind ||
          old.host !== v.host ||
          old.rootPath !== v.rootPath ||
          old.engine !== v.engine ||
          JSON.stringify(old.configuration) !== JSON.stringify(v.configuration)
        ) {
          const history = await client.query(
            'select id from destination_results where organization_id=$1 and repository_id=$2 limit 1',
            [ctx.organizationId, old.repositoryId],
          );
          if (history.rowCount)
            throw new ConfigurationError(
              409,
              'Este destino possui histórico. Crie outro destino para mudar protocolo, pasta ou mecanismo.',
            );
          const active = await client.query(
            'select p.id from plans p join plan_destinations d on d.organization_id=p.organization_id and d.plan_id=p.id where p.organization_id=$1 and d.repository_id=$2 and p.enabled and p.archived_at is null limit 1',
            [ctx.organizationId, old.repositoryId],
          );
          if (active.rowCount)
            throw new ConfigurationError(
              409,
              'Desabilite os planos deste destino antes de alterar sua conexão.',
            );
        }
        const secret = await credential(client, id, v);
        await client.query(
          'update destinations set name=$3,host=$4,kind=$5,root_path=$6,status=$7,credential_id=coalesce($8::uuid,credential_id),configuration=$9 where organization_id=$1 and id=$2',
          [
            ctx.organizationId,
            id,
            v.name,
            v.host,
            v.kind,
            v.rootPath,
            v.status,
            secret,
            v.configuration,
          ],
        );
        await client.query('update repositories set engine=$3 where organization_id=$1 and id=$2', [
          ctx.organizationId,
          old.repositoryId,
          v.engine,
        ]);
        await audit(client, ctx, 'destination', id, 'update');
        return get(id, client);
      });
    },
    archive: (id: string, input: unknown) =>
      setArchived(ctx, 'destinations', id, input, true, get, async (client) => {
        const used = await client.query(
          'select p.id from plans p join plan_destinations d on d.organization_id=p.organization_id and d.plan_id=p.id join repositories r on r.organization_id=d.organization_id and r.id=d.repository_id where p.organization_id=$1 and r.destination_id=$2 and p.enabled and p.archived_at is null limit 1',
          [ctx.organizationId, id],
        );
        if (used.rowCount)
          throw new ConfigurationError(
            409,
            'Desabilite os planos deste destino antes de arquivá-lo.',
          );
      }),
    restore: (id: string, input: unknown) =>
      setArchived(ctx, 'destinations', id, input, false, get),
  };
}
