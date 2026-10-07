// Import a Vivado project (.xpr) into a fpga-web project.
//
// Accepts either a zip (a zipped project folder, or Vivado's File > Project >
// Archive output) or a set of loose files picked together (the .xpr plus its
// sources). The .xpr says which files make up the design, the constraints and
// the testbenches, the top module and the FPGA part; everything else in a
// Vivado folder (.runs, .cache, .hw, .sim, IP output...) is ignored.
import { strFromU8, unzipSync } from 'fflate';
import type { BoardInfo } from './api';
import { importZip, NAME_RE, type Project } from './project';

// A whole project folder zipped as-is still carries .runs/.cache (checkpoints,
// bitstreams), so the zip may be big; only the entries the .xpr names are
// ever decompressed, and those stay within the backend's per-project limits.
const MAX_ZIP_BYTES = 100_000_000;
const MAX_ZIP_ENTRIES = 20_000;
const MAX_FILES = 50;
const MAX_TOTAL_BYTES = 1_000_000;

const DESIGN_EXTS = new Set(['.v', '.sv', '.vh', '.svh', '.mem', '.hex']);
const VHDL_EXTS = new Set(['.vhd', '.vhdl']);

export type VivadoNote =
  | { kind: 'missing'; file: string }
  | { kind: 'vhdl'; file: string }
  | { kind: 'skipped'; file: string }
  | { kind: 'renamedTb'; file: string; to: string }
  | { kind: 'mergedXdc'; files: string[]; to: string }
  | { kind: 'expandedXdc'; file: string }
  | { kind: 'board'; part: string; board: string; others: string[] }
  | { kind: 'noBoard'; part: string; board: string }
  | { kind: 'guessedTop'; top: string };

export interface ImportResult {
  project: Project;
  notes: VivadoNote[];
  vivado: boolean;
}

export interface Upload {
  name: string;
  bytes: Uint8Array;
}

/** Read access to a set of files by '/'-separated path. */
interface Source {
  paths: string[];
  readMany(paths: string[]): Map<string, Uint8Array>;
}

function zipSource(bytes: Uint8Array): Source {
  if (bytes.length > MAX_ZIP_BYTES) throw new Error('zip too large');
  const paths: string[] = [];
  unzipSync(bytes, {
    filter: (f) => {
      if (paths.length >= MAX_ZIP_ENTRIES) throw new Error('zip has too many entries');
      if (!f.name.endsWith('/')) paths.push(f.name);
      return false;
    },
  });
  return {
    paths,
    readMany(wanted) {
      const set = new Set(wanted);
      let total = 0;
      const out = unzipSync(bytes, {
        filter: (f) => {
          if (!set.has(f.name)) return false;
          total += f.originalSize || 0;
          if (total > MAX_TOTAL_BYTES * 2) throw new Error('project files too large');
          return true;
        },
      });
      return new Map(Object.entries(out));
    },
  };
}

function looseSource(files: Upload[]): Source {
  const byName = new Map(files.map((f) => [f.name, f.bytes]));
  return {
    paths: [...byName.keys()],
    readMany: (wanted) => new Map(wanted.filter((p) => byName.has(p)).map((p) => [p, byName.get(p)!])),
  };
}

const ext = (name: string) => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
};
const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const dirname = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

/** Join and normalise a path, resolving '.' and '..'; null if it climbs above the root. */
function resolvePath(...parts: string[]): string | null {
  const out: string[] = [];
  for (const seg of parts.join('/').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (!out.length) return null;
      out.pop();
    } else out.push(seg);
  }
  return out.join('/');
}

function unescapeXml(s: string): string {
  return s.replace(/&(lt|gt|quot|apos|amp|#\d+|#x[0-9a-f]+);/gi, (m, e: string) => {
    const named: Record<string, string> = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' };
    if (e[0] !== '#') return named[e.toLowerCase()] ?? m;
    return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  });
}

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
  return m ? unescapeXml(m[1]) : undefined;
}

function option(xml: string, name: string): string | undefined {
  const m = new RegExp(`<Option\\s+Name="${name}"\\s+Val="([^"]*)"`).exec(xml);
  return m ? unescapeXml(m[1]) : undefined;
}

interface XprFile {
  path: string;
  enabled: boolean;
}
interface XprFileSet {
  name: string;
  type: string;
  top?: string;
  files: XprFile[];
}
export interface Xpr {
  part: string;
  boardPart: string;
  fileSets: XprFileSet[];
  srcSet?: string;
  constrsSet?: string;
  simSet?: string;
}

