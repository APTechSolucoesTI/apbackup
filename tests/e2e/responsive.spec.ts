import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { consoleURL, fixture, login } from './support/fixtures.js';
const evidence = resolve('../.superpowers/sdd/2026-10-28-backup-platform/task3-evidence');
for (const [name, width, height] of [
  ['desktop', 1440, 900],
  ['tablet', 768, 1024],
  ['mobile', 390, 844],
] as const) {
  for (const theme of ['light', 'dark'] as const) {
    test(`${name} ${theme}: keyboard navigation, columns and catalog fit the viewport without console errors`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text());
      });
      await page.goto(`${consoleURL}/login`);
      await expect(page.getByLabel('E-mail')).toBeEnabled();
      if (theme === 'dark') await page.getByRole('button', { name: 'Usar tema escuro' }).click();
      await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /dark/ : /^$/);
      await mkdir(evidence, { recursive: true });
      await page.screenshot({
        path: resolve(evidence, `login-${name}-${theme}.png`),
        fullPage: true,
      });
      await login(page, await fixture(12));
      await page.goto(`${consoleURL}/servers`);
      await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /dark/ : /^$/);
      expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(
        theme === 'dark' ? 'rgb(6, 6, 8)' : 'rgb(247, 248, 250)',
      );
      await expect(page.getByText('1–10 de 12', { exact: true }).first()).toBeVisible();
      if (name === 'mobile') {
        await page.getByRole('button', { name: 'Abrir navegação' }).focus();
        await page.keyboard.press('Enter');
        await expect(page.getByRole('dialog')).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(page.getByRole('dialog')).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Abrir navegação' })).toBeFocused();
      }
      await page.getByRole('button', { name: 'Colunas', exact: true }).focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('dialog')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('button', { name: 'Colunas', exact: true })).toBeFocused();
      await expect(page.locator('h1')).toHaveCount(1);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.screenshot({
        path: resolve(evidence, `servers-${name}-${theme}.png`),
        fullPage: true,
      });
      await page.goto(`${consoleURL}/security`);
      await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /dark/ : /^$/);
      await expect(
        page.getByRole('heading', { name: 'Segurança da conta', exact: true }),
      ).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.screenshot({
        path: resolve(evidence, `security-${name}-${theme}.png`),
        fullPage: true,
      });
      expect(errors).toEqual([]);
    });
  }
}
