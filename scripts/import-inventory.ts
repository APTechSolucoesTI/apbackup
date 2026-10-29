import { z } from 'zod';
import { serverInputSchema, serverReadSchema, destinationReadSchema } from '@apbackup/contracts';
const inputSchema = z.strictObject({
  baseURL: z.url().refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === 'http:' &&
      ['127.0.0.1', '[::1]'].includes(url.hostname) &&
      !url.username &&
      !url.password &&
      url.pathname === '/'
    );
  }, 'Use the explicit loopback console origin'),
  organizationId: z.uuid(),
  email: z.email(),
  password: z.string().min(12).max(128),
  code: z.string().regex(/^\d{6}$/),
  server: serverInputSchema,
  destination: z.strictObject({
    name: z.string().trim().min(1).max(200),
    host: z.string().regex(/^[a-zA-Z0-9.-]+$/),
  }),
});
const listSchema = z.object({
  items: z.array(z.object({ id: z.uuid(), name: z.string(), detail: z.string() })),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
});
async function importInventory(raw: unknown) {
  const value = inputSchema.parse(raw),
    origin = new URL(value.baseURL).origin,
    jar = new Map<string, string>();
  async function request(path: string, body?: unknown) {
    const response = await fetch(`${origin}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        origin,
        'content-type': 'application/json',
        cookie: [...jar].map(([key, v]) => `${key}=${v}`).join('; '),
        'x-organization-id': value.organizationId,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15000),
    });
    for (const cookie of response.headers.getSetCookie()) {
      const first = cookie.split(';')[0]!,
        index = first.indexOf('=');
      const key = first.slice(0, index),
        content = first.slice(index + 1);
      if (content) jar.set(key, content);
      else jar.delete(key);
    }
    return response;
  }
  async function exact(
    kind: 'servers' | 'destinations',
    search: string,
    name: string,
    detail: string,
  ) {
    let page = 1;
    for (;;) {
      const response = await request(
        `/api/console/catalog?${new URLSearchParams({ kind, search, page: String(page), pageSize: '100' })}`,
      );
      if (!response.ok) throw new Error('Não foi possível consultar o inventário autorizado.');
      const list = listSchema.parse(await response.json());
      const found = list.items.find((item) => item.name === name && item.detail === detail);
      if (found) return found.id;
      if (page * list.pageSize >= list.total) return null;
      page++;
    }
  }
  try {
    const login = await request('/api/auth/sign-in/email', {
      email: value.email,
      password: value.password,
    });
    if (!login.ok) throw new Error('Não foi possível autenticar o operador.');
    const loginBody = z
      .object({ twoFactorRedirect: z.boolean().optional() })
      .parse(await login.json());
    if (!loginBody.twoFactorRedirect)
      throw new Error('Configure e verifique MFA antes de importar o inventário.');
    if (!(await request('/api/auth/two-factor/verify-totp', { code: value.code })).ok)
      throw new Error('Segundo fator inválido ou limite de tentativas atingido.');
    if (!(await request('/api/reauthenticate', { password: value.password, code: value.code })).ok)
      throw new Error('Confirme sua senha e segundo fator para configurar.');
    let serverId: string;
    const createdServer = await request('/api/configuration/servers', value.server);
    if (createdServer.ok) serverId = serverReadSchema.parse(await createdServer.json()).id;
    else if (createdServer.status === 409) {
      const found = await exact(
        'servers',
        value.server.externalIdentity,
        value.server.name,
        value.server.externalIdentity,
      );
      if (!found)
        throw new Error(
          'A identificação da origem já existe com outra configuração. Revise o cadastro.',
        );
      serverId = found;
    } else throw new Error('Não foi possível cadastrar a origem.');
    let destinationId: string;
    const createdDestination = await request('/api/configuration/destinations', {
      ...value.destination,
      kind: null,
      engine: null,
      rootPath: null,
      status: 'aguardando_configuracao',
    });
    if (createdDestination.ok)
      destinationId = destinationReadSchema.parse(await createdDestination.json()).id;
    else if (createdDestination.status === 409) {
      const found = await exact(
        'destinations',
        value.destination.name,
        value.destination.name,
        value.destination.host,
      );
      if (!found)
        throw new Error('O nome do destino já existe com outra configuração. Revise o cadastro.');
      destinationId = found;
    } else
      throw new Error(
        'A origem foi cadastrada; não foi possível cadastrar o destino. A repetição preserva os cadastros existentes.',
      );
    const destination = await request(`/api/configuration/destinations/${destinationId}`);
    if (!destination.ok) throw new Error('Não foi possível confirmar o destino importado.');
    return {
      serverId,
      destinationId,
      destinationStatus: destinationReadSchema.parse(await destination.json()).status,
    };
  } finally {
    if (jar.size) await request('/api/auth/sign-out', {}).catch(() => undefined);
  }
}
if (!process.argv.includes('--stdin'))
  throw new Error('Use inventory:import e forneça a configuração pela entrada padrão.');
try {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk as Uint8Array);
    bytes += buffer.length;
    if (bytes > 65536) throw new Error('Configuração excedeu o limite.');
    chunks.push(buffer);
  }
  const result = await importInventory(
    JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
  );
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(
    error instanceof z.ZodError
      ? 'Revise os campos de configuração e a origem local informada.'
      : error instanceof Error && !(error instanceof SyntaxError)
        ? error.message
        : 'Não foi possível importar. Confira os dados e tente novamente.',
  );
  process.exitCode = 1;
}
