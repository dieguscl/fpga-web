// Lightweight Verilog/SystemVerilog top-module port scanner for the pin planner.
// Not a full parser: handles ANSI and non-ANSI port lists, vectors, simple
// parameter arithmetic in ranges, and comments. Anything it can't size is
// reported as a scalar with a warning.

export type PortDir = 'input' | 'output' | 'inout';

export interface Port {
  name: string;
  dir: PortDir;
  msb: number | null;
  lsb: number | null;
}

export interface PortScan {
  ports: Port[];
  warnings: string[];
}

export interface PortBit {
  bit: string; // "led[3]" or "clk"
  port: string;
  dir: PortDir;
}

const DIR_RE = /^(input|output|inout)\b/;
const TYPE_WORDS = new Set(['wire', 'reg', 'logic', 'signed', 'unsigned', 'var', 'tri', 'bit']);
const IDENT = /^[A-Za-z_][A-Za-z0-9_$]*/;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/** Evaluate a tiny integer expression (numbers, parameters, + - * / parentheses). */
function evalExpr(expr: string, params: Map<string, number>): number | null {
  const replaced = expr.replace(/[A-Za-z_][A-Za-z0-9_$]*/g, (id) => {
    const v = params.get(id);
    return v === undefined ? 'NaN' : String(v);
  });
  if (!/^[\d\s+\-*/()NaN]+$/.test(replaced)) return null;
  try {
    // Safe: the string only contains digits, whitespace, operators, parens and "NaN".
    const v = Function(`"use strict"; return (${replaced});`)() as number;
    return Number.isFinite(v) ? Math.trunc(v) : null;
  } catch {
    return null;
  }
}

function collectParams(text: string): Map<string, number> {
  const params = new Map<string, number>();
  const re = /\b(?:parameter|localparam)\b(?:\s+(?:integer|int|signed|\[[^\]]*\]))*\s+([A-Za-z_][\w$]*)\s*=\s*([^,;)]+)/g;
  for (const m of text.matchAll(re)) {
    const v = evalExpr(m[2].replace(/\d+'[sS]?[dD](\d+)/g, '$1'), params);
    if (v !== null) params.set(m[1], v);
  }
  return params;
}

/** Split a declaration list on top-level commas (ignores commas inside [] and ()). */
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '[' || ch === '(' || ch === '{') depth++;
    if (ch === ']' || ch === ')' || ch === '}') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

interface Decl {
  dir: PortDir;
  range: string | null;
  names: string[];
}

/** Parse "input wire [7:0] a" or a continuation "b" (dir inherited). */
function parseDeclItem(item: string, prev: Decl | null): Decl | null {
  let rest = item.trim();
  let dir = prev?.dir ?? null;
  let range = prev?.range ?? null;
  const d = DIR_RE.exec(rest);
  if (d) {
    dir = d[1] as PortDir;
    range = null;
    rest = rest.slice(d[0].length).trim();
    for (;;) {
      const w = IDENT.exec(rest);
      if (w && TYPE_WORDS.has(w[0])) rest = rest.slice(w[0].length).trim();
      else break;
    }
    const r = /^\[([^\]]*)\]/.exec(rest);
    if (r) {
      range = r[1];
      rest = rest.slice(r[0].length).trim();
    }
  }
  if (!dir) return null;
  const name = IDENT.exec(rest);
  if (!name) return null;
  return { dir, range, names: [name[0]] };
}

function sizeRange(range: string | null, params: Map<string, number>): { msb: number | null; lsb: number | null; ok: boolean } {
  if (range === null) return { msb: null, lsb: null, ok: true };
  const parts = range.split(':');
  if (parts.length !== 2) return { msb: null, lsb: null, ok: false };
  const msb = evalExpr(parts[0], params);
  const lsb = evalExpr(parts[1], params);
  if (msb === null || lsb === null) return { msb: null, lsb: null, ok: false };
  return { msb, lsb, ok: true };
}

export function findModulePorts(files: Record<string, string>, top: string): PortScan {
  const warnings: string[] = [];
  for (const [fname, raw] of Object.entries(files)) {
    if (!/\.s?v$/i.test(fname)) continue;
    const text = stripComments(raw);
    const modRe = /\bmodule\s+([A-Za-z_][\w$]*)/g;
    for (const m of text.matchAll(modRe)) {
      if (m[1] !== top) continue;
      const start = (m.index ?? 0) + m[0].length;
      const endIdx = text.indexOf('endmodule', start);
      const body = text.slice(start, endIdx < 0 ? undefined : endIdx);
      const params = collectParams(body);

      // Skip an optional #( ... ) parameter block, then take the ( ... ) port list.
      let i = 0;
      const skipWs = () => { while (i < body.length && /\s/.test(body[i])) i++; };
      const matchParens = (from: number): number => {
        let depth = 0;
        for (let j = from; j < body.length; j++) {
          if (body[j] === '(') depth++;
          else if (body[j] === ')' && --depth === 0) return j;
        }
        return -1;
      };
      skipWs();
      if (body[i] === '#') {
        i++;
        skipWs();
        const close = matchParens(i);
        i = close < 0 ? body.length : close + 1;
        skipWs();
      }
      let header = '';
      let afterHeader = i;
      if (body[i] === '(') {
        const close = matchParens(i);
        header = body.slice(i + 1, close < 0 ? body.length : close);
        afterHeader = close < 0 ? body.length : close + 1;
      }

      const decls: Decl[] = [];
      let prev: Decl | null = null;
      const headerItems = splitTop(header).map((s) => s.trim()).filter(Boolean);
      const ansi = headerItems.some((s) => DIR_RE.test(s));
      if (ansi) {
        for (const item of headerItems) {
          const d = parseDeclItem(item, prev);
          if (d) {
            decls.push(d);
            prev = d;
          }
        }
      } else {
        const order = headerItems.map((s) => IDENT.exec(s)?.[0]).filter((s): s is string => !!s);
        const found = new Map<string, Decl>();
        const stmts = body.slice(afterHeader).split(';');
        for (const st of stmts) {
          const s = st.trim();
          if (!DIR_RE.test(s)) continue;
          let p: Decl | null = null;
          for (const item of splitTop(s)) {
            const d = parseDeclItem(item, p);
            if (d) {
              p = d;
              for (const n of d.names) found.set(n, d);
            }
          }
        }
        for (const n of order) {
          const d = found.get(n);
          if (d) decls.push({ ...d, names: [n] });
          else warnings.push(`port ${n} has no input/output declaration`);
        }
      }

      const ports: Port[] = [];
      for (const d of decls) {
        const size = sizeRange(d.range, params);
        if (!size.ok) warnings.push(`could not work out the width of ${d.names.join(', ')} ([${d.range}])`);
        for (const n of d.names) ports.push({ name: n, dir: d.dir, msb: size.msb, lsb: size.lsb });
      }
      return { ports, warnings };
    }
  }
  return { ports: [], warnings: [`top module "${top}" not found in the project's Verilog files`] };
}

export function expandBits(ports: Port[]): PortBit[] {
  const out: PortBit[] = [];
  for (const p of ports) {
    if (p.msb === null || p.lsb === null) {
      out.push({ bit: p.name, port: p.name, dir: p.dir });
      continue;
    }
    const lo = Math.min(p.msb, p.lsb);
    const hi = Math.max(p.msb, p.lsb);
    for (let k = lo; k <= hi; k++) out.push({ bit: `${p.name}[${k}]`, port: p.name, dir: p.dir });
  }
  return out;
}
