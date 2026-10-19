/**
 * Line runs: run the line under the cursor (or the selected text) of a code cell, run all its
 * lines one by one, or step through them, pausing before each line like a debugger. Lines are
 * commands as `core/steps.ts` finds them; the controller runs them in one shell.
 *
 * In cells with two or more commands, each command has buttons. By default they are in a hover on
 * the line (links in a hover take a plain click): Run line, Run until here, Run / Step from here, Check, Breakpoint,
 * Copy with values, Explain (with an AI provider set), then what the line would ask before running,
 * the last known target context, and the current values of its `${…}` references. Checked lines
 * get a ☑ in the margin, and the cell's status line has "Run N checked lines". With
 * `lines.buttons: inline` they are `▶ ☐` in front of each command instead (inlay hints: always
 * shown, but VS Code runs them on Ctrl+click only).
 *
 * Breakpoints (VS Code's red dots) in a cell make its runs pause before those lines: a normal run
 * of such a cell becomes a line run.
 */

import * as vscode from 'vscode';
import { SUPPORTED_LANGUAGE_IDS, shellKindForLanguage } from '@md-runbook/core';
import { SECTION } from './config';
import { LineStep, formatLineRange, formatLineRanges, splitSteps, stepAtLine } from '@md-runbook/core/steps';
import { LineRun, RunbookController } from './controller';
import { isCell, runbookEditor, selectRunbookKernel } from './progress';
import type { SafetyInfo } from './safety';
import type { SecretsInfo } from './secrets';
import { NOTEBOOK_TYPE } from './serializer';

type Mode = 'selection' | 'each' | 'step' | 'from' | 'stepFrom' | 'to' | 'at' | 'checked';

/** What other features know about a line, for its hover. */
export interface LineInfo {
  safety: Pick<SafetyInfo, 'confirmation' | 'context'>;
  secrets: SecretsInfo;
}

/** For `at`, `from`, `stepFrom`, `to`: the line (0-based) to run, start at or end at; for `checked`: the checked commands' texts. */
interface PlanOptions {
  line?: number;
  checked?: ReadonlySet<string>;
}

/** A Step Through run waiting before its next line. */
interface Paused {
  cell: vscode.NotebookCell;
  /** The step that runs next, and the run's steps. */
  index: number;
  steps: readonly LineStep[];
  next(): void;
  rest(): void;
  stop(): void;
}

const PAUSED_KEY = 'mdRunbook.stepPaused';
/** A runbook code cell's editor has text selected (menus offer "… Selection" only then). */
const SELECTION_KEY = 'mdRunbook.cellSelection';
/** Some cell of an open runbook has checked lines (menus offer Run Checked Lines only then). */
const CHECKED_KEY = 'mdRunbook.hasCheckedLines';

type ButtonsMode = 'hover' | 'inline' | 'off';

/** `lines.buttons`; the true / false of 0.3.x still work (true: inline, false: off). */
function buttonsMode(): ButtonsMode {
  const v = vscode.workspace.getConfiguration(SECTION).get<unknown>('lines.buttons', 'hover');
  if (v === false || v === 'off') return 'off';
  if (v === true || v === 'inline') return 'inline';
  return 'hover';
}

const breakpointsOn = (): boolean => vscode.workspace.getConfiguration(SECTION).get<boolean>('lines.breakpoints', true);

/** The breakpoints (enabled or not) on lines `start`..`end` of a cell. */
function breakpointsIn(uri: vscode.Uri, start: number, end: number): vscode.SourceBreakpoint[] {
  const key = uri.toString();
  return vscode.debug.breakpoints.filter(
    (b): b is vscode.SourceBreakpoint =>
      b instanceof vscode.SourceBreakpoint && b.location.uri.toString() === key && b.location.range.start.line >= start && b.location.range.start.line <= end,
  );
}

