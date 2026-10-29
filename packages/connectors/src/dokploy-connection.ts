import type { PlatformDatabase } from '@apbackup/db';
import { dokployConnectionSchema } from '@apbackup/contracts';
import { readSecret } from './postgresql-connection.js';
import { dokployClient } from './dokploy-client.js';
export async function readDokployClient(
  db: PlatformDatabase,
  organizationId: string,
  id: string,
  signal?: AbortSignal,
) {
  const row = (
    await db.pool.query<{ configuration: unknown; server_id: string; secret_reference_id: string }>(
      "select configuration,server_id,secret_reference_id from connections where organization_id=$1 and id=$2 and kind='dokploy'",
      [organizationId, id],
    )
  ).rows[0];
  if (!row) return null;
  const configuration = dokployConnectionSchema.parse({
    ...(row.configuration as object),
    id,
    serverId: row.server_id,
  });
  return dokployClient(
    configuration.endpoint,
    await readSecret(db, organizationId, row.secret_reference_id, 'dokploy-connection'),
    signal,
  );
}
/** Durable read-only reconciliation. A lost mutation response never causes another mutation. */
export async function reconcileDokployNative(db: PlatformDatabase, signal?: AbortSignal) {
  const rows = (
    await db.pool.query<{
      id: string;
      organization_id: string;
      connection_id: string;
      provider_context: { destinationId: string; search: string; serverId?: string | null };
      baseline: { Path: string; Size: number }[];
      created_at: Date;
    }>(
      "select id,organization_id,connection_id,provider_context,baseline,created_at from dokploy_native_runs where status in('requested','accepted','unknown') and (checked_at is null or checked_at<now()-interval '15 seconds') order by checked_at nulls first,created_at limit 10",
    )
  ).rows;
  for (const row of rows) {
    if (signal?.aborted) return;
    try {
      const client = await readDokployClient(db, row.organization_id, row.connection_id, signal);
      if (!client) throw new Error('Connection unavailable');
      const p = row.provider_context,
        files = await client.files(p.destinationId, p.search, p.serverId),
        newFiles = files.filter(
          (f) =>
            !f.IsDir &&
            f.Size > 0 &&
            f.Path.startsWith(p.search) &&
            !row.baseline.some((b) => b.Path === f.Path),
        );
      await db.pool.query(
        "update dokploy_native_runs set status=case when $3='accepted' and status='unknown' then 'unknown' else $3 end,artifacts=$4,checked_at=now() where organization_id=$1 and id=$2 and status in('requested','accepted','unknown')",
        [
          row.organization_id,
          row.id,
          newFiles.length
            ? 'artifact_observed'
            : Date.now() - row.created_at.getTime() > 900000
              ? 'unknown'
              : 'accepted',
          JSON.stringify(newFiles.map((f) => ({ path: f.Path, sizeBytes: String(f.Size) }))),
        ],
      );
    } catch {
      await db.pool.query(
        "update dokploy_native_runs set checked_at=now(),status=case when created_at<now()-interval '15 minutes' then 'unknown' else status end where organization_id=$1 and id=$2 and status in('requested','accepted','unknown')",
        [row.organization_id, row.id],
      );
    }
  }
}
