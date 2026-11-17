/**
 * Notebook renderer for a running cell's status (src/runningStatus.ts): a thin bar against the
 * block's estimate in the theme's progress colour (the warning colour once past it), and the words
 * every client uses: `running · 12s of about 30s · attempt 2/5`. Without an estimate, the words
 * only. Redrawn in place every second; the bar glides between redraws unless the reader asked for
 * reduced motion.
 *
 * Built separately as an ES module for the notebook webview (tsconfig.renderer.json).
 */

/** What the extension sends (src/runningStatus.ts RunningState). */
export interface RunningState {
  text: string;
  attempt?: string;
  fraction?: number;
  over: boolean;
}

interface OutputItem {
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

function isState(v: unknown): v is RunningState {
  const s = v as Partial<RunningState> | null;
  return typeof s === 'object' && s !== null && typeof s.text === 'string';
}

/** The status in `element`: built once, then updated in place (so the bar can glide). */
export function renderRunning(element: HTMLElement, state: RunningState): void {
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
  const line = state.attempt ? `${state.text} · ${state.attempt}` : state.text;
  root.classList.toggle('over', state.over);
  // Text only: the words come from the extension, never markup.
  words.textContent = line;
  if (state.fraction === undefined) {
    track.hidden = true;
  } else {
    const f = Math.min(1, Math.max(0, Number.isFinite(state.fraction) ? state.fraction : 0));
    track.hidden = false;
    track.setAttribute('aria-valuenow', String(Math.round(f * 100)));
    track.setAttribute('aria-valuetext', line);
    fill.style.width = `${(f * 100).toFixed(1)}%`;
  }
}

export function activate(): { renderOutputItem(item: OutputItem, element: HTMLElement): void } {
  return {
    renderOutputItem(item, element) {
      const state = item.json();
      if (isState(state)) renderRunning(element, state);
    },
  };
}
