import { z } from 'zod';
export const sessionSchema = z.object({
  userId: z.uuid(),
  organizationId: z.uuid(),
  name: z.string(),
  email: z.email(),
  organization: z.string(),
  role: z.enum(['administrator', 'backup_operator', 'restore_operator', 'viewer']),
  mfaEnabled: z.boolean(),
  canConfigure: z.boolean(),
});
export type ConsoleSession = z.infer<typeof sessionSchema>;
export class HttpError extends Error {
  constructor(public status: number) {
    super(
      status === 403
        ? 'Você não tem permissão para acessar este conteúdo.'
        : status === 429
          ? 'Muitas tentativas. Aguarde um minuto e tente novamente.'
          : 'Não foi possível concluir. Confira os dados e tente novamente.',
    );
  }
}
export async function api<T>(
  path: string,
  schema: z.ZodType<T>,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...(body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith('/api/auth/')) window.location.assign('/login');
    throw new HttpError(response.status);
  }
  return schema.parse(await response.json());
}
export const resultSchema = z.object({}).passthrough();
