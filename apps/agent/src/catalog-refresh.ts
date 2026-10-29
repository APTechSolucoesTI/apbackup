/** Inventory is advisory; a slow or failed scan must not hold up commands/results. */
export function createCatalogRefresh(
  run: () => Promise<void>,
  signal: AbortSignal,
  onError: () => void,
  now: () => number = Date.now,
) {
  let nextAt = 0,
    pending: Promise<void> | undefined;
  return {
    tick(): void {
      if (signal.aborted || pending || now() < nextAt) return;
      nextAt = now() + 30000;
      pending = Promise.resolve()
        .then(run)
        .catch(() => {
          if (!signal.aborted) onError();
        })
        .finally(() => {
          pending = undefined;
        });
    },
    async close(): Promise<void> {
      await pending;
    },
  };
}
