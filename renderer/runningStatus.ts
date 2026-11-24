/**
 * Notebook renderer for a running cell's status (src/runningStatus.ts): a thin bar against the
 * block's estimate in the theme's progress colour (the warning colour once past it), and the words
 * every client uses: `running · 12s of about 30s · attempt 2/5`. Without an estimate, the words
 * only. The extension sends when the cell started once (runningView.ts); this renderer redraws
 * the words and the bar every second with its own timer. The bar glides between redraws unless
 * the reader asked for reduced motion. The timer stops when the output goes, or when it is given
 * the ended item (runningView.ts EndedData): then it draws nothing.
 *
 * Data drawn for the first time may have come minutes ago (scrolled back into view, a new webview
 * after a split or a move): the renderer asks the extension host how long the cell has run, and
 * counts from its answer.
 *
 * Built separately as an ES module for the notebook webview (tsconfig.renderer.json).
 */

import { Count, ElapsedAsk, RunningData, RunningView, firstCount, hostCount, isElapsedAnswer, isRunningData, msToNextSecond, runningView } from './runningView';

interface OutputItem {
  id: string;
  json(): unknown;
}

/** The part of VS Code's renderer context used here: messaging, when the extension host is there. */
interface RendererContext {
  postMessage?(message: unknown): void;
  onDidReceiveMessage?(listener: (message: unknown) => void): unknown;
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
    track.setAttribute('aria-label', 'Running');
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

/** The redraw timer of each output item, its redraw, and the item drawing into each element. */
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const redraws = new Map<string, () => void>();
const drawing = new WeakMap<HTMLElement, string>();
/**
 * Each item's count, for its data (sentAt). Kept after a dispose: an item drawn again (scrolled
 * back into view) goes on counting. The oldest go past a few hundred.
 */
const counts = new Map<string, { sentAt: number; count: Count }>();
const COUNTS_KEPT = 200;

/** The item's count; new data (first drawn here, or a new attempt) starts one, and asks the host. */
function countFor(id: string, d: RunningData, now: number, ask: ((m: ElapsedAsk) => void) | undefined): Count {
  const known = counts.get(id);
  if (known !== undefined && known.sentAt === d.sentAt) return known.count;
  const count = firstCount(d, now);
  counts.delete(id);
  counts.set(id, { sentAt: d.sentAt, count });
  if (counts.size > COUNTS_KEPT) counts.delete(counts.keys().next().value!);
  ask?.({ type: 'elapsed?', id, startedAt: d.startedAt });
  return count;
}

function stop(id: string): void {
  const t = timers.get(id);
  if (t !== undefined) clearTimeout(t);
  timers.delete(id);
  redraws.delete(id);
}

export function activate(ctx: RendererContext = {}): { renderOutputItem(item: OutputItem, element: HTMLElement): void; disposeOutputItem(id?: string): void } {
  const ask = ctx.postMessage ? (m: ElapsedAsk): void => ctx.postMessage!(m) : undefined;
  // The host's answer: count from it, and redraw now if the item is still drawn.
  ctx.onDidReceiveMessage?.((m) => {
    if (!isElapsedAnswer(m)) return;
    const known = counts.get(m.id);
    if (known === undefined) return;
    known.count = hostCount(m.elapsedMs, Date.now());
    redraws.get(m.id)?.();
  });
  return {
    renderOutputItem(item, element) {
      // New data for this item (a new attempt), or another item drawing into this element.
      stop(item.id);
      const before = drawing.get(element);
      if (before !== undefined) stop(before);
      drawing.set(element, item.id);
      const data = item.json();
      // Ended (runningView.ts EndedData), or nothing we can draw: draw nothing, count no more.
      if (!isRunningData(data)) {
        element.textContent = '';
        counts.delete(item.id);
        return;
      }
      countFor(item.id, data, Date.now(), ask);
      let seen = false;
      const draw = (): void => {
        // Removed without a dispose: stop once it was in the page and no longer is.
        if (seen && !element.isConnected) return stop(item.id);
        seen ||= element.isConnected;
        const pending = timers.get(item.id);
        if (pending !== undefined) clearTimeout(pending);
        const now = Date.now();
        const count = countFor(item.id, data, now, undefined);
        renderRunning(element, runningView(data, now, count));
        // Just past the next whole second, when the words change.
        timers.set(item.id, setTimeout(draw, msToNextSecond(count, now) + 20));
      };
      redraws.set(item.id, draw);
      draw();
    },
    disposeOutputItem(id) {
      if (id !== undefined) return stop(id);
      for (const k of [...timers.keys()]) stop(k);
    },
  };
}
