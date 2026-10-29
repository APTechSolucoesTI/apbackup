import { mkdtemp, rm, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
test('durable journal never replays a started effect, remembers fences and tolerates only torn final record', async () => {
  const { openJournal, recoverJournal } = await import('../../apps/agent/src/journal.js');
  const directory = await mkdtemp(join(tmpdir(), 'apbackup-journal-'));
  try {
    const j = await openJournal(directory);
    await j.record({
      kind: 'accepted',
      commandId: 'c1',
      resourceId: 'r1',
      fencingToken: '9007199254740993',
      digest: 'abc',
    });
    await j.record({ kind: 'started', commandId: 'c1' });
    await j.close();
    await appendFile(join(directory, 'journal.ndjson'), '{"torn":');
    const recovered = await recoverJournal(directory);
    expect(recovered.commands.c1?.phase).toBe('unknown');
    expect(recovered.fences.r1).toBe('9007199254740993');
    const again = await openJournal(directory);
    expect(again.state.commands.c1?.phase).toBe('unknown');
    await again.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('executor refuses expired/scope/stale commands and caches effects before loss of response', async () => {
  const { openJournal } = await import('../../apps/agent/src/journal.js');
  const { createExecutor } = await import('../../apps/agent/src/executor.js');
  const { randomUUID } = await import('node:crypto');
  const { mkdir, writeFile } = await import('node:fs/promises');
  const directory = await mkdtemp(join(tmpdir(), 'apbackup-executor-'));
  await mkdir(join(directory, 'source'));
  await writeFile(join(directory, 'source', 'file'), 'content');
  const journal = await openJournal(join(directory, 'journal'));
  const agentId = randomUUID(),
    organizationId = randomUUID(),
    resourceId = randomUUID();
  const command = {
    version: 1 as const,
    commandId: randomUUID(),
    organizationId,
    agentId,
    executionId: randomUUID(),
    profileVersionId: randomUUID(),
    resourceId,
    fencingToken: '9007199254740993',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    operation: { kind: 'inspect' as const, path: 'source' },
  };
  try {
    const executor = createExecutor(
      {
        agentId,
        organizationId,
        resources: { [resourceId]: { root: directory, units: [] } },
        artifactRoot: directory,
      },
      journal,
    );
    const result = await executor.runCommand(command, {
      ...command,
      signal: new AbortController().signal,
    });
    expect(result.outcome).toBe('completed');
    expect(
      await executor.runCommand(command, { ...command, signal: new AbortController().signal }),
    ).toEqual(result);
    expect(
      (
        await executor.runCommand(
          { ...command, commandId: randomUUID(), fencingToken: '9007199254740992' },
          { ...command, signal: new AbortController().signal },
        )
      ).outcome,
    ).toBe('rejected');
    expect(
      (
        await executor.runCommand(
          { ...command, commandId: randomUUID(), expiresAt: new Date(0).toISOString() },
          { ...command, signal: new AbortController().signal },
        )
      ).outcome,
    ).toBe('rejected');
    expect(
      (
        await executor.runCommand(
          { ...command, commandId: randomUUID(), agentId: randomUUID() },
          { ...command, signal: new AbortController().signal },
        )
      ).outcome,
    ).toBe('rejected');
  } finally {
    await journal.close();
    await rm(directory, { recursive: true, force: true });
  }
});
test('mutable commands fail closed without current control-plane lease authorization', async () => {
  const { openJournal } = await import('../../apps/agent/src/journal.js');
  const { createExecutor } = await import('../../apps/agent/src/executor.js');
  const directory = await mkdtemp(join(tmpdir(), 'apbackup-authorize-'));
  const j = await openJournal(directory);
  const agentId = crypto.randomUUID(),
    organizationId = crypto.randomUUID(),
    resourceId = crypto.randomUUID();
  const c = {
    version: 1 as const,
    commandId: crypto.randomUUID(),
    organizationId,
    agentId,
    executionId: crypto.randomUUID(),
    profileVersionId: crypto.randomUUID(),
    resourceId,
    fencingToken: '1',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    operation: { kind: 'service_pause' as const, unit: 'test.service' },
  };
  try {
    const executor = createExecutor(
      {
        agentId,
        organizationId,
        resources: { [resourceId]: { root: directory, units: ['test.service'] } },
        artifactRoot: directory,
      },
      j,
    );
    expect(
      (await executor.runCommand(c, { ...c, signal: new AbortController().signal })).outcome,
    ).toBe('rejected');
    expect(j.state.commands[c.commandId]).toBeUndefined();
  } finally {
    await j.close();
    await rm(directory, { recursive: true, force: true });
  }
});
