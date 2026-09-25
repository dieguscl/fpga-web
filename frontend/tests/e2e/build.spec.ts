import { expect, test } from '@playwright/test';

test('new basys3 project builds and offers a download', async ({ page }) => {
  await page.goto('/');
  await page.selectOption('#board', 'basys3');
  page.once('dialog', (d) => d.accept('blink'));
  await page.click('#new-project');
  await expect(page.locator('#file-list')).toContainText('blinky.v');
  await page.click('#build');
  await expect(page.locator('#status')).toContainText('Build succeeded', { timeout: 150_000 });
  await expect(page.locator('#summary')).not.toBeEmpty();
  const download = page.waitForEvent('download');
  await page.click('#download');
  expect((await download).suggestedFilename()).toBe('basys3.bit');
});

test('syntax error shows a clickable location', async ({ page }) => {
  await page.goto('/');
  await page.selectOption('#board', 'icebreaker');
  page.once('dialog', (d) => d.accept('broken'));
  await page.click('#new-project');
  await page.locator('#file-list li', { hasText: 'blinky.v' }).click();
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\nmodule oops( ;\n');
  await page.click('#build');
  await expect(page.locator('#status')).toContainText('failed', { timeout: 120_000 });
  const link = page.locator('#log a.loc').first();
  await expect(link).toContainText('blinky.v:');
  await link.click();
  await expect(page.locator('.cm-activeLine')).toBeVisible();
});
