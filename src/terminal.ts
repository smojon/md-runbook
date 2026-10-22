/**
 * Terminal mode (`mdRunbook.terminal.mode`, off by default): cells run in a real VS Code terminal,
 * so password prompts and confirmations work and what the user types never passes through the
 * extension. Output and exit code come from VS Code's shell-integration API (VS Code 1.93+).
 */

import { execFile } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { SECTION } from './config';
import { ExecuteResult, isCodeMeta, shellKindForLanguage } from '@md-runbook/core';
import { nodeShellEnv, resolveShell } from '@md-runbook/core/node';
import { parseCellOptions } from '@md-runbook/core/cellOptions';
import { proposalOf } from '@md-runbook/core/proposal';
import { killTree } from '@md-runbook/core/node/runner';
import {
  TerminalOutputFilter,
  descendants,
  parseStatus,
  terminalCmdCommandLine,
  terminalCommandLine,
  terminalInlineCommandLine,
  terminalSignature,
} from '@md-runbook/core/terminalCommand';
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
/** How long to wait for the exit-code file after the terminal reports the end of the command. */
const STATUS_GRACE_MS = 1_000;
/**
 * How long to wait for the end report once the exit-code file exists. The report normally comes
 * about 0.5 s later (the command line ends with a short pause); when it never comes (shell
 * integration can lose it, e.g. for a command sent right after the previous one), the file is
 * enough.
 */
const END_REPORT_GRACE_MS = 3_000;

