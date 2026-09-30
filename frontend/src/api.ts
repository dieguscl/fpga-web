export interface BoardInfo {
  id: string;
  description: string;
  arch: 'xilinx' | 'ice40' | 'ecp5' | 'gowin';
  part: string;
  constraint_ext: string;
  bitstream_ext: string;
  flash: 'browser' | 'download';
  ofl_args: string[];
  writes_flash: boolean;
}

export interface Template {
  top: string;
  files: Record<string, string>;
}

export type BuildEvent =
  | { type: 'queued'; position: number }
  | { type: 'step'; name: string }
  | { type: 'log'; line: string }
  | { type: 'done'; kind?: 'build'; bitstream: string; summary: { utilization: Record<string, { used: number; available: number }>; fmax: Record<string, number> } }
  | { type: 'done'; kind: 'sim'; wave: string }
  | { type: 'error'; message: string };

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function json<T>(r: Response): Promise<T> {
  if (!r.ok) {
    let detail = r.statusText;
    try {
      detail = (await r.json()).detail ?? detail;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(r.status, typeof detail === 'string' ? detail : JSON.stringify(detail));
  }
  return r.json() as Promise<T>;
}

export const fetchBoards = () => fetch('/api/boards').then((r) => json<BoardInfo[]>(r));
export const fetchTemplate = (id: string) => fetch(`/api/boards/${encodeURIComponent(id)}/template`).then((r) => json<Template>(r));

export function submitBuild(req: { board: string; top: string; files: Record<string, string>; lint: boolean }) {
  return fetch('/api/build', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(req),
  }).then((r) => json<{ job_id: string; queue_position: number }>(r));
}

export function submitSim(req: { board: string; testbench: string; files: Record<string, string> }) {
  return fetch('/api/simulate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(req),
  }).then((r) => json<{ job_id: string; queue_position: number }>(r));
}

export async function fetchWave(jobId: string): Promise<string> {
  const r = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/wave`);
  if (!r.ok) throw new ApiError(r.status, 'waveform not available (expired?)');
  return r.text();
}

export function streamEvents(jobId: string, onEvent: (ev: BuildEvent) => void, onError?: (message: string) => void): () => void {
  const es = new EventSource(`/api/jobs/${encodeURIComponent(jobId)}/events`);
  let errorCount = 0;

  es.onmessage = (m) => {
    errorCount = 0;
    const ev = JSON.parse(m.data) as BuildEvent;
    onEvent(ev);
    if (ev.type === 'done' || ev.type === 'error') es.close();
  };

  es.onerror = () => {
    errorCount++;
    if (es.readyState === 2 || errorCount >= 5) {
      es.close();
      onEvent({ type: 'error', message: 'lost connection to the build server' });
      onError?.('lost connection to the build server');
    }
  };

  return () => es.close();
}

export const bitstreamUrl = (jobId: string) => `/api/jobs/${encodeURIComponent(jobId)}/bitstream`;

export async function fetchBitstream(jobId: string): Promise<Uint8Array> {
  const r = await fetch(bitstreamUrl(jobId));
  if (!r.ok) throw new ApiError(r.status, 'bitstream not available (expired?)');
  return new Uint8Array(await r.arrayBuffer());
}
