import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createAgentClient } from '../../../apps/agent/src/client.js';
import { createExecutor } from '../../../apps/agent/src/executor.js';
import { openJournal } from '../../../apps/agent/src/journal.js';
import { dockerClient } from '../../../packages/connectors/src/docker-client.js';
const config = z
  .object({
    baseURL: z.string(),
    identity: z.string(),
    agentId: z.uuid(),
    organizationId: z.uuid(),
    helperImage: z.string(),
  })
  .parse(JSON.parse(Buffer.from(process.env.DOCKER_BROWSER_WORKER ?? '', 'base64').toString()));
const root = await mkdtemp(join(tmpdir(), 'docker-browser-'));
await mkdir(join(root, 'artifacts'), { mode: 0o700 });
await mkdir(join(root, 'repositories'), { mode: 0o700 });
const journal = await openJournal(join(root, 'journal')),
  client = createAgentClient(config.baseURL, config.identity),
  policy = {
    socketPath: '/var/run/docker.sock',
    helperImage: config.helperImage,
    repositoryRoot: join(root, 'repositories'),
    directories: {},
  },
  executor = createExecutor(
    {
      agentId: config.agentId,
      organizationId: config.organizationId,
      resources: {},
      artifactRoot: join(root, 'artifacts'),
      docker: policy,
    },
    journal,
  );
let stop = false,
  catalogAt = 0;
process.once('SIGTERM', () => {
  stop = true;
});
try {
  while (!stop) {
    if (Date.now() - catalogAt > 15000) {
      await client.publishDockerCatalog(
        await dockerClient(policy, AbortSignal.timeout(15000)).discover(),
      );
      catalogAt = Date.now();
    }
    for (const command of await client.poll()) {
      const result = await executor.runCommand(command, {
        organizationId: config.organizationId,
        agentId: config.agentId,
        executionId: command.executionId,
        profileVersionId: command.profileVersionId,
        fencingToken: command.fencingToken,
        signal: new AbortController().signal,
        authorizeEffect: client.authorizeEffect,
        resolveDocker: client.resolveDocker,
      });
      await client.publish(result);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
} finally {
  await journal.close();
  await rm(root, { recursive: true, force: true });
}
