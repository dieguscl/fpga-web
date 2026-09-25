export interface Location {
  file: string;
  line: number;
}

const LOC_RE = /(?:^|[\s/:(])([A-Za-z0-9_][A-Za-z0-9_.-]*\.(?:sv|v|vh|svh|xdc|pcf|lpf|cst)):(\d+)/g;

export function parseLocations(text: string): Location[] {
  const out: Location[] = [];
  for (const m of text.matchAll(LOC_RE)) out.push({ file: m[1], line: Number(m[2]) });
  return out;
}
