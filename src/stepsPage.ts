/**
 * The Steps view's page (stepsView.ts posts it a StepsModel): the header (where the run is, the
 * bar, Retry step and Resume after a failure, the preflight line with its links), then the rail
 * of chapters and steps. Each row is one element, kept by its key and updated in place, so a
 * click, the hover and the keyboard focus survive the updates (every second while a step runs).
 * A step that waits for a question asked on its cell shows that question's answers as buttons.
 * With no runbook: a short empty state with Open Sample Runbook and Open as Runbook.
 * Before a Run All, the launch form (launch.ts) stands in for the list: a <form> with the
 * parameters and inputs to fill in, the secrets to set, the risky steps, the steps by hand, the
 * time and the context; Enter or Start runs, Escape or Back goes back to the list.
 *
 * The script is in a template string: no backslashes, no backticks and no `${` in it.
 */

import type * as vscode from 'vscode';

function nonce(): string {
  let s = '';
  for (let i = 0; i < 32; i++) s += 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'.charAt(Math.floor(Math.random() * 62));
  return s;
}

/** The page; `codicons` is the URI of codicon.css (with codicon.ttf beside it). */
export function stepsPage(webview: vscode.Webview, codicons: vscode.Uri): string {
  const n = nonce();
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${n}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${codicons.toString()}" id="vscode-codicon-stylesheet">
<style>
  body { padding: 6px 8px 12px 6px; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
  [hidden] { display: none !important; }
  .head { margin: 2px 0 8px 2px; }
  .headline { font-weight: 600; }
  .headline.failed { color: var(--vscode-errorForeground); }
  .headline.waiting { color: var(--vscode-editorWarning-foreground); }
  .sub { color: var(--vscode-descriptionForeground); margin-top: 2px; }
  .hacts { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
  .btn { border: 1px solid var(--vscode-button-border, transparent); border-radius: 2px; padding: 2px 10px; font: inherit; line-height: 18px; cursor: pointer; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .btn:hover { background: var(--vscode-button-hoverBackground); }
  .btn.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .btn.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .btn:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
  .barwrap { position: relative; margin-top: 6px; height: 6px; }
  .barwrap .track { position: absolute; inset: 0; border-radius: 3px; background: var(--vscode-editorWidget-border, #8884); }
  .barwrap .fill { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 3px; background: var(--vscode-progressBar-background); }
  .pre { margin-top: 4px; color: var(--vscode-descriptionForeground); font-size: .92em; }
  .link { color: var(--vscode-textLink-foreground); text-decoration: none; cursor: pointer; }
  .link:hover, .link:focus-visible { color: var(--vscode-textLink-activeForeground); text-decoration: underline; }
  .link:focus-visible { outline: 1px solid var(--vscode-focusBorder); }
  .rail { position: relative; }
  .rail::before { content: ''; position: absolute; left: 8px; top: 0; bottom: 0; width: 3px; border-radius: 2px; background: var(--vscode-editorWidget-border, #8884); }
  .railfill { position: absolute; left: 8px; top: 0; width: 3px; border-radius: 2px; background: var(--vscode-progressBar-background); }
  .row { position: relative; display: flex; align-items: center; gap: 8px; padding: 3px 4px 3px 22px; border-radius: 4px; cursor: pointer; min-height: 20px; }
  .row:hover { background: var(--vscode-list-hoverBackground); }
  .row.seen { background: color-mix(in srgb, var(--vscode-editor-inactiveSelectionBackground) 40%, transparent); }
  .chapter, .merged { padding-top: 8px; }
  .chapter { font-weight: 600; }
  .chapter::before { content: ''; position: absolute; left: 4px; width: 11px; height: 2px; background: var(--vscode-descriptionForeground); }
  .merged .label { font-weight: 600; }
  .chapter.l1, .merged.l1 .label { font-size: 1.05em; }
  .dot { position: absolute; left: 3px; width: 13px; height: 13px; border-radius: 50%; border: 1.5px solid var(--vscode-descriptionForeground); background: var(--vscode-sideBar-background); box-sizing: border-box; display: flex; align-items: center; justify-content: center; font-size: 8px; line-height: 1; color: var(--vscode-sideBar-background); font-weight: 700; }
  .row:focus { outline: none; }
  .row:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  .done .dot { background: var(--vscode-testing-iconPassed, #388a34); border-color: var(--vscode-testing-iconPassed, #388a34); }
  .failed .dot { background: var(--vscode-testing-iconFailed, #e51400); border-color: var(--vscode-testing-iconFailed, #e51400); }
  .skipped .dot { background: var(--vscode-descriptionForeground); border-color: var(--vscode-descriptionForeground); }
  .skipped .label { color: var(--vscode-descriptionForeground); }
  .running .dot { background: var(--vscode-progressBar-background); border-color: var(--vscode-progressBar-background); animation: pulse 1.2s ease-in-out infinite; }
  .waiting .dot { background: var(--vscode-editorWarning-foreground); border-color: var(--vscode-editorWarning-foreground); animation: pulse 1.2s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: .3; } }
  .spin { flex: none; font-size: 12px !important; color: var(--vscode-progressBar-background); }
  .mark { flex: none; font-size: 12px !important; color: var(--vscode-descriptionForeground); }
  @media (prefers-reduced-motion: reduce) { .running .dot, .waiting .dot, .codicon-modifier-spin { animation: none !important; } }
  .num { color: var(--vscode-descriptionForeground); min-width: 1.6em; text-align: right; }
  .lab { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .labline { display: flex; align-items: center; gap: 4px; min-width: 0; }
  .label { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chapter .label { flex: 1; }
  .running .label, .waiting .label { font-weight: 600; }
  .detail, .needs { color: var(--vscode-descriptionForeground); font-size: .85em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .err { color: var(--vscode-errorForeground); font-family: var(--vscode-editor-font-family); font-size: .85em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .answers { display: flex; flex-wrap: wrap; gap: 4px; margin: 4px 0 2px; }
  .answers .btn { display: inline-flex; align-items: center; gap: 4px; padding: 1px 8px; font-size: .92em; }
  .answers .btn .codicon { font-size: 14px !important; }
  .time { color: var(--vscode-descriptionForeground); white-space: nowrap; font-size: .92em; }
  .time.over { color: var(--vscode-editorWarning-foreground); }
  .stepbar { position: absolute; left: 22px; right: 4px; bottom: 0; height: 2px; }
  .stepbar .fill { height: 2px; background: var(--vscode-progressBar-background); }
  .stepbar.over .fill { background: var(--vscode-editorWarning-foreground); }
  .acts { display: none; gap: 1px; flex: none; }
  .row:hover .acts, .row:focus-within .acts { display: flex; }
  .act { display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; padding: 0; border: none; border-radius: 3px; background: transparent; color: var(--vscode-icon-foreground, var(--vscode-foreground)); cursor: pointer; }
  .act:hover { background: var(--vscode-toolbar-hoverBackground); }
  .act:focus-visible { outline: 1px solid var(--vscode-focusBorder); }
  .box { width: 14px; height: 14px; margin: 3px; border: 1px solid var(--vscode-checkbox-border, var(--vscode-descriptionForeground)); background: var(--vscode-checkbox-background, transparent); color: var(--vscode-checkbox-foreground, var(--vscode-foreground)); }
  .box .codicon { font-size: 12px !important; }
  .box:not(.checked) .codicon { visibility: hidden; }
  .empty { color: var(--vscode-descriptionForeground); margin: 2px 0 0 2px; }
  .empty p { margin: 0 0 10px; }
  .empty .btn { display: block; width: 100%; margin-bottom: 6px; }
  /* The launch form (Run All…), in place of the list. */
  .launch { margin: 0 0 0 2px; }
  .lhead { display: flex; align-items: center; gap: 4px; margin: 0 0 2px -4px; }
  .lhead h2 { font-size: 1em; font-weight: 600; margin: 0; }
  .launch fieldset { border: none; padding: 0; margin: 12px 0 0; min-width: 0; }
  .launch legend { padding: 0; font-weight: 600; margin-bottom: 4px; }
  .field { margin: 0 0 10px; }
  .field label { display: block; font-family: var(--vscode-editor-font-family); font-size: .95em; }
  .desc { color: var(--vscode-descriptionForeground); font-size: .92em; margin: 1px 0 3px; }
  .field input, .field select { box-sizing: border-box; width: 100%; padding: 3px 6px; font: inherit; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; }
  .field select { color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background); border-color: var(--vscode-dropdown-border, transparent); }
  .field input::placeholder { color: var(--vscode-input-placeholderForeground); }
  .field input:focus, .field select:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .field [aria-invalid="true"] { border-color: var(--vscode-inputValidation-errorBorder, var(--vscode-errorForeground)); }
  .ferr, .lerr { color: var(--vscode-errorForeground); font-size: .92em; margin-top: 3px; }
  .litems { list-style: none; margin: 0; padding: 0; }
  .litems li { margin: 0 0 8px; }
  .srow { display: flex; align-items: center; gap: 6px; }
  .srow .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; font-family: var(--vscode-editor-font-family); font-size: .95em; }
  .srow .btn { padding: 1px 8px; font-size: .92em; }
  .cmd { margin: 3px 0 0; padding: 4px 6px; white-space: pre-wrap; word-break: break-all; font-family: var(--vscode-editor-font-family); font-size: .85em; background: var(--vscode-textCodeBlock-background); border-radius: 2px; }
  .lfoot { margin-top: 14px; }
  .lfoot .btn { display: inline-flex; align-items: center; gap: 4px; }
  /* High contrast: an outlined track (a filled one looks like a full bar), the cells on screen as a left border. */
  body.vscode-high-contrast .barwrap .track, body.vscode-high-contrast-light .barwrap .track { background: transparent; border: 1px solid var(--vscode-contrastBorder); }
  body.vscode-high-contrast .rail::before, body.vscode-high-contrast-light .rail::before { background: transparent; width: 0; left: 9px; border-left: 1px dashed var(--vscode-contrastBorder); border-radius: 0; }
  body.vscode-high-contrast .row.seen, body.vscode-high-contrast-light .row.seen { background: transparent; box-shadow: inset 2px 0 0 var(--vscode-contrastActiveBorder, var(--vscode-focusBorder)); }
  body.vscode-high-contrast .row:hover, body.vscode-high-contrast-light .row:hover { outline: 1px dashed var(--vscode-contrastActiveBorder, var(--vscode-focusBorder)); outline-offset: -1px; }
</style></head><body>
<div id="live" class="sr" role="status" aria-live="polite"></div>
<div id="empty" class="empty" hidden>
  <p>No runbook open. A runbook is a Markdown file whose shell blocks you run one step at a time.</p>
  <button class="btn" id="sample">Open Sample Runbook</button>
  <button class="btn secondary" id="openAs" title="Open a Markdown file as a runbook">Open as Runbook</button>
</div>
<div id="main" hidden>
  <div class="head">
    <div id="headline" class="headline"></div>
    <div id="hacts" class="hacts" hidden>
      <button class="btn" id="retry">Retry step</button>
      <button class="btn secondary" id="resume" title="Resume Run: run the failed step and the steps still to do">Resume</button>
    </div>
    <div id="barwrap" class="barwrap" hidden><div class="track"></div><div id="barfill" class="fill"></div></div>
    <div id="sub" class="sub" hidden></div>
    <div id="pre" class="pre" hidden></div>
  </div>
  <div id="rail" class="rail" role="tree" aria-label="Steps of the runbook"><div id="railfill" class="railfill"></div></div>
</div>
<form id="launch" class="launch" hidden novalidate aria-labelledby="lTitle">
  <div class="lhead">
    <button type="button" class="act codicon codicon-arrow-left" id="lBack" title="Back to the steps (Escape)" aria-label="Back to the steps"></button>
    <h2 id="lTitle">Run All</h2>
  </div>
  <div id="lSub" class="sub"></div>
  <div id="lBody"></div>
  <div id="lError" class="lerr" role="alert" hidden></div>
  <div class="hacts lfoot">
    <button type="submit" class="btn" id="lStart"><span class="codicon codicon-run-all" aria-hidden="true"></span>Start</button>
    <button type="button" class="btn secondary" id="lCancel">Back</button>
  </div>
  <div id="lNote" class="pre" hidden></div>
</form>
<script nonce="${n}">
  const vscode = acquireVsCodeApi();
  const post = (msg) => vscode.postMessage(msg);
  const $ = (id) => document.getElementById(id);
  const live = $('live'), emptyEl = $('empty'), main = $('main'), headline = $('headline'), hacts = $('hacts'), resumeBtn = $('resume');
  const barwrap = $('barwrap'), barfill = $('barfill'), sub = $('sub'), pre = $('pre'), rail = $('rail'), railfill = $('railfill');
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  /** Set a text (and hide the element when there is none), only when it changed. */
  const put = (node, text) => { const t = text || ''; if (node.textContent !== t) node.textContent = t; node.hidden = !t; };
  const attr = (node, name, value) => { if (value === undefined) node.removeAttribute(name); else if (node.getAttribute(name) !== value) node.setAttribute(name, value); };
  // A line break (a backslash escape would become a real one in the template string).
  const NL = String.fromCharCode(10);
  // State in a symbol too, not colour alone (the running step has a spinning icon beside its name).
  const GLYPH = { done: '✓', skipped: '↷', failed: '✕', running: '', waiting: '❚❚', pending: '' };
  const STATE = { done: 'done', skipped: 'skipped', failed: 'failed', running: 'running', waiting: 'waiting for you', pending: 'to do' };
  let model;
  let lastState;
  let keys = '';
  let preKey;
  const rowsByKey = new Map();

  $('sample').addEventListener('click', () => post({ openSample: true }));
  $('openAs').addEventListener('click', () => post({ openAsRunbook: true }));
  $('retry').addEventListener('click', () => { if (model && model.failedCell !== undefined) post({ run: model.failedCell }); });
  resumeBtn.addEventListener('click', () => post({ resume: true }));

  /** A row's buttons, the same as its keys: run it, run from it, mark it, unmark it; tick a checklist item. */
  function actionsFor(r) {
    const a = [];
    if (r.kind !== 'step') return a;
    if (r.task) {
      a.push({ id: 'tick', key: ' ', keyName: 'Space', icon: 'check', box: true, title: r.task.checked ? 'Untick' : 'Tick (done by hand)', msg: { tick: r.index, offset: r.task.offset, checked: !r.task.checked } });
    } else if (r.runnable && r.state !== 'running' && r.state !== 'waiting') {
      a.push({ id: 'run', key: 'r', keyName: 'R', icon: 'play', title: 'Run this step', msg: { run: r.index } });
      a.push({ id: 'from', key: 'f', keyName: 'F', icon: 'run-below', title: 'Run from here', msg: { runFrom: r.index } });
      if (r.state === 'pending' || r.state === 'failed') {
        a.push({ id: 'done', key: 'd', keyName: 'D', icon: 'check', title: 'Mark done', msg: { mark: r.index, as: 'done' } });
        a.push({ id: 'skip', key: 's', keyName: 'S', icon: 'debug-step-over', title: 'Mark skipped', msg: { mark: r.index, as: 'skipped' } });
      }
      if (r.marked) a.push({ id: 'unmark', key: 'u', keyName: 'U', icon: 'discard', title: 'Unmark', msg: { unmark: r.index } });
      // Failure triage: the on-failure step, and the assistant's Explain / Suggest a Fix.
      if (r.rollback) a.push({ id: 'rollback', key: 'b', keyName: 'B', icon: 'debug-reverse-continue', title: 'Run ' + r.rollback.name + ' (on-failure)', msg: { run: r.rollback.index } });
      if (r.assistant) {
        a.push({ id: 'explain', key: 'e', keyName: 'E', icon: 'sparkle', title: 'Explain why it failed', msg: { explain: r.index } });
        a.push({ id: 'fix', key: 'x', keyName: 'X', icon: 'lightbulb', title: 'Suggest a fix (a proposal to approve)', msg: { fix: r.index } });
      }
    }
    return a;
  }

  function makeRow(r) {
    const row = el('div', 'row');
    row.tabIndex = -1;
    row.setAttribute('role', 'treeitem');
    if (r.kind === 'chapter') row.append(el('span', 'label'));
    else {
      const lab = el('span', 'lab');
      const line = el('span', 'labline');
      line.append(el('span', 'label'), el('span', 'spin codicon codicon-sync codicon-modifier-spin'), el('span', 'mark codicon codicon-debug-pause'), el('span', 'mark codicon codicon-bell'));
      line.lastChild.setAttribute('aria-hidden', 'true');
      lab.append(line, el('span', 'detail'), el('span', 'needs'), el('span', 'err'), el('span', 'answers'));
      const bar = el('div', 'stepbar');
      bar.append(el('div', 'fill'));
      row.append(el('span', 'dot'), el('span', 'num'), lab, el('span', 'time'), el('span', 'acts'), bar);
      row.firstChild.setAttribute('aria-hidden', 'true');
    }
    row.addEventListener('click', () => { if (row.r) post({ go: row.r.index }); });
    return row;
  }

  function update(row, r, m) {
    row.r = r;
    const seen = m.visible && r.index >= m.visible.first && r.index <= m.visible.last ? ' seen' : '';
    const cls = 'row ' + (r.kind === 'chapter' ? 'chapter l' + r.level : r.state + (r.chapter ? ' merged l' + r.chapter : '')) + seen;
    if (row.className !== cls) row.className = cls;
    let title;
    if (r.kind === 'chapter') {
      put(row.querySelector('.label'), r.title);
      title = 'Go to ' + r.title;
      attr(row, 'aria-description', undefined);
    } else {
      const dot = row.querySelector('.dot');
      if (dot.textContent !== GLYPH[r.state]) dot.textContent = GLYPH[r.state];
      put(row.querySelector('.num'), r.step !== undefined ? String(r.step) : '·');
      put(row.querySelector('.label'), r.label);
      row.querySelector('.spin').hidden = r.state !== 'running';
      // The marks a reader put on it (stepMarks.ts), and its right-click menu (package.json webview/context).
      const pause = row.querySelector('.codicon-debug-pause');
      pause.hidden = !r.paused;
      pause.title = 'Run All pauses before this step';
      const bell = row.querySelector('.codicon-bell');
      bell.hidden = !r.notify;
      bell.title = 'A notification when this step starts';
      const ctx = r.runnable && !r.task ? JSON.stringify({ webviewSection: 'step', preventDefaultContextMenuItems: true, mdRunbookUri: m.uri, mdRunbookCell: r.index, mdRunbookPaused: !!r.paused, mdRunbookNotify: !!r.notify }) : undefined;
      if (row.dataset.vscodeContext !== ctx) { if (ctx) row.dataset.vscodeContext = ctx; else delete row.dataset.vscodeContext; }
      put(row.querySelector('.detail'), r.detail);
      put(row.querySelector('.needs'), r.needs ? 'needs ' + r.needs.join(', ') : '');
      put(row.querySelector('.err'), r.error);
      // The last lines it printed, in full on hover.
      attr(row.querySelector('.err'), 'title', r.errors && r.errors.length > 1 ? r.errors.join(NL) : undefined);
      // A question asked on the cell (Done / Skip / Stop, the teardown offer): its buttons, always shown, keys 1, 2, 3.
      const answers = r.answers || [];
      const ans = row.querySelector('.answers');
      const asig = answers.map((a) => a.id + '=' + a.label + '=' + (a.icon || '')).join('|');
      if (ans.dataset.sig !== asig) {
        ans.dataset.sig = asig;
        ans.replaceChildren(...answers.map((a, i) => {
          const b = el('button', 'btn' + (i > 0 ? ' secondary' : ''));
          if (a.icon) { const icon = el('span', 'codicon codicon-' + a.icon); icon.setAttribute('aria-hidden', 'true'); b.append(icon); }
          b.append(a.label);
          b.title = (a.tooltip || a.label) + ' (' + (i + 1) + ')';
          b.setAttribute('aria-label', a.label + ': ' + r.label);
          b.addEventListener('click', (ev) => { ev.stopPropagation(); if (row.r) post({ answer: a.id, cell: row.r.index }); });
          return b;
        }));
      }
      ans.hidden = answers.length === 0;
      const time = row.querySelector('.time');
      put(time, r.time);
      const tcls = 'time' + (r.over ? ' over' : '');
      if (time.className !== tcls) time.className = tcls;
      // The buttons are made again only when the set changes, so a click during a run is not lost.
      const acts = actionsFor(r);
      const box = row.querySelector('.acts');
      const sig = acts.map((a) => a.id + (a.box && r.task.checked ? '+' : '')).join(',');
      if (box.dataset.sig !== sig) {
        box.dataset.sig = sig;
        box.replaceChildren(...acts.map((a) => {
          const b = el('button', 'act' + (a.box ? ' box' + (r.task.checked ? ' checked' : '') : ' codicon codicon-' + a.icon));
          if (a.box) b.append(el('span', 'codicon codicon-' + a.icon));
          if (a.box) b.setAttribute('aria-pressed', r.task.checked ? 'true' : 'false');
          b.title = a.title + ' (' + a.keyName + ')';
          b.setAttribute('aria-label', a.title + ': ' + r.label);
          b.addEventListener('click', (ev) => {
            ev.stopPropagation();
            const now = actionsFor(row.r).find((x) => x.id === a.id);
            if (now) post(now.msg);
          });
          return b;
        }));
      }
      box.hidden = acts.length === 0;
      const bar = row.querySelector('.stepbar');
      bar.hidden = r.fraction === undefined;
      if (r.fraction !== undefined) {
        const w = Math.round(r.fraction * 100) + '%';
        if (bar.firstChild.style.width !== w) bar.firstChild.style.width = w;
        bar.classList.toggle('over', !!r.over);
      }
      title = (r.step !== undefined ? 'Step ' + r.step + ': ' : '') + r.label + (r.detail ? ' (' + r.detail + ')' : '') + ', ' + STATE[r.state] + (r.time ? ', ' + r.time : '') + (r.needs ? '. Needs ' + r.needs.join(', ') : '') + (r.error ? '. Error: ' + r.error : '');
      attr(row, 'aria-current', r.state === 'running' || r.state === 'waiting' ? 'step' : undefined);
      // The keys a screen reader user can press on the row.
      const keys = (r.answers || []).map((a, i) => (i + 1) + ' ' + a.label).concat(acts.map((a) => a.keyName + ' ' + a.title.toLowerCase()));
      attr(row, 'aria-description', ['Enter goes to the cell'].concat(keys).join(', '));
    }
    if (row.title !== title) row.title = title;
    attr(row, 'aria-label', title);
  }

  function drawPreflight(m) {
    const parts = m.preflightParts || [];
    const k = JSON.stringify(parts);
    if (k === preKey) return;
    preKey = k;
    pre.hidden = parts.length === 0;
    const TITLES = {
      value: 'Set the values now (Set Parameters, Set Inputs)',
      secret: 'Set Secret',
      confirmation: 'Go to the first step that asks for your confirmation',
      proposal: 'Go to the first proposed step',
      byHand: 'Go to the first step done by hand',
    };
    const nodes = ['Before you run: '];
    parts.forEach((p, i) => {
      if (i > 0) nodes.push(' · ');
      const a = el('a', 'link', p.text);
      a.href = '#';
      a.setAttribute('role', 'button');
      a.title = TITLES[p.kind] + (p.names && p.names.length ? ': ' + p.names.join(', ') : '');
      a.addEventListener('click', (ev) => { ev.preventDefault(); post({ preflight: p.kind }); });
      nodes.push(a);
    });
    pre.replaceChildren(...nodes);
  }

  function draw(m) {
    model = m;
    emptyEl.hidden = true;
    // The launch form stands in for the list while it is open; the list keeps up behind it.
    main.hidden = !!launch;
    // Say a change of state once (failed, waiting, done), not the clock every second.
    if (m.state !== lastState && lastState !== undefined) live.textContent = m.headline;
    lastState = m.state;
    put(headline, m.headline);
    const hcls = 'headline ' + m.state;
    if (headline.className !== hcls) headline.className = hcls;
    hacts.hidden = m.failedCell === undefined;
    resumeBtn.hidden = !m.canResume;
    barwrap.hidden = m.fraction === undefined;
    if (m.fraction !== undefined) barfill.style.width = Math.round(m.fraction * 100) + '%';
    put(sub, m.fraction !== undefined ? (m.share || m.percent + '%') + ' · ' + m.left : '');
    drawPreflight(m);
    // One element per row key, updated in place; the list is put together again only when the rows change.
    const seenKeys = new Map();
    const want = m.rows.map((r) => {
      const base = r.kind + ':' + r.index + ':' + (r.step !== undefined ? r.step : r.title || r.label);
      const n = (seenKeys.get(base) || 0) + 1;
      seenKeys.set(base, n);
      return n > 1 ? base + '#' + n : base;
    });
    const els = m.rows.map((r, i) => {
      let row = rowsByKey.get(want[i]);
      if (!row) { row = makeRow(r); rowsByKey.set(want[i], row); }
      update(row, r, m);
      return row;
    });
    const focused = document.activeElement;
    const hadFocus = rail.contains(focused);
    const joined = want.join('|');
    if (joined !== keys) {
      keys = joined;
      const keep = new Set(want);
      for (const k of [...rowsByKey.keys()]) if (!keep.has(k)) rowsByKey.delete(k);
      rail.replaceChildren(railfill, ...els);
      if (hadFocus && focused !== document.activeElement && rail.contains(focused)) focused.focus();
    }
    // One tab stop for the list: the row that has it, else the running one, else the first.
    if (!els.some((x) => x.tabIndex === 0)) {
      const stop = els.find((x) => x.hasAttribute('aria-current')) || els[0];
      if (stop) stop.tabIndex = 0;
      // The focused row went away: the focus goes to the list's tab stop, not to the page.
      if (stop && hadFocus && !rail.contains(document.activeElement)) stop.focus();
    }
    // The rail fills down to the last step reached (running, done or failed).
    let reached;
    m.rows.forEach((r, i) => { if (r.kind === 'step' && r.state !== 'pending') reached = els[i]; });
    requestAnimationFrame(() => { railfill.style.height = reached ? (reached.offsetTop + reached.offsetHeight / 2) + 'px' : '0'; });
  }

  function drawEmpty() {
    model = undefined;
    if (launch) closeLaunch(false);
    main.hidden = true;
    emptyEl.hidden = false;
  }

  // The launch form (Run All…): built when it opens; sent again (a secret just set), the same
  // fields stay as they are, with what was typed, and only the secrets' rows change.
  const launchEl = $('launch'), lSub = $('lSub'), lBody = $('lBody'), lError = $('lError'), lNote = $('lNote');
  let launch;
  let launchKey;
  const secretRows = new Map();
  const stepName = (x) => (x.step !== undefined ? 'Step ' + x.step + ' · ' : '') + x.label;

  /** A labelled field: the name, its description, the control, and a line for its error. */
  function field(kind, name, desc, control) {
    const id = 'f-' + kind + '-' + name;
    const wrap = el('div', 'field');
    const label = el('label', '', name);
    label.htmlFor = id;
    control.id = id;
    control.name = kind + ':' + name;
    wrap.append(label);
    const by = [];
    if (desc) {
      const d = el('div', 'desc', desc);
      d.id = 'd-' + kind + '-' + name;
      by.push(d.id);
      wrap.append(d);
    }
    const err = el('div', 'ferr');
    err.id = 'e-' + kind + '-' + name;
    err.hidden = true;
    by.push(err.id);
    control.setAttribute('aria-describedby', by.join(' '));
    wrap.append(control, err);
    return wrap;
  }

  function section(title, note, children) {
    const fs = el('fieldset');
    fs.append(el('legend', '', title));
    if (note) fs.append(el('div', 'desc', note));
    fs.append(...children);
    return fs;
  }

  function paramField(p) {
    let control;
    const ok = p.value !== undefined && (!p.choices || p.choices.indexOf(p.value) >= 0);
    if (p.choices) {
      control = el('select');
      if (!ok) { const none = el('option', '', 'Choose one…'); none.value = ''; control.append(none); }
      for (const c of p.choices) { const o = el('option', '', c); o.value = c; control.append(o); }
      control.value = ok ? p.value : '';
    } else {
      control = el('input');
      control.type = 'text';
      control.value = ok ? p.value : '';
    }
    const from = p.from === 'session' ? 'set for this session' : p.from === 'last' ? 'last used' : '';
    const def = p.default !== undefined && p.from !== 'default' ? 'default ' + (p.default === '' ? '(empty)' : p.default) : '';
    return field('param', p.name, [p.description || '', def, from].filter(Boolean).join(' · '), control);
  }

  function inputField(i) {
    const control = el('input');
    control.type = i.secret ? 'password' : 'text';
    if (i.secret) control.placeholder = i.set ? 'Set for this session: empty keeps it' : 'Empty: asked when the run starts';
    else if (i.value !== undefined) control.value = i.value;
    return field('input', i.name, i.secret ? 'Secret: not shown, not remembered' : '', control);
  }

  function secretRow(s) {
    const li = el('li', 'srow');
    const icon = el('span', 'codicon codicon-key');
    icon.setAttribute('aria-hidden', 'true');
    const state = el('span', 'desc');
    const set = el('button', 'btn secondary', 'Set…');
    set.type = 'button';
    set.title = 'Set Secret ' + s.name + ' (stored in the OS keychain)';
    set.setAttribute('aria-label', 'Set secret ' + s.name);
    set.addEventListener('click', () => post({ launchSecret: s.name }));
    li.append(icon, el('span', 'name', s.name), state, set);
    li.stateEl = state;
    li.setBtn = set;
    return li;
  }

  function updateSecret(li, s) {
    put(li.stateEl, s.stored ? (s.askAllow ? 'stored · the run asks to allow it here' : 'stored') : 'not stored');
    li.setBtn.hidden = s.stored;
  }

  function stepLink(x) {
    const a = el('a', 'link', stepName(x));
    a.href = '#';
    a.title = 'Go to the step';
    a.addEventListener('click', (ev) => { ev.preventDefault(); post({ go: x.index }); });
    return a;
  }

  /** Build the form for a new launch model, or update the one shown. */
  function drawLaunch(l) {
    if (launch && launch.uri !== l.uri) closeLaunch(false);
    const first = !launch;
    launch = l;
    const key = JSON.stringify([l.uri, l.params.map((p) => [p.name, p.choices]), l.inputs.map((i) => [i.name, i.secret]), l.secrets.map((s) => s.name), l.risky.map((r) => [r.index, r.lines]), l.byHand.map((b) => b.index)]);
    if (key !== launchKey) {
      // Typed values survive a new build of the same fields.
      const typed = new Map();
      for (const c of launchEl.querySelectorAll('input, select')) if (c.name) typed.set(c.name, c.value);
      launchKey = key;
      secretRows.clear();
      const parts = [];
      if (l.params.length) parts.push(section('Parameters', '', l.params.map(paramField)));
      if (l.inputs.length) parts.push(section('Inputs', '', l.inputs.map(inputField)));
      if (l.secrets.length) {
        const ul = el('ul', 'litems');
        for (const s of l.secrets) { const li = secretRow(s); secretRows.set(s.name, li); ul.append(li); }
        parts.push(section('Secrets', 'From the OS keychain, never shown.', [ul]));
      }
      if (l.risky.length) {
        const ul = el('ul', 'litems');
        for (const r of l.risky) {
          const li = el('li');
          li.append(stepLink(r));
          if (r.match) li.append(el('div', 'desc', 'matches “' + r.match + '”'));
          li.append(el('pre', 'cmd', r.lines.join(NL) + (r.more ? NL + '… ' + r.more + ' more line' + (r.more === 1 ? '' : 's') : '')));
          ul.append(li);
        }
        parts.push(section('Risky steps', 'Each one still asks for your confirmation when it runs.', [ul]));
      }
      if (l.byHand.length) {
        const ul = el('ul', 'litems');
        for (const b of l.byHand) { const li = el('li'); li.append(stepLink(b)); ul.append(li); }
        parts.push(section('Steps by hand', l.byHandWaits ? 'The run waits at each one until you tick it, skip it or stop.' : 'Reminders: the run goes on past them (manual-steps: continue).', [ul]));
      }
      const where = (l.context || []).map((c) => c.name + ': ' + c.value);
      if (l.kubeContext) where.push('kube-context: ' + l.kubeContext + ' (checked before each step)');
      if (l.contextLater) where.push('Recorded when the first step runs.');
      if (where.length) parts.push(section('Context', '', where.map((w) => el('div', 'desc', w))));
      if (!l.params.length && !l.inputs.length && !l.secrets.length) parts.unshift(el('p', 'desc', 'Nothing to type or set.'));
      lBody.replaceChildren(...parts);
      for (const c of launchEl.querySelectorAll('input, select')) if (typed.has(c.name)) c.value = typed.get(c.name);
    }
    for (const s of l.secrets) { const li = secretRows.get(s.name); if (li) updateSecret(li, s); }
    put(lSub, [l.title, l.time].filter(Boolean).join(' · '));
    const missing = l.secrets.filter((s) => !s.stored).map((s) => s.name);
    put(lNote, missing.length ? (missing.length === 1 ? 'Secret ' + missing[0] + ' is not stored: the run asks for it when it gets there.' : missing.length + ' secrets are not stored: the run asks for each when it gets there.') : '');
    if (first) {
      put(lError, '');
      emptyEl.hidden = true;
      main.hidden = true;
      launchEl.hidden = false;
      live.textContent = 'Run All: check the values, then Start.';
      const go = launchEl.querySelector('#lBody input, #lBody select') || $('lStart');
      go.focus();
    }
  }

  /** Close the form (Back, Escape, Start, or the extension's word), back to the list. */
  function closeLaunch(tell) {
    if (!launch) return;
    launch = undefined;
    launchKey = undefined;
    secretRows.clear();
    lBody.replaceChildren();
    launchEl.hidden = true;
    if (tell) post({ launchBack: true });
    if (model) {
      main.hidden = false;
      const stop = rail.querySelector('.row[tabindex="0"]');
      if (stop) stop.focus();
    } else emptyEl.hidden = false;
  }

  /** A field's error, or none; the first wrong field gets the focus. */
  function fieldError(name, text) {
    const c = launchEl.querySelector('[name="' + name + '"]');
    if (!c) return false;
    const err = $('e-' + name.replace(':', '-'));
    attr(c, 'aria-invalid', text ? 'true' : undefined);
    if (err) put(err, text);
    return !!text;
  }

  launchEl.addEventListener('submit', (ev) => {
    ev.preventDefault();
    if (!launch) return;
    const params = {}, inputs = {};
    let wrong;
    for (const p of launch.params) {
      const c = launchEl.querySelector('[name="param:' + p.name + '"]');
      if (!c) continue;
      const bad = p.choices && p.choices.indexOf(c.value) < 0 ? 'Choose one of: ' + p.choices.join(', ') : '';
      if (fieldError('param:' + p.name, bad) && !wrong) wrong = c;
      params[p.name] = c.value;
    }
    for (const i of launch.inputs) {
      const c = launchEl.querySelector('[name="input:' + i.name + '"]');
      if (c) inputs[i.name] = c.value;
    }
    if (wrong) { put(lError, 'Check the values marked above.'); wrong.focus(); return; }
    put(lError, '');
    post({ launchStart: { params, inputs } });
  });
  launchEl.addEventListener('input', (ev) => { if (ev.target.name && ev.target.getAttribute('aria-invalid')) fieldError(ev.target.name, ''); });
  launchEl.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { ev.preventDefault(); closeLaunch(true); } });
  $('lBack').addEventListener('click', () => closeLaunch(true));
  $('lCancel').addEventListener('click', () => closeLaunch(true));

  // Up/Down (Home/End) move between rows; Enter goes to the row's cell; R, F, D, S, U and Space act on its step.
  rail.addEventListener('keydown', (e) => {
    const row = e.target.closest && e.target.closest('.row');
    if (!row) return;
    const rows = [...rail.querySelectorAll('.row')];
    const i = rows.indexOf(row);
    const to = e.key === 'ArrowDown' ? rows[i + 1] : e.key === 'ArrowUp' ? rows[i - 1] : e.key === 'Home' ? rows[0] : e.key === 'End' ? rows[rows.length - 1] : undefined;
    if (to) {
      e.preventDefault();
      row.tabIndex = -1;
      to.tabIndex = 0;
      to.focus();
      return;
    }
    // On a row button, Enter and Space press the button.
    if (e.target !== row || e.ctrlKey || e.altKey || e.metaKey || !row.r) return;
    const key = e.key === ' ' ? ' ' : e.key.toLowerCase();
    const act = actionsFor(row.r).find((a) => a.key === key);
    const answer = row.r.answers && /^[1-9]$/.test(e.key) ? row.r.answers[Number(e.key) - 1] : undefined;
    if (answer) {
      e.preventDefault();
      post({ answer: answer.id, cell: row.r.index });
    } else if (act) {
      e.preventDefault();
      post(act.msg);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      post({ go: row.r.index });
    }
  });
  window.addEventListener('message', (e) => {
    const d = e.data || {};
    if (d.model) draw(d.model);
    else if (d.empty) drawEmpty();
    else if (d.launch) drawLaunch(d.launch);
    else if (d.launchClose) closeLaunch(false);
    else if (d.launchError) {
      // Start refused a value (checked again there): say which, keep the form.
      put(lError, d.launchError.error);
      if (d.launchError.field && fieldError(d.launchError.field, d.launchError.error)) launchEl.querySelector('[name="' + d.launchError.field + '"]').focus();
    }
  });
  post({ ready: true });
</script></body></html>`;
}
