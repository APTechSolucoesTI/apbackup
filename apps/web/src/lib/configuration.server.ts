import { z } from 'zod';
import type { PlatformDatabase } from '@apbackup/db';
import { optionsResultSchema, configurationKindSchema } from '@apbackup/contracts';
import { createServersRepository } from '../../../../packages/db/src/repositories/servers.js';
import { createResourcesRepository } from '../../../../packages/db/src/repositories/resources.js';
import { createProfilesRepository } from '../../../../packages/db/src/repositories/profiles.js';
import { createPlansRepository } from '../../../../packages/db/src/repositories/plans.js';
import { createDestinationsRepository } from '../../../../packages/db/src/repositories/destinations.js';
import { createCoverageRepository } from '../../../../packages/db/src/repositories/coverage.js';
import {
  ConfigurationError,
  type VaultWriter,
} from '../../../../packages/db/src/repositories/shared.js';
import {
  authorize,
  AccessError,
  type SessionPrincipal,
} from '../../../../packages/security/src/authorization.js';
import { encryptSecret } from '../../../../packages/security/src/vault.js';
import { createSessionService } from './session.server.js';
import type { PlatformAuth } from './auth.server.js';
export function createConfigurationService(
  db: PlatformDatabase,
  principal: SessionPrincipal,
  vault: VaultWriter = { encryptSecret },
) {
  const ctx = { db, organizationId: principal.organizationId, actorId: principal.userId, vault };
  const read = () => authorize(principal, 'read', { organizationId: ctx.organizationId });
  const write = () => authorize(principal, 'configure', { organizationId: ctx.organizationId });
  function guard<T>(repo: {
    get: (id: string) => Promise<T>;
    create: (input: unknown) => Promise<T>;
    update: (id: string, input: unknown) => Promise<T>;
    archive: (id: string, input: unknown) => Promise<T>;
    restore: (id: string, input: unknown) => Promise<T>;
  }) {
    return {
      get: async (id: string) => {
        read();
        return repo.get(z.uuid().parse(id));
      },
      create: async (input: unknown) => {
        write();
        return repo.create(input);
      },
      update: async (id: string, input: unknown) => {
        write();
        return repo.update(z.uuid().parse(id), input);
      },
      archive: async (id: string, input: unknown) => {
        write();
        return repo.archive(z.uuid().parse(id), input);
      },
      restore: async (id: string, input: unknown) => {
        write();
        return repo.restore(z.uuid().parse(id), input);
      },
    };
  }
  const profiles = createProfilesRepository(ctx),
    coverage = createCoverageRepository(ctx);
  return {
    servers: guard(createServersRepository(ctx)),
    resources: guard(createResourcesRepository(ctx)),
    profiles: guard(profiles),
    destinations: guard(createDestinationsRepository(ctx)),
    plans: guard(createPlansRepository(ctx)),
    resolveProfile: (id: string, org: string) => {
      read();
      return profiles.resolveProfile(z.uuid().parse(id), z.uuid().parse(org));
    },
    getCoverage: (id: string, org: string) => {
      read();
      return coverage.getCoverage(z.uuid().parse(id), z.uuid().parse(org));
    },
    async options(input: unknown) {
      read();
      const q = z
        .object({
          kind: z.enum(['servers', 'resources', 'profiles', 'destinations']),
          destinationKind: z.enum(['local', 'sftp', 'smb', 's3', 'google_drive']).optional(),
          search: z.string().trim().max(200).default(''),
          serverId: z.uuid().optional(),
          ids: z
            .preprocess(
              (v) => (typeof v === 'string' ? (v ? v.split(',') : []) : v),
              z.array(z.uuid()).max(200),
            )
            .default([]),
        })
        .parse(input);
      const escaped = q.search.replace(/[\\%_]/g, '\\$&');
      const definitions = {
        servers: `select id,name as label,external_identity as detail,null::uuid as "serverId",archived_at from servers where organization_id=$1`,
        resources: `select r.id,r.name as label,r.kind::text||' · '||s.name as detail,r.server_id as "serverId",r.archived_at from resources r join servers s on s.organization_id=r.organization_id and s.id=r.server_id where r.organization_id=$1`,
        profiles: `select v.id,p.name||' · v'||v.version::text as label,p.external_identity as detail,p.server_id as "serverId",p.archived_at from system_profiles p join lateral(select id,version from profile_versions where organization_id=p.organization_id and profile_id=p.id order by version desc limit 1) v on true where p.organization_id=$1 union all select v.id,p.name||' · v'||v.version::text as label,p.external_identity as detail,p.server_id as "serverId",p.archived_at from profile_versions v join system_profiles p on p.organization_id=v.organization_id and p.id=v.profile_id where v.organization_id=$1 and v.id=any($4::uuid[]) and v.id not in(select id from profile_versions pv where pv.organization_id=$1 and pv.profile_id=p.id order by version desc limit 1)`,
        destinations: `select id,name as label,status::text as detail,null::uuid as "serverId",kind as "destinationKind",(kind='local' and configuration is null) as "localCapture",archived_at from destinations where organization_id=$1`,
      };
      const where = `where ${q.kind === 'destinations' && q.destinationKind ? `"destinationKind"='${q.destinationKind}' and ` : ''}((archived_at is null and (label ilike $2 or detail ilike $2) and ($3::uuid is null or "serverId"=$3)) or id=any($4::uuid[]))`;
      const values = [ctx.organizationId, `%${escaped}%`, q.serverId ?? null, q.ids];
      const total = Number(
        (
          await db.pool.query<{ total: string }>(
            `select count(*) as total from (${definitions[q.kind]}) o ${where}`,
            values,
          )
        ).rows[0]!.total,
      );
      const items = (
        await db.pool.query(
          `select id,label,detail,"serverId"${q.kind === 'destinations' ? ',"destinationKind","localCapture"' : ''} from (${definitions[q.kind]}) o ${where} order by (id=any($4::uuid[])) desc,label collate apbackup_pt_numeric,id limit 250`,
          values,
        )
      ).rows;
      return optionsResultSchema.parse({ items, total });
    },
  };
}
export function createConfigurationApi(auth: PlatformAuth, db: PlatformDatabase) {
  const sessions = createSessionService(auth, db);
  return async (request: Request) => {
    const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
    try {
      const principal = await sessions.requireSession(request),
        url = new URL(request.url);
      const service = createConfigurationService(db, principal);
      if (
        request.method !== 'GET' &&
        request.headers.get('origin') !== new URL(auth.options.baseURL as string).origin
      )
        throw new AccessError(403);
      if (request.method === 'GET' && url.pathname === '/api/configuration/options')
        return Response.json(await service.options(Object.fromEntries(url.searchParams)), {
          headers,
        });
      if (request.method === 'GET' && url.pathname.startsWith('/api/configuration/coverage/'))
        return Response.json(
          await service.getCoverage(url.pathname.split('/').at(-1)!, principal.organizationId),
          { headers },
        );
      const parts = url.pathname.split('/').filter(Boolean),
        kind = configurationKindSchema.parse(parts[2]),
        repo = kind === 'systems' ? service.profiles : service[kind];
      const id = parts[3];
      if (request.method === 'GET' && id && parts.length === 4)
        return Response.json(await repo.get(id), { headers });
      if (request.method === 'POST') {
        if (Number(request.headers.get('content-length') ?? 0) > 100000)
          return Response.json(
            { error: 'O formulário excedeu o limite permitido.' },
            { status: 413, headers },
          );
        const input: unknown = await request.json();
        if (!id && parts.length === 3)
          return Response.json(await repo.create(input), { status: 201, headers });
        if (id && parts.length === 4)
          return Response.json(await repo.update(id, input), { headers });
        if (id && parts.length === 5 && parts[4] === 'archive')
          return Response.json(await repo.archive(id, input), { headers });
        if (id && parts.length === 5 && parts[4] === 'restore')
          return Response.json(await repo.restore(id, input), { headers });
      }
      return Response.json({ error: 'Página não encontrada.' }, { status: 404, headers });
    } catch (error) {
      if (error instanceof AccessError || error instanceof ConfigurationError)
        return Response.json(
          {
            error: error.message,
            ...(error instanceof ConfigurationError ? { fields: error.fields } : {}),
          },
          { status: error.status, headers },
        );
      if (error instanceof z.ZodError) {
        const fields: Record<string, string> = {};
        for (const issue of error.issues) {
          const key = String(issue.path[0] ?? 'form');
          if (!fields[key]) fields[key] = issue.message;
        }
        return Response.json(
          { error: 'Revise os campos informados.', fields },
          { status: 400, headers },
        );
      }
      if (error instanceof SyntaxError)
        return Response.json({ error: 'Verifique os dados informados.' }, { status: 400, headers });
      console.error('Não foi possível concluir a configuração.');
      return Response.json(
        { error: 'Não foi possível salvar. Tente novamente.' },
        { status: 500, headers },
      );
    }
  };
}
