import { spawnSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, sep } from 'node:path';
import { createServer } from 'node:net';
import { createServer as createHttpsServer, request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';

const project = `apbackup-shipping-${randomUUID().slice(0, 8)}`;
const temporary = await mkdtemp(resolve(tmpdir(), 'apbackup-shipping-'));
const envFile = resolve(temporary, 'environment');
const password = randomBytes(24).toString('hex'),
  auth = randomBytes(32).toString('hex'),
  vault = randomBytes(32).toString('base64');
const administratorPassword = randomBytes(24).toString('base64url');
const sensitive = [password, auth, vault, administratorPassword];
const redact = (value) =>
  sensitive.reduce((text, secret) => text.replaceAll(secret, '[private]'), String(value));
const listener = createServer();
await new Promise((ready, reject) => {
  listener.once('error', reject);
  listener.listen(0, '127.0.0.1', ready);
});
const address = listener.address();
if (!address || typeof address === 'string')
  throw new Error('Unable to allocate a disposable port');
const port = address.port;
await new Promise((done, reject) => listener.close((error) => (error ? reject(error) : done())));
const pem = docker([
  'run',
  '--rm',
  'postgres:17-bookworm@sha256:839fbb5a4942a7758dd93e18b42ea5649807491a0545b5eeeb8f0b8bb11857a5',
  'bash',
  '-c',
  'openssl req -x509 -newkey rsa:2048 -nodes -keyout /tmp/key -out /tmp/cert -days 1 -subj /CN=localhost -addext subjectAltName=IP:127.0.0.1 2>/dev/null && cat /tmp/key /tmp/cert',
]);
const key = pem.match(/-----BEGIN PRIVATE KEY-----[\s\S]+?-----END PRIVATE KEY-----/)?.[0];
const certificate = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/)?.[0];
if (!key || !certificate) throw new Error('Disposable TLS identity was not generated');
const proxy = createHttpsServer({ key, cert: certificate }, (request, response) => {
  const upstream = httpRequest(
    {
      host: '127.0.0.1',
      port,
      path: request.url,
      method: request.method,
      headers: { ...request.headers, 'x-forwarded-proto': 'https' },
    },
    (backend) => {
      response.writeHead(backend.statusCode ?? 502, backend.headers);
      backend.pipe(response);
    },
  );
  upstream.on('error', () => {
    response.writeHead(502);
    response.end();
  });
  request.pipe(upstream);
});
await new Promise((ready, reject) => {
  proxy.once('error', reject);
  proxy.listen(0, '127.0.0.1', ready);
});
const proxyAddress = proxy.address();
if (!proxyAddress || typeof proxyAddress === 'string')
  throw new Error('Disposable TLS proxy did not start');
