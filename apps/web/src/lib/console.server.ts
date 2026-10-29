import { z } from 'zod';
import type { PlatformDatabase } from '@apbackup/db';
import type { PlatformAuth } from './auth.server.js';
import { createSessionService } from './session.server.js';
import { AccessError, authorize } from '../../../../packages/security/src/authorization.js';
import { listQuerySchema, type CatalogKind, type CatalogRow } from './listing.js';

// SQL identifiers/expressions below are exclusively programmer-owned. All user values are parameters.
const sources: Record<
  CatalogKind,
  { table: string; name: string; detail: string; status: string }
> = {
  servers: { table: 'servers', name: 'name', detail: 'external_identity', status: "'cadastrado'" },
  systems: {
    table: 'system_profiles',
    name: 'name',
    detail: 'external_identity',
    status: "'cadastrado'",
  },
  resources: {
    table: 'resources',
    name: 'name',
    detail: 'external_identity',
    status: 'kind::text',
  },
  destinations: {
    table: 'destinations',
    name: 'name',
    detail: "coalesce(host, '—')",
    status: 'status::text',
  },
  plans: {
    table: 'plans',
    name: 'name',
    detail: 'id::text',
    status: "case when enabled then 'habilitado' else 'desabilitado' end",
  },
  executions: {
    table: 'executions',
    name: 'id::text',
    detail: 'kind::text',
    status: 'status::text',
  },
  coverage: {
    table: 'recovery_points',
    name: 'id::text',
    detail: 'server_id::text',
    status: 'status::text',
  },
};
export function createConsoleApi(auth: PlatformAuth, db: PlatformDatabase) {
  const sessions = createSessionService(auth, db);
  return async (request: Request): Promise<Response> => {
    const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
    try {
      const principal = await sessions.requireSession(request);
      authorize(principal, 'read', { organizationId: principal.organizationId });
      if (request.method !== 'GET')
        return Response.json({ error: 'Ação não disponível.' }, { status: 405, headers });
      if (new URL(request.url).pathname === '/api/console/session') {
        const row = (
          await db.pool.query<{
            name: string;
            email: string;
            organization: string;
            mfaEnabled: boolean;
          }>(
            'select u.name,u.email,o.name as organization,u.two_factor_enabled as "mfaEnabled" from users u join organizations o on o.id=$2 where u.id=$1',
            [principal.userId, principal.organizationId],
          )
        ).rows[0];
        if (!row) throw new AccessError(403);
        let canConfigure = false;
        try {
          authorize(principal, 'configure', { organizationId: principal.organizationId });
          canConfigure = true;
        } catch {
          /* The read-only session remains available without a fresh configuration proof. */
        }
        return Response.json(
          {
            ...row,
            userId: principal.userId,
            organizationId: principal.organizationId,
            role: principal.role,
            canConfigure,
          },
          { headers },
        );
      }
      if (new URL(request.url).pathname !== '/api/console/catalog')
        return Response.json({ error: 'Página não encontrada.' }, { status: 404, headers });
      const q = listQuerySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
      const source = sources[q.kind];
      const sortColumn = {
        name: 'name collate apbackup_pt_numeric',
        detail: 'detail collate apbackup_pt_numeric',
        status: 'status collate apbackup_pt_numeric',
        createdAt: '"createdAt"',
      }[q.sort];
      const direction = q.direction === 'desc' ? 'desc' : 'asc';
      const escaped = q.search.replace(/[\\%_]/g, '\\$&');
      const client = await db.pool.connect();
      try {
        // Count and page use one consistent snapshot; concurrent deletes cannot invalidate the selected page.
        await client.query('begin isolation level repeatable read read only');
        const configurable = ['servers', 'systems', 'resources', 'destinations', 'plans'].includes(
          q.kind,
        );
        const status = configurable
          ? `case when archived_at is not null then 'arquivado' else ${source.status} end`
          : source.status;
        const archiveCondition = configurable
          ? ` and archived_at is ${q.status === 'arquivado' ? 'not ' : ''}null`
          : '';
        const base = `select id, ${source.name} as name, ${source.detail} as detail, ${status} as status, created_at as "createdAt" from ${source.table} where organization_id=$1${archiveCondition}`;
        const where = `where (name ilike $2 or detail ilike $2) and ($3='' or status=$3)`;
        const values = [principal.organizationId, `%${escaped}%`, q.status];
        const total = Number(
          (
            await client.query<{ total: string }>(
              `select count(*) as total from (${base}) c ${where}`,
              values,
            )
          ).rows[0]!.total,
        );
        const page = Math.min(q.page, Math.max(1, Math.ceil(total / q.pageSize)));
        const result = await client.query<CatalogRow>(
          `select * from (${base}) c ${where} order by ${q.direction === 'none' ? '"createdAt" desc' : `${sortColumn} ${direction}`} , id asc limit $4 offset $5`,
          [...values, q.pageSize, (page - 1) * q.pageSize],
        );
        await client.query('commit');
        return Response.json(
          { items: result.rows, total, page, pageSize: q.pageSize },
          { headers },
        );
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      if (error instanceof AccessError)
        return Response.json({ error: error.message }, { status: error.status, headers });
      if (error instanceof z.ZodError)
        return Response.json(
          { error: 'Verifique os filtros informados.' },
          { status: 400, headers },
        );
      console.error('Não foi possível consultar o catálogo.');
      return Response.json(
        { error: 'Não foi possível carregar os dados. Tente novamente.' },
        { status: 500, headers },
      );
    }
  };
}
