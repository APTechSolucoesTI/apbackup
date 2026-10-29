import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createExecutor } from './executor.js';
import { openJournal } from './journal.js';
import { readAgentConfig, saveAgentConfig } from './config.js';
import { resumePaused } from './watchdog.js';
import { createAgentClient } from './client.js';
import { dockerClient } from '../../../packages/connectors/src/docker-client.js';
export async function runAgent(configPath: string, signal: AbortSignal, watchdogOnly = false) {
  const config = await readAgentConfig(configPath);
  const journal = await openJournal(config.journalDirectory);
  const client = createAgentClient(config.baseURL, config.identity);
  const executor = createExecutor(config, journal);
  let pausedSince = 0;
  let catalogAt = 0;
  try {
    if (!(await resumePaused(journal, config.resources)))
      throw new Error('Watchdog requires intervention');
    if (watchdogOnly) return;
    while (!signal.aborted) {
      try {
        if (Object.keys(journal.state.paused).length) {
          pausedSince ||= Date.now();
          if (Date.now() - pausedSince > 60000 && !(await resumePaused(journal, config.resources)))
            throw new Error('Watchdog incident');
        } else pausedSince = 0;
        if (config.docker && Date.now() - catalogAt > 30000) {
          await client.publishDockerCatalog(
            await dockerClient(
              config.docker,
              AbortSignal.any([signal, AbortSignal.timeout(15000)]),
            ).discover(),
          );
          catalogAt = Date.now();
        }
        const commands = await client.poll();
        for (const command of commands) {
          if (signal.aborted) break;
          const result = await executor.runCommand(command, {
            organizationId: config.organizationId,
            executionId: command.executionId,
            profileVersionId: command.profileVersionId,
            agentId: config.agentId,
            fencingToken: command.fencingToken,
            signal,
            authorizeEffect: client.authorizeEffect,
            resolvePostgres: client.resolvePostgres,
            resolveDocker: client.resolveDocker,
            resolveRepositories: client.resolveRepositories,
          });
          await client.publish(result);
        }
      } catch {
        await resumePaused(journal, config.resources);
        console.error('Agente aguardando conexão ou intervenção operacional.');
      }
      try {
        await delay(1000, undefined, { signal });
      } catch {
        break;
      }
    }
  } finally {
    await resumePaused(journal, config.resources);
    await journal.close();
  }
}
async function enroll(configPath: string) {
  let input = '';
  for await (const chunk of process.stdin) {
    input += String(chunk);
    if (Buffer.byteLength(input) > 65536) throw new Error('Enrollment input too large');
  }
  const value = JSON.parse(input) as Record<string, unknown>;
  if (
    typeof value.baseURL !== 'string' ||
    typeof value.enrollment !== 'string' ||
    typeof value.externalIdentity !== 'string'
  )
    throw new Error('Enrollment fields required');
  const base = new URL(value.baseURL);
  if (base.protocol !== 'https:' || base.username || base.password)
    throw new Error('Enrollment requires HTTPS');
  const response = await fetch(new URL('/api/agents/enroll', base), {
    method: 'POST',
    redirect: 'error',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      enrollment: value.enrollment,
      externalIdentity: value.externalIdentity,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error('Enrollment refused');
  const identity = (await response.json()) as Record<string, unknown>;
  const { enrollment: discarded, externalIdentity: external, ...local } = value;
  void discarded;
  void external;
  await saveAgentConfig(configPath, { ...local, ...identity });
  console.log('Identidade local gravada.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController();
  process.once('SIGTERM', () => controller.abort());
  process.once('SIGINT', () => controller.abort());
  const path = process.env.AGENT_CONFIG ?? '/etc/apbackup/agent.json';
  try {
    if (process.argv.includes('--enroll')) await enroll(path);
    else await runAgent(path, controller.signal, process.argv.includes('--watchdog'));
  } catch {
    console.error('Agente interrompido; confira a configuração e o journal local.');
    process.exitCode = 1;
  }
}
