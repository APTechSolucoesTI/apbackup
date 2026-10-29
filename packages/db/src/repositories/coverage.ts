import { z } from 'zod';
import {
  manifestSchema,
  profileVersionSchema,
  coverageSummarySchema,
  canonicalJson,
} from '@apbackup/contracts';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ConfigurationError, type RepositoryContext } from './shared.js';
const pointSchema = z.object({
  id: z.uuid(),
  serverId: z.uuid(),
  body: z.unknown(),
  sha256: z.string(),
  definition: z.unknown(),
  capturedAt: z.coerce.date(),
  components: z.array(
    z.object({
      resourceId: z.uuid(),
      componentKey: z.string(),
      artifactPath: z.string(),
      sha256: z.string(),
      sizeBytes: z.string(),
    }),
  ),
  destinations: z.array(
    z.object({ repositoryId: z.uuid(), verifiedAt: z.coerce.date(), scope: z.string() }),
  ),
});
export async function verifiedPoints(
  ctx: RepositoryContext,
  filters: { serverId?: string; repositoryId?: string } = {},
  client: PoolClient | typeof ctx.db.pool = ctx.db.pool,
) {
  const rows = (
    await client.query(
      `select p.id,p.server_id as "serverId",p.captured_at as "capturedAt",m.body,m.sha256,v.definition,
 coalesce((select jsonb_agg(jsonb_build_object('resourceId',c.resource_id,'componentKey',c.component_key,'artifactPath',c.artifact_path,'sha256',c.sha256,'sizeBytes',c.size_bytes::text)) from components c where c.organization_id=p.organization_id and c.recovery_point_id=p.id),'[]'::jsonb) as components,
 coalesce((select jsonb_agg(jsonb_build_object('repositoryId',d.repository_id,'verifiedAt',d.verified_at,'scope',d.verification_scope)) from destination_results d where d.organization_id=p.organization_id and d.recovery_point_id=p.id and d.status='concluida' and d.removed_at is null and not d.retention_pending and d.verified_at is not null and nullif(trim(d.verification_scope),'') is not null),'[]'::jsonb) as destinations
 from recovery_points p join manifests m on m.organization_id=p.organization_id and m.recovery_point_id=p.id join profile_versions v on v.organization_id=p.organization_id and v.id=p.profile_version_id
 where p.organization_id=$1 and p.status='complete' and (p.protected_until is null or p.protected_until>now()) and ($2::uuid is null or p.server_id=$2) order by p.captured_at desc,p.id`,
      [ctx.organizationId, filters.serverId ?? null],
    )
  ).rows;
  const valid: { id: string; resourceIds: string[]; verifiedAt: Date }[] = [];
  for (const raw of rows) {
    const point = pointSchema.safeParse(raw);
    if (!point.success) continue;
    const manifest = manifestSchema.safeParse(point.data.body),
      profile = profileVersionSchema.safeParse(point.data.definition);
    if (!manifest.success || !profile.success) continue;
    if (
      createHash('sha256').update(canonicalJson(manifest.data)).digest('hex') !== point.data.sha256
    )
      continue;
    const m = manifest.data,
      p = profile.data;
    if (
      m.organizationId !== ctx.organizationId ||
      m.serverId !== point.data.serverId ||
      m.profileId !== p.profileId ||
      m.profileVersion !== p.version ||
      canonicalJson(m.adapter) !== canonicalJson(p.adapter) ||
      m.consistency !== p.consistency ||
      m.components.some(
        (component) =>
          !p.resources.some((resource) => resource.resourceId === component.resourceId),
      ) ||
      new Date(m.capturedAt).getTime() !== point.data.capturedAt.getTime()
    )
      continue;
    const evidence = point.data.destinations.filter(
      (d) => !filters.repositoryId || d.repositoryId === filters.repositoryId,
    );
    if (!evidence.length) continue;
    if (
      m.components.some(
        (component) =>
          !point.data.components.some(
            (actual) =>
              actual.componentKey === component.id &&
              actual.resourceId === component.resourceId &&
              actual.artifactPath === component.artifactPath &&
              actual.sha256 === component.sha256 &&
              actual.sizeBytes === String(component.sizeBytes),
          ),
      )
    )
      continue;
    if (
      p.resources
        .filter((r) => r.required)
        .some(
          (resource) =>
            !m.components.some(
              (component) =>
                component.resourceId === resource.resourceId &&
                m.requiredComponentIds.includes(component.id),
            ),
        )
    )
      continue;
    valid.push({
      id: point.data.id,
      resourceIds: [...new Set(m.components.map((component) => component.resourceId))],
      verifiedAt: new Date(Math.max(...evidence.map((d) => d.verifiedAt.getTime()))),
    });
  }
  return valid;
}
export function createCoverageRepository(ctx: RepositoryContext) {
  return {
    async getCoverage(serverId: string, organizationId: string) {
      if (organizationId !== ctx.organizationId)
        throw new ConfigurationError(403, 'Acesso não autorizado.');
      if (
        !(
          await ctx.db.pool.query('select id from servers where organization_id=$1 and id=$2', [
            ctx.organizationId,
            serverId,
          ])
        ).rowCount
      )
        throw new ConfigurationError(404, 'Servidor não encontrado.');
      const resources = (
        await ctx.db.pool.query<{ id: string }>(
          'select id from resources where organization_id=$1 and server_id=$2 and archived_at is null',
          [ctx.organizationId, serverId],
        )
      ).rows;
      const points = await verifiedPoints(ctx, { serverId }),
        covered = new Set(points.flatMap((p) => p.resourceIds));
      const protectedCount = resources.filter((r) => covered.has(r.id)).length;
      return coverageSummarySchema.parse({
        serverId,
        covered: resources.length > 0 && protectedCount === resources.length,
        resourceCount: resources.length,
        protectedResourceCount: protectedCount,
        verifiedPointCount: points.length,
        latestVerifiedAt: points.length
          ? new Date(Math.max(...points.map((p) => p.verifiedAt.getTime())))
          : null,
      });
    },
  };
}
