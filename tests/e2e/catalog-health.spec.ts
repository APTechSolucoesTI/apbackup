import { expect, test } from '@playwright/test';

test('serves health from the running catalog and persists schema availability across HTTP requests', async ({
  request,
}) => {
  const response = await request.get('/health');
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({
    service: 'apbackup-catalog',
    database: 'ready',
    migrations: 7,
  });
  expect((await request.get('/health')).status()).toBe(200);
  expect((await request.get('/servers')).status()).toBe(404);
});
