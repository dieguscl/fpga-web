import type { BoardInfo } from './api';

export function webUsbSupported(): boolean {
  return typeof navigator !== 'undefined' && 'usb' in navigator;
}

export function buildOflArgs(board: BoardInfo, fileName: string, toFlash: boolean): string[] {
  if (board.flash !== 'browser') throw new Error(`${board.id} is download-only; flash it with your own tool`);
  const args = [...board.ofl_args];
  if (toFlash && !board.writes_flash && !args.includes('-f') && !args.includes('--write-flash')) args.push('-f');
  return [...args, fileName];
}

export async function flash(board: BoardInfo, bitstream: Uint8Array, toFlash: boolean,
                            onLog: (text: string) => void): Promise<void> {
  if (!webUsbSupported()) throw new Error('This browser has no WebUSB. Use Chrome or Edge, or download the bitstream.');
  const { runOpenFPGALoader } = await import('@yowasp/openfpgaloader');
  try {
    await navigator.usb.requestDevice({ filters: runOpenFPGALoader.requiresUSBDevice as USBDeviceFilter[] });
  } catch {
    throw new Error('No USB device selected.');
  }
  const fileName = `${board.id}${board.bitstream_ext}`;
  const decoder = new TextDecoder();
  const out = (bytes: Uint8Array | null) => {
    if (bytes) onLog(decoder.decode(bytes, { stream: true }));
  };
  try {
    await runOpenFPGALoader(buildOflArgs(board, fileName, toFlash), { [fileName]: bitstream }, { stdout: out, stderr: out });
  } catch (e) {
    const code = (e as { code?: number }).code;
    throw new Error(code !== undefined ? `openFPGALoader exited with code ${code}` : String(e));
  }
}
