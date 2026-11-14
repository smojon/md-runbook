/**
 * The Runbook Steps view (Explorer): the runbook's progress as a rail beside its steps, the same
 * as the app's rail but with room for names. At the top, where the run is (the status bar's
 * words), the bar and the time left; then the chapters (`#`/`##` headings) and the steps, each
 * with its state on the rail, its name and its time; the running one with its bar against its
 * estimate; a pale band for the cells on screen. A row goes to its cell. Shown while a runbook is
 * the active editor.
 */

import * as vscode from 'vscode';
import { formatEstimate, formatFinish, isCodeMeta, runbookEstimate, stepState, taskItems } from '@md-runbook/core';
import { blockProgress, overEstimate, remaining, stepLabel } from '@md-runbook/core/estimate';
import { headingsOf, withoutFrontMatter } from '@md-runbook/core/title';
import { setContext } from './contextKeys';
import { cellPart } from './controller';
import { cellEstimate, lastDuration, notebookEstimateSteps, notebookPartStates, runningSince } from './estimates';
import { META_KEY } from './outputs';
import { cellAttrs, notebookProgress, progressStatus } from './progress';
import { NOTEBOOK_TYPE } from './serializer';
import { onDidChangeWaiting, waitingIn } from './waiting';

export const STEPS_VIEW = 'mdRunbook.steps';

export type StepRowState = 'done' | 'failed' | 'running' | 'pending' | 'waiting';

export type StepsRow =
  | { kind: 'chapter'; index: number; title: string; level: number }
  | {
      kind: 'step';
      index: number;
      /** 1-based step number; undefined for the ready check and an offered teardown. */
      step?: number;
      label: string;
      state: StepRowState;
      /** What the time column says: `est. 2m30s`, `took 3m10s (+40s)`, `12s of 1m`. */
      time?: string;
      over?: boolean;
      /** The running step's share of its estimate, 0 to 1. */
      fraction?: number;
    };

export interface StepsModel {
  title: string;
  headline: string;
  state: 'idle' | 'running' | 'failed' | 'done' | 'waiting';
  /** By the estimates: share done, time left, finish time. */
  fraction?: number;
  /** The share done as shown: never 100 while a step is open. */
  percent?: number;
  left?: string;
  rows: StepsRow[];
  /** The cells on screen, first and last index. */
  visible?: { first: number; last: number };
}

/** The view's content for a runbook, from the same model as the status bar. */
export function stepsModel(nb: vscode.NotebookDocument, visible?: { first: number; last: number }, now = Date.now()): StepsModel {
  const p = notebookProgress(nb);
  const status = progressStatus(nb, p, now);
  const e = runbookEstimate(notebookEstimateSteps(nb, cellAttrs, now), notebookPartStates(nb, cellAttrs));
  const waiting = waitingIn(nb);
  const rows: StepsRow[] = [];
  let anyRunning = false;
  /** The last step number given (a block's from the progress, checklist items counted on). */
  let taskStep = 0;
  for (const cell of nb.getCells()) {
    const i = cell.index;
    if (cell.kind === vscode.NotebookCellKind.Markup) {
      const text = cell.document.getText();
      for (const h of headingsOf(i === 0 ? withoutFrontMatter(text) : text)) if (h.level <= 2) rows.push({ kind: 'chapter', index: i, title: h.text, level: h.level });
      // Checklist items are steps too (manual ones): numbered in order with the blocks.
      const lines = text.split(/\r?\n/);
      for (const item of taskItems(text)) {
        taskStep++;
        rows.push({
          kind: 'step',
          index: i,
          step: taskStep,
          label: (lines[item.line] ?? '').replace(/^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\[[ xX]\][ \t]*/, '') || 'checklist item',
          state: item.checked ? 'done' : 'pending',
          time: 'by hand',
        });
      }
      continue;
    }
    const step = p.stepOfCell[i];
    if (step !== undefined) taskStep = step;
    const meta: unknown = cell.metadata?.[META_KEY];
    const info = isCodeMeta(meta) ? meta.info : '';
    // Not a step: the ready check (a quick look) and a teardown not run yet (offered).
    const part = cellPart(cell);
    const offered = step === undefined && part === 'teardown' && p.resume.includes(i);
    const ready = step === undefined && part === 'ready';
    if (step === undefined && !offered && !ready) continue;
    const since = runningSince(cell);
    const est = cellEstimate(cell);
    const a = cellAttrs(cell);
    const s = stepState(a?.exit, a?.lines !== undefined, a?.check);
    let state: StepRowState = s === 'done' || s === 'skipped' ? 'done' : s === 'failed' ? 'failed' : 'pending';
    let time: string | undefined;
    let over = false;
    let fraction: number | undefined;
    if (waiting?.cell === cell) state = 'waiting';
    if (since !== undefined) {
      anyRunning = true;
      state = 'running';
      const elapsed = (now - since) / 1000;
      if (est !== undefined) {
        const b = blockProgress(elapsed, est);
        fraction = b.fraction;
        over = b.overSeconds > 0;
        time = over ? `+${formatEstimate(b.overSeconds)} over ${formatEstimate(est)}` : `${formatEstimate(elapsed)} of ${formatEstimate(est)}`;
      } else time = formatEstimate(elapsed);
    } else {
      const took = lastDuration(cell);
      const extra = took !== undefined && est !== undefined ? overEstimate(took, est) : undefined;
      if (took !== undefined && extra !== undefined) {
        time = `took ${formatEstimate(took)} (+${formatEstimate(extra)})`;
        over = true;
      } else if (took !== undefined && state !== 'pending') time = formatEstimate(took);
      else if (est !== undefined) time = `est. ${formatEstimate(est)}`;
    }
    const label = stepLabel(info, cell.document.getText(), cell.document.languageId) || `cell ${i + 1}`;
    rows.push({
      kind: 'step',
      index: i,
      ...(step !== undefined ? { step } : {}),
      label: offered ? `${label} (teardown, offered)` : ready ? `Ready check: ${label}` : label,
      state,
      ...(time !== undefined ? { time } : {}),
      ...(over ? { over } : {}),
      ...(fraction !== undefined ? { fraction } : {}),
    });
  }
  const done = p.pending === 0 && p.failed === 0 && p.total > 0;
  // Never "100%" or "nothing left" while a step is open (core remaining()).
  const rest = remaining(e, p.pending);
  return {
    title: nb.uri.path.split('/').pop() ?? 'runbook',
    headline: status.text.replace(/^\$\([^)]+\)\s*/, ''),
    state: waiting ? 'waiting' : anyRunning ? 'running' : p.firstFailed ? 'failed' : done ? 'done' : 'idle',
    ...(e.fraction !== undefined ? { fraction: e.fraction } : {}),
    ...(rest.percent !== undefined ? { percent: rest.percent, left: rest.left + (e.leftSeconds > 0 ? ` · ends ≈ ${formatFinish(e.leftSeconds, now)}` : '') } : {}),
    rows,
    ...(visible ? { visible } : {}),
  };
}

