import type { BoardInfo } from './api';
import { t } from './i18n';

export function webUsbSupported(): boolean {
  return typeof navigator !== 'undefined' && 'usb' in navigator;
}

export function buildOflArgs(board: BoardInfo, fileName: string, toFlash: boolean): string[] {
  if (board.flash !== 'browser') throw new Error(t('flash.downloadOnly', { board: board.id }));
  const args = [...board.ofl_args];
  if (toFlash && !board.writes_flash && !args.includes('-f') && !args.includes('--write-flash')) args.push('-f');
  return [...args, fileName];
}

export async function flash(board: BoardInfo, bitstream: Uint8Array, toFlash: boolean,
                            onLog: (text: string) => void): Promise<void> {
  if (!webUsbSupported()) throw new Error(t('flash.noWebUsb'));
  const fileName = `${board.id}${board.bitstream_ext}`;
  const args = buildOflArgs(board, fileName, toFlash);
  const { runOpenFPGALoader } = await import('@yowasp/openfpgaloader');
  try {
    await navigator.usb.requestDevice({ filters: runOpenFPGALoader.requiresUSBDevice as USBDeviceFilter[] });
  } catch {
    throw new Error(t('flash.noDevice'));
  }
  const decoder = new TextDecoder();
  const out = (bytes: Uint8Array | null) => {
    if (bytes) onLog(decoder.decode(bytes, { stream: true }));
  };
  try {
    await runOpenFPGALoader(args, { [fileName]: bitstream }, { stdout: out, stderr: out });
  } catch (e) {
    const code = (e as { code?: number }).code;
    if (code !== undefined) throw new Error(t('flash.exitCode', { code }));
    throw e instanceof Error ? e : new Error(String(e));
  }
}
