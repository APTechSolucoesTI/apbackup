import type { AgentCommand, ExecutionContext } from '@apbackup/contracts';
export class CommandDeadlineError extends Error {
  constructor() {
    super('Command deadline elapsed; reconcile the existing effect');
  }
}
export function assertCommandActive(command: AgentCommand, context: ExecutionContext) {
  if (Date.now() >= Date.parse(command.expiresAt)) throw new CommandDeadlineError();
  context.signal.throwIfAborted();
}
/** A single budget covers all sequential tools, SQL calls and verification work. */
export async function withCommandDeadline<T>(
  command: AgentCommand,
  context: ExecutionContext,
  run: (scoped: ExecutionContext) => Promise<T>,
): Promise<T> {
  assertCommandActive(command, context);
  const deadline = new AbortController(),
    signal = AbortSignal.any([context.signal, deadline.signal]);
  const timer = setTimeout(
    () => deadline.abort(new CommandDeadlineError()),
    Date.parse(command.expiresAt) - Date.now(),
  );
  timer.unref();
  const scoped = { ...context, signal };
  try {
    const result = await run(scoped);
    assertCommandActive(command, scoped);
    return result;
  } catch (error) {
    if (deadline.signal.aborted || Date.now() >= Date.parse(command.expiresAt))
      throw new CommandDeadlineError();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
