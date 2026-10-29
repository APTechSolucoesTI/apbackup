import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { PlatformDatabase } from '@apbackup/db';
import { runtimeTransaction } from '../../../packages/db/src/repositories/jobs.js';
const digest = (v: string) => createHash('sha256').update(v).digest('hex');
export function createAgentRegistry(db: PlatformDatabase) {
  return {
    async invite(organizationId: string, serverId: string, expiresAt: Date) {
      if (+expiresAt <= Date.now() || +expiresAt > Date.now() + 86400000)
        throw new Error('Invalid enrollment expiry');
      const value = randomBytes(32).toString('base64url');
      await db.pool.query(
        'insert into agent_enrollments(digest,organization_id,server_id,expires_at) values($1,$2,$3,$4)',
        [digest(value), organizationId, serverId, expiresAt],
      );
      return value;
    },
    async enroll(value: string, externalIdentity: string) {
      if (!/^[a-zA-Z0-9:_.-]{1,128}$/.test(externalIdentity))
        throw new Error('Invalid agent identity');
      return runtimeTransaction(db, async (c) => {
        const row = (
          await c.query<{ organization_id: string; server_id: string }>(
            'update agent_enrollments set used_at=now() where digest=$1 and used_at is null and expires_at>now() returning organization_id,server_id',
            [digest(value)],
          )
        ).rows[0];
        if (!row) throw new Error('Enrollment refused');
        const identity = randomBytes(32).toString('base64url'),
          agentId = randomUUID();
        await c.query(
          "insert into agents(id,organization_id,server_id,external_identity,public_key,identity_digest) values($1,$2,$3,$4,'bearer-sha256-v1',$5)",
          [agentId, row.organization_id, row.server_id, externalIdentity, digest(identity)],
        );
        return { agentId, organizationId: row.organization_id, identity };
      });
    },
    async authenticate(identity: string) {
      if (!/^[a-zA-Z0-9_-]{43}$/.test(identity)) throw new Error('Agent refused');
      const agent = (
        await db.pool.query<{ id: string; organization_id: string; server_id: string }>(
          'update agents set last_heartbeat_at=now() where identity_digest=$1 and revoked_at is null returning id,organization_id,server_id',
          [digest(identity)],
        )
      ).rows[0];
      if (!agent) throw new Error('Agent refused');
      return agent;
    },
    async revoke(organizationId: string, id: string) {
      await db.pool.query('update agents set revoked_at=now() where organization_id=$1 and id=$2', [
        organizationId,
        id,
      ]);
    },
  };
}
