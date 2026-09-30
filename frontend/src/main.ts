import '@fontsource/space-grotesk/500.css';
import '@fontsource/space-grotesk/700.css';
import '@fontsource/inter/400.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/jetbrains-mono/400.css';
import { ApiError, fetchBitstream, fetchBoards, fetchTemplate, streamEvents, submitBuild, type BoardInfo, type BuildEvent } from './api';
import { Editor } from './editor';
import { parseLocations } from './errors';
import { applyStatic, getLang, LANGS, onLangChange, setLang, t, type Key, type Lang } from './i18n';
import { PinPlanner } from './pinplanner';
import { findModulePorts } from './verilog-ports';
import { flash, webUsbSupported } from './flasher';
import { exportZip, importZip, newProject, NAME_RE, ProjectStore, type Project } from './project';
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
const GATED_CONTROLS = ['board', 'new-project', 'project', 'import', 'export', 'add-file', 'build'];
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

function showView() {
  const usePlanner = plannerApplies(currentFile);
  $('view-toggle').hidden = !usePlanner;
  const board = usePlanner && fileView === 'board';
  $('planner').hidden = !board;
  $('editor').hidden = board;
  $('view-board').classList.toggle('active', board);
  $('view-text').classList.toggle('active', !board);
  if (board) {
    const top = $<HTMLInputElement>('top').value.trim() || project.top;
    planner.open(project.files[currentFile] ?? '', findModulePorts(project.files, top), top);
  } else {
    editor.setDoc(currentFile, project.files[currentFile] ?? '', currentFile === '');
  }
}

function openFile(name: string) {
  currentFile = name;
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

function renderSummary(ev: Extract<BuildEvent, { type: 'done' }>) {
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

async function build() {
  resetOutput(); // closes any previous stream and bumps buildGen
  const gen = buildGen; // this build's token: events checked against it below are dropped once stale
  const board = boardInfo(project.board)!;
  project.top = $<HTMLInputElement>('top').value.trim();
  scheduleSave();
  $<HTMLButtonElement>('build').disabled = true;
  setStatus('status.submitting');
  try {
    const { job_id } = await submitBuild({ board: project.board, top: project.top, files: project.files, lint: $<HTMLInputElement>('lint').checked });
    if (gen !== buildGen) return; // superseded (e.g. project switched) while submitting
    closeStream = streamEvents(job_id, async (ev) => {
      if (gen !== buildGen) return; // stale job; the UI has moved on -- never touch it
      try {
        if (ev.type === 'queued') setStatus('status.queued', { n: ev.position });
        else if (ev.type === 'step') { setStatus('status.running', { step: ev.name }); appendLog(`== ${ev.name}`); }
        else if (ev.type === 'log') appendLog(ev.line);
        else if (ev.type === 'error') { setStatus('status.buildFailed', { msg: ev.message }, 'err'); $<HTMLButtonElement>('build').disabled = false; }
        else if (ev.type === 'done') {
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
          $<HTMLButtonElement>('build').disabled = false;
        }
      } catch (e) {
        // A failed bitstream fetch (or any other handler error) must not
        // leave the UI stuck on "Running: ..."/Build disabled forever.
        if (gen !== buildGen) return;
        const msg = e instanceof ApiError ? e.message : String((e as Error)?.message ?? e);
        setStatus('status.buildFailed', { msg }, 'err');
        $<HTMLButtonElement>('build').disabled = false;
      }
    });
  } catch (e) {
    if (gen !== buildGen) return;
    const msg = e instanceof ApiError ? e.message : String(e);
    setStatus('status.buildFailed', { msg }, 'err');
    $<HTMLButtonElement>('build').disabled = false;
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

function showHelp() {
  $('setup-help-body').innerHTML = setupHelpHtml(detectOS());
  $<HTMLDialogElement>('setup-help').showModal();
}

async function init() {
  boards = await fetchBoards();
  const sel = $<HTMLSelectElement>('board');
  for (const b of boards) sel.append(new Option(`${b.description}${b.flash === 'download' ? t('board.downloadOnly') : ''}`, b.id));
  if (!webUsbSupported()) {
    const banner = $('banner');
    banner.textContent = t('banner.noWebUsb');
    banner.hidden = false;
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
  $('add-file').onclick = () => {
    const name = prompt(t('prompt.fileName'))?.trim();
    if (!name) return;
    if (!NAME_RE.test(name)) return alert(t('alert.invalidName'));
    project.files[name] ??= '';
    scheduleSave();
    openFile(name);
  };
  $('build').onclick = build;
  $('flash').onclick = doFlash;
  $('help').onclick = showHelp;
  $('view-board').onclick = () => { fileView = 'board'; showView(); };
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
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    try {
      const p = importZip(new Uint8Array(await f.arrayBuffer()));
      if (!boardInfo(p.board)) throw new Error(t('err.unknownBoard', { board: p.board }));
      projectGen++;
      await store.save(p);
      await openProject(p);
    } catch (err) {
      alert(t('alert.importFailed', { msg: (err as Error).message }));
    }
  };

  const existing = await store.list();
  if (existing.length) {
    projectGen++;
    await openProject(existing[0]);
  } else {
    await createProject('basys3', 'basys3-blinky');
  }
  setControlsReady(true);
}

function initLanguage() {
  const sel = $<HTMLSelectElement>('lang');
  for (const l of LANGS) sel.append(new Option(l.label, l.id, false, l.id === getLang()));
  sel.onchange = () => setLang(sel.value as Lang);
  document.documentElement.lang = getLang();
  applyStatic();
  onLangChange(() => {
    applyStatic();
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
    if (!$('banner').hidden) $('banner').textContent = t('banner.noWebUsb');
  });
}

initLanguage();
init().catch((e) => setStatus('status.loadFailed', { msg: String(e) }, 'err'));
