import type pg from 'pg';
import { postgresSchemaNameSchema } from '@apbackup/contracts';

/** Catalog dependencies are conservative. Function-body dynamic SQL is not inferable from pg_depend. */
export async function discoverPostgresSchemas(client: pg.Client) {
  const result = await client.query<{ name: string }>(
    "select nspname as name from pg_namespace where has_schema_privilege(current_user,oid,'USAGE') and nspname not like 'pg_%' and nspname <> 'information_schema' order by nspname",
  );
  return result.rows.map((r) => ({
    name: r.name,
    selectable: postgresSchemaNameSchema.safeParse(r.name).success,
  }));
}
export async function inspectPostgresSchemaScope(client: pg.Client, schemas: readonly string[]) {
  if (!schemas.length) return { isolated: true, dependencies: [] as string[] };
  const available = await discoverPostgresSchemas(client);
  if (schemas.some((s) => !available.some((a) => a.name === s && a.selectable)))
    throw new Error('Schema unavailable');
  const result = await client.query<{ dependency: string }>(
    `
    select distinct left(format('%s → %s', a.identity,b.identity),500) dependency
    from pg_depend d
    cross join lateral pg_identify_object(d.classid,d.objid,d.objsubid) a
    cross join lateral pg_identify_object(d.refclassid,d.refobjid,d.refobjsubid) b
    where a.schema=any($1::text[]) and (
      (b.schema is not null and b.schema<>'pg_catalog' and not b.schema=any($1::text[]))
      or d.refclassid='pg_extension'::regclass)
    union
    select distinct left(format('policy %I.%I requires role %s',n.nspname,p.polname,r::regrole),500)
    from pg_policy p join pg_class c on c.oid=p.polrelid join pg_namespace n on n.oid=c.relnamespace
    cross join lateral unnest(p.polroles) r
    where n.nspname=any($1::text[]) and r<>0
    limit 101`,
    [schemas],
  );
  return { isolated: result.rows.length === 0, dependencies: result.rows.map((r) => r.dependency) };
}
