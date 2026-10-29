import { createHash } from 'node:crypto';
import type { PlatformDatabase } from '@apbackup/db';
// Callers must supply a subject established at their authentication boundary.
// Atomic PostgreSQL buckets enforce the same budget across server processes.
export async function consumeRateLimit(
  db: PlatformDatabase,
  subject: string,
  max: number,
): Promise<boolean> {
  const key = createHash('sha256').update(subject).digest('hex');
  const now = Date.now();
  const row = (
    await db.pool.query<{ count: number }>(
      `insert into auth_rate_limits(key,count,last_request) values($1,1,$2) on conflict(key) do update set count=case when auth_rate_limits.last_request<$3 then 1 else auth_rate_limits.count+1 end,last_request=case when auth_rate_limits.last_request<$3 then $2 else auth_rate_limits.last_request end returning count`,
      [key, now, now - 60000],
    )
  ).rows[0];
  return Boolean(row && row.count <= max);
}
