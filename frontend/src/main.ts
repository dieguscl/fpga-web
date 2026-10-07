import '@fontsource/space-grotesk/500.css';
import '@fontsource/space-grotesk/700.css';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/700.css';
import { ApiError, fetchBitstream, fetchNetlist, fetchWave, submitNetlist, submitSim, fetchBoards, fetchTemplate, streamEvents, submitBuild, type BoardInfo, type BuildEvent, fetchConfig, fetchShare, reportShare } from './api';
import { Editor, plainQuotes, vimEnabled } from './editor';
import { parseLocations } from './errors';
import { applyTheme, getTheme, onThemeChange, setTheme, type ThemeChoice } from './theme';
import { decorateIcons } from './icons';
import { ShareDialog, shareIdFromPath } from './share';
import { applyStatic, getLang, LANGS, onLangChange, setLang, t, type Key, type Lang } from './i18n';
import { PinPlanner } from './pinplanner';
import { findModulePorts } from './verilog-ports';
import { generateTestbench, testbenchName } from './tbgen';
import { parseVcd } from './vcd';
import { WaveformViewer } from './waveform';
import { VirtualBoard } from './boardsim/board';
import { CircuitEditor } from './circuit/editor';
import { emptyCircuit, parseCircuit, serializeCircuit, type Circuit } from './circuit/model';
import { subInterfaces } from './circuit/sim';
import { generateVerilog } from './circuit/verilog';
import { flash, webUsbSupported } from './flasher';
import { exportZip, newProject, ProjectStore, type Project } from './project';
import { importUpload, type VivadoNote } from './vivado';
import { checkStem, FILE_KINDS, planNewFile, starterContent, type FileKind } from './newfile';
import { detectOS, setupHelpHtml } from './setup-help';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const store = new ProjectStore();
let boards: BoardInfo[] = [];
let project: Project;
let currentFile = '';
let lastBitstream: { data: Uint8Array; board: BoardInfo } | null = null;
let saveTimer: number | undefined;
// The project a pending debounced save is for, captured at schedule time
// (not read from the `project` module binding when the timer fires) --
// otherwise a project switch inside the debounce window saves the *new*
// project instead of the old one, silently dropping the old one's last
// edit (it was only ever applied in memory to the old, now-discarded
// Project object).
let pendingSave: Project | null = null;
// Bumped on every project switch/creation so a slower, earlier-started load
// (e.g. the initial default-project bootstrap) can detect it has been
// superseded and avoid clobbering a newer one once its awaits resolve.
let projectGen = 0;
// Bumped by resetOutput() (project switch, new build, etc.) so a build's
// event-stream callback can tell it has been superseded and stop touching
// the UI / lastBitstream, even though the stream itself is also closed.
let buildGen = 0;
let closeStream: (() => void) | null = null;

const editor = new Editor($('editor'), (text) => {
  if (!currentFile) return; // no file open (e.g. after deleting the last file) -- nothing to persist
  project.files[currentFile] = text;
  scheduleSave();
});

function scheduleSave() {
  const p = project;
  p.updatedAt = Date.now();
  pendingSave = p;
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(flushSave, 400);
}

function flushSave() {
  clearTimeout(saveTimer);
  saveTimer = undefined;
  const p = pendingSave;
  pendingSave = null;
  if (p) void store.save(p);
}

// A pending save must not be silently lost when the tab is backgrounded or
// closed before the 400ms debounce fires.
window.addEventListener('pagehide', flushSave);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushSave();
});

function boardInfo(id: string): BoardInfo | undefined {
  return boards.find((b) => b.id === id);
}

// These controls read/mutate the module-level `project` singleton, so they
// stay disabled until the initial project (existing or freshly created) has
// finished loading. Without this, a fast click/selectOption racing the
// still-in-flight default-project bootstrap (network + IndexedDB awaits)
// could fire before `project` exists, or be clobbered when the bootstrap's
// own openProject() call lands afterwards. Playwright (and real users)
// naturally wait for a control to become enabled before interacting with
// it, so this serializes interaction after the bootstrap deterministically.
const GATED_CONTROLS = ['board', 'new-project', 'project', 'import', 'export', 'share', 'add-file', 'new-tb', 'new-circuit', 'build', 'simulate'];
function setControlsReady(ready: boolean) {
  for (const id of GATED_CONTROLS) ($(id) as HTMLButtonElement | HTMLSelectElement).disabled = !ready;
}

// The status line remembers its message key so a language switch can re-render it.
let lastStatus: { key: Key; vars: Record<string, string | number>; kind: '' | 'ok' | 'err' } = { key: 'status.ready', vars: {}, kind: '' };
function setStatus(key: Key, vars: Record<string, string | number> = {}, kind: '' | 'ok' | 'err' = '') {
  lastStatus = { key, vars, kind };
  const s = $('status');
  s.textContent = t(key, vars);
  s.className = kind;
}