/** Pull out of a .xpr just what an import needs (Vivado writes it in a fixed, regular form). */
export function parseXpr(xml: string): Xpr {
  if (!/<Project\b[^>]*Product="Vivado"/.test(xml)) throw new Error('not a Vivado project (.xpr) file');
  const config = /<Configuration>([\s\S]*?)<\/Configuration>/.exec(xml)?.[1] ?? '';
  const fileSets: XprFileSet[] = [];
  for (const m of xml.matchAll(/<FileSet\b([^>]*)>([\s\S]*?)<\/FileSet>/g)) {
    const files: XprFile[] = [];
    for (const f of m[2].matchAll(/<File\b([^>]*?)(?:\/>|>([\s\S]*?)<\/File>)/g)) {
      const path = attr(f[1], 'Path');
      if (!path) continue;
      const info = f[2] ?? '';
      files.push({ path, enabled: !/<Attr\s+Name="IsEnabled"\s+Val="(0|false)"/i.test(info) });
    }
    fileSets.push({ name: attr(m[1], 'Name') ?? '', type: attr(m[1], 'Type') ?? '', top: option(m[2], 'TopModule'), files });
  }
  const synth = [...xml.matchAll(/<Run\b([^>]*)>/g)].map((r) => r[1]).find((r) => /Type="[^"]*Synth/.test(r));
  return {
    part: option(config, 'Part') ?? '',
    boardPart: option(config, 'BoardPart') ?? '',
    fileSets,
    srcSet: synth && attr(synth, 'SrcSet'),
    constrsSet: synth && attr(synth, 'ConstrsSet'),
    simSet: option(config, 'ActiveSimSet'),
  };
}

/** Device + package of a Xilinx part, ignoring speed and temperature grade: xc7a35ticpg236-1L -> xc7a35t/cpg236. */
export function partKey(part: string): string | null {
  const p = part.toLowerCase();
  const vivado = /^(xc7[aksz]\d+t?)[il]?([a-z]{3,4}\d+)-/.exec(p); // xc7a35tcpg236-1, xc7a35ticpg236-1L
  const apio = /^(xc7[aksz]\d+t?)-\d+l?([a-z]{3,4}\d+)$/.exec(p); // XC7A35T-1CPG236
  const m = vivado ?? apio;
  return m ? `${m[1]}/${m[2]}` : null;
}

/** Board for a Vivado part; the .xpr's board part (e.g. digilentinc.com:basys3:part0:1.2) breaks ties. */
export function pickBoard(xpr: Pick<Xpr, 'part' | 'boardPart'>, boards: BoardInfo[], current: string):
  { board: string; matched: boolean; others: string[] } {
  const key = partKey(xpr.part);
  const candidates = key ? boards.filter((b) => partKey(b.part) === key).map((b) => b.id) : [];
  if (!candidates.length) return { board: current, matched: false, others: [] };
  const hint = (xpr.boardPart.split(':')[1] ?? '').toLowerCase().replace(/_/g, '-');
  const board =
    (hint && (candidates.find((id) => id === hint) ?? candidates.find((id) => id.startsWith(hint)))) ||
    (candidates.includes(current) ? current : candidates[0]);
  return { board, matched: true, others: candidates.filter((id) => id !== board) };
}

/** A file name the backend accepts: no directories, safe characters, lower-case extension. */
function safeName(name: string, taken: Set<string>): string {
  const e = ext(name);
  let stem = name.slice(0, name.length - (e ? e.length : 0)).replace(/[^A-Za-z0-9_.-]/g, '_');
  if (!/^[A-Za-z0-9_]/.test(stem)) stem = `_${stem}`;
  stem = stem.slice(0, 60 - e.length);
  let out = stem + e;
  for (let i = 2; taken.has(out.toLowerCase()); i++) out = `${stem}_${i}${e}`;
  taken.add(out.toLowerCase());
  return out;
}

const GET_PORTS_RE = /\[get_ports\s+(\{[^}]*\}|[^\s\]]+)\s*\]/g;
const unbrace = (s: string) => (s.startsWith('{') ? s.slice(1, -1).trim() : s);
const isGlob = (s: string) => /[*?]/.test(s);

/**
 * nextpnr-xilinx ignores wildcards in get_ports, so a Vivado-style
 * `set_property IOSTANDARD LVCMOS33 [get_ports {led[*]}]` silently applies
 * to nothing and placement fails ("has no IOSTANDARD property"). Repeat such
 * a line for every port the file names explicitly that the pattern matches.
 */
