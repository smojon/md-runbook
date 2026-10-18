/**
 * Terminal mode (`mdRunbook.terminal.mode`, off by default): cells run in a real VS Code terminal,
 * so password prompts and confirmations work and what the user types never passes through the
 * extension. Output and exit code come from VS Code's shell-integration API (VS Code 1.93+).
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { SECTION } from './config';
import { ExecuteResult, isCodeMeta, nodeShellEnv, resolveShell, shellKindForLanguage } from './core';
import { parseCellOptions } from './core/cellOptions';
import { proposalOf } from './core/proposal';
import { TerminalOutputFilter, parseStatus, terminalCommandLine, terminalSignature } from './core/terminalCommand';
import { META_KEY } from './outputs';
import { CellExecutor, CellPlan, ExecuteIO, PrepareContext, RunPipeline } from './pipeline';

type Mode = 'off' | 'perCell' | 'always';

// Shell integration is not in @types/vscode 1.85: minimal shapes, feature-detected at runtime.
interface ShellExecution {
  read(): AsyncIterable<string>;
}
interface ShellIntegration {
  executeCommand(commandLine: string): ShellExecution;
}
interface TerminalWithIntegration extends vscode.Terminal {
  readonly shellIntegration?: ShellIntegration;
}
interface WindowWithIntegration {
  onDidChangeTerminalShellIntegration?: vscode.Event<{ terminal: vscode.Terminal; shellIntegration: ShellIntegration }>;
  onDidEndTerminalShellExecution?: vscode.Event<{ terminal: vscode.Terminal; execution: ShellExecution; exitCode: number | undefined }>;
}

const INTEGRATION_TIMEOUT_MS = 10_000;
const CANCEL_GRACE_MS = 3_000;
const READ_GRACE_MS = 3_000;

const terminalMode = (): Mode => {
  const m = vscode.workspace.getConfiguration(SECTION).get<string>('terminal.mode', 'off');
  return m === 'perCell' || m === 'always' ? m : 'off';
};

function cellInfo(cell: vscode.NotebookCell): string {
  const meta: unknown = cell.metadata?.[META_KEY];
  return isCodeMeta(meta) ? meta.info : '';
}

function wantsTerminal(cell: vscode.NotebookCell): boolean {
  const optionsOn = vscode.workspace.getConfiguration(SECTION).get<boolean>('cellOptions.enabled', true);
  return optionsOn && parseCellOptions(cellInfo(cell)).terminal === true;
}

const notRun = (error: string): ExecuteResult => ({ exitCode: null, signal: null, timedOut: false, cancelled: false, error, durationMs: 0 });

export function registerTerminal(context: vscode.ExtensionContext, pipeline: RunPipeline): void {
  const win = vscode.window as typeof vscode.window & WindowWithIntegration;
  /** One terminal per runbook and shell kind, recreated when its cwd/env change. */
  const terminals = new Map<string, { terminal: vscode.Terminal; signature: string }>();

  const waitForIntegration = (terminal: TerminalWithIntegration): Promise<ShellIntegration | undefined> => {
    if (terminal.shellIntegration) return Promise.resolve(terminal.shellIntegration);
    if (!win.onDidChangeTerminalShellIntegration) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        sub.dispose();
        resolve(terminal.shellIntegration);
      }, INTEGRATION_TIMEOUT_MS);
      const sub = win.onDidChangeTerminalShellIntegration!((e) => {
        if (e.terminal !== terminal) return;
        clearTimeout(timer);
        sub.dispose();
        resolve(e.shellIntegration);
      });
    });
  };

  const terminalExecutor: CellExecutor = {
    async execute(plan: CellPlan, io: ExecuteIO, ctx: PrepareContext): Promise<ExecuteResult> {
      const kind = shellKindForLanguage(plan.language);
      if (kind === undefined || kind === 'cmd') return notRun('cmd cells cannot run in a terminal (no shell integration); remove the terminal option.');
      if (!win.onDidEndTerminalShellExecution) return notRun('Terminal mode needs VS Code 1.93 or newer (terminal shell integration).');
      const resolved = resolveShell(kind, plan.shell, nodeShellEnv());
      if (!resolved.ok) return notRun(resolved.error);
      const shell = resolved.shell;

      const key = `${ctx.notebook.uri.toString()}#${kind}`;
      const signature = terminalSignature(kind, shell.command, plan.cwd, plan.env);
      let entry = terminals.get(key);
      if (entry && (entry.signature !== signature || entry.terminal.exitStatus !== undefined)) {
        entry.terminal.dispose();
        entry = undefined;
      }
      if (!entry) {
        const name = `md-runbook: ${path.basename(ctx.notebook.uri.path)} (${shell.label})`;
        const terminal = vscode.window.createTerminal({ name, shellPath: shell.command, cwd: plan.cwd, env: plan.env });
        entry = { terminal, signature };
        terminals.set(key, entry);
      }
      const terminal = entry.terminal as TerminalWithIntegration;
      // Focus it: the user may need to type a password or answer a prompt.
      terminal.show(false);

      const integration = await waitForIntegration(terminal);
      if (!integration) {
        return notRun(
          'Terminal shell integration did not start, so output and exit code cannot be captured. ' +
            'Check `terminal.integrated.shellIntegration.enabled` and that the shell is supported (bash, zsh, PowerShell).',
        );
      }

      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-runbook-term-'));
      const scriptPath = path.join(dir, `cell-${crypto.randomBytes(4).toString('hex')}${shell.extension}`);
      fs.writeFileSync(scriptPath, shell.script(plan.source), 'utf8');
      const statusPath = path.join(dir, 'status');
      // bash gets paths in the form its args use (forward slashes for Git Bash); pwsh native paths.
      const asArg = (p: string): string => (kind === 'bash' ? (shell.args(p)[0] ?? p) : p);
      const started = Date.now();
      let timedOut = false;
      let cancelled = false;

      try {
        const execution = integration.executeCommand(terminalCommandLine(kind, asArg(scriptPath), asArg(statusPath)));
        const ended = new Promise<number | undefined>((resolve) => {
          const sub = win.onDidEndTerminalShellExecution!((e) => {
            if (e.execution !== execution) return;
            sub.dispose();
            resolve(e.exitCode);
          });
          // A disposed terminal never reports the end.
          const closed = vscode.window.onDidCloseTerminal((t) => {
            if (t !== terminal) return;
            closed.dispose();
            resolve(undefined);
          });
        });
        // read() must be called right away, or early output is lost.
        const filter = new TerminalOutputFilter();
        const reading = (async () => {
          for await (const data of execution.read()) {
            const text = filter.push(data);
            if (text) io.onStdout(text);
          }
          const rest = filter.flush();
          if (rest) io.onStdout(rest);
        })();

        const interrupt = (): void => {
          terminal.sendText('\x03', false); // Ctrl+C
          setTimeout(() => {
            if (terminals.get(key)?.terminal === terminal) {
              terminals.delete(key);
              terminal.dispose();
            }
          }, CANCEL_GRACE_MS).unref();
        };
        const onAbort = (): void => {
          cancelled = true;
          interrupt();
        };
        io.signal.addEventListener('abort', onAbort);
        const timer =
          plan.timeoutMs > 0
            ? setTimeout(() => {
                timedOut = true;
                interrupt();
              }, plan.timeoutMs)
            : undefined;

        const reported = await ended;
        let written: string | undefined;
        try {
          written = fs.readFileSync(statusPath, 'utf8');
        } catch {
          // Interrupted before the status was written.
        }
        const exitCode = parseStatus(written) ?? reported;
        clearTimeout(timer);
        io.signal.removeEventListener('abort', onAbort);
        // The stream finishes shortly after the end event; don't cut off the last lines.
        await Promise.race([reading.catch(() => undefined), new Promise((r) => setTimeout(r, READ_GRACE_MS))]);
        return { exitCode: exitCode ?? null, signal: null, timedOut, cancelled, durationMs: Date.now() - started, shell: { ...shell, label: `${shell.label} terminal` } };
      } finally {
        fs.rm(dir, { recursive: true, force: true }, () => undefined);
      }
    },
  };

  const fallback = pipeline.executorFor;
  pipeline.executorFor = (nb) => {
    const base = fallback(nb);
    const mode = terminalMode();
    if (mode === 'off') return base;
    return {
      execute: (plan, io, ctx) => {
        const asked = wantsTerminal(ctx.cell);
        if (!asked && mode !== 'always') return base.execute(plan, io, ctx);
        // Assistant-written cells never get an interactive terminal.
        if (proposalOf(cellInfo(ctx.cell)).by !== undefined) {
          return asked ? Promise.resolve(notRun('cells written by an assistant never run in a terminal.')) : base.execute(plan, io, ctx);
        }
        if (mode === 'always' && !asked && shellKindForLanguage(plan.language) === 'cmd') return base.execute(plan, io, ctx);
        return terminalExecutor.execute(plan, io, ctx);
      },
    };
  };

  context.subscriptions.push(
    vscode.workspace.onDidCloseNotebookDocument((nb) => {
      for (const [key, entry] of [...terminals]) {
        if (key.startsWith(`${nb.uri.toString()}#`)) {
          entry.terminal.dispose();
          terminals.delete(key);
        }
      }
    }),
    vscode.window.onDidCloseTerminal((t) => {
      for (const [key, entry] of [...terminals]) if (entry.terminal === t) terminals.delete(key);
    }),
    { dispose: () => terminals.forEach((e) => e.terminal.dispose()) },
  );
}
