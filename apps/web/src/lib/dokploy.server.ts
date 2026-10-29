import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PlatformDatabase } from '@apbackup/db';
import {
  dokployConnectionInputSchema,
  dokployConnectionSchema,
  dokployNativeSelectionSchema,
  dokployServiceTypeSchema,
  uuidSchema,
  canonicalJson,
} from '@apbackup/contracts';
import { runtimeTransaction } from '../../../../packages/db/src/repositories/jobs.js';
import { ConfigurationError } from '../../../../packages/db/src/repositories/shared.js';
import { encryptSecret } from '../../../../packages/security/src/vault.js';
import {
  authorize,
  AccessError,
  type SessionPrincipal,
} from '../../../../packages/security/src/authorization.js';
import { assertApprovedDokployOrigin } from '../../../../packages/connectors/src/dokploy-client.js';
import { readDokployClient } from '../../../../packages/connectors/src/dokploy-connection.js';
export function createDokployApi(
  db: PlatformDatabase,
  requireSession: (r: Request) => Promise<SessionPrincipal>,
  baseURL: string,
) {
  return async (request: Request) => {
    const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
    try {
      const actor = await requireSession(request),
        org = actor.organizationId,
        path = new URL(request.url).pathname.replace('/api/dokploy', '');
      authorize(
        actor,
        request.method === 'GET' ? 'read' : path === '/native/run' ? 'backup' : 'configure',
        actor,
      );
      if (request.method !== 'GET' && request.headers.get('origin') !== new URL(baseURL).origin)
        throw new AccessError(403);
      const input = async () => {
        const text = await request.text();
        if (Buffer.byteLength(text) > 16384)
          throw new ConfigurationError(400, 'Formulário muito grande.');
        return JSON.parse(text || '{}') as unknown;
      };
      if (path === '/connections' && request.method === 'GET') {
        const rows = (
          await db.pool.query<{ id: string; server_id: string; configuration: unknown }>(
            "select id,server_id,configuration from connections where organization_id=$1 and kind='dokploy' order by created_at desc",
            [org],
          )
        ).rows;
        return Response.json(
          {
            items: rows.map((r) =>
              dokployConnectionSchema.parse({
                ...(r.configuration as object),
                id: r.id,
                serverId: r.server_id,
              }),
            ),
          },
          { headers },
        );
      }
      if (path === '/connections' && request.method === 'POST') {
        const v = dokployConnectionInputSchema.parse(await input());
        try {
          assertApprovedDokployOrigin(v.endpoint);
        } catch {
          throw new ConfigurationError(
            400,
            'A origem Dokploy deve estar aprovada pelo administrador.',
          );
        }
        const id = randomUUID(),
          reference = randomUUID(),
          { apiKey, ...configuration } = v,
          envelope = encryptSecret(apiKey, {
            organizationId: org,
            reference,
            purpose: 'dokploy-connection',
          });
        await runtimeTransaction(db, async (c) => {
          if (
            !(
              await c.query(
                'select id from servers where organization_id=$1 and id=$2 and archived_at is null',
                [org, v.serverId],
              )
            ).rowCount
          )
            throw new ConfigurationError(404, 'Servidor não encontrado.');
          await c.query(
            'insert into secret_references(id,organization_id,name,ciphertext,key_reference,algorithm,version) values($1,$2,$3,$4,$5,$6,$7)',
            [
              reference,
              org,
              `dokploy:${id}`,
              JSON.stringify(envelope),
              envelope.keyReference,
              envelope.algorithm,
              envelope.version,
            ],
          );
          await c.query(
            "insert into connections(id,organization_id,server_id,kind,endpoint,secret_reference_id,configuration) values($1,$2,$3,'dokploy',$4,$5,$6)",
            [id, org, v.serverId, v.endpoint, reference, JSON.stringify(configuration)],
          );
        });
        return Response.json(dokployConnectionSchema.parse({ ...configuration, id }), {
          status: 201,
          headers,
        });
      }
      const discover = /^\/connections\/([^/]+)\/discover$/.exec(path);
      if (discover && request.method === 'POST') {
        z.strictObject({}).parse(await input());
        const client = await readDokployClient(db, org, uuidSchema.parse(discover[1]));
        if (!client) throw new ConfigurationError(404, 'Conexão não encontrada.');
        return Response.json(await client.discover(), { headers });
      }
      if (path === '/native/configurations' && request.method === 'POST') {
        const v = z
          .strictObject({
            connectionId: uuidSchema,
            resourceId: z.string().min(1).max(128),
            resourceType: dokployServiceTypeSchema,
          })
          .parse(await input());
        const client = await readDokployClient(db, org, v.connectionId);
        if (!client) throw new ConfigurationError(404, 'Conexão não encontrada.');
        const found = await client.configurations(v.resourceType, v.resourceId);
        return Response.json({ items: found.items }, { headers });
      }
      if (path === '/native/run' && request.method === 'POST') {
        const v = dokployNativeSelectionSchema
            .extend({ idempotencyKey: z.string().min(1).max(160) })
            .parse(await input()),
          { idempotencyKey, ...selection } = v;
        const prior = (
          await db.pool.query<{ id: string; selection: unknown; status: string }>(
            'select id,selection,status from dokploy_native_runs where organization_id=$1 and idempotency_key=$2',
            [org, idempotencyKey],
          )
        ).rows[0];
        if (prior) {
          if (canonicalJson(prior.selection) !== canonicalJson(selection))
            throw new ConfigurationError(409, 'Solicitação já vinculada a outro recurso.');
          return Response.json({ id: prior.id, status: prior.status }, { headers });
        }
        const client = await readDokployClient(db, org, v.connectionId);
        if (!client) throw new ConfigurationError(404, 'Conexão não encontrada.');
        const native = await client.nativeConfig(selection),
          baseline = await client.files(
            native.config.destinationId,
            native.search,
            native.serverId,
          );
        if (baseline.length >= 100)
          throw new ConfigurationError(
            409,
            'Prefixo com muitos objetos. Reduza o prefixo no painel nativo antes de executar.',
          );
        const id = randomUUID(),
          providerContext = {
            destinationId: native.config.destinationId,
            search: native.search,
            serverId: native.serverId ?? null,
          };
        await db.pool.query(
          "insert into dokploy_native_runs(id,organization_id,connection_id,idempotency_key,selection,provider_context,baseline,status) values($1,$2,$3,$4,$5,$6,$7,'requested')",
          [
            id,
            org,
            v.connectionId,
            idempotencyKey,
            JSON.stringify(selection),
            JSON.stringify(providerContext),
            JSON.stringify(baseline),
          ],
        );
        try {
          const accepted = await client.run(v.kind, v.configurationId);
          if (accepted === false) throw new Error('Provider failed');
          await db.pool.query(
            "update dokploy_native_runs set status='accepted' where organization_id=$1 and id=$2 and status='requested'",
            [org, id],
          );
        } catch {
          await db.pool.query(
            "update dokploy_native_runs set status='unknown' where organization_id=$1 and id=$2 and status='requested'",
            [org, id],
          );
        }
        return Response.json({ id, status: 'pending_observation' }, { status: 202, headers });
      }
      if (path === '/native/runs' && request.method === 'GET')
        return Response.json(
          {
            items: (
              await db.pool.query(
                'select id,selection,status,artifacts,created_at as "createdAt",checked_at as "checkedAt" from dokploy_native_runs where organization_id=$1 order by created_at desc limit 100',
                [org],
              )
            ).rows,
          },
          { headers },
        );
      return Response.json({ error: 'Página não encontrada.' }, { status: 404, headers });
    } catch (e) {
      if (e instanceof AccessError || e instanceof ConfigurationError)
        return Response.json({ error: e.message }, { status: e.status, headers });
      if (e instanceof z.ZodError || e instanceof SyntaxError)
        return Response.json({ error: 'Revise os campos informados.' }, { status: 400, headers });
      return Response.json(
        {
          error:
            'Não foi possível concluir. Verifique conexão, versão, permissões e destino nativo.',
        },
        { status: 409, headers },
      );
    }
  };
}
