import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { buildOflArgs, flash } from '../src/flasher';
import { detectOS, setupHelpHtml } from '../src/setup-help';
import type { BoardInfo } from '../src/api';

const board = (over: Partial<BoardInfo> = {}): BoardInfo => ({
  id: 'basys3', description: '', arch: 'xilinx', part: '', constraint_ext: '.xdc', bitstream_ext: '.bit',
  flash: 'browser', ofl_args: ['--board', 'basys3'], writes_flash: false, ...over,
});

describe('buildOflArgs', () => {
  it('SRAM load appends only the file', () => {
    expect(buildOflArgs(board(), 'basys3.bit', false)).toEqual(['--board', 'basys3', 'basys3.bit']);
  });
  it('flash write adds -f once', () => {
    expect(buildOflArgs(board(), 'b.bit', true)).toEqual(['--board', 'basys3', '-f', 'b.bit']);
    const w = board({ ofl_args: ['-c', 'cmsisdap', '--write-flash'], writes_flash: true });
    expect(buildOflArgs(w, 'b.bit', true)).toEqual(['-c', 'cmsisdap', '--write-flash', 'b.bit']);
  });
  it('rejects download-only boards', () => {
    expect(() => buildOflArgs(board({ flash: 'download' }), 'b.bit', false)).toThrow(/download/);
  });
});

describe('setup help', () => {
  it('detects OS from user agent', () => {
    expect(detectOS('Mozilla/5.0 (X11; Linux x86_64)')).toBe('linux');
    expect(detectOS('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('windows');
    expect(detectOS('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)')).toBe('mac');
  });
  it('has Linux udev and Windows Zadig instructions', () => {
    expect(setupHelpHtml('linux')).toContain('udev');
    expect(setupHelpHtml('windows')).toContain('Zadig');
    expect(setupHelpHtml('windows')).toMatch(/Vivado/);
  });
  it('includes all 7 vendor IDs in Linux udev rules', () => {
    const linux = setupHelpHtml('linux');
    expect(linux).toContain('0403'); // FTDI
    expect(linux).toContain('09fb'); // Altera USB-Blaster
    expect(linux).toContain('0d28'); // ARM CMSIS-DAP, Colorlight
    expect(linux).toContain('1209'); // pid.codes DFU
    expect(linux).toContain('1d50'); // OpenMoko DFU
    expect(linux).toContain('2a19'); // Numato
    expect(linux).toContain('c251'); // Keil CMSIS-DAP
  });
});

describe('flash', () => {
  let originalNavigator: Navigator;

  beforeEach(() => {
    originalNavigator = globalThis.navigator;
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'navigator', {
      value: originalNavigator,
      configurable: true,
    });
  });

  it('rejects download-only boards without calling requestDevice', async () => {
    const requestDeviceMock = vi.fn();
    Object.defineProperty(globalThis, 'navigator', {
      value: { usb: { requestDevice: requestDeviceMock } },
      configurable: true,
    });

    const downloadOnlyBoard = board({ flash: 'download' });
    await expect(flash(downloadOnlyBoard, new Uint8Array(), false, () => {})).rejects.toThrow(/download/);
    expect(requestDeviceMock).not.toHaveBeenCalled();
  });
});
