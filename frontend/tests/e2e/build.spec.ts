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
  await expect(page.locator('#planner svg.pp-board')).toBeVisible();
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
  // click a wire (near its end) selects it instead of starting a new wire
  const q = at(13.7, 4); // close to the wire's end at the output pin
  await page.mouse.click(q.x, q.y);
  await expect(page.locator('line.ce-wire.ce-sel')).toHaveCount(1);
  await page.keyboard.press('Delete');
  await expect(page.locator('.ce-problem')).not.toHaveCount(0);
  await page.keyboard.press('Control+z');
  await expect(page.locator('.ce-problem')).toHaveCount(0);
  // copy everything and paste it below at the mouse: a second, fully wired copy
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Control+c');
  const dst = at(2, 12);
  await page.mouse.move(dst.x, dst.y);
  await page.keyboard.press('Control+v');
  await expect(page.locator('.ce-comp')).toHaveCount(8);
  await expect(page.locator('.ce-problem')).toHaveCount(0);
  await page.keyboard.press('Control+z');
  await expect(page.locator('.ce-comp')).toHaveCount(4);
  // negate the gate's second input (Digital's "inverted inputs"): y = a & ~b
  await page.keyboard.press('Escape');
  await page.locator('.ce-comp.ce-t-and').click();
  await page.locator('.ce-invert input[data-input="1"]').check();
  await expect(page.locator('.ce-comp.ce-t-and .ce-bubble')).toHaveCount(1);
  if (process.env.INVERT_SHOT) await page.locator('.ce-comp.ce-t-and').screenshot({ path: process.env.INVERT_SHOT });
  await page.locator('#file-list li', { hasText: 'gates.v' }).click();
  await expect(page.locator('.cm-content')).toContainText('assign out0 = in0 & ~in1;');
  await page.locator('#file-list li', { hasText: 'gates.circ' }).click();
  await page.click('.ce-modes [data-mode="sim"]');
  await expect(page.locator('.ce-comp.ce-t-out.ce-on')).toHaveCount(0);
  await page.locator('.ce-comp.ce-t-in').nth(0).click();
  await expect(page.locator('.ce-comp.ce-t-out.ce-on')).toHaveCount(1);
  await page.locator('.ce-comp.ce-t-in').nth(1).click();
  await expect(page.locator('.ce-comp.ce-t-out.ce-on')).toHaveCount(0);
});

test('virtual Basys 3: switches drive LEDs and the 7-segment display', async ({ page }) => {
  const { strToU8, zipSync } = await import('fflate');
  const sw = ['V17', 'V16', 'W16', 'W17', 'W15', 'V15', 'W14', 'W13', 'V2', 'T3', 'T2', 'R3', 'W2', 'U1', 'T1', 'R2'];
  const led = ['U16', 'E19', 'U19', 'V19', 'W18', 'U15', 'U14', 'V14', 'V13', 'V3', 'W3', 'U3', 'P3', 'N3', 'P1', 'L1'];
  const line = (pin: string, port: string) => `set_property -dict { PACKAGE_PIN ${pin} IOSTANDARD LVCMOS33 } [get_ports { ${port} }]\n`;
  let xdc = line('W5', 'clk') + line('U18', 'btnC');
  sw.forEach((p, i) => (xdc += line(p, `sw[${i}]`)));
  led.forEach((p, i) => (xdc += line(p, `led[${i}]`)));
  ['W7', 'W6', 'U8', 'V8', 'U5', 'V5', 'U7'].forEach((p, i) => (xdc += line(p, `seg[${i}]`)));
  ['U2', 'U4', 'V4', 'W4'].forEach((p, i) => (xdc += line(p, `an[${i}]`)));
  const v = `module top(input clk, input [15:0] sw, input btnC, output [15:0] led, output reg [6:0] seg, output reg [3:0] an);
    assign led = btnC ? ~sw : sw;
    reg [15:0] refresh = 0; always @(posedge clk) refresh <= refresh + 1;
    reg [3:0] nib;
    always @* begin
      an = 4'b1111; an[refresh[15:14]] = 1'b0; nib = sw[refresh[15:14]*4 +: 4];
      case (nib) 4'd0: seg = 7'b1000000; 4'd1: seg = 7'b1111001; default: seg = 7'b0111111; endcase
    end
  endmodule\n`;
  const zip = zipSync({ 'project.json': strToU8(JSON.stringify({ name: 'vb', board: 'basys3', top: 'top' })), 'top.v': strToU8(v), 'basys3.xdc': strToU8(xdc) });
  await page.goto('/');
  await page.setInputFiles('#import-file', { name: 'vb.zip', mimeType: 'application/zip', buffer: Buffer.from(zip) });
  await expect(page.locator('#file-list')).toContainText('top.v');
  await page.click('#tab-board');
  await page.click('button[data-i18n="vb.load"]');
  await expect(page.locator('.vb-status')).toContainText('MHz', { timeout: 60_000 });
  await expect(page.locator('.vb-led.vb-lit')).toHaveCount(0);
  await page.locator('.vb-sw[data-signal="sw[0]"]').click();
  await page.locator('.vb-sw[data-signal="sw[5]"]').click();
  await expect(page.locator('.vb-led.vb-lit')).toHaveCount(2);
  await expect(page.locator('.vb-seg.vb-lit')).not.toHaveCount(0);
  const b = (await page.locator('.vb-btn[data-signal="btnC"]').boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await expect(page.locator('.vb-led.vb-lit')).toHaveCount(14);
  await page.mouse.up();
  await expect(page.locator('.vb-led.vb-lit')).toHaveCount(2);
});
