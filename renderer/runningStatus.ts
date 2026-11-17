/**
 * Notebook renderer for a running cell's status (src/runningStatus.ts): a thin bar against the
 * block's estimate in the theme's progress colour (the warning colour once past it), and the words
 * every client uses: `running · 12s of about 30s · attempt 2/5`. Without an estimate, the words
 * only. The extension sends when the cell started once (runningView.ts); this renderer redraws
 * the words and the bar every second with its own timer. The bar glides between redraws unless
 * the reader asked for reduced motion. The timer stops when the output goes.
 *
 * Built separately as an ES module for the notebook webview (tsconfig.renderer.json).
 */

import { RunningView, isRunningData, msToNextSecond, runningView } from './runningView';

interface OutputItem {
  id: string;
  json(): unknown;
}

const CSS = `
.mdr-running { display: flex; flex-direction: column; gap: 4px; padding: 6px 0 2px; color: var(--vscode-descriptionForeground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size, 13px); }
.mdr-running .track { height: 4px; max-width: 480px; border-radius: 2px; overflow: hidden; background: var(--vscode-editorWidget-border, rgba(128, 128, 128, 0.35)); }
.mdr-running .fill { height: 100%; background: var(--vscode-progressBar-background); transition: width 0.9s linear; }
.mdr-running.over .fill { background: var(--vscode-editorWarning-foreground); }
.mdr-running.over .words { color: var(--vscode-editorWarning-foreground); }
@media (prefers-reduced-motion: reduce) { .mdr-running .fill { transition: none; } }
`;

/** The status in `element`: built once, then updated in place (so the bar can glide). */
export function renderRunning(element: HTMLElement, view: RunningView): void {
  let root = element.querySelector<HTMLElement>(':scope > .mdr-running');
  if (!root) {
    element.textContent = '';
    const style = document.createElement('style');
    style.textContent = CSS;
    root = document.createElement('div');
    root.className = 'mdr-running';
    const track = document.createElement('div');
    track.className = 'track';
    track.setAttribute('role', 'progressbar');
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', '100');
    const fill = document.createElement('div');
    fill.className = 'fill';
    track.append(fill);
    const words = document.createElement('div');
    words.className = 'words';
    root.append(track, words);
    element.append(style, root);
  }
  const track = root.querySelector<HTMLElement>('.track')!;
  const fill = root.querySelector<HTMLElement>('.fill')!;
  const words = root.querySelector<HTMLElement>('.words')!;
  root.classList.toggle('over', view.over);
  // Text only, never markup.
  words.textContent = view.line;
  if (view.fraction === undefined) {
    track.hidden = true;
  } else {
    const f = Math.min(1, Math.max(0, Number.isFinite(view.fraction) ? view.fraction : 0));
    track.hidden = false;
    track.setAttribute('aria-valuenow', String(Math.round(f * 100)));
    track.setAttribute('aria-valuetext', view.line);
    fill.style.width = `${(f * 100).toFixed(1)}%`;
  }
}

/** The redraw timer of each output item, and the item drawing into each element. */
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const drawing = new WeakMap<HTMLElement, string>();
/**
 * When each item's data was first drawn, by this window's clock. Kept after a dispose: an item
 * drawn again (scrolled back into view) goes on counting. The oldest go past a few hundred.
 */
const received = new Map<string, { sentAt: number; at: number }>();
const RECEIVED_KEPT = 200;

function receivedAt(id: string, sentAt: number, now: number): number {
  const r = received.get(id);
  // The same data again: when it first came. New data (a new attempt): from now.
  if (r !== undefined && r.sentAt === sentAt) return r.at;
  received.delete(id);
  received.set(id, { sentAt, at: now });
  if (received.size > RECEIVED_KEPT) received.delete(received.keys().next().value!);
  return now;
}

function stop(id: string): void {
  const t = timers.get(id);
  if (t !== undefined) clearTimeout(t);
  timers.delete(id);
}

export function activate(): { renderOutputItem(item: OutputItem, element: HTMLElement): void; disposeOutputItem(id?: string): void } {
  return {
    renderOutputItem(item, element) {
      // New data for this item (a new attempt), or another item drawing into this element.
      stop(item.id);
      const before = drawing.get(element);
      if (before !== undefined) stop(before);
      drawing.set(element, item.id);
      const data = item.json();
      if (!isRunningData(data)) return;
      const since = receivedAt(item.id, data.sentAt, Date.now());
      let seen = false;
      const draw = (): void => {
        // Removed without a dispose: stop once it was in the page and no longer is.
        if (seen && !element.isConnected) return stop(item.id);
        seen ||= element.isConnected;
        const now = Date.now();
        renderRunning(element, runningView(data, now, since));
        // Just past the next whole second, when the words change.
        timers.set(item.id, setTimeout(draw, msToNextSecond(data, now, since) + 20));
      };
      draw();
    },
    disposeOutputItem(id) {
      if (id !== undefined) return stop(id);
      for (const k of [...timers.keys()]) stop(k);
    },
  };
}
