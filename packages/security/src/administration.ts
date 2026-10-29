import { randomUUID } from 'node:crypto';
import { hashPassword } from 'better-auth/crypto';
import { z } from 'zod';
import type { PlatformDatabase } from '@apbackup/db';
const credentials = z.object({
  email: z.email().transform((value) => value.trim().toLowerCase()),
  password: z.string().min(12).max(128),
});
export async function bootstrapAdmin(
  db: PlatformDatabase,
  input: z.input<typeof credentials> & { name: string; organizationName: string },
) {
  const value = credentials
    .extend({ name: z.string().trim().min(1), organizationName: z.string().trim().min(1) })
    .parse(input);
  const hash = await hashPassword(value.password);
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("select pg_advisory_xact_lock(hashtext('apbackup-bootstrap-admin'))");
    const existing = await client.query<{ user_id: string; organization_id: string }>(
      `select m.user_id,m.organization_id from users u join organization_memberships m on m.user_id=u.id where u.email=$1 and m.role='administrator' and m.revoked_at is null order by m.created_at limit 1`,
      [value.email],
    );
    if (existing.rows[0]) {
      await client.query('COMMIT');
      return {
        userId: existing.rows[0].user_id,
        organizationId: existing.rows[0].organization_id,
        created: false,
      };
    }
    if ((await client.query('select id from users where email=$1', [value.email])).rowCount)
      throw new Error('Existing identity requires explicit membership administration');
    const userId = randomUUID(),
      organizationId = randomUUID();
    await client.query('insert into users(id,name,email,email_verified) values($1,$2,$3,true)', [
      userId,
      value.name,
      value.email,
    ]);
    await client.query('insert into organizations(id,name) values($1,$2)', [
      organizationId,
      value.organizationName,
    ]);
    await client.query(
      "insert into organization_memberships(user_id,organization_id,role) values($1,$2,'administrator')",
      [userId, organizationId],
    );
    await client.query(
      "insert into auth_accounts(id,user_id,account_id,provider_id,password) values($1,$2,$4,'credential',$3)",
      [randomUUID(), userId, hash, userId],
    );
    await client.query(
      "insert into audit_events(organization_id,actor_id,action,subject_type,subject_id) values($1,$2,'auth.bootstrap','user',$2)",
      [organizationId, userId],
    );
    await client.query('COMMIT');
    return { userId, organizationId, created: true };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
export async function recoverAccess(
  db: PlatformDatabase,
  input: z.input<typeof credentials>,
): Promise<void> {
  const value = credentials.parse(input),
    hash = await hashPassword(value.password);
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const user = (
      await client.query<{ id: string }>('select id from users where email=$1 for update', [
        value.email,
      ])
    ).rows[0];
    if (!user) throw new Error('Identity not found');
    const credential = await client.query(
      "update auth_accounts set password=$1,updated_at=now() where user_id=$2 and provider_id='credential'",
      [hash, user.id],
    );
    if (credential.rowCount !== 1)
      throw new Error('Exactly one existing credential account is required for password recovery');
    await client.query('delete from auth_sessions where user_id=$1', [user.id]);
    await client.query('delete from auth_two_factors where user_id=$1', [user.id]);
    await client.query('update users set two_factor_enabled=false where id=$1', [user.id]);
    await client.query(
      "insert into audit_events(organization_id,actor_id,action,subject_type,subject_id) select organization_id,$1,'auth.local_recovery','user',$1 from organization_memberships where user_id=$1",
      [user.id],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