function nonce(): string {
  let s = '';
  for (let i = 0; i < 32; i++) s += 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'.charAt(Math.floor(Math.random() * 62));
  return s;
}

/** The view's page: draws what the extension posts (a StepsModel); a click asks to go to a cell. */
function page(webview: vscode.Webview): string {
  const n = nonce();
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${n}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { padding: 6px 8px 12px 6px; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
  .head { margin: 2px 0 8px 2px; }
  .headline { font-weight: 600; }
  .headline.failed { color: var(--vscode-errorForeground); }
  .headline.waiting { color: var(--vscode-editorWarning-foreground); }
  .sub { color: var(--vscode-descriptionForeground); margin-top: 2px; }
  .bar { height: 6px; border-radius: 3px; background: var(--vscode-progressBar-background); opacity: .25; position: relative; margin-top: 6px; }
  .barwrap { position: relative; margin-top: 6px; height: 6px; }
  .barwrap .track { position: absolute; inset: 0; border-radius: 3px; background: var(--vscode-editorWidget-border, #8884); }
  .barwrap .fill { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 3px; background: var(--vscode-progressBar-background); }
  .rail { position: relative; }
  .rail::before { content: ''; position: absolute; left: 8px; top: 0; bottom: 0; width: 3px; border-radius: 2px; background: var(--vscode-editorWidget-border, #8884); }
  .railfill { position: absolute; left: 8px; top: 0; width: 3px; border-radius: 2px; background: var(--vscode-progressBar-background); }
  .row { position: relative; display: flex; align-items: center; gap: 8px; padding: 3px 4px 3px 22px; border-radius: 4px; cursor: pointer; min-height: 20px; }
  .row:hover { background: var(--vscode-list-hoverBackground); }
  .row.seen { background: color-mix(in srgb, var(--vscode-editor-inactiveSelectionBackground) 40%, transparent); }
  .chapter { font-weight: 600; padding-top: 8px; }
  .chapter::before { content: ''; position: absolute; left: 4px; width: 11px; height: 2px; background: var(--vscode-descriptionForeground); }
  .chapter.l1 { font-size: 1.05em; }
  .dot { position: absolute; left: 3px; width: 13px; height: 13px; border-radius: 50%; border: 1.5px solid var(--vscode-descriptionForeground); background: var(--vscode-sideBar-background); box-sizing: border-box; display: flex; align-items: center; justify-content: center; font-size: 8px; line-height: 1; color: var(--vscode-sideBar-background); font-weight: 700; }
  .row:focus { outline: none; }
  .row:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  .done .dot { background: var(--vscode-testing-iconPassed, #388a34); border-color: var(--vscode-testing-iconPassed, #388a34); }
  .failed .dot { background: var(--vscode-testing-iconFailed, #e51400); border-color: var(--vscode-testing-iconFailed, #e51400); }
  .running .dot { background: var(--vscode-progressBar-background); border-color: var(--vscode-progressBar-background); animation: pulse 1.2s ease-in-out infinite; }
  .waiting .dot { background: var(--vscode-editorWarning-foreground); border-color: var(--vscode-editorWarning-foreground); animation: pulse 1.2s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: .3; } }
  @media (prefers-reduced-motion: reduce) { .running .dot, .waiting .dot { animation: none; } }
  .num { color: var(--vscode-descriptionForeground); min-width: 1.6em; text-align: right; }
  .label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .time { color: var(--vscode-descriptionForeground); white-space: nowrap; font-size: .92em; }
  .time.over { color: var(--vscode-editorWarning-foreground); }
  .running .label, .waiting .label { font-weight: 600; }
  .stepbar { position: absolute; left: 22px; right: 4px; bottom: 0; height: 2px; }
  .stepbar .fill { height: 2px; background: var(--vscode-progressBar-background); }
  .stepbar.over .fill { background: var(--vscode-editorWarning-foreground); }
  .empty { color: var(--vscode-descriptionForeground); }
</style></head><body>
<div id="live" class="sr" role="status" aria-live="polite"></div>
<div id="root" class="empty">Open a runbook to see its steps.</div>
<script nonce="${n}">
  const vscode = acquireVsCodeApi();
  const root = document.getElementById('root');
  const live = document.getElementById('live');
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  // State in a symbol too, not colour alone.
  const GLYPH = { done: '✓', failed: '✕', running: '▶', waiting: '❚❚', pending: '' };
  const STATE = { done: 'done', failed: 'failed', running: 'running', waiting: 'waiting for you', pending: 'to do' };
  let lastState;
  function draw(m) {
    // Keep the keyboard focus across redraws (every second while a step runs).
    const focused = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.key : undefined;
    // Say a change of state once (failed, waiting, done), not the clock every second.
    if (m.state !== lastState && lastState !== undefined) live.textContent = m.headline;
    lastState = m.state;
    root.className = '';
    root.replaceChildren();
    const head = el('div', 'head');
    head.append(el('div', 'headline ' + m.state, m.headline));
    if (m.fraction !== undefined) {
      const w = el('div', 'barwrap'); w.append(el('div', 'track'));
      const f = el('div', 'fill'); f.style.width = Math.round(m.fraction * 100) + '%'; w.append(f); head.append(w);
      head.append(el('div', 'sub', m.percent + '% · ' + m.left));
    }
    root.append(head);
    const rail = el('div', 'rail');
    rail.setAttribute('role', 'tree');
    rail.setAttribute('aria-label', 'Steps of the runbook');
    const fill = el('div', 'railfill');
    rail.append(fill);
    let reached;
    for (const r of m.rows) {
      const row = el('div', 'row ' + (r.kind === 'chapter' ? 'chapter l' + r.level : r.state));
      row.dataset.index = r.index;
      row.dataset.key = r.kind + ':' + r.index + ':' + (r.step !== undefined ? r.step : r.title || r.label);
      row.tabIndex = -1;
      row.setAttribute('role', 'treeitem');
      if (m.visible && r.index >= m.visible.first && r.index <= m.visible.last) row.classList.add('seen');
      if (r.kind === 'chapter') {
        row.append(el('span', 'label', r.title));
        row.title = 'Go to ' + r.title;
      } else {
        row.append(el('span', 'dot', GLYPH[r.state]));
        row.append(el('span', 'num', r.step !== undefined ? String(r.step) : '·'));
        row.append(el('span', 'label', r.label));
        if (r.time) row.append(el('span', 'time' + (r.over ? ' over' : ''), r.time));
        if (r.fraction !== undefined) {
          const b = el('div', 'stepbar' + (r.over ? ' over' : ''));
          const bf = el('div', 'fill'); bf.style.width = Math.round(r.fraction * 100) + '%'; b.append(bf); row.append(b);
        }
        row.title = (r.step !== undefined ? 'Step ' + r.step + ': ' : '') + r.label + ' (' + STATE[r.state] + (r.time ? ', ' + r.time : '') + ')';
        if (r.state === 'running' || r.state === 'waiting') row.setAttribute('aria-current', 'step');
        if (r.state !== 'pending') reached = row;
      }
      row.setAttribute('aria-label', row.title);
      row.addEventListener('click', () => vscode.postMessage({ go: r.index }));
      rail.append(row);
    }
    root.append(rail);
    // One tab stop for the list: the focused row, else the running one, else the first.
    const rows = [...rail.querySelectorAll('.row')];
    const again = focused !== undefined ? rows.find((x) => x.dataset.key === focused) : undefined;
    const stop = again || rail.querySelector('[aria-current]') || rows[0];
    if (stop) stop.tabIndex = 0;
    if (again) again.focus();
    // The rail fills down to the last step reached (running, done or failed).
    requestAnimationFrame(() => { fill.style.height = reached ? (reached.offsetTop + reached.offsetHeight / 2) + 'px' : '0'; });
  }
  // Up/Down (Home/End) move between rows; Enter or Space goes to the row's cell.
  root.addEventListener('keydown', (e) => {
    const row = e.target.closest && e.target.closest('.row');
    if (!row) return;
    const rows = [...root.querySelectorAll('.row')];
    const i = rows.indexOf(row);
    const to = e.key === 'ArrowDown' ? rows[i + 1] : e.key === 'ArrowUp' ? rows[i - 1] : e.key === 'Home' ? rows[0] : e.key === 'End' ? rows[rows.length - 1] : undefined;
    if (to) {
      e.preventDefault();
      row.tabIndex = -1;
      to.tabIndex = 0;
      to.focus();
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      vscode.postMessage({ go: Number(row.dataset.index) });
    }
  });
  window.addEventListener('message', (e) => { if (e.data && e.data.model) draw(e.data.model); else if (e.data && e.data.empty) { root.className = 'empty'; root.textContent = 'Open a runbook to see its steps.'; } });
  vscode.postMessage({ ready: true });
</script></body></html>`;
}

class StepsView implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private timer: NodeJS.Timeout | undefined;
  private ticker: NodeJS.Timeout | undefined;
  /** The last model posted (tests read it). */
  last: StepsModel | undefined;

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = page(view.webview);
    view.webview.onDidReceiveMessage((m: unknown) => {
      const msg = m as { ready?: boolean; go?: unknown };
      if (msg.ready) this.refresh();
      if (typeof msg.go === 'number') void this.go(msg.go);
    });
    view.onDidChangeVisibility(() => this.refresh());
    view.onDidDispose(() => (this.view = undefined));
  }

  private editor(): vscode.NotebookEditor | undefined {
    const e = vscode.window.activeNotebookEditor;
    return e?.notebook.notebookType === NOTEBOOK_TYPE ? e : undefined;
  }

  private async go(index: number): Promise<void> {
    const editor = this.editor();
    if (!editor || index < 0 || index >= editor.notebook.cellCount) return;
    const range = new vscode.NotebookRange(index, index + 1);
    editor.selections = [range];
    editor.revealRange(range, vscode.NotebookEditorRevealType.InCenterIfOutsideViewport);
  }

  /** Redraw soon (changes come in bursts), and every second while a block runs. */
  refresh(): void {
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      this.draw();
    }, 150);
  }

  model(): StepsModel | undefined {
    const editor = this.editor();
    if (!editor) return undefined;
    const r = editor.visibleRanges;
    const visible = r.length > 0 ? { first: Math.min(...r.map((x) => x.start)), last: Math.max(...r.map((x) => x.end - 1)) } : undefined;
    return stepsModel(editor.notebook, visible);
  }

  private draw(): void {
    const editor = this.editor();
    setContext('mdRunbook.runbookActive', !!editor);
    const m = this.model();
    this.last = m;
    const running = m?.state === 'running' || m?.state === 'waiting';
    if (running && !this.ticker) this.ticker = setInterval(() => this.refresh(), 1000);
    if (!running && this.ticker) {
      clearInterval(this.ticker);
      this.ticker = undefined;
    }
    if (!this.view?.visible) return;
    void this.view.webview.postMessage(m ? { model: m } : { empty: true });
  }

  dispose(): void {
    clearTimeout(this.timer);
    clearInterval(this.ticker);
  }
}

export function registerStepsView(context: vscode.ExtensionContext): void {
  const view = new StepsView();
  context.subscriptions.push(
    view,
    vscode.window.registerWebviewViewProvider(STEPS_VIEW, view),
    vscode.window.onDidChangeActiveNotebookEditor(() => view.refresh()),
    vscode.window.onDidChangeNotebookEditorVisibleRanges(() => view.refresh()),
    vscode.workspace.onDidChangeNotebookDocument((e) => {
      if (e.notebook.notebookType === NOTEBOOK_TYPE) view.refresh();
    }),
    onDidChangeWaiting(() => view.refresh()),
    // For tests: the view's model for the active runbook.
    vscode.commands.registerCommand('mdRunbook._steps', () => view.model()),
  );
  view.refresh();
}
