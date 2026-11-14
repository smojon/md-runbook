/**
 * The runbook's transcript (core/transcript.ts): every run of a cell appended to
 * `.md-runbook/<runbook>.transcript.log` as it happens, so it is on disk even if the runbook is
 * never saved. `mdRunbook.output.transcript` (on by default), `.transcriptFolder` (`.md-runbook`,
 * next to the runbook; empty = beside it), `.transcriptExtension`. The first transcript in that
 * folder inside a Git repository whose .gitignore doesn't cover it offers to add it there.
 */

import * as fs from 'node:fs';

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
export function transcriptPathFor(nb: { uri: vscode.Uri }): string | undefined {
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
  const folder = c.get<string>('output.transcriptFolder', DEFAULT_FOLDER).trim();
  return path.join(folder ? path.resolve(dir, folder) : dir, transcriptFileName(path.basename(nb.uri.fsPath), ext));
}

/** Where transcripts go by default: a folder next to the runbook, not a file beside each one. */
export const DEFAULT_FOLDER = '.md-runbook';
const NEVER_GITIGNORE = 'mdRunbook.transcript.gitignoreNever';
/** Repositories asked about this session (once each). */
const askedRepos = new Set<string>();
let globalState: vscode.Memento | undefined;

/** Remember where to keep "Don't Ask Again" (called once at activation). */
export function initTranscripts(context: vscode.ExtensionContext): void {
  globalState = context.globalState;
}

/** The Git repository a path is in (the folder with .git), or undefined. */
function repoOf(file: string): string | undefined {
  for (let dir = path.dirname(file); ; ) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

/** Whether the repository's .gitignore already names the transcript folder (a simple check, by name). */
function ignored(repo: string, folderName: string): boolean {
  try {
    return fs
      .readFileSync(path.join(repo, '.gitignore'), 'utf8')
      .split(/\r?\n/)
      .some((l) => l.trim().replace(/^\/|\/$/g, '').replace(/^\*\*\//, '') === folderName);
  } catch {
    return false;
  }
}

/**
 * The first transcript written into a transcript folder (`.md-runbook`) of a Git repository whose
 * .gitignore doesn't name it: offer to add it, once per repository and session.
 */
function offerGitignore(file: string): void {
  const folder = path.dirname(file);
  const name = path.basename(folder);
  if (!name.startsWith('.') || globalState?.get<boolean>(NEVER_GITIGNORE)) return;
  const repo = repoOf(file);
  if (!repo || askedRepos.has(repo) || ignored(repo, name)) return;
  askedRepos.add(repo);
  const add = 'Add to .gitignore';
  const never = "Don't Ask Again";
  void vscode.window
    .showInformationMessage(`md-runbook keeps run transcripts in ${name}/ next to the runbook. Add ${name}/ to the repository's .gitignore?`, add, 'Not Now', never)
    .then(async (pick) => {
      if (pick === never) await globalState?.update(NEVER_GITIGNORE, true);
      if (pick !== add) return;
      const gi = path.join(repo, '.gitignore');
      const before = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
      const eol = before.includes('\r\n') ? '\r\n' : '\n';
      fs.writeFileSync(gi, `${before}${before === '' || before.endsWith('\n') ? '' : eol}# md-runbook run transcripts${eol}${name}/${eol}`);
    });
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
    offerGitignore(file);
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
  initTranscripts(context);
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
