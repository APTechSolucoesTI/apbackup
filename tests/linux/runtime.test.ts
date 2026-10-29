import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  stat,
  symlink,
  lstat,
  appendFile,
  readFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openJournal, recoverJournal } from '../../apps/agent/src/journal.js';
import { createExecutor } from '../../apps/agent/src/executor.js';
import { spawnTool } from '../../packages/connectors/src/runtime/spawn-tool.js';
import { safePath } from '../../packages/connectors/src/runtime/safe-path.js';
import { resumePaused } from '../../apps/agent/src/watchdog.js';
if (process.argv.includes('--journal-worker')) {
  const j = await openJournal(process.argv.at(-1)!);
  await j.record({
    kind: 'accepted',
    commandId: 'effect',
    resourceId: 'r',
    fencingToken: '9007199254740993',
    digest: 'digest',
  });
  await j.record({ kind: 'started', commandId: 'effect' });
  console.log('durable');
  await new Promise(() => {});
} else if (process.argv.includes('--lock-contender')) {
  console.log('ready');
  await new Promise<void>((resolve) => process.stdin.once('data', () => resolve()));
  let journal;
  try {
    journal = await openJournal(process.argv.at(-1)!);
    console.log('held');
  } catch {
    console.log('refused');
  }
  await new Promise<void>((resolve) => process.stdin.once('data', () => resolve()));
  await journal?.close();
} else {
  test('simultaneous Linux stale-lock reclaimers never remove a successor lock or admit two agents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'reclaim-'));
    try {
      for (let round = 0; round < 4; round++) {
        const directory = join(root, String(round));
        await mkdir(directory, { mode: 0o700 });
        await writeFile(join(directory, 'process.lock'), '2147483647', { mode: 0o600 });
        const children = Array.from({ length: 8 }, () =>
          spawn(process.execPath, [fileURLToPath(import.meta.url), '--lock-contender', directory], {
            stdio: ['pipe', 'pipe', 'pipe'],
          }),
        );
        const outputs = children.map(() => ''),
          states = children.map(() => ''),
          errors: string[] = [];
        children.forEach((child, i) => {
          child.stdout.on('data', (chunk) => {
            outputs[i] += String(chunk);
            if (outputs[i]!.includes('held')) states[i] = 'held';
            else if (outputs[i]!.includes('refused')) states[i] = 'refused';
          });
          child.stderr.on('data', (chunk) => errors.push(String(chunk)));
        });
        const until = async (predicate: () => boolean) => {
          for (let i = 0; i < 500 && !predicate(); i++) await new Promise((r) => setTimeout(r, 10));
          assert.ok(predicate(), errors.join(''));
        };
        try {
          await until(() => outputs.every((v) => v.includes('ready')));
          for (const c of children) c.stdin.write('go\n');
          await until(() => states.every(Boolean));
          assert.equal(
            states.filter((s) => s === 'held').length,
            1,
            `round ${round}: ${states.join(',')}`,
          );
        } finally {
          for (const c of children)
            if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
          await Promise.all(
            children.map((c) =>
              c.exitCode !== null || c.signalCode !== null
                ? Promise.resolve()
                : new Promise((r) => c.once('exit', r)),
            ),
          );
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test('journal reopens two paused units on one resource and watchdog attempts both without dropping either', async () => {
    const root = await mkdtemp(join(tmpdir(), 'multi-service-'));
    let journal = await openJournal(root);
    try {
      await journal.record({ kind: 'paused', resourceId: 'r', unit: 'a.service' });
      await journal.record({ kind: 'paused', resourceId: 'r', unit: 'b.service' });
      await journal.record({ kind: 'resumed', resourceId: 'r', unit: 'a.service' });
      await journal.close();
      journal = await openJournal(root);
      assert.deepEqual(journal.state.paused.r, { 'b.service': true });
      await journal.record({ kind: 'paused', resourceId: 'r', unit: 'a.service' });
      await journal.close();
      journal = await openJournal(root);
      assert.deepEqual(journal.state.paused.r, { 'a.service': true, 'b.service': true });
      assert.equal(
        await resumePaused(journal, { r: { root, units: ['a.service', 'b.service'] } }),
        false,
      );
      const lines = (await readFile(join(root, 'journal.ndjson'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { record: { kind: string; unit: string } });
      assert.deepEqual(
        lines
          .filter((l) => l.record.kind === 'incident')
          .map((l) => l.record.unit)
          .sort(),
        ['a.service', 'b.service'],
      );
      assert.deepEqual(journal.state.paused.r, { 'a.service': true, 'b.service': true });
    } finally {
      await journal.close();
      await rm(root, { recursive: true, force: true });
    }
  });
  test('Linux mutable archive result survives journal reopen and a lost response without replay', async () => {
    const root = await mkdtemp(join(tmpdir(), 'effect-'));
    try {
      await mkdir(join(root, 'source'));
      await mkdir(join(root, 'artifacts'), { mode: 0o700 });
      await writeFile(join(root, 'source', 'payload'), 'durable payload');
      const agentId = randomUUID(),
        organizationId = randomUUID(),
        resourceId = randomUUID();
      const c = {
        version: 1 as const,
        commandId: randomUUID(),
        organizationId,
        agentId,
        executionId: randomUUID(),
        profileVersionId: randomUUID(),
        resourceId,
        fencingToken: '9007199254740993',
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        operation: { kind: 'archive_files' as const, path: 'source', artifact: 'capture.tar' },
      };
      const policy = {
        agentId,
        organizationId,
        resources: { [resourceId]: { root, units: [] } },
        artifactRoot: join(root, 'artifacts'),
      };
      const context = {
        ...c,
        signal: new AbortController().signal,
        authorizeEffect: async () => true,
      };
      let journal = await openJournal(join(root, 'journal'));
      const unauthorized = await createExecutor(policy, journal).runCommand(c, {
        ...c,
        signal: new AbortController().signal,
      });
      assert.equal(unauthorized.outcome, 'rejected');
      assert.equal(journal.state.commands[c.commandId], undefined);
      const first = await createExecutor(policy, journal).runCommand(c, context);
      assert.equal(first.outcome, 'completed');
      assert.ok(first.artifact);
      await journal.close();
      const artifact = join(root, 'artifacts', first.artifact!.path);
      const initial = await stat(artifact);
      journal = await openJournal(join(root, 'journal'));
      try {
        assert.deepEqual(await createExecutor(policy, journal).runCommand(c, context), first);
        assert.equal((await stat(artifact)).ino, initial.ino);
        assert.equal((await stat(artifact)).mtimeMs, initial.mtimeMs);
      } finally {
        await journal.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test('Linux fsync journal survives SIGKILL, reclaims dead process lock and rejects corruption', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'journal-'));
    try {
      const child = spawn(
        process.execPath,
        [fileURLToPath(import.meta.url), '--journal-worker', directory],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      );
      await new Promise<void>((resolve, reject) => {
        child.stdout.once('data', () => resolve());
        child.once('exit', () => reject(new Error('worker exited before durable write')));
      });
      child.kill('SIGKILL');
      await new Promise((r) => child.once('exit', r));
      const j = await openJournal(directory);
      assert.equal(j.state.commands.effect?.phase, 'unknown');
      assert.equal(j.state.fences.r, '9007199254740993');
      await j.close();
      assert.equal((await stat(directory)).mode & 0o777, 0o700);
      assert.equal((await stat(join(directory, 'journal.ndjson'))).mode & 0o777, 0o600);
      await appendFile(join(directory, 'journal.ndjson'), '{"torn":');
      assert.equal((await recoverJournal(directory)).commands.effect?.phase, 'unknown');
      await appendFile(join(directory, 'journal.ndjson'), '{}\n');
      await assert.rejects(recoverJournal(directory));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  test('Linux source, staging and journal reject symlink parents before creating files outside scope', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scope-'));
    try {
      await mkdir(join(root, 'source'));
      await writeFile(join(root, 'source', 'payload'), 'data');
      const outside = join(root, 'outside');
      await mkdir(outside, { mode: 0o700 });
      await symlink(outside, join(root, 'link'));
      await assert.rejects(safePath(root, 'link/payload'));
      await assert.rejects(openJournal(join(root, 'link', 'journal')));
      assert.equal(
        await lstat(join(outside, 'journal')).then(
          () => true,
          () => false,
        ),
        false,
      );
      const journal = await openJournal(join(root, 'journal'));
      try {
        const agentId = randomUUID(),
          organizationId = randomUUID(),
          resourceId = randomUUID();
        const c = {
          version: 1 as const,
          commandId: randomUUID(),
          organizationId,
          agentId,
          executionId: randomUUID(),
          profileVersionId: randomUUID(),
          resourceId,
          fencingToken: '1',
          expiresAt: new Date(Date.now() + 60000).toISOString(),
          operation: { kind: 'archive_files' as const, path: 'source', artifact: 'payload.tar' },
        };
        const executor = createExecutor(
          {
            agentId,
            organizationId,
            resources: { [resourceId]: { root, units: [] } },
            artifactRoot: join(root, 'link'),
          },
          journal,
        );
        const result = await executor.runCommand(c, {
          ...c,
          signal: new AbortController().signal,
          authorizeEffect: async () => true,
        });
        assert.equal(result.outcome, 'failed');
        assert.deepEqual(await import('node:fs/promises').then((m) => m.readdir(outside)), []);
      } finally {
        await journal.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test('Linux tool streams large artifacts separately, bounds diagnostics and terminates process groups on timeout/cancel', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tool-'));
    try {
      await writeFile(join(root, 'payload'), Buffer.alloc(1024 * 1024, 0x61));
      const artifact = join(root, 'payload.tar');
      const streamed = await spawnTool('tar', ['-cf', '-', '--', 'payload'], {
        cwd: root,
        timeoutMs: 2000,
        diagnosticLimit: 64,
        stdoutArtifactPath: artifact,
      });
      assert.equal(streamed.exitCode, 0);
      assert.equal(streamed.outputLimited, false);
      assert.ok((await stat(artifact)).size > 1000000);
      const bounded = await spawnTool('tar', ['--help'], {
        cwd: root,
        timeoutMs: 2000,
        diagnosticLimit: 64,
      });
      assert.equal(bounded.outputLimited, true);
      assert.ok(Buffer.byteLength(bounded.diagnostics) <= 64);
      const fifo = join(root, 'fifo');
      execFileSync('/usr/bin/mkfifo', [fifo]);
      const timed = await spawnTool('tar', ['-cf', '-', '--files-from', fifo], {
        cwd: root,
        timeoutMs: 100,
        diagnosticLimit: 64,
      });
      assert.equal(timed.timedOut, true);
      assert.equal(timed.signal, 'SIGTERM');
      const abort = new AbortController();
      setTimeout(() => abort.abort(), 100);
      const cancelled = await spawnTool('tar', ['-cf', '-', '--files-from', fifo], {
        cwd: root,
        timeoutMs: 2000,
        diagnosticLimit: 64,
        signal: abort.signal,
      });
      assert.equal(cancelled.signal, 'SIGTERM');
      assert.equal(cancelled.timedOut, false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test('Linux watchdog persists a failed service recovery as an incident', async () => {
    const root = await mkdtemp(join(tmpdir(), 'watchdog-'));
    const j = await openJournal(root);
    try {
      await j.record({
        kind: 'paused',
        resourceId: 'r',
        unit: 'nonexistent-apbackup-test.service',
      });
      assert.equal(
        await resumePaused(j, { r: { root, units: ['nonexistent-apbackup-test.service'] } }),
        false,
      );
      assert.deepEqual(j.state.incidents, ['r']);
      assert.deepEqual(j.state.paused.r, { 'nonexistent-apbackup-test.service': true });
    } finally {
      await j.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
