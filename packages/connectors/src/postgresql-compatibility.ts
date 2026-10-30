/** A logical dump cannot move cluster-bound extensions into an arbitrary new database. */
export function requiresCompatibleSupabaseCluster(tableOfContents: string): boolean {
  return /^\d+;\s+\d+\s+\d+\s+EXTENSION\s+-\s+(?:pg_cron|supabase_vault)\b/m.test(tableOfContents);
}