function renderFiles() {
  refreshTestbenches();
  const ul = $('file-list');
  ul.replaceChildren();
  for (const name of Object.keys(project.files).sort()) {
    const li = document.createElement('li');
    li.className = name === currentFile ? 'active' : '';
    const label = document.createElement('span');
    label.textContent = name;
    const rm = document.createElement('button');
    rm.textContent = '×';
    rm.title = t('file.delete.title', { name });
    rm.onclick = (e) => {
      e.stopPropagation();
      if (!confirm(t('file.delete.confirm', { name }))) return;
      delete project.files[name];
      scheduleSave();
      // Only move the open file if the *open* file was the one deleted --
      // deleting some other file in the list shouldn't change what's shown.
      if (name === currentFile) openFile(Object.keys(project.files).sort()[0] ?? '');
      else renderFiles();
    };
    li.append(label, rm);
    li.onclick = () => openFile(name);
    ul.append(li);
  }
}

// Pin planner: .xdc files on boards with a planner open as a board picture
// (Board view) with a Text toggle. The planner rewrites the .xdc on each change.
const PLANNER_BOARDS = new Set(['basys3']);
let fileView: 'board' | 'text' = 'board';
const planner = new PinPlanner($('planner'), (xdc) => {
  if (!currentFile) return;
  project.files[currentFile] = xdc;
  scheduleSave();
});

function plannerApplies(name: string): boolean {
  return !!project && PLANNER_BOARDS.has(project.board) && /\.xdc$/i.test(name);
}

// Editor panel tabs: the code/planner view, or the last simulation's waveform.
let mainTab: 'code' | 'wave' | 'board' = 'code';
const waveViewer = new WaveformViewer($('wave'));

// ── Drawn circuits (.circ) ─────────────────────────────────────────────────
// Each name.circ generates the Verilog module name.v on every change.
const CIRCUIT_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
let loadedCircuit = '';

function projectCircuits(): Map<string, Circuit> {
  const out = new Map<string, Circuit>();
  for (const [name, text] of Object.entries(project?.files ?? {})) {
    if (name.endsWith('.circ')) out.set(name.slice(0, -5), parseCircuit(text));
  }
  return out;
}

function isGeneratedVerilog(name: string): boolean {
  return name.endsWith('.v') && `${name.slice(0, -2)}.circ` in (project?.files ?? {});
}

/** Regenerate every circuit's Verilog (a sub-circuit's ports may have changed). */
function regenerateCircuits(): boolean {
  const circuits = projectCircuits();
  const subs = subInterfaces(circuits);
  let added = false;
  for (const [name, circ] of circuits) {
    const file = `${name}.v`;
    if (!(file in project.files)) added = true;
    project.files[file] = generateVerilog(name, circ, subs, `${name}.circ`).verilog;
  }
  return added;
}

const circuitEditor = new CircuitEditor($('circuit'), {
  onChange: (circ) => {
    if (!currentFile.endsWith('.circ')) return;
    project.files[currentFile] = serializeCircuit(circ);
    if (regenerateCircuits()) renderFiles();
    scheduleSave();
  },
  circuits: projectCircuits,
});

function newCircuit(name: string) {
  if (!CIRCUIT_NAME.test(name)) return alert(t('alert.badCircuitName'));
  const file = `${name}.circ`;
  if (!(file in project.files)) {
    project.files[file] = serializeCircuit(emptyCircuit());
    regenerateCircuits();
    scheduleSave();
  }
  openFile(file);
}

// New file: pick what the file is for; name and starter content are filled in.
let newFileKind: FileKind = 'module';
let newFileStemEdited = false;

function newFilePlan() {
  return planNewFile(newFileKind, project.files, boardInfo(project.board)?.constraint_ext ?? '.xdc',
    $<HTMLInputElement>('top').value.trim() || project.top);
}

function renderNewFileDialog(resetStem: boolean) {
  const plan = newFilePlan();
  const ext = boardInfo(project.board)?.constraint_ext ?? '.xdc';
  $('newfile-kinds').replaceChildren(...FILE_KINDS.map((k) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'newfile-kind' + (k === newFileKind ? ' active' : '');
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(k === newFileKind));
    const title = document.createElement('span');
    title.textContent = t(`newfile.kind.${k}` as Key);
    const desc = document.createElement('small');
    desc.textContent = t(`newfile.kind.${k}.desc` as Key, { ext });
    b.append(title, desc);
    b.onclick = () => { newFileKind = k; newFileStemEdited = false; renderNewFileDialog(true); };
    return b;
  }));
  const stem = $<HTMLInputElement>('newfile-stem');
  if (resetStem || !newFileStemEdited) stem.value = plan.stem;
  stem.disabled = plan.fixed;
  $('newfile-ext').textContent = plan.ext;
  validateNewFile();
}

