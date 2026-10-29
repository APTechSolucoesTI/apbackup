import { createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import { createDatabase, migrate } from '@apbackup/db';
import { test, expect } from 'vitest';
import { createVault, encryptSecret, decryptSecret } from '../../packages/security/src/vault.js';
import { redact } from '../../packages/security/src/redaction.js';

test('authenticates secret tenant, purpose, reference and ciphertext', () => {
  const vault = createVault(randomBytes(32), 'local-test-key');
  const context = { organizationId: 'organization-a', reference: 'connection-a', purpose: 'sftp' };
  const encrypted = vault.encryptSecret('never-log-this-password', context);
  expect(JSON.stringify(encrypted)).not.toContain('never-log-this-password');
  expect(vault.decryptSecret(encrypted, context)).toBe('never-log-this-password');
  expect(() => vault.decryptSecret(encrypted, { ...context, organizationId: 'b' })).toThrow();
  expect(() => vault.decryptSecret(encrypted, { ...context, purpose: 'postgres' })).toThrow();
  expect(() => vault.decryptSecret({ ...encrypted, ciphertext: 'AAAA' }, context)).toThrow();
  expect(() => createVault(randomBytes(32), 'other').decryptSecret(encrypted, context)).toThrow();
});

test.each([4, 8, 12, 15])('rejects a shortened %i-byte GCM tag', (length) => {
  const vault = createVault(randomBytes(32), 'test-key');
  const context = { organizationId: 'a', reference: 'a', purpose: 'sftp' };
  const envelope = vault.encryptSecret('private', context);
  expect(Buffer.from(envelope.tag, 'base64')).toHaveLength(16);
  expect(() =>
    vault.decryptSecret(
      {
        ...envelope,
        tag: Buffer.from(envelope.tag, 'base64').subarray(0, length).toString('base64'),
      },
      context,
    ),
  ).toThrow();
});

test.each([8, 16])('rejects an otherwise authenticated envelope with a %i-byte IV', (length) => {
  const key = randomBytes(32);
  const context = { organizationId: 'a', reference: 'a', purpose: 'sftp' };
  const iv = randomBytes(length);
  // Independently construct an authentic GCM envelope outside the fixed IV contract.
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(JSON.stringify([1, 'test-key', 'a', 'a', 'sftp'])));
  const ciphertext = Buffer.concat([cipher.update('private', 'utf8'), cipher.final()]);
  expect(() =>
    createVault(key, 'test-key').decryptSecret(
      {
        version: 1,
        algorithm: 'aes-256-gcm',
        keyReference: 'test-key',
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        ciphertext: ciphertext.toString('base64'),
      },
      context,
    ),
  ).toThrow();
});

test('redacts nested credentials and credentials embedded in diagnostic messages', () => {
  const secret = 'sensitive-value-239';
  const output = redact({
    password: secret,
    nested: [{ Authorization: `Bearer ${secret}` }],
    message: `failed postgres://operator:${secret}@localhost/db?token=${secret}`,
    error: new Error(`Bearer ${secret}`),
  });
  expect(JSON.stringify(output)).not.toContain(secret);
  expect(JSON.stringify(output)).toContain('REDACTED');
});

test('public vault interface requires external custody key and rejects cross-reference context', () => {
  const context = { organizationId: 'a', reference: 'a', purpose: 'database' };
  const oldKey = process.env.VAULT_KEY_BASE64,
    oldReference = process.env.VAULT_KEY_REFERENCE;
  try {
    delete process.env.VAULT_KEY_BASE64;
    expect(() => encryptSecret('private', context)).toThrow();
    process.env.VAULT_KEY_BASE64 = randomBytes(32).toString('base64');
    process.env.VAULT_KEY_REFERENCE = 'external-test-key';
    const envelope = encryptSecret('private', context);
    expect(decryptSecret(envelope, context)).toBe('private');
    expect(() => decryptSecret(envelope, { ...context, reference: 'b' })).toThrow();
    expect(encryptSecret('private', context).ciphertext).not.toBe(envelope.ciphertext);
  } finally {
    if (oldKey === undefined) delete process.env.VAULT_KEY_BASE64;
    else process.env.VAULT_KEY_BASE64 = oldKey;
    if (oldReference === undefined) delete process.env.VAULT_KEY_REFERENCE;
    else process.env.VAULT_KEY_REFERENCE = oldReference;
  }
});
test('redacts PEM, JWT and colon-delimited token diagnostics', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.dGVzdHNpZ25hdHVyZQ';
  const output = JSON.stringify(
    redact({
      message: `token: sensitive-other-value ${jwt}`,
      certificate: '-----BEGIN PRIVATE KEY-----\nsensitive-key-material\n-----END PRIVATE KEY-----',
    }),
  );
  expect(output).not.toContain('sensitive-other-value');
  expect(output).not.toContain(jwt);
  expect(output).not.toContain('sensitive-key-material');
});
test('persists only authenticated ciphertext and recovers it across database connections', async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (
    !url ||
    new URL(url).hostname !== '127.0.0.1' ||
    !/^apbackup_test_[a-f0-9]+$/.test(new URL(url).pathname.slice(1))
  )
    throw new Error('Disposable loopback database required');
  const db = createDatabase(url),
    organizationId = randomUUID(),
    reference = randomUUID();
  const vault = createVault(randomBytes(32), 'offline-custody');
  const context = { organizationId, reference, purpose: 'postgresql' };
  const plaintext = randomBytes(40).toString('base64url');
  const envelope = vault.encryptSecret(plaintext, context);
  try {
    await migrate(db);
    await db.pool.query('insert into organizations(id,name) values($1,$2)', [
      organizationId,
      'Ciphertext persistence',
    ]);
    await db.pool.query(
      'insert into secret_references(id,organization_id,name,ciphertext,key_reference) values($1,$2,$3,$4,$5)',
      [
        reference,
        organizationId,
        'private-reference',
        JSON.stringify(envelope),
        envelope.keyReference,
      ],
    );
    const reopened = createDatabase(url);
    try {
      const row = (
        await reopened.pool.query<{ ciphertext: string }>(
          'select ciphertext from secret_references where id=$1 and organization_id=$2',
          [reference, organizationId],
        )
      ).rows[0]!;
      expect(row.ciphertext).not.toContain(plaintext);
      expect(vault.decryptSecret(JSON.parse(row.ciphertext) as typeof envelope, context)).toBe(
        plaintext,
      );
      expect(() =>
        vault.decryptSecret(JSON.parse(row.ciphertext) as typeof envelope, {
          ...context,
          organizationId: randomUUID(),
        }),
      ).toThrow();
    } finally {
      await reopened.close();
    }
  } finally {
    await db.pool.query('delete from secret_references where id=$1', [reference]);
    await db.pool.query('delete from organizations where id=$1', [organizationId]);
    await db.close();
  }
});
