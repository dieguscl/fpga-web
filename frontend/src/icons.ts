// Lucide icons for buttons. Icon-only buttons carry their (translated) label in
// the tooltip and aria-label; labelled buttons show icon + text.
import {
  Activity, CircuitBoard, Link, Share2, TriangleAlert, ClipboardPaste, Copy, Cpu, Download, Eraser, Expand, FilePlus, FlaskConical, FolderPlus, Fullscreen, Hammer,
  ListPlus, Pause, Play, Redo2, RotateCcw, RotateCw, Settings, StepForward, Trash2, Undo2, Upload,
  Usb, WandSparkles, Zap, ZoomIn, ZoomOut, createElement, type IconNode,
} from 'lucide';
import { t, type Key } from './i18n';

export const ICONS = {
  activity: Activity, alert: TriangleAlert, link: Link, share: Share2, board: CircuitBoard, paste: ClipboardPaste, copy: Copy, cpu: Cpu, download: Download,
  eraser: Eraser, filePlus: FilePlus, flask: FlaskConical, folderPlus: FolderPlus, hammer: Hammer, listPlus: ListPlus,
  fullscreen: Fullscreen, pause: Pause, play: Play, redo: Redo2, reset: RotateCcw, rotate: RotateCw, fit: Expand,
  settings: Settings, step: StepForward, trash: Trash2, undo: Undo2, upload: Upload, usb: Usb, wand: WandSparkles,
  zap: Zap, zoomIn: ZoomIn, zoomOut: ZoomOut,
} satisfies Record<string, IconNode>;

export type IconName = keyof typeof ICONS;

export function iconSvg(name: IconName): SVGElement {
  const svg = createElement(ICONS[name]);
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('btn-ico');
  return svg;
}

/**
 * Give a button an icon and label key. withLabel shows the text next to the icon
 * (data-i18n stays on the button; the text lives in a .btn-label child);
 * otherwise the label goes to the tooltip and aria-label only.
 */
export function setIconButton(b: HTMLButtonElement, name: IconName, key: Key, withLabel = false): HTMLButtonElement {
  b.replaceChildren(iconSvg(name));
  b.dataset.icon = name;
  b.classList.toggle('btn-icon-only', !withLabel);
  if (withLabel) {
    const s = document.createElement('span');
    s.className = 'btn-label';
    s.textContent = t(key);
    b.append(s);
    b.dataset.i18n = key;
  } else {
    delete b.dataset.i18n;
    b.dataset.i18nTitle = key;
    b.dataset.i18nAria = key;
    b.title = t(key);
    b.setAttribute('aria-label', t(key));
  }
  return b;
}

export function iconButton(name: IconName, key: Key, cls: string, onClick: () => void, withLabel = false): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = cls;
  b.onclick = onClick;
  return setIconButton(b, name, key, withLabel);
}

/** Decorate static markup: <button data-icon="hammer" data-i18n="btn.build"> (labelled) or data-i18n-aria only (icon-only). */
export function decorateIcons(root: ParentNode = document): void {
  root.querySelectorAll<HTMLButtonElement>('button[data-icon]').forEach((b) => {
    const key = (b.dataset.i18n ?? b.dataset.i18nAria) as Key;
    setIconButton(b, b.dataset.icon as IconName, key, !!b.dataset.i18n);
  });
}