function validateNewFile(): boolean {
  const plan = newFilePlan();
  const hint = $('newfile-hint');
  const ok = $<HTMLButtonElement>('newfile-ok');
  hint.classList.remove('err');
  ok.textContent = t(plan.exists ? 'newfile.open' : 'newfile.create');
  if (newFileKind === 'constraints' && plan.exists) hint.textContent = t('newfile.hint.constraintsExists', { name: plan.name });
  else if (newFileKind === 'testbench') hint.textContent = plan.exists ? t('newfile.hint.testbenchExists', { name: plan.name }) : t('newfile.hint.testbench', { top: plan.stem.slice(0, -3) });
  else hint.textContent = newFileKind === 'module' || newFileKind === 'circuit' ? t('newfile.hint.module') : '';
  if (plan.fixed) { ok.disabled = false; return true; }
  const err = checkStem(newFileKind, $<HTMLInputElement>('newfile-stem').value.trim(), plan.ext, project.files);
  if (err) { hint.textContent = t(`newfile.err.${err}`); hint.classList.add('err'); }
  ok.disabled = !!err;
  return !err;
}

function openNewFileDialog(kind: FileKind) {
  newFileKind = kind;
  newFileStemEdited = false;
  renderNewFileDialog(true);
  const dlg = $<HTMLDialogElement>('newfile-dialog');
  dlg.showModal();
  const stem = $<HTMLInputElement>('newfile-stem');
  if (!stem.disabled) stem.select();
}

function createNewFile() {
  if (!validateNewFile()) return;
  const plan = newFilePlan();
  const stem = plan.fixed ? plan.stem : $<HTMLInputElement>('newfile-stem').value.trim();
  const name = plan.fixed ? plan.name : `${stem}${plan.ext}`;
  if (newFileKind === 'testbench') return newTestbench();
  if (newFileKind === 'circuit') return newCircuit(stem);
  if (!(name in project.files)) {
    project.files[name] = starterContent(newFileKind, stem, plan.ext, project.board);
    scheduleSave();
  }
  openFile(name);
}

/** Replace typographic quotes/dashes (from code copied out of PDFs/Word) in HDL files; returns the changed files. */
function vivadoNote(n: VivadoNote): string {
  switch (n.kind) {
    case 'missing': return t('log.vivado.missing', { file: n.file });
    case 'vhdl': return t('log.vivado.vhdl', { file: n.file });
    case 'skipped': return t('log.vivado.skipped', { file: n.file });
    case 'renamedTb': return t('log.vivado.renamedTb', { file: n.file, to: n.to });
    case 'mergedXdc': return t('log.vivado.mergedXdc', { files: n.files.join(', '), to: n.to });
    case 'expandedXdc': return t('log.vivado.expandedXdc', { file: n.file });
    case 'guessedTop': return t('log.vivado.guessedTop', { top: n.top });
    case 'noBoard': return t('log.vivado.noBoard', { part: n.part || '?', board: n.board });
    case 'board':
      return t('log.vivado.board', { part: n.part, board: n.board }) +
        (n.others.length ? ' ' + t('log.vivado.boardOthers', { others: n.others.join(', ') }) : '');
  }
}

function fixTypography(p: Project): string[] {
  const changed: string[] = [];
  for (const [name, text] of Object.entries(p.files)) {
    if (!/\.(sv|v|svh|vh)$/.test(name)) continue;
    const fixed = plainQuotes(text);
    if (fixed !== text) {
      p.files[name] = fixed;
      changed.push(name);
    }
  }
  return changed;
}

/** Fix the open project before sending it to the server, and say so in the log. */
function fixTypographyInProject(): void {
  const before = currentFile ? project.files[currentFile] : undefined;
  const changed = fixTypography(project);
  if (!changed.length) return;
  if (currentFile && changed.includes(currentFile) && before !== undefined) editor.replaceText(project.files[currentFile]);
  scheduleSave();
  appendLog(t('log.fixedQuotes', { files: changed.join(', ') }));
}

/** Files the server understands (drawn circuits are sent as their generated Verilog). */
function sourceFiles(): Record<string, string> {
  return Object.fromEntries(Object.entries(project.files).filter(([n]) => !n.endsWith('.circ')));
}

