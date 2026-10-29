import { test, expect } from 'vitest';
import { createCatalogRefresh } from '../../apps/agent/src/catalog-refresh.js';
test('slow catalog refresh is single-flight and never blocks command polling', async () => {
  let complete: () => void = () => {};
  let started = 0;
  const signal = new AbortController();
  const refresh = createCatalogRefresh(
    async () => {
      started++;
      await new Promise<void>((resolve) => {
        complete = resolve;
      });
    },
    signal.signal,
    () => {},
    () => 1000,
  );
  expect(refresh.tick()).toBeUndefined();
  await Promise.resolve();
  refresh.tick();
  expect(started).toBe(1);
  let polled = false;
  await Promise.resolve().then(() => {
    polled = true;
  });
  expect(polled).toBe(true);
  complete();
  await refresh.close();
});
test('failed discovery backs off while the command lane remains usable', async () => {
  let now = 1000,
    attempts = 0,
    errors = 0;
  const signal = new AbortController();
  const refresh = createCatalogRefresh(
    async () => {
      attempts++;
      throw new Error('discovery unavailable');
    },
    signal.signal,
    () => {
      errors++;
    },
    () => now,
  );
  refresh.tick();
  await refresh.close();
  expect(errors).toBe(1);
  refresh.tick();
  await refresh.close();
  expect(attempts).toBe(1);
  now += 30001;
  refresh.tick();
  await refresh.close();
  expect(attempts).toBe(2);
  signal.abort();
  now += 30001;
  refresh.tick();
  await refresh.close();
  expect(attempts).toBe(2);
});