const origin = `https://127.0.0.1:${proxyAddress.port}`;
function request(path, options = {}) {
  return new Promise((ready, reject) => {
    const outgoing = httpsRequest(origin + path, { ...options, ca: certificate }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () =>
        ready({
          ok: response.statusCode >= 200 && response.statusCode < 300,
          status: response.statusCode,
          headers: response.headers,
          json: () => JSON.parse(Buffer.concat(chunks).toString('utf8')),
        }),
      );
    });
    outgoing.on('error', reject);
    outgoing.end(options.body);
  });
}
await writeFile(
  envFile,
  Object.entries({
    POSTGRES_PASSWORD: password,
    CATALOG_DATABASE_URL: `postgresql://apbackup:${password}@postgres:5432/apbackup`,
    ADMIN_DATABASE_URL: `postgresql://apbackup:${password}@127.0.0.1:5432/apbackup`,
    AUTH_BASE_URL: origin,
    AUTH_SECRET: auth,
    VAULT_KEY_BASE64: vault,
    WEB_PORT: String(port),
    APBACKUP_CONTROLLER_IMAGE:
      process.env.APBACKUP_CONTROLLER_IMAGE ?? 'apbackup-controller:validation',
  })
    .map(([key, value]) => `${key}=${value}\n`)
    .join(''),
  { mode: 0o600 },
);
const prefix = [
  'compose',
  '--project-name',
  project,
  '--env-file',
  envFile,
  '-f',
  resolve('deploy/compose.yaml'),
];
function docker(args, input) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    ...(input === undefined ? {} : { input }),
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw new Error(
      redact(`Docker ${args[0]} failed: ${result.stderr ?? result.error?.message ?? ''}`),
    );
  return result.stdout.trim();
}
function compose(args, input) {
  return docker([...prefix, ...args], input);
}
let attempted = false;
try {
  compose(['config', '--quiet']);
  attempted = true;
  console.log(
    'Starting a new, isolated installation (private catalog, migrations, console, coordinator).',
  );
  compose(['up', '--no-build', '-d', 'postgres', 'migrate', 'web', 'coordinator']);
  let ready = false;
  for (let attempt = 0; attempt < 90; attempt++) {
    try {
      const response = await request('/login');
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      /* Starting. */
    }
    await new Promise((done) => setTimeout(done, 500));
  }
  if (!ready) throw new Error('The installed console did not start');
  const email = `shipping-${randomUUID()}@example.test`;
  compose(
    ['run', '--rm', '--no-deps', '-T', 'administrator'],
    JSON.stringify({ email, password: administratorPassword }),
  );
  const login = await request('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ email, password: administratorPassword }),
  });
  if (!login.ok) throw new Error(`Installed login failed: ${login.status}`);
  const cookie = (login.headers['set-cookie'] ?? []).map((value) => value.split(';')[0]).join('; ');
  const catalog = await request('/api/console/catalog?kind=servers', { headers: { cookie } });
  if (!catalog.ok || catalog.json().total !== 0)
    throw new Error('Authenticated empty catalog failed');
  const coordinator = compose(['ps', '-q', 'coordinator']);
  if (docker(['inspect', '--format', '{{.State.Running}}', coordinator]) !== 'true')
    throw new Error('Installed coordinator exited');
  for (const name of ['web', 'coordinator']) {
    const mounts = JSON.parse(
      docker(['inspect', '--format', '{{json .Mounts}}', compose(['ps', '-q', name])]),
    );
    if (mounts.some((mount) => mount.Destination === '/var/run/docker.sock'))
      throw new Error('Controller received a Docker socket');
  }
  const migrations = Number(
    compose([
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      'apbackup',
      '-d',
      'apbackup',
      '-Atc',
      'select count(*) from platform_migrations',
    ]),
  );
  if (migrations < 13) throw new Error('Installed migrations are incomplete');
  const dump = spawnSync(
    'docker',
    [...prefix, 'exec', '-T', 'postgres', 'pg_dump', '-U', 'apbackup', '-d', 'apbackup', '-Fc'],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  if (dump.status !== 0) throw new Error('Disposable catalog export failed');
  compose(['exec', '-T', 'postgres', 'createdb', '-U', 'apbackup', 'apbackup_recovery']);
  compose(
    [
      'exec',
      '-T',
      'postgres',
      'pg_restore',
      '-U',
      'apbackup',
      '-d',
      'apbackup_recovery',
      '--no-owner',
    ],
    dump.stdout,
  );
  const recovered = compose([
    'exec',
    '-T',
    'postgres',
    'psql',
    '-U',
    'apbackup',
    '-d',
    'apbackup_recovery',
    '-Atc',
    'select count(*) from platform_migrations; select count(*) from users;',
  ]);
  if (recovered !== `${migrations}\n1`)
    throw new Error('Recovered catalog did not preserve migrations and administrator');
  console.log(
    JSON.stringify({
      migrations,
      bootstrap: true,
      login: true,
      authenticatedCatalog: true,
      coordinator: true,
      panelWithoutDockerSocket: true,
      catalogExportAndRestore: true,
    }),
  );
} catch (error) {
  if (attempted) {
    try {
      console.error(
        redact(compose(['logs', '--no-color', '--tail', '35', 'web', 'coordinator', 'migrate'])),
      );
    } catch {
      /* Keep the first error. */
    }
  }
  throw error;
} finally {
  await new Promise((done) => proxy.close(done));
  // Only the unique project created above can be removed. No user containers are targeted.
  if (attempted) compose(['down', '--volumes', '--remove-orphans']);
  await cleanupTestDirectory();
}
async function cleanupTestDirectory() {
  const target = resolve(temporary),
    base = resolve(tmpdir()) + sep;
  if (!target.startsWith(base + 'apbackup-shipping-'))
    throw new Error('Refusing an unrelated cleanup path');
  await rm(target, { recursive: true });
}
