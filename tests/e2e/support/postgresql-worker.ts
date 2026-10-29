// Disposable Linux worker for the browser proof. Shipping agent/client/executor are reused.
import { createServer, connect } from 'node:net';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createAgentClient } from '../../../apps/agent/src/client.js';
import { createExecutor } from '../../../apps/agent/src/executor.js';
import { openJournal } from '../../../apps/agent/src/journal.js';
const config = z
  .object({
    baseURL: z.string(),
    identity: z.string(),
    agentId: z.uuid(),
    organizationId: z.uuid(),
    forwardPort: z.number(),
  })
  .parse(JSON.parse(Buffer.from(process.env.PG_BROWSER_WORKER ?? '', 'base64').toString('utf8')));
const root = await mkdtemp(join(tmpdir(), 'pg-browser-worker-'));
await mkdir(join(root, 'artifacts'), { mode: 0o700 });
await mkdir(join(root, 'repositories'), { mode: 0o700 });
// Windows and Linux access the same disposable source through the same loopback endpoint.
const forward = createServer((socket) => {
  const upstream = connect(5432, '127.0.0.1');
  socket.pipe(upstream).pipe(socket);
  socket.on('error', () => upstream.destroy());
  upstream.on('error', () => socket.destroy());
});
await new Promise<void>((resolve) => forward.listen(config.forwardPort, '127.0.0.1', resolve));
const journal = await openJournal(join(root, 'journal')),
  client = createAgentClient(config.baseURL, config.identity),
  executor = createExecutor(
    {
      agentId: config.agentId,
      organizationId: config.organizationId,
      resources: {},
      artifactRoot: join(root, 'artifacts'),
      postgresql: { allowedHosts: ['127.0.0.1'], repositoryRoot: join(root, 'repositories') },
    },
    journal,
  );
let stop = false;
process.once('SIGTERM', () => {
  stop = true;
});
try {
  while (!stop) {
    for (const command of await client.poll()) {
      const result = await executor.runCommand(command, {
        organizationId: config.organizationId,
        agentId: config.agentId,
        executionId: command.executionId,
        profileVersionId: command.profileVersionId,
        fencingToken: command.fencingToken,
        signal: new AbortController().signal,
        authorizeEffect: client.authorizeEffect,
        resolvePostgres: client.resolvePostgres,
      });
      await client.publish(result);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
} finally {
  forward.close();
  await journal.close();
  await rm(root, { recursive: true, force: true });
}
