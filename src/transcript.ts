/**
 * The runbook's transcript (core/transcript.ts): every run of a cell appended to
 * `<runbook>.transcript.log` as it happens, so it is on disk even if the runbook is never saved.
 * `mdRunbook.output.transcript` (on by default), `.transcriptFolder`, `.transcriptExtension`.
 */

import * as path from 'node:path';
import * as vscode from 'vscode';
import { isCodeMeta } from '@md-runbook/core';
import { parseCellOptions } from '@md-runbook/core/cellOptions';
import { stepNumbers } from '@md-runbook/core/os';
import { TranscriptFile } from '@md-runbook/core/node';
import {
  DEFAULT_TRANSCRIPT_EXTENSION,
  TranscriptEnd,
  TranscriptEntry,
  lastHeading,
  transcriptExtensionProblem,
  transcriptFileName,
  transcriptNote,
} from '@md-runbook/core/transcript';
import { SECTION, writeOptions } from './config';
import { META_KEY } from './outputs';

const files = new Map<string, TranscriptFile>();
let reportedExtension: string | undefined;

/** Where a runbook's transcript is (whether it is on or not), or undefined for a runbook that is not a file on disk. */
export function transcriptPathFor(nb: vscode.NotebookDocument): string | undefined {
  if (nb.uri.scheme !== 'file') return undefined;
  const c = vscode.workspace.getConfiguration(SECTION);
  let ext = c.get<string>('output.transcriptExtension', DEFAULT_TRANSCRIPT_EXTENSION).trim() || DEFAULT_TRANSCRIPT_EXTENSION;
  const problem = transcriptExtensionProblem(ext);
  if (problem !== undefined) {
    if (reportedExtension !== ext) {
      void vscode.window.showWarningMessage(`md-runbook: mdRunbook.output.transcriptExtension "${ext}" is not used (${problem}); writing ${DEFAULT_TRANSCRIPT_EXTENSION}.`);
    }
    reportedExtension = ext;
    ext = DEFAULT_TRANSCRIPT_EXTENSION;
  }
  const dir = path.dirname(nb.uri.fsPath);
  const folder = c.get<string>('output.transcriptFolder', '').trim();
  return path.join(folder ? path.resolve(dir, folder) : dir, transcriptFileName(path.basename(nb.uri.fsPath), ext));
}

/** Whether runs are written to the transcript (mdRunbook.output.transcript, on by default). */
export function transcriptOn(): boolean {
  return vscode.workspace.getConfiguration(SECTION).get<boolean>('output.transcript', true);
}

/** The transcript file of a runbook, or undefined (turned off, not a file on disk). */
export function transcriptFileFor(nb: vscode.NotebookDocument): TranscriptFile | undefined {
  if (!transcriptOn()) return undefined;
  const file = transcriptPathFor(nb);
  if (file === undefined) return undefined;
  let f = files.get(file);
  if (!f) {
    f = new TranscriptFile(file, (e) => void vscode.window.showWarningMessage(`md-runbook: the transcript ${file} can't be written, so it stops for this session: ${e.message}`));
    files.set(file, f);
  }
  return f;
}

/** A cell's run in the transcript; `end` also writes it out at once. */
export interface CellTranscript {
  out(stream: 'stdout' | 'stderr', text: string): void;
  attempt(n: number, of: number): void;
  end(e: TranscriptEnd): void;
}

function infoOf(cell: vscode.NotebookCell): string {
  const meta: unknown = cell.metadata?.[META_KEY];
  return isCodeMeta(meta) ? meta.info : '';
}

/** The heading a cell is under: the last one in the Markdown cells above it. */
function sectionOf(cell: vscode.NotebookCell): string | undefined {
  for (let i = cell.index - 1; i >= 0; i--) {
    const c = cell.notebook.cellAt(i);
    if (c.kind !== vscode.NotebookCellKind.Markup) continue;
    const h = lastHeading(c.document.getText());
    if (h !== undefined) return h;
  }
  return undefined;
}

/**
 * Start the transcript of a cell's run, or undefined when there is none. `command` is the script
 * as it runs (after the preparers), left out for line runs, which echo each line. `hold`: the cell
 * captures a secret, so its output is written when it has ended, redacted with the value.
 */
