/**
 * Proposed cells: an assistant (or anything that edits the file) only proposes cells; a human
 * approves them before they run. Gate, approve / reject commands, command policy, audit trail
 * in the output marker, and read-only credentials for AI-proposed cells.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { CodeMeta, formatLocalIso, isCodeMeta } from './core';
import { ApprovalStatus, CommandPolicy, DEFAULT_POLICY, PolicyResult, approvalStatus, codeHash, evaluatePolicy, parsePolicy } from './core/policy';
import { Proposal, approvedInfo, asProposed, proposalOf, withInfo } from './core/proposal';
import { VAR_NAME_RE } from './core/secrets';
import { tokenizeInfo } from './core/cellOptions';
import { SECTION } from './config';
import { workingDirectory } from './controller';
import { META_KEY } from './outputs';
import { CellPlan, CellPreparer, PrepareContext, RunPipeline } from './pipeline';
import { NOTEBOOK_TYPE } from './serializer';

/** Cell metadata key: hash of the code when it was approved in this editor session. */
export const APPROVAL_KEY = 'mdRunbookApproval';
const LEDGER_KEY = 'mdRunbook.approvedHashes';
const LEDGER_MAX = 5000;
const POLICY_FILE = '.md-runbook-policy.json';
/** The secrets feature stores values under this prefix. */
const SECRET_PREFIX = 'mdRunbook.secret.';

const cfg = (): vscode.WorkspaceConfiguration => vscode.workspace.getConfiguration(SECTION);
const gateEnabled = (): boolean => cfg().get<boolean>('approval.enabled', true);

function isCell(v: unknown): v is vscode.NotebookCell {
  return typeof v === 'object' && v !== null && 'notebook' in v && 'document' in v && typeof (v as { index?: unknown }).index === 'number';
}

function codeMeta(cell: vscode.NotebookCell): CodeMeta | undefined {
  const m: unknown = cell.metadata?.[META_KEY];
  return cell.kind === vscode.NotebookCellKind.Code && isCodeMeta(m) ? m : undefined;
}

function userName(): string {
  const set = cfg().get<string>('approval.userName', '').trim();
  if (set) return set;
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USER ?? process.env.USERNAME ?? 'unknown';
  }
}

interface CellApproval {
  meta: CodeMeta;
  proposal: Proposal;
  status: ApprovalStatus;
}

const SKIP_REASON = { proposed: 'proposed — approve it first', changed: 'changed since approval — approve it again', unverified: 'approval not made on this machine — approve it again' };

