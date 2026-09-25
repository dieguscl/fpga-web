import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { exportZip, importZip, newProject, ProjectStore } from '../src/project';

const tpl = { top: 'main', files: { 'main.v': 'module main; endmodule\n', 'p.xdc': '' } };

describe('projects', () => {
  it('zip roundtrip keeps files and metadata', () => {
    const p = newProject('demo', 'basys3', tpl);
    const q = importZip(exportZip(p));
    expect(q.name).toBe('demo');
    expect(q.board).toBe('basys3');
    expect(q.top).toBe('main');
    expect(q.files).toEqual(p.files);
    expect(q.id).not.toBe(p.id);
  });

  it('rejects zips with bad file names', async () => {
    const { zipSync, strToU8 } = await import('fflate');
    const bad = zipSync({
      'project.json': strToU8(JSON.stringify({ name: 'x', board: 'basys3', top: 'main' })),
      '../evil.v': strToU8('x'),
    });
    expect(() => importZip(bad)).toThrow(/file name/);
  });

  it('rejects zips without project.json', async () => {
    const { zipSync, strToU8 } = await import('fflate');
    expect(() => importZip(zipSync({ 'a.v': strToU8('x') }))).toThrow(/project.json/);
  });

  it('store saves, lists newest first, removes', async () => {
    const store = new ProjectStore('test-db');
    const a = newProject('a', 'basys3', tpl);
    const b = { ...newProject('b', 'basys3', tpl), updatedAt: a.updatedAt + 10 };
    await store.save(a);
    await store.save(b);
    expect((await store.list()).map((p) => p.name)).toEqual(['b', 'a']);
    await store.remove(a.id);
    expect((await store.list()).map((p) => p.name)).toEqual(['b']);
    expect(await store.get(b.id)).toEqual(b);
  });

  it('rejects zips with too many entries', async () => {
    const { zipSync, strToU8 } = await import('fflate');
    const entries: Record<string, Uint8Array> = {
      'project.json': strToU8(JSON.stringify({ name: 'x', board: 'basys3', top: 'main' })),
    };
    for (let i = 0; i < 60; i++) {
      entries[`file${i}.v`] = strToU8('x');
    }
    const bad = zipSync(entries);
    expect(() => importZip(bad)).toThrow(/too many/);
  });

  it('rejects zips with entries exceeding size limit', async () => {
    const { zipSync, strToU8 } = await import('fflate');
    const largeContent = strToU8('x'.repeat(1_100_000));
    const bad = zipSync({
      'project.json': strToU8(JSON.stringify({ name: 'x', board: 'basys3', top: 'main' })),
      'large.v': largeContent,
    });
    expect(() => importZip(bad)).toThrow(/too large/);
  });

  it('rejects zips with invalid project.json (wrong name type)', async () => {
    const { zipSync, strToU8 } = await import('fflate');
    const bad = zipSync({
      'project.json': strToU8(JSON.stringify({ name: 1, board: 'basys3', top: 'main' })),
      'a.v': strToU8('x'),
    });
    expect(() => importZip(bad)).toThrow(/invalid project.json/);
  });

  it('rejects zips with missing project.json fields', async () => {
    const { zipSync, strToU8 } = await import('fflate');
    const bad = zipSync({
      'project.json': strToU8(JSON.stringify({ name: 'x', board: 'basys3' })),
      'a.v': strToU8('x'),
    });
    expect(() => importZip(bad)).toThrow(/invalid project.json/);
  });
});
