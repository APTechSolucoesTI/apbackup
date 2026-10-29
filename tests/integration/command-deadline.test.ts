import { afterEach, expect, test, vi } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import {
  withCommandDeadline,
  CommandDeadlineError,
} from '../../packages/connectors/src/runtime/command-deadline.js';
import type { AgentCommand, ExecutionContext } from '@apbackup/contracts';
const id = () => crypto.randomUUID();
function fixture() {
  const command: AgentCommand = {
    version: 1,
    commandId: id(),
    organizationId: id(),
    executionId: id(),
    profileVersionId: id(),
    agentId: id(),
    resourceId: id(),
    fencingToken: '1',
    expiresAt: new Date(Date.now() + 100).toISOString(),
    operation: { kind: 'postgresql_backup', repositoryId: id() },
  };
  const context: ExecutionContext = { ...command, signal: new AbortController().signal };
  return { command, context };
}
afterEach(() => vi.useRealTimers());
test('one overall deadline aborts a compound command even while an awaited stage is running', async () => {
  const { command, context } = fixture();
  let aborted = false;
  const promise = withCommandDeadline(command, context, async (scoped) => {
    try {
      await delay(10000, undefined, { signal: scoped.signal });
    } finally {
      aborted = scoped.signal.aborted;
    }
  });
  await expect(promise).rejects.toBeInstanceOf(CommandDeadlineError);
  expect(aborted).toBe(true);
});
test('clock crossing between verification stages never returns a successful command after expiry', async () => {
  vi.useFakeTimers();
  const { command, context } = fixture();
  await expect(
    withCommandDeadline(command, context, async () => {
      vi.setSystemTime(Date.parse(command.expiresAt) + 1);
      return 'unverified-success';
    }),
  ).rejects.toBeInstanceOf(CommandDeadlineError);
  expect(vi.getTimerCount()).toBe(0);
});
