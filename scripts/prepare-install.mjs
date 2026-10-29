import { randomBytes } from 'node:crypto';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
if (process.platform === 'win32')
  throw new Error(
    'Prepare a instalação de produção no Linux. No desenvolvimento, use .env.example.',
  );
if (args.length !== 4 || args[0] !== '--origin' || args[2] !== '--output')
  throw new Error('Use --origin https://backup.example.com --output .env.production');
const origin = new URL(args[1]);
if (
  origin.protocol !== 'https:' ||
  origin.username ||
  origin.password ||
  origin.pathname !== '/' ||
  origin.search ||
  origin.hash
)
  throw new Error('Informe somente a origem HTTPS pública do painel.');
const password = randomBytes(32).toString('hex');
const values = {
  POSTGRES_PASSWORD: password,
  CATALOG_DATABASE_URL: `postgresql://apbackup:${password}@postgres:5432/apbackup`,
  ADMIN_DATABASE_URL: `postgresql://apbackup:${password}@127.0.0.1:5432/apbackup`,
  AUTH_BASE_URL: origin.origin,
  AUTH_SECRET: randomBytes(48).toString('base64url'),
  VAULT_KEY_BASE64: randomBytes(32).toString('base64'),
  VAULT_KEY_REFERENCE: 'primary-v1',
  WEB_PORT: '4320',
  POSTGRES_ALLOWED_HOSTS: '',
  DOKPLOY_ALLOWED_ORIGINS: '',
  COORDINATOR_SCHEDULES: 'disabled',
};
const path = resolve(args[3]);
// Never replace an existing installation or rotate the keys of an existing catalog.
const file = await open(path, 'wx', 0o600);
try {
  await file.writeFile(
    Object.entries(values)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(''),
  );
  await file.sync();
} finally {
  await file.close();
}
console.log(
  `Configuração privada criada em ${path}. Guarde uma cópia cifrada fora do servidor antes de usar. Nenhum serviço foi iniciado.`,
);
