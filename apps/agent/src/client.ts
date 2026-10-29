import {
  agentCommandSchema,
  agentResultSchema,
  postgresRuntimeSecretsSchema,
  dockerRuntimeSchema,
  dockerCatalogSchema,
  repositoryRuntimeSchema,
  type AgentResult,
  type AgentCommand,
} from '@apbackup/contracts';
import { z } from 'zod';
export function createAgentClient(baseURL: string, identity: string) {
  const base = new URL(baseURL);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash)
    throw new Error('Agent requires an HTTPS control plane');
  async function request(path: string, body: unknown) {
    const limit = path.endsWith('-context') ? 1048576 : 65536;
    const response = await fetch(new URL(path, base), {
      method: 'POST',
      redirect: 'error',
      headers: { authorization: `Bearer ${identity}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error('Control plane refused request');
    if (Number(response.headers.get('content-length')) > limit)
      throw new Error('Control plane response too large');
    const text = await response.text();
    if (Buffer.byteLength(text) > limit) throw new Error('Control plane response too large');
    return JSON.parse(text) as unknown;
  }
  return {
    async resolveRepositories(command: AgentCommand) {
      return z
        .strictObject({
          repositories: z.array(repositoryRuntimeSchema).max(10),
          files: z.array(z.object({ name: z.string(), sha256: z.string() })),
          cleanup: z.object({ executionId: z.uuid(), commandId: z.uuid() }).optional(),
          retention: z
            .object({ forget: z.array(z.string()), protect: z.array(z.string()) })
            .optional(),
        })
        .parse(await request('/api/agents/repository-context', command));
    },
    async resolveDocker(command: AgentCommand) {
      return dockerRuntimeSchema.parse(await request('/api/agents/docker-context', command));
    },
    async publishDockerCatalog(catalog: unknown) {
      await request('/api/agents/docker-catalog', dockerCatalogSchema.parse(catalog));
    },
    async resolvePostgres(command: AgentCommand) {
      return postgresRuntimeSecretsSchema.parse(
        await request('/api/agents/postgresql-context', command),
      );
    },
    async authorizeEffect(command: AgentCommand) {
      return z
        .strictObject({ allowed: z.boolean() })
        .parse(await request('/api/agents/authorize', command)).allowed;
    },
    async poll() {
      return z
        .strictObject({ commands: z.array(agentCommandSchema).max(16) })
        .parse(await request('/api/agents/poll', {})).commands;
    },
    async publish(result: AgentResult) {
      await request('/api/agents/results', agentResultSchema.parse(result));
    },
  };
}