// Virtual Basys 3 (Board tab): builds a gate-level netlist on the server and runs it in a worker.
const VBOARD_BOARDS = new Set(['basys3']);
const virtualBoard = new VirtualBoard($('vboard'), {
  load: async (speedup) => {
    const top = $<HTMLInputElement>('top').value.trim() || project.top;
    const xdcName = Object.keys(project.files).find((n) => n.endsWith('.xdc'));
    resetOutput();
    fixTypographyInProject();
    const gen = buildGen;
    appendLog('== virtual board');
    const { job_id } = await submitNetlist({ board: project.board, top, files: sourceFiles(), speedup });
    await new Promise<void>((resolve, reject) => {
      closeStream = streamEvents(job_id, (ev) => {
        if (gen !== buildGen) return reject(new Error('cancelled'));
        if (ev.type === 'step') appendLog(`== ${ev.name}`);
        else if (ev.type === 'log') appendLog(ev.line);
        else if (ev.type === 'error') reject(new Error(ev.message));
        else if (ev.type === 'done') resolve();
      });
    });
    const netlist = (await fetchNetlist(job_id)) as { modules: Record<string, { ports: Record<string, { bits: (number | string)[]; offset?: number }> }> };
    return { netlist, top, xdc: xdcName ? project.files[xdcName] : '' };
  },
});

function showView() {
  $('tab-board').hidden = !(project && VBOARD_BOARDS.has(project.board));
  if (mainTab === 'board' && $('tab-board').hidden) mainTab = 'code';
  const vboard = mainTab === 'board';
  $('vboard').hidden = !vboard;
  if (!vboard) virtualBoard.stop();
  $('tab-board').classList.toggle('active', vboard);
  const wave = mainTab === 'wave' && !$('tab-wave').hidden;
  $('wave').hidden = !wave;
  $('tab-code').classList.toggle('active', !wave && !vboard);
  $('tab-wave').classList.toggle('active', wave);
  if (vboard) {
    for (const id of ['circuit', 'planner', 'editor', 'view-toggle']) $(id).hidden = true;
    return;
  }
  const circuit = !wave && currentFile.endsWith('.circ');
  $('circuit').hidden = !circuit;
  const usePlanner = !wave && !circuit && plannerApplies(currentFile);
  $('view-toggle').hidden = !usePlanner;
  const board = usePlanner && fileView === 'board';
  $('planner').hidden = !board;
  $('editor').hidden = board || wave || circuit;
  if (wave) return;
  if (circuit) {
    const key = `${project.id}/${currentFile}`;
    if (loadedCircuit !== key) {
      loadedCircuit = key;
      circuitEditor.load(currentFile.slice(0, -5), parseCircuit(project.files[currentFile] ?? ''));
    }
    return;
  }
  $('view-board').classList.toggle('active', board);
  $('view-text').classList.toggle('active', !board);
  if (board) {
    const top = $<HTMLInputElement>('top').value.trim() || project.top;
    planner.open(project.files[currentFile] ?? '', findModulePorts(project.files, top), top);
  } else {
    editor.setDoc(currentFile, project.files[currentFile] ?? '', currentFile === '' || isGeneratedVerilog(currentFile));
  }
}

/** Phones show one panel at a time (bottom tab bar); desktop ignores this. */
type MobileView = 'files' | 'editor' | 'output';
function setMobileView(v: MobileView) {
  document.body.dataset.mview = v;
  document.querySelectorAll<HTMLButtonElement>('#mobile-nav [data-mview]').forEach((b) => {
    b.classList.toggle('active', b.dataset.mview === v);
    b.setAttribute('aria-current', String(b.dataset.mview === v));
  });
  if (v === 'editor') window.dispatchEvent(new Event('resize')); // canvases size themselves on show
}

function openFile(name: string) {
  setMobileView('editor');
  currentFile = name;
  mainTab = 'code';
  // No files left (name === ''): show an empty, read-only editor instead of
  // a writable "nameless" document that would silently create a `''` entry
  // in project.files the moment the user typed into it.
  showView();
  renderFiles();
}

async function renderProjects() {
  const sel = $<HTMLSelectElement>('project');
  sel.replaceChildren();
  for (const p of await store.list()) sel.append(new Option(`${p.name} (${p.board})`, p.id, false, p.id === project?.id));
}

async function openProject(p: Project) {
  // Flush (not drop) any debounced save for the project we're leaving --
  // it's about to be discarded, and covers project switch, new-project and
  // import in one place since they all funnel through here.
  flushSave();
  project = p;
  $<HTMLSelectElement>('board').value = p.board;
  $<HTMLInputElement>('top').value = p.top;
  const firstV = Object.keys(p.files).sort().find((n) => /\.s?v$/.test(n)) ?? Object.keys(p.files)[0] ?? '';
  openFile(firstV);
  await renderProjects();
  resetOutput();
}

async function createProject(boardId: string, name?: string): Promise<boolean> {
  const gen = ++projectGen;
  const projectName = name ?? prompt(t('prompt.projectName'), `${boardId}-blinky`) ?? '';
  if (!projectName) return false;
  const tpl = await fetchTemplate(boardId);
  if (gen !== projectGen) return false; // superseded by a newer project switch
  const p = newProject(projectName, boardId, tpl);
  await store.save(p);
  if (gen !== projectGen) return false; // superseded while saving
  await openProject(p);
  return true;
}

