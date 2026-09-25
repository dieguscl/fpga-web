import { createStore, del, get, set, values, type UseStore } from 'idb-keyval';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import type { Template } from './api';

export interface Project {
  id: string;
  name: string;
  board: string;
  top: string;
  files: Record<string, string>;
  updatedAt: number;
}

const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;

export function newProject(name: string, board: string, tpl: Template): Project {
  return { id: crypto.randomUUID(), name, board, top: tpl.top, files: { ...tpl.files }, updatedAt: Date.now() };
}

export class ProjectStore {
  private store: UseStore;
  constructor(dbName = 'fpga-web') {
    this.store = createStore(dbName, 'projects');
  }
  async list(): Promise<Project[]> {
    const all = (await values(this.store)) as Project[];
    return all.sort((a, b) => b.updatedAt - a.updatedAt);
  }
  get(id: string): Promise<Project | undefined> {
    return get(id, this.store);
  }
  save(p: Project): Promise<void> {
    return set(p.id, p, this.store);
  }
  remove(id: string): Promise<void> {
    return del(id, this.store);
  }
}

export function exportZip(p: Project): Uint8Array {
  const entries: Record<string, Uint8Array> = {
    'project.json': strToU8(JSON.stringify({ name: p.name, board: p.board, top: p.top })),
  };
  for (const [name, text] of Object.entries(p.files)) entries[name] = strToU8(text);
  return zipSync(entries);
}

export function importZip(bytes: Uint8Array): Project {
  const entries = unzipSync(bytes);
  const meta = entries['project.json'];
  if (!meta) throw new Error('zip has no project.json');
  const { name, board, top } = JSON.parse(strFromU8(meta));
  const files: Record<string, string> = {};
  for (const [path, data] of Object.entries(entries)) {
    if (path === 'project.json' || path.endsWith('/')) continue;
    if (!NAME_RE.test(path)) throw new Error(`invalid file name in zip: ${path}`);
    files[path] = strFromU8(data);
  }
  return { id: crypto.randomUUID(), name: String(name), board: String(board), top: String(top), files, updatedAt: Date.now() };
}
