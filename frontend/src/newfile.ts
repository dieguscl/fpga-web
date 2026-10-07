// "New file" by kind: the user picks what the file is for and gets a sensible
// name and starter content instead of having to type a name with the right
// extension.

export type FileKind = 'module' | 'constraints' | 'testbench' | 'circuit' | 'header' | 'memory';

export const FILE_KINDS: FileKind[] = ['module', 'constraints', 'testbench', 'circuit', 'header', 'memory'];

const STEM = { module: 'module', circuit: 'circuit', header: 'defines', memory: 'data' } as const;
const EXT = { module: '.v', circuit: '.circ', header: '.vh', memory: '.mem' } as const;

/** Verilog identifier: module and circuit names become module names. */
export const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,59}$/;
const STEM_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,59}$/;

export interface NewFilePlan {
  /** File to create, or to open when it already exists. */
  name: string;
  /** Name is fixed by the project (one constraint file per board, testbench named after top). */
  fixed: boolean;
  /** The file already exists and will just be opened. */
  exists: boolean;
  /** Extension shown after the editable stem. */
  ext: string;
  stem: string;
}

const isConstraint = (n: string) => /\.(xdc|pcf|lpf|cst)$/i.test(n);

/** Default name for a new file of this kind in a project with these files. */
export function planNewFile(kind: FileKind, files: Record<string, string>, constraintExt: string, top: string): NewFilePlan {
  if (kind === 'constraints') {
    const existing = Object.keys(files).find(isConstraint);
    if (existing) return { name: existing, fixed: true, exists: true, ext: '', stem: existing };
    return { name: `pins${constraintExt}`, fixed: false, exists: false, ext: constraintExt, stem: 'pins' };
  }
  if (kind === 'testbench') {
    const name = `${top}_tb.v`;
    return { name, fixed: true, exists: name in files, ext: '.v', stem: `${top}_tb` };
  }
  const ext = EXT[kind];
  let stem: string = STEM[kind];
  for (let i = 1; ; i++) {
    stem = `${STEM[kind]}${i}`;
    if (!(`${stem}${ext}` in files)) break;
  }
  return { name: `${stem}${ext}`, fixed: false, exists: false, ext, stem };
}

/** Check a user-edited stem; returns an error key or null. */
export function checkStem(kind: FileKind, stem: string, ext: string, files: Record<string, string>):
  'invalid' | 'exists' | null {
  const re = kind === 'module' || kind === 'circuit' ? IDENT_RE : STEM_RE;
  if (!re.test(stem)) return 'invalid';
  if (`${stem}${ext}` in files) return 'exists';
  return null;
}

/** Starter content for module, constraint, header and memory files. */
export function starterContent(kind: FileKind, stem: string, ext: string, board: string): string {
  switch (kind) {
    case 'module':
      return `module ${stem} (\n    // ports, e.g.  input wire clk,  output wire [3:0] led\n);\n\nendmodule\n`;
    case 'header':
      return `// Shared definitions: \`include "${stem}${ext}" where needed\n\n`;
    case 'memory':
      return '// Data for $readmemh: one hex value per line\n00\n';
    case 'constraints':
      return {
        '.xdc': `## Pin constraints for ${board}\n## set_property -dict { PACKAGE_PIN W5 IOSTANDARD LVCMOS33 } [get_ports clk]\n\n`,
        '.pcf': `# Pin constraints for ${board}\n# set_io clk 21\n\n`,
        '.lpf': `# Pin constraints for ${board}\n# LOCATE COMP "clk" SITE "P3";\n# IOBUF PORT "clk" IO_TYPE=LVCMOS33;\n\n`,
        '.cst': `// Pin constraints for ${board}\n// IO_LOC "clk" 52;\n\n`,
      }[ext] ?? '';
    default:
      return '';
  }
}