// Wraps createProject() for the #board dropdown and #new-project button:
// restores the select to the still-open project's board if the user
// declines the name prompt or fetchTemplate/store.save fails, and surfaces
// any failure in #status instead of an uncaught rejection.
async function startNewProject(sel: HTMLSelectElement, boardId: string) {
  try {
    const created = await createProject(boardId);
    if (!created) sel.value = project.board;
  } catch (e) {
    sel.value = project.board;
    const msg = e instanceof ApiError ? e.message : String(e);
    setStatus('status.createFailed', { msg }, 'err');
  }
}

function resetOutput() {
  // Stop any in-flight build's event stream and invalidate its callbacks --
  // called on project switch (via openProject), a fresh build, and manual
  // board changes, so a stale job can never keep writing into the UI after
  // the user has moved on.
  closeStream?.();
  closeStream = null;
  buildGen++;
  const dl = $<HTMLAnchorElement>('download');
  if (lastBitstream) URL.revokeObjectURL(dl.href);
  $('log').replaceChildren();
  $('summary').replaceChildren();
  $<HTMLButtonElement>('build').disabled = false;
  $<HTMLButtonElement>('simulate').disabled = false;
  $<HTMLButtonElement>('flash').disabled = true;
  dl.hidden = true;
  lastBitstream = null;
  setStatus('status.ready');
}

function appendLog(line: string) {
  const log = $('log');
  const locs = parseLocations(line);
  if (locs.length === 0) {
    log.append(line + '\n');
  } else {
    let rest = line;
    for (const loc of locs) {
      const token = `${loc.file}:${loc.line}`;
      const idx = rest.indexOf(token);
      if (idx < 0) continue;
      log.append(rest.slice(0, idx));
      const a = document.createElement('a');
      a.className = 'loc';
      a.textContent = token;
      a.onclick = () => {
        if (loc.file in project.files) {
          openFile(loc.file);
          editor.gotoLine(loc.line);
        }
      };
      log.append(a);
      rest = rest.slice(idx + token.length);
    }
    log.append(rest + '\n');
  }
  log.scrollTop = log.scrollHeight;
}

function renderSummary(ev: Extract<BuildEvent, { type: 'done'; bitstream: string }>) {
  // Metric chips built with textContent only (resource/clock names come from tool output).
  const chip = (cls: string, value: string, name: string) => {
    const el = document.createElement('div');
    el.className = `metric ${cls}`;
    const v = document.createElement('span');
    v.className = 'value';
    v.textContent = value;
    const n = document.createElement('span');
    n.className = 'name';
    n.textContent = name;
    n.title = name;
    el.append(v, n);
    return el;
  };
  const chips = [
    ...Object.entries(ev.summary.fmax).map(([k, f]) => chip('fmax', `${f} MHz`, `fmax ${k}`)),
    ...Object.entries(ev.summary.utilization).map(([k, u]) => chip('util', `${u.used}/${u.available}`, k)),
  ];
  $('summary').replaceChildren(...chips);
}

function enableRun() {
  $<HTMLButtonElement>('build').disabled = false;
  $<HTMLButtonElement>('simulate').disabled = false;
}

async function build() {
  resetOutput(); // closes any previous stream and bumps buildGen
  setMobileView('output');
  fixTypographyInProject();
  const gen = buildGen; // this build's token: events checked against it below are dropped once stale
  const board = boardInfo(project.board)!;
  project.top = $<HTMLInputElement>('top').value.trim();
  scheduleSave();
  $<HTMLButtonElement>('build').disabled = true;
  $<HTMLButtonElement>('simulate').disabled = true;
  setStatus('status.submitting');
  try {
    const { job_id } = await submitBuild({ board: project.board, top: project.top, files: sourceFiles(), lint: $<HTMLInputElement>('lint').checked });
    if (gen !== buildGen) return; // superseded (e.g. project switched) while submitting
    closeStream = streamEvents(job_id, async (ev) => {
      if (gen !== buildGen) return; // stale job; the UI has moved on -- never touch it
      try {
        if (ev.type === 'queued') setStatus('status.queued', { n: ev.position });
        else if (ev.type === 'step') { setStatus('status.running', { step: ev.name }); appendLog(`== ${ev.name}`); }
        else if (ev.type === 'log') appendLog(ev.line);
        else if (ev.type === 'error') { setStatus('status.buildFailed', { msg: ev.message }, 'err'); enableRun(); }
        else if (ev.type === 'done' && 'bitstream' in ev) {
          renderSummary(ev);
          const data = await fetchBitstream(job_id);
          if (gen !== buildGen) return; // superseded while fetching the bitstream: never set lastBitstream/download/flash
          lastBitstream = { data, board };
          const a = $<HTMLAnchorElement>('download');
          a.href = URL.createObjectURL(new Blob([new Uint8Array(data)]));
          a.download = `${board.id}${board.bitstream_ext}`;
          a.hidden = false;
          $<HTMLButtonElement>('flash').disabled = !(board.flash === 'browser' && webUsbSupported());
          setStatus('status.buildOk', {}, 'ok');
          enableRun();
        }
      } catch (e) {
        // A failed bitstream fetch (or any other handler error) must not
        // leave the UI stuck on "Running: ..."/Build disabled forever.
        if (gen !== buildGen) return;
        const msg = e instanceof ApiError ? e.message : String((e as Error)?.message ?? e);
        setStatus('status.buildFailed', { msg }, 'err');
        enableRun();
      }
    });
  } catch (e) {
    if (gen !== buildGen) return;
    const msg = e instanceof ApiError ? e.message : String(e);
    setStatus('status.buildFailed', { msg }, 'err');
    if (e instanceof ApiError) appendLog(msg); // file:line in validation errors becomes a link
    enableRun();
  }
}

