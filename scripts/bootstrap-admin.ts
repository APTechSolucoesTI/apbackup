import { createDatabase } from '@apbackup/db';
import { bootstrapAdmin, recoverAccess } from '../packages/security/src/administration.js';
import { z } from 'zod';
// Deliberately process-local: no HTTP route imports this entrypoint. Input goes
// through stdin, never password command arguments or diagnostic output.
const inputSchema = z
  .object({
    email: z.email(),
    password: z.string().min(12).max(128),
    name: z.string().min(1).optional(),
    organizationName: z.string().min(1).optional(),
  })
  .strict();
async function main() {
  const url = process.env.DATABASE_URL;
  if (!url || !['127.0.0.1', '[::1]', 'localhost'].includes(new URL(url).hostname))
    throw new Error('Local PostgreSQL connection required');
  if (!process.argv.includes('--stdin'))
    throw new Error(
      'Use --stdin with a JSON object on standard input; credentials are never accepted as arguments',
    );
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > 16384) throw new Error('Input is too large');
    chunks.push(buffer);
  }
  const input = inputSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  const db = createDatabase(url);
  try {
    if (process.argv.includes('--recover')) {
      await recoverAccess(db, input);
      console.log(
        'Acesso recuperado localmente. Sessões revogadas; configure o segundo fator novamente.',
      );
    } else {
      const result = await bootstrapAdmin(db, {
        ...input,
        name: input.name ?? 'Administrador',
        organizationName: input.organizationName ?? 'Organização principal',
      });
      console.log(
        result.created
          ? 'Administrador criado. Configure o segundo fator antes de executar ações sensíveis.'
          : 'Administrador já existente; credenciais preservadas.',
      );
    }
  } finally {
    await db.close();
  }
}
main().catch(() => {
  console.error(
    'Não foi possível concluir a administração local. Verifique o banco, as migrations e os dados fornecidos.',
  );
  process.exitCode = 1;
});