export function expandXdcWildcards(text: string): { text: string; changed: boolean } {
  const ports: string[] = [];
  for (const m of text.matchAll(GET_PORTS_RE)) {
    for (const p of unbrace(m[1]).split(/\s+/)) if (p && !isGlob(p) && !ports.includes(p)) ports.push(p);
  }
  let changed = false;
  const lines = text.split('\n').flatMap((line) => {
    if (/^\s*#/.test(line)) return [line];
    const uses = [...line.matchAll(GET_PORTS_RE)];
    if (uses.length !== 1) return [line];
    const pattern = unbrace(uses[0][1]);
    if (!isGlob(pattern) || /\s/.test(pattern)) return [line];
    const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
    const hits = ports.filter((p) => re.test(p));
    if (!hits.length) return [line];
    changed = true;
    return hits.map((p) => line.replace(uses[0][0], `[get_ports {${p}}]`));
  });
  return { text: lines.join('\n'), changed };
}

function decode(bytes: Uint8Array): string {
  const text = strFromU8(bytes);
  return text.startsWith('﻿') ? text.slice(1) : text;
}

/** Top module when the .xpr doesn't name one: the module nothing else instantiates. */
function guessTop(sources: string[], preferred: string): string {
  const modules = sources.flatMap((s) => [...s.matchAll(/^\s*module\s+([A-Za-z_][A-Za-z0-9_$]*)/gm)].map((m) => m[1]));
  const all = sources.join('\n');
  const roots = modules.filter((m) => !new RegExp(`(^|[^\\w$])${m.replace(/\$/g, '\\$')}\\s+(#\\s*\\(|[A-Za-z_][\\w$]*\\s*\\()`).test(all));
  return roots.find((m) => m === preferred) ?? roots[0] ?? modules[0] ?? '';
}

export function importVivado(src: Source, boards: BoardInfo[], currentBoard: string): ImportResult {
  const xprs = src.paths.filter((p) => ext(p) === '.xpr' && !p.startsWith('__MACOSX/'));
  if (!xprs.length) throw new Error('no Vivado project (.xpr) found');
  // A zip of several projects: take the shallowest .xpr.
  const xprPath = xprs.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))[0];
  const xpr = parseXpr(decode(src.readMany([xprPath]).get(xprPath)!));

  const projDir = dirname(xprPath);
  const projName = basename(xprPath).slice(0, -4);
  const vars: Record<string, string> = {
    PPRDIR: projDir,
    PSRCDIR: resolvePath(projDir, `${projName}.srcs`) ?? '',
    PGENDIR: resolvePath(projDir, `${projName}.gen`) ?? '',
    PIPUSERFILESDIR: resolvePath(projDir, `${projName}.ip_user_files`) ?? '',
  };
  const pathSet = new Set(src.paths);
  const byBase = new Map<string, string[]>();
  for (const p of src.paths) byBase.set(basename(p), [...(byBase.get(basename(p)) ?? []), p]);

  // Paths in a .xpr are relative to the project ($PPRDIR...) or absolute on the
  // machine that wrote it. Use the exact path when the upload has it, otherwise
  // the uploaded file with the same name whose directories match best.
  const locate = (raw: string): string | null => {
    const path = raw.replace(/\\/g, '/');
    const expanded = path.replace(/^\$(\w+)/, (m, v: string) => vars[v] ?? m);
    if (!expanded.startsWith('$') && !/^([A-Za-z]:)?\//.test(expanded)) {
      const exact = resolvePath(expanded);
      if (exact !== null && pathSet.has(exact)) return exact;
    }
    const same = byBase.get(basename(path)) ?? [];
    const segs = path.split('/').reverse();
    const score = (p: string) => {
      const ps = p.split('/').reverse();
      let i = 0;
      while (i < ps.length && i < segs.length && ps[i] === segs[i]) i++;
      return i;
    };
    return same.sort((a, b) => score(b) - score(a))[0] ?? null;
  };

  const set = (type: string, name?: string) =>
    xpr.fileSets.find((s) => s.type === type && s.name === name) ?? xpr.fileSets.find((s) => s.type === type);
  const design = set('DesignSrcs', xpr.srcSet);
  const constrs = set('Constrs', xpr.constrsSet);
  const sim = set('SimulationSrcs', xpr.simSet);

  const notes: VivadoNote[] = [];
  type Pick = { from: string; role: 'design' | 'xdc' | 'tb' };
  const picks: Pick[] = [];
  const seen = new Set<string>();
  const take = (fs: XprFileSet | undefined, role: Pick['role']) => {
    for (const f of fs?.files ?? []) {
      if (!f.enabled) continue;
      const shown = basename(f.path.replace(/\\/g, '/'));
      const e = ext(shown);
      if (VHDL_EXTS.has(e)) { notes.push({ kind: 'vhdl', file: shown }); continue; }
      const wanted = role === 'xdc' ? e === '.xdc' : DESIGN_EXTS.has(e);
      if (!wanted) { notes.push({ kind: 'skipped', file: shown }); continue; }
      const at = locate(f.path);
      if (!at) { notes.push({ kind: 'missing', file: shown }); continue; }
      if (seen.has(at)) continue;
      seen.add(at);
      // A header or memory file in the simulation set is support, not a testbench.
      picks.push({ from: at, role: role === 'tb' && !['.v', '.sv'].includes(e) ? 'design' : role });
    }
  };
  take(design, 'design');
  take(constrs, 'xdc');
  take(sim, 'tb');

  const data = src.readMany(picks.map((p) => p.from));
  const taken = new Set<string>();
  const files: Record<string, string> = {};
  let total = 0;
  const add = (name: string, text: string) => {
    files[name] = text;
    total += new TextEncoder().encode(text).length;
  };

  for (const p of picks.filter((p) => p.role !== 'xdc')) {
    let name = basename(p.from);
    if (p.role === 'tb' && !/_tb$/i.test(name.slice(0, -ext(name).length))) {
      const tbName = `${name.slice(0, -ext(name).length)}_tb${ext(name)}`;
      notes.push({ kind: 'renamedTb', file: name, to: tbName });
      name = tbName;
    }
    add(safeName(name, taken), decode(data.get(p.from)!));
  }

  // The build takes exactly one constraint file, so several XDCs become one.
  const xdcs = picks.filter((p) => p.role === 'xdc');
  if (xdcs.length === 1) {
    add(safeName(basename(xdcs[0].from), taken), decode(data.get(xdcs[0].from)!));
  } else if (xdcs.length > 1) {
    const to = safeName(`${projName}.xdc`, taken);
    const parts = xdcs.map((p) => `## ---- ${basename(p.from)} ----\n${decode(data.get(p.from)!).replace(/\n*$/, '\n')}`);
    add(to, parts.join('\n'));
    notes.push({ kind: 'mergedXdc', files: xdcs.map((p) => basename(p.from)), to });
  }
  for (const n of Object.keys(files).filter((n) => ext(n) === '.xdc')) {
    const x = expandXdcWildcards(files[n]);
    if (x.changed) {
      files[n] = x.text;
      notes.push({ kind: 'expandedXdc', file: n });
    }
  }

  const hdl = Object.keys(files).filter((n) => ['.v', '.sv'].includes(ext(n)) && !/_tb\.s?v$/i.test(n));
  if (!hdl.length) throw new Error('the Vivado project has no Verilog design sources that could be found');
  if (Object.keys(files).length > MAX_FILES) throw new Error(`a project can have at most ${MAX_FILES} files`);
  if (total > MAX_TOTAL_BYTES) throw new Error('project files too large');

  let top = design?.top ?? '';
  if (!top) {
    top = guessTop(hdl.map((n) => files[n]), projName);
    notes.push({ kind: 'guessedTop', top });
  }

  const pick = pickBoard(xpr, boards, currentBoard);
  if (pick.matched) notes.push({ kind: 'board', part: xpr.part, board: pick.board, others: pick.others });
  else notes.push({ kind: 'noBoard', part: xpr.part, board: pick.board });

  let name = projName.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64);
  if (!NAME_RE.test(name)) name = `vivado_${name}`.slice(0, 64);
  return {
    project: { id: crypto.randomUUID(), name, board: pick.board, top, files, updatedAt: Date.now() },
    notes,
    vivado: true,
  };
}

/** Import whatever the user picked: a fpga-web export, a zipped Vivado project, or a .xpr with its sources. */
export function importUpload(uploads: Upload[], boards: BoardInfo[], currentBoard: string): ImportResult {
  if (uploads.length === 1 && ext(uploads[0].name) === '.zip') {
    const src = zipSource(uploads[0].bytes);
    if (src.paths.includes('project.json')) return { project: importZip(uploads[0].bytes), notes: [], vivado: false };
    return importVivado(src, boards, currentBoard);
  }
  if (!uploads.some((u) => ext(u.name) === '.xpr')) {
    throw new Error('pick a project .zip, or a Vivado .xpr together with its source files');
  }
  return importVivado(looseSource(uploads), boards, currentBoard);
}
