import { randomBytes, randomUUID, createHmac } from 'node:crypto';
import { createDatabase } from '@apbackup/db';
import { bootstrapAdmin } from '../../../packages/security/src/administration.js';
import type { Page } from '@playwright/test';
export const consoleURL = 'http://127.0.0.1:4320';
export function disposableDatabase() {
  const url = process.env.TEST_DATABASE_URL;
  if (
    !url ||
    !['127.0.0.1', '[::1]'].includes(new URL(url).hostname) ||
    !/^apbackup_test_[a-f0-9]+$/.test(new URL(url).pathname.slice(1))
  )
    throw new Error('Disposable database required');
  return createDatabase(url);
}
export async function fixture(count = 0) {
  const db = disposableDatabase();
  const email = `browser-${randomUUID()}@example.test`;
  const password = randomBytes(24).toString('base64url');
  const account = await bootstrapAdmin(db, {
    email,
    password,
    name: 'Operador de teste',
    organizationName: 'Ambiente de validação',
  });
  for (let i = 1; i <= count; i++)
    await db.pool.query(
      'insert into servers(organization_id,name,external_identity,hostname) values($1,$2,$3,$4)',
      [
        account.organizationId,
        `Servidor ${String(i).padStart(2, '0')}`,
        `fixture-${i}`,
        `host-${i}.example.test`,
      ],
    );
  await db.close();
  return { ...account, email, password };
}
export async function login(page: Page, account: Awaited<ReturnType<typeof fixture>>) {
  await page.goto(`${consoleURL}/login`);
  await page.getByLabel('E-mail').fill(account.email);
  await page.getByLabel('Senha', { exact: true }).fill(account.password);
  const responsePromise = page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/api/auth/sign-in/email',
  );
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  const response = await responsePromise;
  if (!response.ok()) throw new Error(`Fixture sign-in failed: ${response.status()}`);
  await Promise.race([
    page.waitForURL((url) => url.pathname === '/'),
    page.getByRole('heading', { name: 'Verifique sua identidade' }).waitFor(),
  ]);
}
export function totp(secret: string) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bits = [...secret.toUpperCase()]
    .map((c) => alphabet.indexOf(c).toString(2).padStart(5, '0'))
    .join('');
  const bytes = Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const digest = createHmac('sha1', bytes).update(counter).digest();
  const offset = digest[digest.length - 1]! & 15;
  return ((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).toString().padStart(6, '0');
}