/** Inline code for the hover: one line, at most 60 characters. */
function code(s: string): string {
  const one = s.replace(/\r?\n/g, ' ⏎ ');
  const short = one.length > 60 ? `${one.slice(0, 59)}…` : one;
  const ticks = '`'.repeat(Math.max(0, ...[...short.matchAll(/`+/g)].map((m) => m[0].length)) + 1);
  return `${ticks} ${short} ${ticks}`;
}

const escapeMd = (s: string): string => s.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');

/** Lines (0-based) of the cell that have an enabled breakpoint (none with `lines.breakpoints` off). */
function breakpointLines(cell: vscode.NotebookCell): Set<number> {
  if (!breakpointsOn()) return new Set();
  const uri = cell.document.uri.toString();
  return new Set(
    vscode.debug.breakpoints
      .filter((b): b is vscode.SourceBreakpoint => b instanceof vscode.SourceBreakpoint && b.enabled && b.location.uri.toString() === uri)
      .map((b) => b.location.range.start.line),
  );
}

/** The cell a command applies to, with its text editor when one is shown (for the cursor). */
function targetCell(arg: unknown): { cell: vscode.NotebookCell; editor?: vscode.TextEditor } | undefined {
  const editorOf = (cell: vscode.NotebookCell): vscode.TextEditor | undefined =>
    vscode.window.visibleTextEditors.find((e) => e.document === cell.document);
  if (isCell(arg)) return arg.notebook.notebookType === NOTEBOOK_TYPE ? { cell: arg, editor: editorOf(arg) } : undefined;
  const nbEditor = runbookEditor(vscode.window.activeNotebookEditor?.notebook);
  if (!nbEditor) return undefined;
  const active = vscode.window.activeTextEditor;
  const focused = active && nbEditor.notebook.getCells().find((c) => c.document === active.document);
  if (focused) return { cell: focused, editor: active };
  const index = nbEditor.selections[0]?.start;
  const cell = index !== undefined && index < nbEditor.notebook.cellCount ? nbEditor.notebook.cellAt(index) : undefined;
  return cell && { cell, editor: editorOf(cell) };
}

/** Trimmed to its last character, so a selection of whole lines doesn't end on the next line. */
function lastSelectedLine(sel: vscode.Selection): number {
  return sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line - 1 : sel.end.line;
}

/** Builds what to run, or says why there is nothing to run. */
function planLineRun(
  mode: Mode,
  cell: vscode.NotebookCell,
  editor: vscode.TextEditor | undefined,
  opts: PlanOptions = {},
): Omit<LineRun, 'beforeStep' | 'onStep' | 'cellText'> | string {
  const kind = shellKindForLanguage(cell.document.languageId);
  if (cell.kind !== vscode.NotebookCellKind.Code || kind === undefined) return 'line runs need a bash, PowerShell or cmd code cell.';
  const doc = cell.document;
  const all = splitSteps(doc.getText(), kind);
  if (all.length === 0) return 'this cell has no commands to run.';
  if (mode === 'each' || mode === 'step') return { source: doc.getText(), steps: all, coversCell: true };
  if (mode === 'at') {
    const step = opts.line === undefined ? undefined : stepAtLine(all, opts.line);
    if (!step) return 'that line has no command any more (the cell changed); run it again from its ▶.';
    return { source: step.text, steps: [step], coversCell: all.length === 1 };
  }
  if (mode === 'to') {
    // Up to and including the command on that line (or the last one before it).
    const to = opts.line === undefined ? -1 : all.findIndex((s) => s.end >= opts.line!);
    const end = to < 0 ? all.length - 1 : all[to]!.start <= opts.line! ? to : to - 1;
    if (opts.line === undefined || end < 0) return 'that line has no command any more (the cell changed); hover it again.';
    const steps = all.slice(0, end + 1);
    return { source: steps.map((s) => s.text).join('\n'), steps, coversCell: end === all.length - 1 };
  }
  if (mode === 'checked') {
    const steps = all.filter((s) => opts.checked?.has(s.text));
    if (steps.length === 0) return 'no lines are checked in this cell: hover a line and click ☐ Check first.';
    return { source: steps.map((s) => s.text).join('\n'), steps, coversCell: steps.length === all.length };
  }

  const sel = editor?.selection;
  if (mode === 'from' || mode === 'stepFrom') {
    // From the given line or the cursor line (the selection's first line): its command, or the
    // next one after a blank or comment line.
    const line = opts.line ?? (sel && (sel.isEmpty ? sel.active.line : sel.start.line));
    if (line === undefined) return 'put the cursor on a line of the cell, or select the text to run.';
    const from = all.findIndex((s) => s.end >= line);
    if (from < 0) return `there is no command on or after line ${line + 1}.`;
    const steps = all.slice(from);
    return { source: steps.map((s) => s.text).join('\n'), steps, coversCell: from === 0 };
  }
  if (!sel) return 'put the cursor on a line of the cell, or select the text to run.';
  if (sel.isEmpty) {
    const step = stepAtLine(all, sel.active.line);
    if (!step) return `line ${sel.active.line + 1} has no command (it is blank or a comment).`;
    return { source: step.text, steps: [step], coversCell: all.length === 1 };
  }
  const text = doc.getText(sel).replace(/(\r\n|\n|\r)$/, '');
  if (text.trim() === '') return 'the selection is empty.';
  const step: LineStep = { start: sel.start.line, end: lastSelectedLine(sel), text };
  // Every command of the cell is selected from its first character to the end of its last line.
  const coversCell = all.every((s) => {
    const first = doc.lineAt(s.start);
    return sel.contains(new vscode.Range(s.start, first.firstNonWhitespaceCharacterIndex, s.end, doc.lineAt(s.end).text.length));
  });
  return { source: text, steps: [step], coversCell };
}

export function registerLineRuns(context: vscode.ExtensionContext, controller: RunbookController, info: LineInfo): void {
  const paused = new Map<string, Paused>();
  const running = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('editor.focusedStackFrameHighlightBackground'),
  });
  const waiting = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('editor.stackFrameHighlightBackground'),
    after: {
      contentText: '  ⏸ next line: F10 run · F5 continue · Shift+F5 stop',
      color: new vscode.ThemeColor('editorCodeLens.foreground'),
      fontStyle: 'italic',
    },
  });
  /** The ☑ in the margin of checked lines (hover mode: there is no ☑ in the line then). */
  const checkedMark = vscode.window.createTextEditorDecorationType({
    gutterIconPath: vscode.Uri.joinPath(context.extensionUri, 'images', 'line-checked.svg'),
    gutterIconSize: '80%',
  });
  /** Highlighted line per cell document, re-applied when its editor is shown again. */
  const highlights = new Map<vscode.TextDocument, { type: vscode.TextEditorDecorationType; range: vscode.Range }>();
  const paint = (editors: readonly vscode.TextEditor[] = vscode.window.visibleTextEditors): void => {
    for (const e of editors) {
      const h = highlights.get(e.document);
      e.setDecorations(running, h?.type === running ? [h.range] : []);
      e.setDecorations(waiting, h?.type === waiting ? [h.range] : []);
    }
  };
  const highlight = (cell: vscode.NotebookCell, type: vscode.TextEditorDecorationType | undefined, step?: LineStep): void => {
    if (type && step) highlights.set(cell.document, { type, range: new vscode.Range(step.start, 0, step.end, cell.document.lineAt(step.end).text.length) });
    else highlights.delete(cell.document);
    paint(vscode.window.visibleTextEditors.filter((e) => e.document === cell.document));
  };

  const status = vscode.window.createStatusBarItem('mdRunbook.stepThrough', vscode.StatusBarAlignment.Left, 99);
  status.name = 'md-runbook step through';
  status.command = 'mdRunbook.stepNext';
  /** The paused run of the active runbook, if any. */
  const activePaused = (): Paused | undefined => {
    const nb = vscode.window.activeNotebookEditor?.notebook;
    return nb && paused.get(nb.uri.toString());
  };
  const updateUi = (): void => {
    const p = activePaused();
    void vscode.commands.executeCommand('setContext', PAUSED_KEY, p !== undefined);
    if (!p) return status.hide();
    const step = p.steps[p.index]!;
    status.text = `$(debug-pause) line ${formatLineRange(step.start, step.end)} next (${p.index + 1}/${p.steps.length})`;
    status.tooltip = `md-runbook: paused in cell ${p.cell.index + 1}. Click or F10 to run the next line, F5 to continue (to the next breakpoint), Shift+F5 to stop.`;
    status.show();
  };

  /** Checked commands per cell (cell document URI → command texts); kept until the runbook closes. */
  const checks = new Map<string, Set<string>>();
  const checkedIn = (cell: vscode.NotebookCell): Set<string> => {
    const key = cell.document.uri.toString();
    let set = checks.get(key);
    if (!set) checks.set(key, (set = new Set()));
    return set;
  };
  /** Fired when checks or `lines.buttons` change: the ▶ ☐ hints, the ☑ margin and the cell status redraw. */
  const hintsChanged = new vscode.EventEmitter<void>();

  /** A runbook's code cell by its document URI (what the ▶ and ☐ buttons pass). */
  const cellByUri = (uri: unknown): vscode.NotebookCell | undefined => {
    const key = String(uri);
    for (const nb of vscode.workspace.notebookDocuments) {
      if (nb.notebookType !== NOTEBOOK_TYPE) continue;
      const cell = nb.getCells().find((c) => c.document.uri.toString() === key);
      if (cell) return cell;
    }
    return undefined;
  };

  const run = async (mode: Mode, arg?: unknown, line?: number): Promise<void> => {
    const target = typeof arg === 'string' ? (cellByUri(arg) ? { cell: cellByUri(arg)! } : undefined) : targetCell(arg);
    if (!target) return void vscode.window.showInformationMessage('md-runbook: open a runbook and pick a code cell first.');
    const { cell, editor } = target as { cell: vscode.NotebookCell; editor?: vscode.TextEditor };
    const plan = planLineRun(mode, cell, editor, { ...(line !== undefined ? { line } : {}), checked: checks.get(cell.document.uri.toString()) ?? new Set() });
    if (typeof plan === 'string') return void vscode.window.showInformationMessage(`md-runbook: ${plan}`);
    await selectRunbookKernel(context, cell.notebook);
    await controller.runLines(cell, makeLineRun(mode, cell, plan));
  };

  /**
   * The LineRun for a plan: it highlights the running line, and pauses before a line in Step
   * Through (after the first) and before every line with a breakpoint. F5 ("continue") stops
   * the stepping pauses but not the breakpoints.
   */
  const makeLineRun = (mode: Mode, cell: vscode.NotebookCell, plan: Omit<LineRun, 'beforeStep' | 'onStep' | 'cellText'>): LineRun => {
    const key = cell.notebook.uri.toString();
    const stepping = mode === 'step' || mode === 'stepFrom';
    const breakpoints = plan.steps.length > 1 ? breakpointLines(cell) : new Set<number>();
    // A breakpoint belongs to the first command at or after its line (one on a blank line, a
    // comment or inside a block pauses before the next command), so every dot is used.
    const hasBreakpoint = (i: number): boolean =>
      [...breakpoints].some((l) => l <= plan.steps[i]!.end && (i === 0 || l > plan.steps[i - 1]!.end));
    let runRest = false;
    return {
      ...plan,
      cellText: cell.document.getText(),
      onStep: (i) => highlight(cell, i === undefined ? undefined : running, i === undefined ? undefined : plan.steps[i]),
      ...(stepping || breakpoints.size > 0
        ? {
            beforeStep: (index: number, token: vscode.CancellationToken) =>
              !hasBreakpoint(index) && (!stepping || index === 0 || runRest)
                ? Promise.resolve(true)
                : new Promise<boolean>((resolve) => {
                    const finish = (go: boolean, rest = false): void => {
                      sub.dispose();
                      if (paused.get(key)?.cell === cell) paused.delete(key);
                      runRest = rest;
                      highlight(cell, undefined);
                      updateUi();
                      resolve(go);
                    };
                    // The cell's Stop button ends the run where it is.
                    const sub = token.onCancellationRequested(() => finish(false));
                    paused.set(key, { cell, index, steps: plan.steps, next: () => finish(true), rest: () => finish(true, true), stop: () => finish(false) });
                    highlight(cell, waiting, plan.steps[index]);
                    updateUi();
                  }),
          }
        : {}),
    };
  };

  /** Acts on the paused run of the given cell's runbook, else of the active runbook. */
  const control = (action: 'next' | 'rest' | 'stop') => (arg?: unknown) => {
    const p = isCell(arg) ? paused.get(arg.notebook.uri.toString()) : activePaused();
    if (!p) return void vscode.window.setStatusBarMessage('md-runbook: no cell is waiting for its next line', 4000);
    p[action]();
  };

  /** The commands of a cell that get buttons: none in a one-command cell (its own ▷ does the same). */
  const buttonSteps = (document: vscode.TextDocument): LineStep[] => {
    const kind = shellKindForLanguage(document.languageId);
    if (!kind || !cellByUri(document.uri.toString())) return [];
    const steps = splitSteps(document.getText(), kind);
    return steps.length < 2 ? [] : steps;
  };
  const checkedSteps = (document: vscode.TextDocument): LineStep[] => {
    const set = checks.get(document.uri.toString());
    return set?.size ? buttonSteps(document).filter((s) => set.has(s.text)) : [];
  };

  const hints: vscode.InlayHintsProvider = {
    onDidChangeInlayHints: hintsChanged.event,
    provideInlayHints(document, range) {
      if (buttonsMode() !== 'inline') return [];
      const checked = checks.get(document.uri.toString());
      const uri = document.uri.toString();
      return buttonSteps(document)
        .filter((s) => s.start >= range.start.line && s.start <= range.end.line)
        .map((s) => {
          const on = checked?.has(s.text) ?? false;
          const at = new vscode.Position(s.start, document.lineAt(s.start).firstNonWhitespaceCharacterIndex);
          const play = new vscode.InlayHintLabelPart('▶');
          play.tooltip = `Run line ${formatLineRange(s.start, s.end)}`;
          play.command = { title: 'Run this line', command: 'mdRunbook.runLineAt', arguments: [uri, s.start] };
          const box = new vscode.InlayHintLabelPart(on ? ' ☑' : ' ☐');
          box.tooltip = on ? 'Checked for Run Checked Lines: click to uncheck' : 'Check for Run Checked Lines';
          box.command = { title: 'Check this line', command: 'mdRunbook.toggleLineCheck', arguments: [uri, s.start] };
          const hint = new vscode.InlayHint(at, [play, box]);
          hint.paddingRight = true;
          return hint;
        });
    },
  };

  const aiOn = (): boolean => ['vscode', 'anthropic'].includes(vscode.workspace.getConfiguration(SECTION).get<string>('ai.provider', 'off'));
  const HOVER_COMMANDS = [
    'mdRunbook.runLineAt',
    'mdRunbook.runToLineAt',
    'mdRunbook.runFromLineAt',
    'mdRunbook.stepFromLineAt',
    'mdRunbook.toggleLineCheck',
    'mdRunbook.toggleBreakpointAt',
    'mdRunbook.copyLineAt',
    'mdRunbook.ai.explainLine',
  ];

  /**
   * The buttons of the command under the mouse (command links: a plain click runs them), then
   * what it would ask before running, where it runs, and its `${…}` values. Nothing is asked for
   * or run to build it.
   */
  const hover: vscode.HoverProvider = {
    provideHover(document, position) {
      if (buttonsMode() !== 'hover') return undefined;
      const steps = buttonSteps(document);
      const step = stepAtLine(steps, position.line);
      const cell = step && cellByUri(document.uri.toString());
      if (!step || !cell) return undefined;
      const uri = document.uri.toString();
      const last = steps[steps.length - 1]!;
      const lines = formatLineRange(step.start, step.end);
      const link = (label: string, command: string, tip: string, args: unknown[] = [uri, step.start]): string =>
        `[${label}](command:${command}?${encodeURIComponent(JSON.stringify(args))} "${tip}")`;

      const runs = [link(`▶ Run line ${lines}`, 'mdRunbook.runLineAt', 'Run only this command')];
      if (step !== steps[0]) runs.push(link(`⤒ Run until here (${formatLineRange(steps[0]!.start, step.end)})`, 'mdRunbook.runToLineAt', 'Run the commands before this one, then this one'));
      if (step !== last) {
        runs.push(link(`⏩ Run from here (${formatLineRange(step.start, last.end)})`, 'mdRunbook.runFromLineAt', 'Run this command and the ones after it'));
        runs.push(link('⏯ Step from here', 'mdRunbook.stepFromLineAt', 'Run this command, then pause before each next one (F10 next, F5 continue)'));
      }
      const on = checks.get(uri)?.has(step.text) ?? false;
      const tools = [link(on ? '☑ Uncheck' : '☐ Check', 'mdRunbook.toggleLineCheck', `${on ? 'Uncheck' : 'Check'} for Run Checked Lines`)];
      if (breakpointsOn()) {
        const has = breakpointsIn(document.uri, step.start, step.end).length > 0;
        tools.push(link(has ? '● Remove breakpoint' : '● Breakpoint', 'mdRunbook.toggleBreakpointAt', has ? 'Remove the breakpoint' : 'Pause before this command when the cell runs'));
      }
      const values = info.secrets.values(cell.notebook, step.text);
      tools.push(
        values.length > 0
          ? link('⧉ Copy with values', 'mdRunbook.copyLineAt', 'Copy with the values filled in; secrets stay as references')
          : link('⧉ Copy', 'mdRunbook.copyLineAt', 'Copy this command'),
      );
      if (aiOn()) tools.push(link('✦ Explain', 'mdRunbook.ai.explainLine', 'Ask the AI what this command does (asks before sending)', [uri, step.start, lines]));

      const facts: string[] = [];
      const ask = info.safety.confirmation(cell, step.text);
      if (ask !== undefined) facts.push(`⚠ Asks before running${ask.trim() ? `: matches ${code(ask.trim())}` : ''}`);
      const where = info.safety.context(cell.notebook);
      if (where && Object.keys(where).length > 0) facts.push(`→ ${Object.entries(where).map(([k, v]) => `${escapeMd(k)}: ${code(v)}`).join(' · ')} (last known)`);
      for (const v of values) {
        const now = v.value !== undefined ? code(v.value) : v.shown ? `*${escapeMd(v.shown)}*` : '•••• (secret)';
        facts.push(`${code(`\${${v.kind}:${v.name}}`)} = ${now}${v.note ? ` *(${escapeMd(v.note)})*` : ''}`);
      }

      const md = new vscode.MarkdownString([runs.join(' · '), tools.join(' · '), ...(facts.length > 0 ? ['---', ...facts] : [])].join('\n\n'));
      md.isTrusted = { enabledCommands: HOVER_COMMANDS };
      return new vscode.Hover(md, new vscode.Range(step.start, 0, step.end, document.lineAt(step.end).text.length));
    },
  };

  /** The command at a line, with its values filled in (secrets stay `${secret:…}`), on the clipboard. */
  const copyLine = async (uri: unknown, line: unknown): Promise<string | undefined> => {
    const cell = cellByUri(uri);
    const step = cell && stepAtLine(buttonSteps(cell.document), Number(line));
    if (!cell || !step) return undefined;
    const values = new Map(info.secrets.values(cell.notebook, step.text).map((v) => [`${v.kind}:${v.name}`, v.value]));
    const left = new Set<string>();
    const text = step.text.replace(/\$\{(secret|input|param|out):([A-Za-z_][A-Za-z0-9_]*)(:secret)?\}/g, (whole: string, kind: string, name: string) => {
      const v = values.get(`${kind}:${name}`);
      if (v !== undefined) return v;
      left.add(whole);
      return whole;
    });
    await vscode.env.clipboard.writeText(text);
    const n = formatLineRange(step.start, step.end);
    vscode.window.setStatusBarMessage(`md-runbook: copied line ${n}${left.size > 0 ? `, left as is: ${[...left].join(', ')}` : ''}`, 5000);
    return text;
  };

  const toggleBreakpoint = (uri: unknown, line: unknown): void => {
    const cell = cellByUri(uri);
    if (!cell || !breakpointsOn()) return;
    const at = Number(line);
    const step = stepAtLine(buttonSteps(cell.document), at) ?? { start: at, end: at };
    const existing = breakpointsIn(cell.document.uri, step.start, step.end);
    if (existing.length > 0) vscode.debug.removeBreakpoints(existing);
    else vscode.debug.addBreakpoints([new vscode.SourceBreakpoint(new vscode.Location(cell.document.uri, new vscode.Position(step.start, 0)))]);
  };

  const paintChecks = (editors: readonly vscode.TextEditor[] = vscode.window.visibleTextEditors): void => {
    const on = buttonsMode() === 'hover';
    for (const e of editors) e.setDecorations(checkedMark, on ? checkedSteps(e.document).map((s) => new vscode.Range(s.start, 0, s.start, 0)) : []);
  };

  /** "▶ Run 2 checked lines" on the status line under a cell with checked lines. */
  const lineStatus = (cell: vscode.NotebookCell): vscode.NotebookCellStatusBarItem[] => {
    const steps = checkedSteps(cell.document);
    if (steps.length === 0) return [];
    const n = steps.length;
    const item = new vscode.NotebookCellStatusBarItem(`$(play) Run ${n} checked line${n === 1 ? '' : 's'}`, vscode.NotebookCellStatusBarAlignment.Left);
    item.tooltip = `Run Checked Lines: ${formatLineRanges(steps)}, in order`;
    item.command = { title: 'Run Checked Lines', command: 'mdRunbook.runCheckedLines', arguments: [cell.document.uri.toString()] };
    return [item];
  };
  const cellStatus: vscode.NotebookCellStatusBarItemProvider = {
    onDidChangeCellStatusBarItems: hintsChanged.event,
    provideCellStatusBarItems: lineStatus,
  };

  // A normal run of a cell with breakpoints: line by line, pausing at them.
  controller.pipeline.lineRunFor = (cell) => {
    if (cell.kind !== vscode.NotebookCellKind.Code || breakpointLines(cell).size === 0) return undefined;
    const plan = planLineRun('each', cell, undefined);
    return typeof plan === 'string' ? undefined : makeLineRun('each', cell, plan);
  };

  const updateSelectionKey = (): void => {
    const e = vscode.window.activeTextEditor;
    const inCell = e !== undefined && cellByUri(e.document.uri.toString())?.kind === vscode.NotebookCellKind.Code;
    void vscode.commands.executeCommand('setContext', SELECTION_KEY, inCell && !e.selection.isEmpty);
  };
  const updateCheckedKey = (): void => {
    void vscode.commands.executeCommand('setContext', CHECKED_KEY, [...checks.values()].some((s) => s.size > 0));
  };
  hintsChanged.event(updateCheckedKey);
  hintsChanged.event(() => paintChecks());

  context.subscriptions.push(
    running,
    waiting,
    checkedMark,
    status,
    hintsChanged,
    vscode.window.onDidChangeTextEditorSelection(updateSelectionKey),
    vscode.window.onDidChangeActiveTextEditor(updateSelectionKey),
    vscode.commands.registerCommand('mdRunbook.runSelection', (arg?: unknown) => run('selection', arg)),
    vscode.commands.registerCommand('mdRunbook.runCursorLine', (arg?: unknown) => run('selection', arg)),
    vscode.commands.registerCommand('mdRunbook.stepThroughFromSelection', (arg?: unknown) => run('stepFrom', arg)),
    vscode.languages.registerInlayHintsProvider(
      SUPPORTED_LANGUAGE_IDS.map((language) => ({ scheme: 'vscode-notebook-cell', language })),
      hints,
    ),
    vscode.languages.registerHoverProvider(
      SUPPORTED_LANGUAGE_IDS.map((language) => ({ scheme: 'vscode-notebook-cell', language })),
      hover,
    ),
    vscode.notebooks.registerNotebookCellStatusBarItemProvider(NOTEBOOK_TYPE, cellStatus),
    // An edit can change which commands are checked (checks follow the command's text).
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (checks.get(e.document.uri.toString())?.size) hintsChanged.fire();
    }),
    vscode.commands.registerCommand('mdRunbook.runLineAt', (uri: unknown, line: unknown) => run('at', String(uri), Number(line))),
    vscode.commands.registerCommand('mdRunbook.runToLineAt', (uri: unknown, line: unknown) => run('to', String(uri), Number(line))),
    vscode.commands.registerCommand('mdRunbook.runFromLineAt', (uri: unknown, line: unknown) => run('from', String(uri), Number(line))),
    vscode.commands.registerCommand('mdRunbook.stepFromLineAt', (uri: unknown, line: unknown) => run('stepFrom', String(uri), Number(line))),
    vscode.commands.registerCommand('mdRunbook.toggleBreakpointAt', toggleBreakpoint),
    vscode.commands.registerCommand('mdRunbook.copyLineAt', copyLine),
    vscode.commands.registerCommand('mdRunbook.toggleLineCheck', (uri: unknown, line: unknown) => {
      const cell = cellByUri(uri);
      const kind = cell && shellKindForLanguage(cell.document.languageId);
      if (!cell || !kind) return;
      const step = stepAtLine(splitSteps(cell.document.getText(), kind), Number(line));
      if (!step) return;
      const set = checkedIn(cell);
      if (set.has(step.text)) set.delete(step.text);
      else set.add(step.text);
      hintsChanged.fire();
    }),
    vscode.commands.registerCommand('mdRunbook.runCheckedLines', (arg?: unknown) => run('checked', arg)),
    vscode.commands.registerCommand('mdRunbook.clearCheckedLines', (arg?: unknown) => {
      const target = targetCell(arg);
      if (target) checks.delete(target.cell.document.uri.toString());
      hintsChanged.fire();
    }),
    // For tests: the checked commands of a cell.
    vscode.commands.registerCommand('mdRunbook._checkedLines', (uri: unknown) => [...(checks.get(String(uri)) ?? [])]),
    // For tests: the cell's status line items, and the lines (0-based) with a ☑ in the margin.
    vscode.commands.registerCommand('mdRunbook._lineStatus', (uri: unknown) => {
      const cell = cellByUri(uri);
      return cell ? lineStatus(cell).map((i) => i.text) : [];
    }),
    vscode.commands.registerCommand('mdRunbook._checkMarks', (uri: unknown) => {
      const cell = cellByUri(uri);
      return cell && buttonsMode() === 'hover' ? checkedSteps(cell.document).map((s) => s.start) : [];
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(`${SECTION}.lines.buttons`)) hintsChanged.fire();
    }),
    vscode.workspace.onDidCloseNotebookDocument((nb) => {
      nb.getCells().forEach((c) => checks.delete(c.document.uri.toString()));
      updateCheckedKey();
    }),
    { dispose: () => [...paused.values()].forEach((p) => p.stop()) },
    vscode.commands.registerCommand('mdRunbook.runLine', (arg?: unknown) => run('selection', arg)),
    vscode.commands.registerCommand('mdRunbook.runLinesOneByOne', (arg?: unknown) => run('each', arg)),
    vscode.commands.registerCommand('mdRunbook.stepThroughLines', (arg?: unknown) => run('step', arg)),
    vscode.commands.registerCommand('mdRunbook.stepThroughFromLine', (arg?: unknown) => run('stepFrom', arg)),
    vscode.commands.registerCommand('mdRunbook.stepNext', control('next')),
    vscode.commands.registerCommand('mdRunbook.stepContinue', control('rest')),
    vscode.commands.registerCommand('mdRunbook.stepStop', control('stop')),
    // For tests: where the active runbook's Step Through run is waiting.
    vscode.commands.registerCommand('mdRunbook._stepPaused', () => {
      const p = activePaused();
      return p && { cell: p.cell.index, index: p.index };
    }),
    vscode.window.onDidChangeVisibleTextEditors((editors) => {
      paint(editors);
      paintChecks(editors);
    }),
    vscode.window.onDidChangeActiveNotebookEditor(updateUi),
    vscode.workspace.onDidCloseNotebookDocument((nb) => paused.get(nb.uri.toString())?.stop()),
  );
}
