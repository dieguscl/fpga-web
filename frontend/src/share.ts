// Share links: the server stores an immutable snapshot and returns a short
// /s/<id> link. Only the creator's browser keeps the key that deletes it.
import { ApiError, createShare, deleteShare } from './api';
import { t } from './i18n';
import { iconButton } from './icons';
import type { Project } from './project';

const KEYS = 'fpgaweb.shareKeys'; // share id → delete key
const LAST = 'fpgaweb.shareLast'; // project id → its most recent share id

function readMap(k: string): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(k) ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
}

function writeMap(k: string, v: Record<string, string>): void {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* private mode: the link still works, it just can't be deleted later */
  }
}

export function shareIdFromPath(path = location.pathname): string | null {
  const m = /^\/s\/([A-Za-z0-9]{1,16})\/?$/.exec(path);
  return m ? m[1] : null;
}

export const shareUrl = (id: string) => `${location.origin}/s/${id}`;

interface Turnstile {
  render(el: HTMLElement, opts: { sitekey: string; callback: (token: string) => void; 'expired-callback': () => void }): string;
  reset(id: string): void;
}

let turnstileLoading: Promise<Turnstile> | null = null;
function loadTurnstile(): Promise<Turnstile> {
  turnstileLoading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true;
    s.onload = () => resolve((window as unknown as { turnstile: Turnstile }).turnstile);
    s.onerror = () => reject(new Error('could not load the human check'));
    document.head.append(s);
  });
  return turnstileLoading;
}

function p(text: string, cls = ''): HTMLParagraphElement {
  const e = document.createElement('p');
  e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

/** The Share dialog: notice → Create link → link with Copy / Delete. */
export class ShareDialog {
  constructor(private dlg: HTMLDialogElement, private body: HTMLElement, private sitekey: string) {}

  open(project: Project): void {
    this.renderStart(project);
    this.dlg.showModal();
  }

  private renderStart(project: Project, error = ''): void {
    const title = document.createElement('h3');
    title.textContent = t('share.title');
    const notice = p(t('share.notice'));
    const err = p(error, 'share-err');
    err.hidden = !error;
    const create = iconButton('link', 'share.create', 'btn-primary', () => void go(), true);
    create.id = 'share-create';
    const human = document.createElement('div');
    human.className = 'share-human';
    let token = '';
    let widget = '';
    let ts: Turnstile | null = null;
    if (this.sitekey) {
      create.disabled = true;
      loadTurnstile()
        .then((tt) => {
          ts = tt;
          widget = tt.render(human, {
            sitekey: this.sitekey,
            callback: (tok) => { token = tok; create.disabled = false; },
            'expired-callback': () => { token = ''; create.disabled = true; },
          });
        })
        .catch((e: Error) => { err.textContent = e.message; err.hidden = false; });
    }
    const go = async () => {
      create.disabled = true;
      err.hidden = true;
      try {
        const r = await createShare({ name: project.name, board: project.board, top: project.top, files: project.files }, token);
        const keys = readMap(KEYS);
        if (r.delete_key) keys[r.id] = r.delete_key;
        writeMap(KEYS, keys);
        const last = readMap(LAST);
        last[project.id] = r.id;
        writeMap(LAST, last);
        this.renderLink(project, r.id);
      } catch (e) {
        err.textContent = e instanceof ApiError ? e.message : String(e);
        err.hidden = false;
        create.disabled = !!this.sitekey && !token;
        if (ts && widget) { ts.reset(widget); token = ''; create.disabled = true; }
      }
    };
    const kids: Node[] = [title, notice, human, err, create];
    const prev = readMap(LAST)[project.id];
    if (prev) kids.splice(2, 0, p(t('share.previous', { url: shareUrl(prev) }), 'share-prev'));
    this.body.replaceChildren(...kids);
  }

  private renderLink(project: Project, id: string): void {
    const title = document.createElement('h3');
    title.textContent = t('share.ready');
    const row = document.createElement('div');
    row.className = 'share-row';
    const input = document.createElement('input');
    input.readOnly = true;
    input.value = shareUrl(id);
    input.id = 'share-url';
    input.onfocus = () => input.select();
    const copy = iconButton('copy', 'share.copy', 'btn-tertiary', () => {
      void navigator.clipboard?.writeText(input.value).then(
        () => { status.textContent = t('share.copied'); },
        () => { input.select(); },
      );
    }, true);
    row.append(input, copy);
    const status = p('', 'share-status');
    const kids: Node[] = [title, row, status, p(t('share.expiry'), 'share-small')];
    const key = readMap(KEYS)[id];
    if (key) {
      const del = iconButton('trash', 'share.delete', 'btn-ghost', () => void (async () => {
        if (!confirm(t('share.deleteConfirm'))) return;
        try {
          await deleteShare(id, key);
          const keys = readMap(KEYS);
          delete keys[id];
          writeMap(KEYS, keys);
          const last = readMap(LAST);
          if (last[project.id] === id) delete last[project.id];
          writeMap(LAST, last);
          this.renderStart(project);
          this.body.prepend(p(t('share.deleted'), 'share-status'));
        } catch (e) {
          status.textContent = e instanceof ApiError ? e.message : String(e);
        }
      })(), true);
      kids.push(del);
    }
    this.body.replaceChildren(...kids);
    input.focus();
  }
}
