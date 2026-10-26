/**
 * Incidents in VS Code (core/incident.ts): Start Incident makes a run copy of the runbook that
 * keeps evidence (incident: and severity: in its front matter; every run records who and where,
 * every attempt is kept) with a first note, `detected`; Add Note records a decision or a milestone
 * (detected, mitigated, resolved) as a timestamped note. Export Report shows the record.
 */

import * as os from 'node:os';
import * as vscode from 'vscode';
import { Milestone, formatNote, withFrontMatterValues } from '@md-runbook/core/incident';
import { contentWithoutOutputs, openRunCopy, sourceUri } from './history';
import { NOTEBOOK_TYPE } from './serializer';

function userName(): string {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USER ?? process.env.USERNAME ?? 'unknown';
  }
}

const pad = (n: number): string => String(n).padStart(2, '0');

async function startIncident(arg?: unknown): Promise<vscode.Uri | undefined> {
  const source = sourceUri(arg);
  if (!source) return void vscode.window.showErrorMessage('md-runbook: open a runbook (a .md file) first.');
  const now = new Date();
  const kind = await vscode.window.showQuickPick(
    [
      { label: '$(flame) A real incident', drill: false },
      { label: '$(beaker) A drill or exercise', description: 'The record says drill; the report measures it against rto:', drill: true },
    ],
    { title: 'Start Incident', placeHolder: 'An incident, or a drill?' },
  );
  if (!kind) return undefined;
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  const id = await vscode.window.showInputBox({
    title: `Start Incident: ${kind.drill ? 'drill' : 'incident'} ID`,
    prompt: "The ID (from your pager or ticket system). The run copy records it, and every run records who ran it and where.",
    value: `${kind.drill ? 'DRILL' : 'INC'}-${stamp}`,
    validateInput: (v) => (v.trim() === '' ? 'An ID' : /[\r\n]/.test(v) ? 'One line' : undefined),
  });
  if (id === undefined) return undefined;
  const severity = kind.drill
    ? 'No severity'
    : await vscode.window.showQuickPick(['SEV1', 'SEV2', 'SEV3', 'SEV4', 'No severity'], { title: 'Start Incident: severity', placeHolder: 'How bad is it?' });
  if (severity === undefined) return undefined;
  const text = withFrontMatterValues(await contentWithoutOutputs(source), {
    incident: id.trim(),
    ...(severity !== 'No severity' ? { severity } : {}),
    ...(kind.drill ? { drill: 'true' } : {}),
  });
  const { target, editor } = await openRunCopy(source, text);
  await insertNote(editor, { at: now, by: userName(), milestone: 'detected', text: `Incident ${id.trim()} started from ${source.path.split('/').pop()}` }, 1);
  await editor.notebook.save();
  void vscode.window.showInformationMessage(
    `md-runbook: incident ${id.trim()} started in ${target.path.split('/').pop()}. Run the steps; Add Note records decisions and milestones; Export Report shows the record.`,
  );
  return target;
}

/** A note cell (Markdown) at `index`, or after the selection. */
async function insertNote(editor: vscode.NotebookEditor, note: Parameters<typeof formatNote>[0], index?: number): Promise<boolean> {
  const at = index ?? (editor.selections.length ? Math.max(...editor.selections.map((r) => r.end)) : editor.notebook.cellCount);
  const i = Math.min(Math.max(at, 0), editor.notebook.cellCount);
  const edit = new vscode.WorkspaceEdit();
  edit.set(editor.notebook.uri, [vscode.NotebookEdit.insertCells(i, [new vscode.NotebookCellData(vscode.NotebookCellKind.Markup, formatNote(note), 'markdown')])]);
  if (!(await vscode.workspace.applyEdit(edit))) return false;
  editor.revealRange(new vscode.NotebookRange(i, i + 1));
  return true;
}

async function addNote(): Promise<boolean> {
  // The runbook notebook in front, else a runbook open as text.
  const nb = vscode.window.activeNotebookEditor?.notebook.notebookType === NOTEBOOK_TYPE ? vscode.window.activeNotebookEditor : undefined;
  const text = nb ? undefined : vscode.window.activeTextEditor;
  if (!nb && text?.document.languageId !== 'markdown') return void vscode.window.showErrorMessage('md-runbook: open a runbook first.'), false;
  const kind = await vscode.window.showQuickPick(
    [
      { label: '$(note) Note', description: 'A decision, a call, an observation', milestone: undefined },
      { label: '$(bell) Detected', description: 'When the problem was noticed (the start of time to mitigate)', milestone: 'detected' as Milestone },
      { label: '$(shield) Mitigated', description: 'Users are no longer affected', milestone: 'mitigated' as Milestone },
      { label: '$(pass) Resolved', description: 'Fixed for good', milestone: 'resolved' as Milestone },
    ],
    { title: 'Add Note', placeHolder: 'A note for the record, or a milestone' },
  );
  if (!kind) return false;
  const body = await vscode.window.showInputBox({
    title: `Add Note${kind.milestone ? `: ${kind.milestone}` : ''}`,
    prompt: 'What happened or was decided (it goes into the runbook with the time and your name).',
    validateInput: (v) => (v.trim() === '' ? 'A few words' : undefined),
  });
  if (body === undefined) return false;
  const note = { at: new Date(), by: userName(), ...(kind.milestone ? { milestone: kind.milestone } : {}), text: body };
  if (nb) return insertNote(nb, note);
  // A runbook open as text: the note goes on its own lines at the cursor.
  const doc = text!.document;
  const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  const line = text!.selection.active.line;
  const at = new vscode.Position(line + 1 > doc.lineCount - 1 ? doc.lineCount - 1 : line + 1, 0);
  return text!.edit((e) => e.insert(at, `${eol}${formatNote(note, eol)}${eol}`));
}

export function registerIncidentCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('mdRunbook.startIncident', startIncident),
    vscode.commands.registerCommand('mdRunbook.addNote', addNote),
  );
}