function testbenches(): string[] {
  return Object.keys(project?.files ?? {}).filter((n) => /_tb\.s?v$/.test(n)).sort();
}

function refreshTestbenches() {
  const sel = $<HTMLSelectElement>('testbench');
  const tbs = testbenches();
  const keep = sel.value;
  sel.replaceChildren(...tbs.map((n) => new Option(n, n, false, n === keep)));
  if (!tbs.includes(keep) && tbs.length) sel.value = tbs[0];
  sel.hidden = tbs.length === 0; // always show which testbench Simulate runs
  const btn = $<HTMLButtonElement>('simulate');
  btn.title = tbs.length ? '' : t('sim.noTb');
}

function newTestbench() {
  const top = $<HTMLInputElement>('top').value.trim() || project.top;
  const name = testbenchName(top);
  if (name in project.files) {
    alert(t('tb.exists', { name }));
    openFile(name);
    return;
  }
  project.files[name] = generateTestbench(top, findModulePorts(project.files, top).ports);
  scheduleSave();
  openFile(name);
}

async function simulate() {
  const tb = $<HTMLSelectElement>('testbench').value || testbenches()[0];
  if (!tb) {
    setStatus('sim.noTb', {}, 'err');
    return;
  }
  resetOutput();
  setMobileView('output');
  fixTypographyInProject();
  const gen = buildGen;
  scheduleSave();
  $<HTMLButtonElement>('build').disabled = true;
  $<HTMLButtonElement>('simulate').disabled = true;
  const done = () => {
    $<HTMLButtonElement>('build').disabled = false;
    $<HTMLButtonElement>('simulate').disabled = false;
  };
  setStatus('status.submitting');
  try {
    const { job_id } = await submitSim({ board: project.board, testbench: tb, files: sourceFiles() });
    if (gen !== buildGen) return;
    closeStream = streamEvents(job_id, async (ev) => {
      if (gen !== buildGen) return;
      try {
        if (ev.type === 'queued') setStatus('status.queued', { n: ev.position });
        else if (ev.type === 'step') { setStatus('status.running', { step: ev.name }); appendLog(`== ${ev.name}`); }
        else if (ev.type === 'log') appendLog(ev.line);
        else if (ev.type === 'error') { setStatus('status.simFailed', { msg: ev.message }, 'err'); done(); }
        else if (ev.type === 'done') {
          const text = await fetchWave(job_id);
          if (gen !== buildGen) return;
          const vcd = parseVcd(text);
          $('tab-wave').hidden = false;
          mainTab = 'wave';
          setMobileView('editor');
          showView();
          waveViewer.load(vcd, tb);
          setStatus('status.simOk', {}, 'ok');
          done();
        }
      } catch (e) {
        if (gen !== buildGen) return;
        setStatus('status.simFailed', { msg: e instanceof ApiError ? e.message : String((e as Error)?.message ?? e) }, 'err');
        done();
      }
    });
  } catch (e) {
    if (gen !== buildGen) return;
    setStatus('status.simFailed', { msg: e instanceof ApiError ? e.message : String(e) }, 'err');
    if (e instanceof ApiError) appendLog(e.message);
    done();
  }
}