export function startCellTranscript(cell: vscode.NotebookCell, command: string | undefined, hold: boolean): CellTranscript | undefined {
  const file = transcriptFileFor(cell.notebook);
  if (!file) return undefined;
  const redact = writeOptions().redact ?? ((t: string) => t);
  const entry = new TranscriptEntry((t) => file.append(t), redact, hold);
  const cells = cell.notebook.getCells().map((c) =>
    c.kind === vscode.NotebookCellKind.Code ? { kind: 'code' as const, os: parseCellOptions(infoOf(c)).os } : { kind: 'markup' as const },
  );
  const name = parseCellOptions(infoOf(cell)).name;
  const first = cell.document.getText().split(/\r?\n/).find((l) => l.trim() !== '')?.trim();
  entry.start({
    at: new Date(),
    runbook: path.basename(cell.notebook.uri.fsPath),
    step: stepNumbers(cells)[cell.index],
    section: sectionOf(cell),
    title: name ?? first,
    command,
  });
  return {
    out: (stream, text) => entry.out(stream, text),
    attempt: (n, of) => entry.attempt(n, of, new Date()),
    end: (e) => {
      entry.end(e);
      file.flush();
    },
  };
}

/** A task-list item ticked or unticked by hand. */
export function noteTaskBox(nb: vscode.NotebookDocument, item: string, checked: boolean): void {
  const file = transcriptFileFor(nb);
  if (!file) return;
  file.append(transcriptNote(new Date(), path.basename(nb.uri.fsPath), `${checked ? 'checked' : 'unchecked'}: ${item}`, writeOptions().redact ?? ((t: string) => t)));
  file.flush();
}

/**
 * Run ▾ › Open Transcript, Run ▾ › Transcript (a check mark: on or off) and Help ▾ › Settings…,
 * so a learner finds the transcript, and every setting, without knowing their names.
 */
export function registerTranscriptCommands(context: vscode.ExtensionContext): void {
  const notebook = (): vscode.NotebookDocument | undefined => vscode.window.activeNotebookEditor?.notebook;
  context.subscriptions.push(
    vscode.commands.registerCommand('mdRunbook.openTranscript', async () => {
      const nb = notebook();
      const file = nb && transcriptPathFor(nb);
      if (!file) {
        void vscode.window.showInformationMessage('md-runbook: save the runbook first; an unsaved runbook has no transcript.');
        return;
      }
      files.get(file)?.flush();
      try {
        await vscode.workspace.fs.stat(vscode.Uri.file(file));
      } catch {
        const turnOn = transcriptOn() ? undefined : 'Turn the Transcript On';
        const answer = await vscode.window.showInformationMessage(
          transcriptOn()
            ? `md-runbook: no step of this runbook has run since the transcript is on; it starts with the next run (${path.basename(file)}).`
            : 'md-runbook: the transcript is off (Run ▾ › Transcript).',
          ...(turnOn ? [turnOn] : []),
        );
        if (answer === turnOn && turnOn) await setTranscript(true);
        return;
      }
      // An editor rather than a preview: it follows the file as later runs append to it.
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      const editor = await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Beside });
      const end = doc.lineAt(Math.max(0, doc.lineCount - 1)).range.end;
      editor.revealRange(new vscode.Range(end, end), vscode.TextEditorRevealType.Default);
    }),
    vscode.commands.registerCommand('mdRunbook.toggleTranscript', () => setTranscript(!transcriptOn())),
    vscode.commands.registerCommand('mdRunbook.openSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${context.extension.id}`),
    ),
  );
}

/** The setting is machine-scoped: it lives in the user settings, never in a workspace. */
async function setTranscript(on: boolean): Promise<void> {
  await vscode.workspace.getConfiguration(SECTION).update('output.transcript', on, vscode.ConfigurationTarget.Global);
  void vscode.window.showInformationMessage(
    on
      ? 'md-runbook: transcript on. Each run is appended to <runbook>.transcript.log next to the runbook (Run ▾ › Open Transcript).'
      : 'md-runbook: transcript off. Runs are no longer written to <runbook>.transcript.log; the files already there stay.',
  );
}
