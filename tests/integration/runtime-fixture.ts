import { randomUUID } from 'node:crypto';
import { createDatabase, migrate } from '@apbackup/db';
export async function runtimeFixture() {
  const url = process.env.TEST_DATABASE_URL;
  if (
    !url ||
    new URL(url).hostname !== '127.0.0.1' ||
    !/^apbackup_test_[a-f0-9]+$/.test(new URL(url).pathname.slice(1))
  )
    throw new Error('Disposable PostgreSQL required');
  const db = createDatabase(url);
  await migrate(db);
  const org = randomUUID(),
    server = randomUUID(),
    resource = randomUUID(),
    profile = randomUUID(),
    version = randomUUID(),
    plan = randomUUID();
  await db.pool.query('insert into organizations(id,name) values($1,$2)', [org, org]);
  await db.pool.query(
    'insert into servers(id,organization_id,name,external_identity) values($1::uuid,$2,$1::text,$1::text)',
    [server, org],
  );
  await db.pool.query(
    "insert into resources(id,organization_id,server_id,kind,name,external_identity) values($1::uuid,$2,$3,'files',$1::text,$1::text)",
    [resource, org, server],
  );
  await db.pool.query(
    'insert into system_profiles(id,organization_id,server_id,name,external_identity) values($1::uuid,$2,$3,$1::text,$1::text)',
    [profile, org, server],
  );
  await db.pool.query(
    'insert into profile_versions(id,organization_id,profile_id,version,definition) values($1,$2,$3,1,$4)',
    [
      version,
      org,
      profile,
      JSON.stringify({
        profileId: profile,
        version: 1,
        adapter: { name: 'files', version: '1.0.0' },
        consistency: 'file_consistent',
        resources: [{ resourceId: resource, required: true }],
        dependencies: [],
        restoreCapabilities: ['files'],
      }),
    ],
  );
  await db.pool.query(
    'insert into profile_resources(organization_id,profile_version_id,resource_id) values($1,$2,$3)',
    [org, version, resource],
  );
  await db.pool.query(
    'insert into plans(id,organization_id,server_id,profile_version_id,name,enabled) values($1::uuid,$2,$3,$4,$1::text,true)',
    [plan, org, server, version],
  );
  await db.pool.query(
    "insert into schedules(organization_id,plan_id,enabled,last_scheduled_at) values($1,$2,false,'2026-10-20T06:00Z')",
    [org, plan],
  );
  return { db, org, server, resource, profile, version, plan };
}