async function doFlash() {
  if (!lastBitstream) return;
  const { board, data } = lastBitstream;
  const toFlash = $<HTMLInputElement>('to-flash').checked;
  const flashBtn = $<HTMLButtonElement>('flash');
  flashBtn.disabled = true;
  setStatus('status.flashing');
  appendLog('== flash');
  try {
    await flash(board, data, toFlash, (t) => appendLog(t.trimEnd()));
    setStatus(toFlash ? 'status.written' : 'status.loaded', {}, 'ok');
  } catch (e) {
    setStatus('status.flashFailed', { msg: (e as Error).message }, 'err');
    showHelp();
  } finally {
    // Re-enable only if this bitstream is still the current one (a project
    // switch/reset during the flash would have cleared lastBitstream).
    flashBtn.disabled = !(lastBitstream && board.flash === 'browser' && webUsbSupported());
  }
}

/** Open a /s/<id> link: save a copy of the shared project in this browser. Returns an error message, or null. */
async function openSharedLink(id: string): Promise<string | null> {
  history.replaceState(null, '', '/'); // the copy is now a normal local project
  try {
    const sp = await fetchShare(id);
    if (!boardInfo(sp.board)) throw new Error(t('err.unknownBoard', { board: sp.board }));
    const names = new Set((await store.list()).map((p) => p.name));
    let name = sp.name;
    for (let i = 2; names.has(name); i++) name = `${sp.name}-${i}`;
    const p: Project = { id: crypto.randomUUID(), name, board: sp.board, top: sp.top, files: sp.files, updatedAt: Date.now() };
    fixTypography(p);
    projectGen++;
    await store.save(p);
    await openProject(p);
    appendLog(t('share.opened', { name }));
    const report = document.createElement('button');
    report.className = 'log-action';
    report.textContent = t('share.report');
    report.onclick = async () => {
      if (!confirm(t('share.reportConfirm'))) return;
      report.disabled = true;
      try {
        await reportShare(id);
        report.textContent = t('share.reported');
      } catch (e) {
        report.disabled = false;
        alert(e instanceof ApiError ? e.message : String(e));
      }
    };
    $('log').append(report, '\n');
    return null;
  } catch (e) {
    return e instanceof ApiError ? e.message : String((e as Error)?.message ?? e);
  }
}

function showNoWebUsb() {
  const p = document.createElement('p');
  p.textContent = t('banner.noWebUsb');
  const h = document.createElement('h3');
  h.textContent = t('usb.unavailable');
  $('setup-help-body').replaceChildren(h, p);
  $<HTMLDialogElement>('setup-help').showModal();
}

function showHelp() {
  $('setup-help-body').innerHTML = setupHelpHtml(detectOS());
  $<HTMLDialogElement>('setup-help').showModal();
}

