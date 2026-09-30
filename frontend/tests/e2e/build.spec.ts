import { expect, test } from '@playwright/test';

test('new basys3 project builds and offers a download', async ({ page }) => {
  await page.goto('/');
  // Browser flashing needs a cross-origin isolated page (@yowasp/openfpgaloader
  // allocates a SharedArrayBuffer-backed WebAssembly.Memory); the backend sets
  // COOP/COEP on every response, including this static shell, to get there.
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
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

test('basys3 pin planner: clear, auto-assign, build', async ({ page }) => {
  await page.goto('/');
  await page.selectOption('#board', 'basys3');
  page.once('dialog', (d) => d.accept('planner'));
  await page.click('#new-project');
  await page.locator('#file-list li', { hasText: 'basys3.xdc' }).click();
  await expect(page.locator('#planner svg')).toBeVisible();
  await expect(page.locator('.pp-summary')).toContainText('17/17');
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Clear all' }).click();
  await expect(page.locator('.pp-summary')).toContainText('0/17');
  await page.locator('[data-signal="led[3]"]').first().click();
  await page.selectOption('select[data-signal="led[3]"]', 'leds[3]');
  await expect(page.locator('.pp-summary')).toContainText('1/17');
  await page.click('#pp-auto');
  await expect(page.locator('.pp-summary')).toContainText('17/17');
  await page.click('#view-text');
  await expect(page.locator('.cm-content')).toContainText('PACKAGE_PIN V19 IOSTANDARD LVCMOS33 } [get_ports { leds[3] }]');
  await page.click('#build');
  await expect(page.locator('#status')).toContainText('Build succeeded', { timeout: 150_000 });
});

test('simulate the basys3 example testbench and show the waveform', async ({ page }) => {
  await page.goto('/');
  await page.selectOption('#board', 'basys3');
  page.once('dialog', (d) => d.accept('sim'));
  await page.click('#new-project');
  await expect(page.locator('#file-list')).toContainText('blinky_tb.v');
  await expect(page.locator('#download')).toBeHidden();
  await page.click('#simulate');
  await expect(page.locator('#status')).toContainText('Simulation finished', { timeout: 60_000 });
  await expect(page.locator('#wave')).toBeVisible();
  await expect(page.locator('.wv-name-label')).toHaveText(['leds[15:0]', 'led_sim', 'led0', 'clk']);
  const box = (await page.locator('.wv-canvas-wrap canvas').boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + 40);
  await expect(page.locator('.wv-cursor-label')).toContainText('µs');
  await page.click('#tab-code');
  await expect(page.locator('.cm-content')).toBeVisible();
});

test('generate a testbench for a new top module', async ({ page }) => {
  await page.goto('/');
  await page.selectOption('#board', 'icebreaker');
  page.once('dialog', (d) => d.accept('tbgen'));
  await page.click('#new-project');
  await page.click('#new-tb');
  await expect(page.locator('#file-list')).toContainText('_tb.v');
  await expect(page.locator('.cm-content')).toContainText('$dumpvars');
  await page.click('#simulate');
  await expect(page.locator('#status')).toContainText('Simulation finished', { timeout: 60_000 });
});

test('draw a circuit, get Verilog, run it live', async ({ page }) => {
  await page.goto('/');
  page.once('dialog', (d) => d.accept('gates'));
  await page.click('#new-circuit');
  const canvas = page.locator('.ce-canvas');
  await expect(canvas).toBeVisible();
  await page.waitForTimeout(100);
  const box = (await canvas.boundingBox())!;
  const at = (gx: number, gy: number) => ({ x: box.x + 40 + gx * 20, y: box.y + 40 + gy * 20 });
  const place = async (type: string, gx: number, gy: number) => {
    await page.click(`.ce-pal-btn[data-type="${type}"]`);
    const q = at(gx, gy);
    await page.mouse.move(q.x, q.y);
    await page.mouse.click(q.x, q.y);
  };
  const wire = async (ax: number, ay: number, bx: number, by: number) => {
    const a = at(ax, ay), c = at(bx, by);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move((a.x + c.x) / 2, (a.y + c.y) / 2);
    await page.mouse.move(c.x, c.y);
    await page.mouse.up();
  };
  await place('in', 2, 2);
  await place('in', 2, 6);
  await place('and', 8, 3);
  await place('out', 14, 3);
  await wire(4, 3, 8, 3);
  await wire(4, 7, 8, 5);
  await wire(11, 4, 14, 4);
  await expect(page.locator('.ce-problem')).toHaveCount(0);
  // move the gate: attached wires follow and the circuit stays valid
  await page.keyboard.press('Escape');
  await wire(9, 4, 9, 7); // drag from the gate body
  await expect(page.locator('.ce-problem')).toHaveCount(0);
  // box-select both inputs and move them together
  await wire(0.5, 0.5, 4.6, 9);
  await expect(page.locator('.ce-comp.ce-sel')).toHaveCount(2);
  await wire(3, 3, 3, 1);
  await expect(page.locator('.ce-problem')).toHaveCount(0);
  await page.locator('#file-list li', { hasText: 'gates.v' }).click();
  await expect(page.locator('.cm-content')).toContainText('assign out0 = in0 & in1;');
  await page.locator('#file-list li', { hasText: 'gates.circ' }).click();
  await page.click('.ce-modes [data-mode="sim"]');
  await page.locator('.ce-comp.ce-t-in').nth(0).click();
  await expect(page.locator('.ce-comp.ce-t-out.ce-on')).toHaveCount(0);
  await page.locator('.ce-comp.ce-t-in').nth(1).click();
  await expect(page.locator('.ce-comp.ce-t-out.ce-on')).toHaveCount(1);
});
