import { ApiError, fetchBitstream, fetchBoards, fetchTemplate, streamEvents, submitBuild, type BoardInfo, type BuildEvent } from './api';
import { Editor } from './editor';
import { parseLocations } from './errors';
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
// Bumped on every project switch/creation so a slower, earlier-started load
// (e.g. the initial default-project bootstrap) can detect it has been
// superseded and avoid clobbering a newer one once its awaits resolve.
let projectGen = 0;

const editor = new Editor($('editor'), (text) => {
  project.files[currentFile] = text;
  scheduleSave();
});

function scheduleSave() {
  project.updatedAt = Date.now();
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => store.save(project), 400);
}

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

function setStatus(text: string, kind: '' | 'ok' | 'err' = '') {
  const s = $('status');
  s.textContent = text;
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
    rm.title = `Delete ${name}`;
    rm.onclick = (e) => {
      e.stopPropagation();
      if (!confirm(`Delete ${name}?`)) return;
      delete project.files[name];
      scheduleSave();
      openFile(Object.keys(project.files).sort()[0] ?? '');
    };
    li.append(label, rm);
    li.onclick = () => openFile(name);
    ul.append(li);
  }
}

function openFile(name: string) {
  currentFile = name;
  editor.setDoc(name, project.files[name] ?? '');
  renderFiles();
}

async function renderProjects() {
  const sel = $<HTMLSelectElement>('project');
  sel.replaceChildren();
  for (const p of await store.list()) sel.append(new Option(`${p.name} (${p.board})`, p.id, false, p.id === project?.id));
}

async function openProject(p: Project) {
  project = p;
  $<HTMLSelectElement>('board').value = p.board;
  $<HTMLInputElement>('top').value = p.top;
  const firstV = Object.keys(p.files).sort().find((n) => /\.s?v$/.test(n)) ?? Object.keys(p.files)[0] ?? '';
  openFile(firstV);
  await renderProjects();
  resetOutput();
}

async function createProject(boardId: string, name?: string) {
  const gen = ++projectGen;
  const projectName = name ?? prompt('Project name', `${boardId}-blinky`) ?? '';
  if (!projectName) return;
  const tpl = await fetchTemplate(boardId);
  if (gen !== projectGen) return; // superseded by a newer project switch
  const p = newProject(projectName, boardId, tpl);
  await store.save(p);
  if (gen !== projectGen) return; // superseded while saving
  await openProject(p);
}

function resetOutput() {
  $('log').replaceChildren();
  $('summary').replaceChildren();
  $<HTMLButtonElement>('flash').disabled = true;
  $('download').hidden = true;
  lastBitstream = null;
  setStatus('Ready');
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
  const parts = Object.entries(ev.summary.utilization).map(([k, u]) => `${k} ${u.used}/${u.available}`);
  const fmax = Object.entries(ev.summary.fmax).map(([k, f]) => `fmax ${k}: ${f} MHz`);
  $('summary').textContent = [...parts, ...fmax].join(' · ');
}

async function build() {
  resetOutput();
  const board = boardInfo(project.board)!;
  project.top = $<HTMLInputElement>('top').value.trim();
  scheduleSave();
  $<HTMLButtonElement>('build').disabled = true;
  setStatus('Submitting…');
  try {
    const { job_id } = await submitBuild({ board: project.board, top: project.top, files: project.files, lint: $<HTMLInputElement>('lint').checked });
    streamEvents(job_id, async (ev) => {
      if (ev.type === 'queued') setStatus(`Queued (position ${ev.position})`);
      else if (ev.type === 'step') { setStatus(`Running: ${ev.name}`); appendLog(`== ${ev.name}`); }
      else if (ev.type === 'log') appendLog(ev.line);
      else if (ev.type === 'error') { setStatus(`Build failed: ${ev.message}`, 'err'); $<HTMLButtonElement>('build').disabled = false; }
      else if (ev.type === 'done') {
        renderSummary(ev);
        lastBitstream = { data: await fetchBitstream(job_id), board };
        const a = $<HTMLAnchorElement>('download');
        a.href = URL.createObjectURL(new Blob([new Uint8Array(lastBitstream.data)]));
        a.download = `${board.id}${board.bitstream_ext}`;
        a.hidden = false;
        $<HTMLButtonElement>('flash').disabled = !(board.flash === 'browser' && webUsbSupported());
        setStatus('Build succeeded', 'ok');
        $<HTMLButtonElement>('build').disabled = false;
      }
    });
  } catch (e) {
    const msg = e instanceof ApiError ? e.message : String(e);
    setStatus(`Build failed: ${msg}`, 'err');
    $<HTMLButtonElement>('build').disabled = false;
  }
}

async function doFlash() {
  if (!lastBitstream) return;
  const toFlash = $<HTMLInputElement>('to-flash').checked;
  setStatus('Flashing…');
  appendLog('== flash');
  try {
    await flash(lastBitstream.board, lastBitstream.data, toFlash, (t) => appendLog(t.trimEnd()));
    setStatus(toFlash ? 'Written to flash' : 'Loaded into FPGA', 'ok');
  } catch (e) {
    setStatus(`Flash failed: ${(e as Error).message}`, 'err');
    showHelp();
  }
}

function showHelp() {
  $('setup-help-body').innerHTML = setupHelpHtml(detectOS());
  $<HTMLDialogElement>('setup-help').showModal();
}

async function init() {
  boards = await fetchBoards();
  const sel = $<HTMLSelectElement>('board');
  for (const b of boards) sel.append(new Option(`${b.description}${b.flash === 'download' ? ' (download only)' : ''}`, b.id));
  if (!webUsbSupported()) {
    const banner = $('banner');
    banner.textContent = 'This browser cannot flash boards (no WebUSB). Use Chrome or Edge, or download the bitstream.';
    banner.hidden = false;
  }
  sel.onchange = () => {
    if (confirm('Start a new project for this board? (Cancel keeps the current files and just changes the target.)')) {
      createProject(sel.value);
    } else {
      project.board = sel.value;
      scheduleSave();
      resetOutput();
    }
  };
  $('new-project').onclick = () => createProject(sel.value);
  $<HTMLSelectElement>('project').onchange = async (e) => {
    projectGen++;
    const p = await store.get((e.target as HTMLSelectElement).value);
    if (p) await openProject(p);
  };
  $('add-file').onclick = () => {
    const name = prompt('File name (e.g. counter.v)')?.trim();
    if (!name) return;
    if (!NAME_RE.test(name)) return alert('Invalid file name');
    project.files[name] ??= '';
    scheduleSave();
    openFile(name);
  };
  $('build').onclick = build;
  $('flash').onclick = doFlash;
  $('help').onclick = showHelp;
  $('export').onclick = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([new Uint8Array(exportZip(project))], { type: 'application/zip' }));
    a.download = `${project.name}.zip`;
    a.click();
  };
  $('import').onclick = () => $<HTMLInputElement>('import-file').click();
  $<HTMLInputElement>('import-file').onchange = async (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    try {
      const p = importZip(new Uint8Array(await f.arrayBuffer()));
      if (!boardInfo(p.board)) throw new Error(`unknown board ${p.board}`);
      projectGen++;
      await store.save(p);
      await openProject(p);
    } catch (err) {
      alert(`Import failed: ${(err as Error).message}`);
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

init().catch((e) => setStatus(`Failed to load: ${e}`, 'err'));