class ApprovalFeature implements vscode.NotebookCellStatusBarItemProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCellStatusBarItems = this.changed.event;
  private readonly item = vscode.window.createStatusBarItem('mdRunbook.proposals', vscode.StatusBarAlignment.Left, 99);
  private policyWarned = '';

  constructor(private readonly context: vscode.ExtensionContext) {
    this.item.name = 'md-runbook proposals';
    this.item.command = 'mdRunbook.revealProposal';
  }

  dispose(): void {
    this.item.dispose();
    this.changed.dispose();
  }

  private ledger(): string[] {
    return this.context.globalState.get<string[]>(LEDGER_KEY, []);
  }

  approvalOf(cell: vscode.NotebookCell): CellApproval | undefined {
    const meta = codeMeta(cell);
    if (!meta) return undefined;
    const proposal = proposalOf(meta.info);
    const stored: unknown = cell.metadata?.[APPROVAL_KEY];
    const approvedHash = typeof stored === 'object' && stored !== null && typeof (stored as { hash?: unknown }).hash === 'string' ? (stored as { hash: string }).hash : undefined;
    const ledger = proposal.state === 'approved' ? new Set(this.ledger()) : undefined;
    const c = cfg();
    const status = approvalStatus(proposal.state, {
      code: cell.document.getText(),
      loadedCode: meta.value,
      approvedHash,
      approvedHere: (h) => ledger?.has(h) ?? false,
      resetOnEdit: c.get<boolean>('approval.resetOnEdit', true),
      trustFileApprovals: c.get<boolean>('approval.trustFileApprovals', false),
    });
    return { meta, proposal, status };
  }

  /** Cells that need approval before they run. */
  pending(nb: vscode.NotebookDocument): vscode.NotebookCell[] {
    return nb.getCells().filter((c) => this.approvalOf(c)?.status.state === 'proposed');
  }

  // --- Gate --------------------------------------------------------------------------------

  readonly gate: CellPreparer = {
    prepare: (plan: CellPlan, { cell }: PrepareContext) => {
      const a = this.approvalOf(cell);
      if (!a) return;
      if (a.status.state === 'proposed' && gateEnabled()) {
        plan.skip = SKIP_REASON[a.status.why];
        return; // Run All carries on with the other cells.
      }
      if (a.proposal.by) {
        plan.attrs['proposed-by'] = a.proposal.by;
        if (cfg().get<boolean>('approval.readOnlyOnly', true) && Object.keys(this.readOnlyEnvSetting()).length === 0) {
          throw new Error(
            `md-runbook: cells proposed by an assistant (by=${a.proposal.by}) only run with read-only credentials. ` +
              'Set "mdRunbook.approval.readOnlyEnv" in your user settings, e.g. { "KUBECONFIG": "${secret:KUBECONFIG_READONLY}" } ' +
              '(store the value with md-runbook: Set Secret), or set "mdRunbook.approval.readOnlyOnly" to false to run them with your normal credentials.',
          );
        }
      }
      if (a.status.state === 'approved' && a.proposal.approvedBy) plan.attrs['approved-by'] = a.proposal.approvedBy;
    },
  };

  // --- Read-only credentials (registered last, so cell options or secrets can't override them) ---

  private readOnlyEnvSetting(): Record<string, string> {
    const raw = cfg().get<Record<string, unknown>>('approval.readOnlyEnv', {});
    return Object.fromEntries(Object.entries(raw ?? {}).filter((e): e is [string, string] => typeof e[1] === 'string'));
  }

  readonly credentials: CellPreparer = {
    prepare: async (plan: CellPlan, { cell }: PrepareContext) => {
      if (plan.skip !== undefined || !this.approvalOf(cell)?.proposal.by) return;
      for (const [name, template] of Object.entries(this.readOnlyEnvSetting())) {
        if (!VAR_NAME_RE.test(name)) throw new Error(`md-runbook: invalid variable name in mdRunbook.approval.readOnlyEnv: ${name}`);
        const found: string[] = [];
        let value = template;
        for (const m of template.matchAll(/\$\{secret:([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
          const secret = await this.context.secrets.get(SECRET_PREFIX + m[1]);
          if (secret === undefined) throw new Error(`md-runbook: secret ${m[1]} (used in mdRunbook.approval.readOnlyEnv) is not set (md-runbook: Set Secret)`);
          value = value.split(m[0]).join(secret);
          found.push(secret);
        }
        plan.env[name] = value;
        plan.secrets.push(value, ...found);
      }
    },
  };

  // --- Policy ------------------------------------------------------------------------------

  /** The policy for a runbook, or undefined when policies are turned off. */
  policyFor(uri: vscode.Uri): { policy: CommandPolicy; source: string } | undefined {
    const c = cfg();
    if (!c.get<boolean>('approval.policy.enabled', true)) return undefined;
    const ws = vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;
    const setting = c.get<string>('approval.policyFile', '').trim();
    let file: string | undefined;
    if (setting) {
      file = path.resolve(ws ?? workingDirectory(uri), setting.replace(/\$\{workspaceFolder\}/g, ws ?? ''));
    } else if (uri.scheme === 'file') {
      for (let dir = path.dirname(uri.fsPath); ; ) {
        const candidate = path.join(dir, POLICY_FILE);
        if (fs.existsSync(candidate)) {
          file = candidate;
          break;
        }
        const parent = path.dirname(dir);
        const rel = ws ? path.relative(ws, parent) : '..';
        if (!ws || parent === dir || rel.startsWith('..') || path.isAbsolute(rel)) break;
        dir = parent;
      }
    }
    if (!file) return { policy: DEFAULT_POLICY, source: 'built-in policy' };
    let errors: string[];
    let policy: CommandPolicy;
    try {
      ({ policy, errors } = parsePolicy(fs.readFileSync(file, 'utf8')));
    } catch (e) {
      policy = DEFAULT_POLICY;
      errors = [e instanceof Error ? e.message : String(e)];
    }
    const text = errors.join('\n');
    if (text && text !== this.policyWarned) void vscode.window.showWarningMessage(`md-runbook: problems in ${file} (built-in values used instead):\n${text}`);
    this.policyWarned = text;
    return { policy, source: file };
  }

  // --- Commands ----------------------------------------------------------------------------

  /** Approve one proposed cell, after the policy check. Resolves to whether it was approved. */
  async approve(cell: vscode.NotebookCell): Promise<boolean> {
    const a = this.approvalOf(cell);
    if (!a || a.status.state !== 'proposed') {
      void vscode.window.showInformationMessage(`md-runbook: cell ${cell.index + 1} is not a proposal.`);
      return false;
    }
    const code = cell.document.getText();
    const found = a.proposal.by ? this.policyFor(cell.notebook.uri) : undefined;
    if (found) {
      const r = evaluatePolicy(code, found.policy);
      if (r.errors.length > 0) void vscode.window.showWarningMessage(`md-runbook: invalid policy pattern(s) ignored:\n${r.errors.join('\n')}`);
      const options = riskyOptions(a.meta.info);
      if (r.verdict === 'denied') return this.refuse(cell, r, found.source);
      if (r.verdict === 'review' || options.length > 0) {
        if (!(await this.review(cell, a.proposal, r, options, found.policy.requireTypedConfirmation))) return false;
      }
    }
    const info = approvedInfo(a.proposal.state === 'approved' ? asProposed(a.meta.info) : a.meta.info, userName(), formatLocalIso(new Date()));
    const hash = codeHash(code);
    const edit = new vscode.WorkspaceEdit();
    edit.set(cell.notebook.uri, [
      vscode.NotebookEdit.updateCellMetadata(cell.index, { ...cell.metadata, [META_KEY]: withInfo(a.meta, info), [APPROVAL_KEY]: { hash } }),
    ]);
    if (!(await vscode.workspace.applyEdit(edit))) return false;
    await this.context.globalState.update(LEDGER_KEY, [...this.ledger().filter((h) => h !== hash), hash].slice(-LEDGER_MAX));
    this.refresh();
    return true;
  }

  private refuse(cell: vscode.NotebookCell, r: PolicyResult, source: string): false {
    const lines = r.denied.map((d) => `“${d.line}” (matches ${d.pattern})`).join('; ');
    // Not modal and not awaited: there is nothing to decide, and the command answers right away.
    void vscode.window.showErrorMessage(`md-runbook: cell ${cell.index + 1} can't be approved — ${source} denies ${lines}.`, 'Edit Cell').then(async (pick) => {
      if (pick !== 'Edit Cell') return;
      const editor = await vscode.window.showNotebookDocument(cell.notebook);
      editor.selections = [new vscode.NotebookRange(cell.index, cell.index + 1)];
      editor.revealRange(editor.selections[0]!, vscode.NotebookEditorRevealType.InCenterIfOutsideViewport);
      await vscode.commands.executeCommand('notebook.cell.edit');
    });
    return false;
  }

  private async review(cell: vscode.NotebookCell, p: Proposal, r: PolicyResult, options: string[], typed: boolean): Promise<boolean> {
    const lines = [
      ...(r.unlisted.length > 0 ? ['Commands not on the allowlist:', ...r.unlisted.map((l) => `  ${l}`)] : []),
      ...(options.length > 0 ? ['Fence options that change how it runs:', ...options.map((o) => `  ${o}`)] : []),
    ];
    const reason = p.reason ? `\n\nReason given: ${p.reason}` : '';
    const pick = await vscode.window.showWarningMessage(
      `Approve cell ${cell.index + 1} proposed by ${p.by}?`,
      { modal: true, detail: `${lines.join('\n')}${reason}` },
      typed ? 'Approve…' : 'Approve',
    );
    if (!pick) return false;
    if (!typed) return true;
    const answer = await vscode.window.showInputBox({
      title: `md-runbook: approve cell ${cell.index + 1}`,
      prompt: 'Type "run" to approve this cell. It can then run with your credentials.',
      ignoreFocusOut: true,
      validateInput: (v) => (v === '' || v.trim().toLowerCase() === 'run' ? undefined : 'Type run to approve, or press Escape.'),
    });
    return answer?.trim().toLowerCase() === 'run';
  }

  async reject(cell: vscode.NotebookCell): Promise<boolean> {
    const a = this.approvalOf(cell);
    if (a?.proposal.state !== 'proposed') {
      void vscode.window.showInformationMessage(`md-runbook: cell ${cell.index + 1} is not a proposal; only proposals can be rejected.`);
      return false;
    }
    // A normal edit: Undo brings the cell back.
    const edit = new vscode.WorkspaceEdit();
    edit.set(cell.notebook.uri, [vscode.NotebookEdit.deleteCells(new vscode.NotebookRange(cell.index, cell.index + 1))]);
    return vscode.workspace.applyEdit(edit);
  }

  async approveAll(nb: vscode.NotebookDocument): Promise<number> {
    let n = 0;
    for (const cell of this.pending(nb)) if (await this.approve(cell)) n++;
    return n;
  }

  async reveal(): Promise<void> {
    const editor = runbookEditor();
    if (!editor) return;
    const pending = this.pending(editor.notebook);
    if (pending.length === 0) return;
    const after = editor.selections[0]?.start ?? -1;
    const next = pending.find((c) => c.index > after) ?? pending[0]!;
    const range = new vscode.NotebookRange(next.index, next.index + 1);
    editor.selections = [range];
    editor.revealRange(range, vscode.NotebookEditorRevealType.InCenterIfOutsideViewport);
  }

  // --- Visuals -----------------------------------------------------------------------------

  provideCellStatusBarItems(cell: vscode.NotebookCell): vscode.NotebookCellStatusBarItem[] {
    const a = this.approvalOf(cell);
    const s = a?.status;
    if (!a || !s || s.state === 'none' || !gateEnabled()) return [];
    const Left = vscode.NotebookCellStatusBarAlignment.Left;
    const p = a.proposal;
    if (s.state === 'approved') {
      const item = new vscode.NotebookCellStatusBarItem(`$(verified) Approved by ${p.approvedBy}`, Left);
      item.tooltip = [p.by && `Proposed by ${p.by}`, p.approvedAt && `Approved ${p.approvedAt}`, p.reason && `Reason: ${p.reason}`].filter(Boolean).join('\n');
      return [item];
    }
    const label = { proposed: `Proposed by ${p.by ?? 'someone'}`, changed: 'Changed since approval', unverified: `Approved by ${p.approvedBy} — not on this machine` }[s.why];
    const head = new vscode.NotebookCellStatusBarItem(`$(shield) ${label}`, Left);
    head.tooltip = p.reason ? `Reason: ${p.reason}` : 'This cell must be approved before it runs.';
    const approve = new vscode.NotebookCellStatusBarItem('$(check) Approve', Left);
    approve.command = { command: 'mdRunbook.approveProposal', title: 'Approve', arguments: [cell] };
    approve.tooltip = 'Approve this cell so it can run';
    const items = [head, approve];
    if (s.why === 'proposed') {
      const reject = new vscode.NotebookCellStatusBarItem('$(trash) Reject', Left);
      reject.command = { command: 'mdRunbook.rejectProposal', title: 'Reject', arguments: [cell] };
      reject.tooltip = 'Delete this proposed cell (Undo brings it back)';
      items.push(reject);
    }
    return items;
  }

  refresh(): void {
    this.changed.fire();
    const nb = vscode.window.activeNotebookEditor?.notebook;
    const n = nb?.notebookType === NOTEBOOK_TYPE && gateEnabled() ? this.pending(nb).length : 0;
    if (n === 0) return void this.item.hide();
    this.item.text = `$(shield) ${n} proposal${n === 1 ? '' : 's'}`;
    this.item.tooltip = 'Cells waiting for approval — click to go to the next one';
    this.item.show();
  }
}

/** Fence options in a proposal that change where or how it runs. */
function riskyOptions(info: string): string[] {
  return tokenizeInfo(info.replace(/^\s*[^\s{]*/, ''))
    .filter((t) => /^(no-confirm|cwd|env\..+|continue-on-error|timeout)$/i.test(t.key))
    .map((t) => (t.value === undefined ? t.key : `${t.key}=${t.value}`));
}

function runbookEditor(): vscode.NotebookEditor | undefined {
  const e = vscode.window.activeNotebookEditor;
  return e?.notebook.notebookType === NOTEBOOK_TYPE ? e : undefined;
}

/** The cell passed as argument (cell object or cell document URI), else the selected cells. */
function targetCells(arg: unknown): vscode.NotebookCell[] {
  if (isCell(arg)) return [arg];
  if (arg instanceof vscode.Uri) {
    const s = arg.toString();
    for (const nb of vscode.workspace.notebookDocuments) {
      const c = nb.getCells().find((x) => x.document.uri.toString() === s);
      if (c) return [c];
    }
    return [];
  }
  const editor = runbookEditor();
  return editor ? editor.selections.flatMap((r) => editor.notebook.getCells(r)) : [];
}

/** Registers the approval gate first in the pipeline; push the returned `credentials` preparer last. */
export function registerApproval(context: vscode.ExtensionContext, pipeline: RunPipeline): { credentials: CellPreparer } {
  const f = new ApprovalFeature(context);
  pipeline.preparers.unshift(f.gate);
  const each = (fn: (c: vscode.NotebookCell) => Promise<boolean>) => async (arg?: unknown) => {
    const cells = targetCells(arg);
    if (cells.length === 0) void vscode.window.showInformationMessage('md-runbook: select a proposed cell first.');
    let ok = cells.length > 0;
    // From the end, so deleting a cell doesn't shift the ones still to do.
    for (const c of [...cells].sort((x, y) => y.index - x.index)) ok = (await fn(c)) && ok;
    return ok;
  };
  context.subscriptions.push(
    f,
    vscode.notebooks.registerNotebookCellStatusBarItemProvider(NOTEBOOK_TYPE, f),
    vscode.commands.registerCommand('mdRunbook.approveProposal', each((c) => f.approve(c))),
    vscode.commands.registerCommand('mdRunbook.rejectProposal', each((c) => f.reject(c))),
    vscode.commands.registerCommand('mdRunbook.approveAllProposals', async (arg?: unknown) => {
      const nb = arg instanceof vscode.Uri ? vscode.workspace.notebookDocuments.find((d) => d.uri.toString() === arg.toString()) : runbookEditor()?.notebook;
      return nb ? f.approveAll(nb) : 0;
    }),
    vscode.commands.registerCommand('mdRunbook.revealProposal', () => f.reveal()),
    vscode.workspace.onDidChangeNotebookDocument((e) => {
      if (e.notebook.notebookType === NOTEBOOK_TYPE) f.refresh();
    }),
    vscode.window.onDidChangeActiveNotebookEditor(() => f.refresh()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(`${SECTION}.approval`)) f.refresh();
    }),
  );
  f.refresh();
  return { credentials: f.credentials };
}