async function init() {
  boards = await fetchBoards();
  const sel = $<HTMLSelectElement>('board');
  for (const b of boards) sel.append(new Option(`${b.description}${b.flash === 'download' ? t('board.downloadOnly') : ''}`, b.id));
  if (!webUsbSupported()) {
    // No banner: flashing controls are disabled and a small warning icon explains why.
    $<HTMLButtonElement>('help').disabled = true;
    $('usb-warn').hidden = false;
    $('flash').title = t('banner.noWebUsb');
  }
  sel.onchange = () => {
    if (confirm(t('confirm.newForBoard'))) {
      void startNewProject(sel, sel.value);
    } else {
      project.board = sel.value;
      scheduleSave();
      resetOutput();
      showView(); // the pin planner only applies to some boards
    }
  };
  $<HTMLInputElement>('top').oninput = () => {
    if (!project) return; // bootstrap not finished yet (shouldn't normally be reachable: #top has no gate, but be defensive)
    project.top = $<HTMLInputElement>('top').value;
    scheduleSave();
  };
  $('new-project').onclick = () => void startNewProject(sel, sel.value);
  $<HTMLSelectElement>('project').onchange = async (e) => {
    projectGen++;
    const p = await store.get((e.target as HTMLSelectElement).value);
    if (p) await openProject(p);
  };
  $('add-file').onclick = () => openNewFileDialog('module');
  document.querySelectorAll<HTMLButtonElement>('#mobile-nav [data-mview]').forEach((b) => {
    b.onclick = () => setMobileView(b.dataset.mview as MobileView);
  });
  setMobileView('editor');
  $('build').onclick = build;
  $('flash').onclick = doFlash;
  $('help').onclick = showHelp;
  $('usb-warn').onclick = showNoWebUsb;
  $('view-board').onclick = () => { fileView = 'board'; showView(); };
  $('tab-code').onclick = () => { mainTab = 'code'; showView(); };
  $('tab-wave').onclick = () => { mainTab = 'wave'; showView(); };
  $('tab-board').onclick = () => { mainTab = 'board'; showView(); };
  $('simulate').onclick = () => void simulate();
  $('new-tb').onclick = newTestbench;
  $<HTMLInputElement>('newfile-stem').oninput = () => { newFileStemEdited = true; validateNewFile(); };
  $('newfile-cancel').onclick = () => $<HTMLDialogElement>('newfile-dialog').close();
  $<HTMLFormElement>('newfile-form').onsubmit = (e) => {
    if (!validateNewFile()) { e.preventDefault(); return; }
    createNewFile();
  };
  $('new-circuit').onclick = () => openNewFileDialog('circuit');
  $('view-text').onclick = () => { fileView = 'text'; showView(); };
  $('export').onclick = () => {
    const a = document.createElement('a');
    const url = URL.createObjectURL(new Blob([new Uint8Array(exportZip(project))], { type: 'application/zip' }));
    a.href = url;
    a.download = `${project.name}.zip`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  $('import').onclick = () => $<HTMLInputElement>('import-file').click();
  $<HTMLInputElement>('import-file').onchange = async (e) => {
    const input = e.target as HTMLInputElement;
    const picked = [...(input.files ?? [])];
    input.value = ''; // so picking the same file again still fires change
    if (!picked.length) return;
    try {
      const uploads = await Promise.all(picked.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));
      const { project: p, notes, vivado } = importUpload(uploads, boards, project.board);
      if (!boardInfo(p.board)) throw new Error(t('err.unknownBoard', { board: p.board }));
      const fixed = fixTypography(p);
      projectGen++;
      await store.save(p);
      await openProject(p);
      if (vivado) {
        appendLog(t('log.vivado.imported', { files: Object.keys(p.files).sort().join(', '), top: p.top }));
        for (const n of notes) appendLog(vivadoNote(n));
      }
      if (fixed.length) appendLog(t('log.fixedQuotes', { files: fixed.join(', ') }));
    } catch (err) {
      alert(t('alert.importFailed', { msg: (err as Error).message }));
    }
  };

  const config = await fetchConfig().catch(() => ({ shares: false, turnstile_sitekey: '' }));
  if (config.shares) {
    const dlg = new ShareDialog($<HTMLDialogElement>('share-dialog'), $('share-body'), config.turnstile_sitekey);
    $('share').hidden = false;
    $('share').onclick = () => { flushSave(); dlg.open(project); };
  }
  const sharedId = shareIdFromPath();
  const sharedErr = sharedId !== null ? await openSharedLink(sharedId) : null;
  const sharedOk = sharedId !== null && sharedErr === null;
  const existing = sharedOk ? [] : await store.list();
  if (sharedOk) {
    /* already open */
  } else if (existing.length) {
    projectGen++;
    await openProject(existing[0]);
  } else {
    await createProject('basys3', 'basys3-blinky');
  }
  if (sharedErr) setStatus('share.openFailed', { msg: sharedErr }, 'err');
  setControlsReady(true);
}

function initSettings() {
  applyTheme();
  const vimBox = $<HTMLInputElement>('vim-mode');
  vimBox.checked = vimEnabled();
  vimBox.onchange = () => editor.setVim(vimBox.checked);
  const marks = () => document.querySelectorAll<HTMLButtonElement>('[data-theme-choice]').forEach((b) => {
    b.classList.toggle('active', b.dataset.themeChoice === getTheme());
    b.setAttribute('aria-checked', String(b.dataset.themeChoice === getTheme()));
  });
  document.querySelectorAll<HTMLButtonElement>('[data-theme-choice]').forEach((b) => {
    b.onclick = () => {
      setTheme(b.dataset.themeChoice as ThemeChoice);
      marks();
    };
  });
  marks();
  onThemeChange(() => window.dispatchEvent(new Event('resize'))); // canvas views re-read theme colours
  $('settings').onclick = () => $<HTMLDialogElement>('settings-dialog').showModal();
}

function initLanguage() {
  const sel = $<HTMLSelectElement>('lang');
  const names: Record<Lang, string> = { en: 'English', 'pt-PT': 'Português (Portugal)', es: 'Español' };
  for (const l of LANGS) sel.append(new Option(names[l.id], l.id, false, l.id === getLang()));
  sel.onchange = () => setLang(sel.value as Lang);
  document.documentElement.lang = getLang();
  decorateIcons();
  applyStatic();
  onLangChange(() => {
    applyStatic();
    circuitEditor.relabel();
    virtualBoard.relabel();
    setStatus(lastStatus.key, lastStatus.vars, lastStatus.kind);
    if (project) {
      renderFiles();
      showView();
    }
    const boardSel = $<HTMLSelectElement>('board');
    for (const opt of Array.from(boardSel.options)) {
      const b = boardInfo(opt.value);
      if (b) opt.text = `${b.description}${b.flash === 'download' ? t('board.downloadOnly') : ''}`;
    }
    if (!webUsbSupported()) $('flash').title = t('banner.noWebUsb');
  });
}

initSettings();
initLanguage();
init().catch((e) => setStatus('status.loadFailed', { msg: String(e) }, 'err'));
