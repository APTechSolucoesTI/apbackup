import { constants } from 'node:fs';
import { open, unlink, realpath, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalJson, agentResultSchema, type AgentResult } from '@apbackup/contracts';
import { trustedDirectory } from '../../../packages/connectors/src/runtime/safe-path.js';
export type JournalRecord =
  | {
      kind: 'accepted';
      commandId: string;
      resourceId: string;
      fencingToken: string;
      digest: string;
    }
  | { kind: 'started'; commandId: string }
  | { kind: 'result'; commandId: string; result: AgentResult }
  | { kind: 'paused'; resourceId: string; unit: string }
  | { kind: 'resumed'; resourceId: string; unit: string }
  | { kind: 'incident'; resourceId: string; unit: string };
export interface JournalRecovery {
  commands: Record<
    string,
    { phase: 'accepted' | 'unknown' | 'completed'; digest: string; result?: AgentResult }
  >;
  fences: Record<string, string>;
  paused: Record<string, Record<string, true>>;
  incidents: string[];
  sequence: number;
  hash: string;
  validBytes: number;
}
function apply(state: JournalRecovery, r: JournalRecord) {
  if (r.kind === 'accepted') {
    if (!/^[1-9][0-9]*$/.test(r.fencingToken)) throw new Error('Corrupt fence');
    state.commands[r.commandId] = { phase: 'accepted', digest: r.digest };
    state.fences[r.resourceId] = r.fencingToken;
  } else if (r.kind === 'started') {
    const command = state.commands[r.commandId];
    if (!command) throw new Error('Missing accepted record');
    command.phase = 'unknown';
  } else if (r.kind === 'result') {
    const command = state.commands[r.commandId];
    if (!command) throw new Error('Missing accepted record');
    command.phase = 'completed';
    command.result = agentResultSchema.parse(r.result);
  } else if (r.kind === 'paused') {
    (state.paused[r.resourceId] ??= {})[r.unit] = true;
  } else if (r.kind === 'resumed') {
    const units = state.paused[r.resourceId];
    if (units) {
      delete units[r.unit];
      if (!Object.keys(units).length) delete state.paused[r.resourceId];
    }
  } else if (r.kind === 'incident') {
    state.incidents.push(r.resourceId);
  } else throw new Error('Corrupt journal record');
}
async function secureDirectory(directory: string) {
  await trustedDirectory(directory, { create: true, private: true });
}
async function loadJournal(directory: string): Promise<JournalRecovery> {
  await secureDirectory(directory);
  const state: JournalRecovery = {
    commands: {},
    fences: {},
    paused: {},
    incidents: [],
    sequence: 0,
    hash: '0'.repeat(64),
    validBytes: 0,
  };
  const file = await open(
    join(directory, 'journal.ndjson'),
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const s = await file.stat();
    if (!s.isFile() || (process.platform !== 'win32' && (s.mode & 0o077) !== 0))
      throw new Error('Journal must be private');
    const bytes = await file.readFile();
    let start = 0;
    for (let end = bytes.indexOf(10, start); end !== -1; end = bytes.indexOf(10, start)) {
      const line = bytes.subarray(start, end).toString('utf8');
      const envelope = JSON.parse(line) as {
        sequence: number;
        previous: string;
        record: JournalRecord;
        hash: string;
      };
      const expected = createHash('sha256')
        .update(
          canonicalJson({
            sequence: envelope.sequence,
            previous: envelope.previous,
            record: envelope.record,
          }),
        )
        .digest('hex');
      if (
        envelope.sequence !== state.sequence + 1 ||
        envelope.previous !== state.hash ||
        envelope.hash !== expected
      )
        throw new Error('Journal integrity failure');
      apply(state, envelope.record);
      state.sequence = envelope.sequence;
      state.hash = expected;
      start = end + 1;
    }
    state.validBytes = start;
    if (start < bytes.length) {
      await file.truncate(start);
      await file.sync();
    }
    return state;
  } finally {
    await file.close();
  }
}
export async function openJournal(directory: string) {
  await secureDirectory(directory);
  const lockPath = join(directory, 'process.lock');
  const linux = process.platform === 'linux';
  // On Linux flock owns the open file description inherited as fd 3. Its short-lived
  // helper shares that description with this process, so the kernel retains the lock
  // until our descriptor closes (including SIGKILL). Never unlink this inode.
  // Other hosts support contract tests only: exclusive-create, no stale recovery.
  const lock = await open(
    lockPath,
    linux ? constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW : 'wx',
    0o600,
  );
  try {
    if (linux) {
      const info = await lock.stat();
      if (!info.isFile() || (info.mode & 0o077) !== 0) throw new Error('Unsafe journal lock');
      const binary = await realpath('/usr/bin/flock');
      const executable = await stat(binary);
      if (binary !== '/usr/bin/flock' || executable.uid !== 0 || (executable.mode & 0o022) !== 0)
        throw new Error('Unsafe flock executable');
      const acquired = spawnSync(binary, ['--exclusive', '--nonblock', '3'], {
        shell: false,
        stdio: ['ignore', 'ignore', 'ignore', lock.fd],
        env: { PATH: '/usr/bin:/bin', LANG: 'C' },
      });
      if (acquired.status !== 0) throw new Error('Agent journal already in use');
    }
  } catch (error) {
    await lock.close();
    if (!linux) await unlink(lockPath);
    throw error;
  }
  let file;
  try {
    const state = await loadJournal(directory);
    file = await open(
      join(directory, 'journal.ndjson'),
      constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW,
    );
    if (process.platform !== 'win32') {
      const dir = await open(directory, 'r');
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    }
    let pending = Promise.resolve();
    let closed = false;
    return {
      state,
      record(r: JournalRecord) {
        const write = pending.then(async () => {
          const envelope = { sequence: state.sequence + 1, previous: state.hash, record: r };
          const hash = createHash('sha256').update(canonicalJson(envelope)).digest('hex');
          await file!.writeFile(JSON.stringify({ ...envelope, hash }) + '\n');
          await file!.sync();
          apply(state, r);
          state.sequence = envelope.sequence;
          state.hash = hash;
        });
        pending = write;
        return write;
      },
      async close() {
        if (closed) return;
        closed = true;
        try {
          await pending;
          await file!.close();
        } finally {
          await lock.close();
          if (!linux) await unlink(lockPath);
        }
      },
    };
  } catch (e) {
    await file?.close();
    await lock.close();
    if (!linux) await unlink(lockPath);
    throw e;
  }
}
export type AgentJournal = Awaited<ReturnType<typeof openJournal>>;
export async function recoverJournal(directory: string): Promise<JournalRecovery> {
  const journal = await openJournal(directory);
  try {
    return journal.state;
  } finally {
    await journal.close();
  }
}