/** Kill everything a terminal's shell started, then the shell (Ctrl+C was not enough). */
function killTerminalTree(pid: number): void {
  if (process.platform === 'win32') return killTree(pid, 'win32'); // taskkill /T walks the tree
  execFile('ps', ['-A', '-o', 'pid=,ppid='], (err, stdout) => {
    const pids = err ? [] : descendants(stdout, pid);
    for (const p of [...pids.reverse(), pid]) {
      try {
        process.kill(p, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function readStatus(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

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

  /** Waits up to 10 s for shell integration; gives up at once when `signal` aborts. */
  const waitForIntegration = (terminal: TerminalWithIntegration, signal: AbortSignal): Promise<ShellIntegration | undefined> => {
    if (terminal.shellIntegration) return Promise.resolve(terminal.shellIntegration);
    if (!win.onDidChangeTerminalShellIntegration || signal.aborted) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const done = (value: ShellIntegration | undefined): void => {
        clearTimeout(timer);
        sub.dispose();
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      };
      const onAbort = (): void => done(undefined);
      const timer = setTimeout(() => done(terminal.shellIntegration), INTEGRATION_TIMEOUT_MS);
      const sub = win.onDidChangeTerminalShellIntegration!((e) => {
        if (e.terminal === terminal) done(e.shellIntegration);
      });
      signal.addEventListener('abort', onAbort);
    });
  };

  const terminalExecutor: CellExecutor = {
    async execute(plan: CellPlan, io: ExecuteIO, ctx: PrepareContext): Promise<ExecuteResult> {
      const cellKind = shellKindForLanguage(plan.language);
      if (cellKind === undefined) return notRun('this cell has no shell to run in a terminal.');
      if (!win.onDidEndTerminalShellExecution) return notRun('Terminal mode needs VS Code 1.93 or newer (terminal shell integration).');
      // cmd.exe has no shell integration: a cmd cell runs from a PowerShell terminal, in a cmd.exe
      // of its own (as cmd cells always do), its batch file written as for a normal run.
      const cmd = cellKind === 'cmd' ? resolveShell('cmd', plan.shell, nodeShellEnv()) : undefined;
      if (cmd && !cmd.ok) return notRun(cmd.error);
      const kind = cellKind === 'cmd' ? 'pwsh' : cellKind;
      const resolved = resolveShell(kind, plan.shell, nodeShellEnv());
      if (!resolved.ok) return notRun(resolved.error);
      const shell = resolved.shell;
      const script = cmd?.ok ? cmd.shell : shell;

      const started = Date.now();
      let timedOut = false;
      let cancelled = io.signal.aborted;
      const result = (exitCode: number | null, error?: string): ExecuteResult => ({
        exitCode,
        signal: null,
        timedOut,
        cancelled,
        durationMs: Date.now() - started,
        shell: { ...script, label: `${script.label} terminal` },
        ...(error !== undefined ? { error } : {}),
      });
      if (cancelled) return result(null);

      // Cancel and timeout apply from the start, including the wait for shell integration.
      const stop = new AbortController();
      const onAbort = (): void => {
        cancelled = true;
        stop.abort();
      };
      io.signal.addEventListener('abort', onAbort);
      const timer =
        plan.timeoutMs > 0
          ? setTimeout(() => {
              timedOut = true;
              stop.abort();
            }, plan.timeoutMs)
          : undefined;
      let dir: string | undefined;

      try {
        // A line run gets a terminal of its own, closed when the run ends: its lines run in that
        // terminal's shell, so `cd` and variables carry over without changing the runbook's terminal.
        const key = `${ctx.notebook.uri.toString()}#${kind}${ctx.lineRun ? '#lines' : ''}`;
        const signature = terminalSignature(kind, shell.command, plan.cwd, plan.env);
        let entry = terminals.get(key);
        if (entry && (entry.signature !== signature || entry.terminal.exitStatus !== undefined)) {
          entry.terminal.dispose();
          entry = undefined;
        }
        if (!entry) {
          const name = `md-runbook: ${path.basename(ctx.notebook.uri.path)} (${shell.label}${ctx.lineRun ? ', lines' : ''})`;
          // Transient: VS Code must not restore it (with its environment, which may hold secrets)
          // or its scrollback after a reload.
          const terminal = vscode.window.createTerminal({ name, shellPath: shell.command, cwd: plan.cwd, env: plan.env, isTransient: true });
          entry = { terminal, signature };
          terminals.set(key, entry);
          ctx.lineRun?.onEnd(() => {
            if (terminals.get(key)?.terminal === terminal) terminals.delete(key);
            terminal.dispose();
          });
        }
        const terminal = entry.terminal as TerminalWithIntegration;
        // Focus it: the user may need to type a password or answer a prompt.
        terminal.show(false);

        const integration = await waitForIntegration(terminal, stop.signal);
        if (stop.signal.aborted) return result(null);
        if (!integration) {
          return notRun(
            'Terminal shell integration did not start, so output and exit code cannot be captured. ' +
              'Check `terminal.integrated.shellIntegration.enabled` and that the shell is supported (bash, zsh, PowerShell).',
          );
        }

        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-runbook-term-'));
        const scriptPath = path.join(dir, `cell-${crypto.randomBytes(4).toString('hex')}${script.extension}`);
        fs.writeFileSync(scriptPath, script.script(plan.source), 'utf8');
        const statusPath = path.join(dir, 'status');
        // bash gets paths in the form its args use (forward slashes for Git Bash); pwsh native paths.
        const asArg = (p: string): string => (kind === 'bash' ? (shell.args(p)[0] ?? p) : p);

        const commandLine = cmd?.ok
          ? terminalCmdCommandLine(cmd.shell.command, scriptPath, statusPath)
          : ctx.lineRun
            ? terminalInlineCommandLine(kind, asArg(scriptPath), asArg(statusPath))
            : terminalCommandLine(kind, shell.command, asArg(scriptPath), asArg(statusPath));
        const execution = integration.executeCommand(commandLine);
        let stopWaiting = (): void => undefined;
        const ended = new Promise<number | undefined>((resolve) => {
          const done = (code: number | undefined): void => {
            endSub.dispose();
            closeSub.dispose();
            resolve(code);
          };
          stopWaiting = () => {
            endSub.dispose();
            closeSub.dispose();
          };
          const endSub = win.onDidEndTerminalShellExecution!((e) => {
            if (e.execution === execution) done(e.exitCode);
          });
          // A disposed terminal never reports the end.
          const closeSub = vscode.window.onDidCloseTerminal((t) => {
            if (t === terminal) done(undefined);
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

        // Ctrl+C; if the command has not ended after the grace period, kill what runs in the
        // terminal and close it. A command that stops in time leaves the terminal reusable.
        let finished = false;
        let grace: NodeJS.Timeout | undefined;
        const interrupt = (): void => {
          terminal.sendText('\x03', false);
          grace = setTimeout(() => {
            if (finished) return;
            if (terminals.get(key)?.terminal === terminal) terminals.delete(key);
            void Promise.resolve(terminal.processId)
              .then((pid) => pid !== undefined && killTerminalTree(pid), () => undefined)
              .then(() => terminal.dispose());
          }, CANCEL_GRACE_MS);
        };
        stop.signal.addEventListener('abort', interrupt, { once: true });

        // The end report, or else the exit-code file the command line writes (plus a grace period).
        let polling = true;
        const byStatusFile = (async (): Promise<undefined> => {
          while (polling) {
            if (readStatus(statusPath) !== undefined) {
              await sleep(END_REPORT_GRACE_MS);
              return undefined;
            }
            await sleep(200);
          }
          return undefined;
        })();
        const reported = await Promise.race([ended, byStatusFile]);
        polling = false;
        stopWaiting();
        finished = true;
        clearTimeout(grace);
        stop.signal.removeEventListener('abort', interrupt);

        let written = readStatus(statusPath);
        // The status is written right after the script ends; give it a moment if the end was
        // reported first.
        for (let waited = 0; written === undefined && !stop.signal.aborted && terminal.exitStatus === undefined && waited < STATUS_GRACE_MS; waited += 100) {
          await sleep(100);
          written = readStatus(statusPath);
        }
        // The stream finishes shortly after the end event; don't cut off the last lines.
        await Promise.race([reading.catch(() => undefined), sleep(READ_GRACE_MS)]);

        const status = parseStatus(written);
        if (status !== undefined) return result(status);
        if (stop.signal.aborted) return result(null);
        // No exit code written: the terminal closed, or the end was reported early (output that
        // imitates the shell-integration end mark). Never a success; and the command may still
        // run there, so the next cell gets a new terminal.
        if (terminals.get(key)?.terminal === terminal) terminals.delete(key);
        if (reported !== undefined && reported !== 0) return result(reported);
        return result(null, 'The terminal reported the end of the command without its exit code, so the result is unknown (the command may still be running in the terminal).');
      } finally {
        clearTimeout(timer);
        io.signal.removeEventListener('abort', onAbort);
        if (dir !== undefined) fs.rm(dir, { recursive: true, force: true }, () => undefined);
      }
    },
  };

  const fallback = pipeline.executorFor;
  pipeline.executorFor = (nb) => {
    const base = fallback(nb);
    const mode = terminalMode();
    if (mode === 'off') {
      // Say why a `terminal` cell gets no input instead of ignoring the option silently.
      return {
        execute: (plan, io, ctx) => {
          if (wantsTerminal(ctx.cell)) {
            io.onStderr('[md-runbook] terminal option ignored: set "mdRunbook.terminal.mode" to "perCell" in your user settings to answer prompts\n');
          }
          return base.execute(plan, io, ctx);
        },
      };
    }
    return {
      execute: (plan, io, ctx) => {
        const asked = wantsTerminal(ctx.cell);
        if (!asked && mode !== 'always') return base.execute(plan, io, ctx);
        // Assistant-written cells never get an interactive terminal.
        if (proposalOf(cellInfo(ctx.cell)).by !== undefined) {
          return asked ? Promise.resolve(notRun('cells written by an assistant never run in a terminal.')) : base.execute(plan, io, ctx);
        }
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
