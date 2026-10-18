/**
 * Persistent shell sessions: one long-lived bash or PowerShell process runs cell after cell, so
 * `cd`, variables, functions and logins carry over.
 *
 * Each cell is written to a temp script and sourced by a one-line command, followed by a
 * sentinel `<RS>__MDRB_<id>__ <exit>\n` on stdout and on stderr (RS = the ASCII record separator,
 * \x1e). Seeing the sentinel on both streams means the cell's output is complete; the sentinel
 * itself is stripped.
 */

import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { ExecuteOptions, ExecuteResult, executeCell, nodeShellEnv } from './execute';
import { RunResult, killTree } from './runner';
import { ResolvedShell, ShellEnv, ShellKind, resolveShell, shellKindForLanguage } from './shell';

/** Starts the sentinel. Not a newline: the output keeps exactly the line endings the cell wrote. */
export const SENTINEL_START = '\x1e';

/**
 * Passes a stream through until the sentinel for one cell, which it strips. Only a trailing
 * piece that could still become the sentinel (from an RS character on) is held back, so complete
 * lines are passed on at once and the other stream can't overtake their newline.
 */
export class SentinelFilter {
  private pending = '';
  private readonly needle: string;
  /** Exit code from the sentinel, once seen. Anything after it is dropped. */
  code: number | undefined;

  constructor(
    marker: string,
    private readonly emit: (text: string) => void,
  ) {
    this.needle = SENTINEL_START + marker + ' ';
  }

  get done(): boolean {
    return this.code !== undefined;
  }

  write(chunk: string): void {
    if (this.done) return;
    let p = this.pending + chunk;
    const at = p.indexOf(this.needle);
    if (at >= 0) {
      this.send(p.slice(0, at));
      p = p.slice(at);
      const end = p.indexOf('\n');
      if (end >= 0) {
        const code = Number.parseInt(p.slice(this.needle.length, end), 10);
        this.code = Number.isNaN(code) ? 1 : code;
        p = '';
      }
      this.pending = p;
      return;
    }
    // The needle has a single RS, at its start: only the text from the last RS can be a prefix.
    const rs = p.lastIndexOf(SENTINEL_START);
    const hold = rs >= 0 && this.needle.startsWith(p.slice(rs)) ? rs : p.length;
    this.send(p.slice(0, hold));
    this.pending = p.slice(hold);
  }

  /** Emit whatever is held back (the process ended without a sentinel). */
  flush(): void {
    this.send(this.pending);
    this.pending = '';
  }

  private send(text: string): void {
    if (text !== '') this.emit(text);
  }
}

export interface SessionRunOptions {
  source: string;
  /** Environment variables set before the cell runs (they stay set afterwards). */
  env?: Record<string, string>;
  /**
   * Run this cell in another folder: the session changes to it before the cell and back
   * afterwards, so a `cd` inside the cell does not carry over either.
   */
  cwd?: string;
  /** 0 = no timeout. */
  timeoutMs: number;
  signal?: AbortSignal;
  onStdout(text: string): void;
  onStderr(text: string): void;
}

export interface SessionResult extends RunResult {
  /** The shell process ended during this cell (`exit`, cancel, timeout, crash). */
  ended: boolean;
}

/** How long to wait for output pipes to close after the process exits. */
const EXIT_GRACE_MS = 1000;
const DIR_ENV = 'MD_RUNBOOK_SESSION_DIR';
const TERM_ENV = 'MD_RUNBOOK_TERM';
/** Location stack for `cwd` cells in PowerShell, so a cell's own Push-Location is left alone. */
const PWSH_STACK = '__mdrbCellCwd';

const sq = (s: string): string => "'" + s.replace(/'/g, "'\\''") + "'";
/** PowerShell also treats the typographic single quotes ‘ ’ ‚ ‛ as quotes: double them all. */
const psq = (s: string): string => "'" + s.replace(/['‘’‚‛]/g, '$&$&') + "'";

function sessionArgs(shell: ResolvedShell, platform: NodeJS.Platform): string[] {
  if (shell.kind === 'bash') return ['-s'];
  // Read commands from stdin; each line runs like a top-level command (output and errors are
  // rendered by the host exactly as in isolated mode).
  return ['-NoLogo', '-NoProfile', '-NonInteractive', ...(platform === 'win32' ? ['-ExecutionPolicy', 'Bypass'] : []), '-Command', '-'];
}

/**
 * Commands sent on stdin. They are ASCII only: paths come from the session directory, which the
 * shell reads once from an environment variable (stdin encoding varies on Windows).
 */
function initCommand(kind: ShellKind): string {
  if (kind === 'bash') return `__mdrb_dir=$${DIR_ENV}; unset ${DIR_ENV}\n`;
  // Must print nothing: its output would land in the first cell. pwsh was started with TERM=dumb
  // (see ShellSession); give cells the real TERM back.
  return (
    `$__mdrbDir = $env:${DIR_ENV}; Remove-Item Env:${DIR_ENV} -ErrorAction Ignore; ` +
    `if ($env:${TERM_ENV}) { $env:TERM = $env:${TERM_ENV} } else { Remove-Item Env:TERM -ErrorAction Ignore }; ` +
    `Remove-Item Env:${TERM_ENV} -ErrorAction Ignore; ` +
    // $OutputEncoding without a BOM: it is what native commands receive on stdin (`$null | cmd`).
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = New-Object System.Text.UTF8Encoding $false\n'
  );
}

/**
 * `pre` = the cell has a setup script (`<id>.pre<ext>`: its environment variables and, for a
 * `cwd` cell, the change of folder). It is deleted right after it has been sourced, so values
 * such as secrets don't stay on disk while the cell runs.
 */
function cellCommand(kind: ShellKind, id: string, ext: string, pre: boolean): string {
  const marker = `__MDRB_${id}__`;
  if (kind === 'bash') {
    // stdin is the command stream, so the cell reads from /dev/null like an isolated run. The
    // setup runs as an `if` condition so a failing `cd` doesn't end a session that has `set -e`.
    const preFile = `"$__mdrb_dir/${id}.pre${ext}"`;
    const run = `. "$__mdrb_dir/${id}${ext}" </dev/null; __mdrb_rc=$?`;
    const body = pre
      ? `__mdrb_cd=; if . ${preFile} </dev/null; then rm -f ${preFile} 2>/dev/null; ${run}; ` +
        `else __mdrb_rc=$?; rm -f ${preFile} 2>/dev/null; fi; ` +
        'if [ -n "$__mdrb_cd" ]; then cd -- "$__mdrb_cd" 2>/dev/null; __mdrb_cd=; fi; '
      : `${run}; `;
    return body + `printf '\\036%s %s\\n' ${marker} "$__mdrb_rc"; printf '\\036%s %s\\n' ${marker} "$__mdrb_rc" >&2\n`;
  }
  // Two lines: a terminating error aborts only the first, and the exit code follows the same rules
  // as isolated mode (pwshWrapper): last native exit code, else 1 if the script failed. The
  // second line also leaves a `cwd` cell's folder (the setup pushed it on a private stack).
  const preFile = `"$__mdrbDir/${id}.pre${ext}"`;
  const setup = pre ? `. ${preFile}; Remove-Item -LiteralPath ${preFile} -Force -ErrorAction Ignore; ` : '';
  return (
    `$global:LASTEXITCODE = 0; $__mdrbOk = $false; $__mdrbPushed = $false; ${setup}. "$__mdrbDir/${id}${ext}"; $__mdrbOk = $?\n` +
    `if ($__mdrbPushed) { Pop-Location -StackName ${PWSH_STACK} -ErrorAction Ignore; $__mdrbPushed = $false }; ` +
    '$__mdrbRc = if ($LASTEXITCODE) { $LASTEXITCODE } elseif (-not $__mdrbOk) { 1 } else { 0 }; ' +
    `$__mdrbS = [string][char]30 + "${marker} $__mdrbRc\`n"; [Console]::Out.Write($__mdrbS); [Console]::Error.Write($__mdrbS)\n`
  );
}

/** A cell's setup script: its environment variables, then the change to its folder (if any). */
export function preScript(kind: ShellKind, env: Record<string, string>, cwd: string | undefined, platform: NodeJS.Platform = process.platform): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (kind === 'pwsh') lines.push(`[Environment]::SetEnvironmentVariable(${psq(k)}, ${psq(v)})`);
    else if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) lines.push(`export ${k}=${sq(v)}`);
  }
  if (cwd !== undefined) {
    if (kind === 'pwsh') {
      lines.push(`Push-Location -LiteralPath ${psq(cwd)} -StackName ${PWSH_STACK} -ErrorAction Stop`, '$__mdrbPushed = $true');
    } else {
      // Last line, so its status is the setup's status. Git Bash takes C:/x/y paths.
      lines.push('__mdrb_cd=$PWD', `cd -- ${sq(platform === 'win32' ? cwd.replace(/\\/g, '/') : cwd)}`);
    }
  }
  return lines.join('\n');
}

interface CurrentCell {
  out: SentinelFilter;
  err: SentinelFilter;
  /** Both sentinels seen: finish the cell. */
  check(): void;
  onExit(code: number | null, signal: NodeJS.Signals | null): void;
}

/** One long-lived shell process. Runs one cell at a time. */
export class ShellSession {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly dir: string;
  private ended = false;
  private killed = false;
  private startError: string | undefined;
  private current: CurrentCell | undefined;
  private readonly outDec = new StringDecoder('utf8');
  private readonly errDec = new StringDecoder('utf8');
  /** Called once when the process has ended. */
  onDidEnd: () => void = () => undefined;

  constructor(
    readonly shell: ResolvedShell,
    /** The session's base folder (the runbook's folder): where it starts. */
    readonly cwd: string,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-runbook-session-'));
    // Git Bash takes C:/x/y paths; backslashes could be read as escapes.
    const dirForShell = platform === 'win32' && shell.kind === 'bash' ? this.dir.replace(/\\/g, '/') : this.dir;
    // Only VS Code's environment: per-cell variables (secrets, inputs, execution.env) are set by
    // each cell's setup script, so a restarted session starts clean.
    const spawnEnv: NodeJS.ProcessEnv = { ...process.env, [DIR_ENV]: dirForShell };
    if (shell.kind === 'pwsh') {
      // .NET reads terminfo once at startup; unless TERM is dumb it writes cursor-key mode codes
      // to stdout around every line it reads from stdin.
      spawnEnv[TERM_ENV] = spawnEnv.TERM ?? '';
      spawnEnv.TERM = 'dumb';
    }
    this.child = spawn(shell.command, sessionArgs(shell, platform), {
      cwd,
      env: spawnEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: platform !== 'win32',
    });
    // Output between cells (e.g. from a background job) belongs to no cell and is dropped.
    this.child.stdout.on('data', (b: Buffer) => this.deliver('out', this.outDec.write(b)));
    this.child.stderr.on('data', (b: Buffer) => this.deliver('err', this.errDec.write(b)));
    this.child.stdin.on('error', () => undefined);
    this.child.on('error', (e) => {
      this.startError = e.message;
      this.end(null, null);
    });
    this.child.on('close', (code, signal) => this.end(code, signal));
    // A background job can hold the pipes open after the shell exits: don't wait for it.
    this.child.on('exit', (code, signal) => setTimeout(() => this.end(code, signal), EXIT_GRACE_MS).unref());
    this.child.stdin.write(initCommand(shell.kind));
  }

  get alive(): boolean {
    return !this.ended && !this.killed;
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  run(opts: SessionRunOptions): Promise<SessionResult> {
    const started = Date.now();
    return new Promise((resolve) => {
      let timedOut = false;
      let cancelled = false;
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const files: string[] = [];
      const finish = (r: { exitCode: number | null; signal: string | null; error?: string }, ended: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        this.current = undefined;
        for (const f of files) fs.rm(f, { force: true }, () => undefined);
        resolve({ ...r, timedOut, cancelled, ended, durationMs: Date.now() - started });
      };
      const onAbort = (): void => {
        cancelled = true;
        this.kill();
      };

      if (!this.alive) return finish({ exitCode: null, signal: null, error: this.startError ?? 'The session has ended.' }, true);
      if (this.current) return finish({ exitCode: null, signal: null, error: 'The session is busy.' }, false);
      if (opts.signal?.aborted) {
        cancelled = true;
        return finish({ exitCode: null, signal: null }, false);
      }

      const id = randomBytes(12).toString('hex');
      const ext = this.shell.extension;
      const env = opts.env ?? {};
      const pre = Object.keys(env).length > 0 || opts.cwd !== undefined;
      try {
        const script = path.join(this.dir, id + ext);
        files.push(script);
        fs.writeFileSync(script, this.shell.script(opts.source), 'utf8');
        if (pre) {
          const preFile = path.join(this.dir, `${id}.pre${ext}`);
          files.push(preFile);
          fs.writeFileSync(preFile, this.shell.script(preScript(this.shell.kind, env, opts.cwd, this.platform)), { encoding: 'utf8', mode: 0o600 });
        }
      } catch (e) {
        return finish({ exitCode: null, signal: null, error: e instanceof Error ? e.message : String(e) }, false);
      }

      const out = new SentinelFilter(`__MDRB_${id}__`, opts.onStdout);
      const err = new SentinelFilter(`__MDRB_${id}__`, opts.onStderr);
      this.current = {
        out,
        err,
        check: () => {
          if (out.done && err.done) finish({ exitCode: out.code!, signal: null }, false);
        },
        onExit: (code, signal) => {
          out.flush();
          err.flush();
          finish({ exitCode: code, signal, error: this.startError }, true);
        },
      };

      opts.signal?.addEventListener('abort', onAbort);
      if (opts.timeoutMs > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          this.kill();
        }, opts.timeoutMs);
      }
      this.child.stdin.write(cellCommand(this.shell.kind, id, ext, pre));
    });
  }

  /** Kill the whole process tree. The running cell (if any) ends as soon as the process does. */
  kill(): void {
    if (this.killed || this.ended) return;
    this.killed = true;
    if (this.child.pid !== undefined) killTree(this.child.pid, this.platform);
  }

  dispose(): void {
    this.kill();
    if (this.ended) this.cleanup();
  }

  private deliver(stream: 'out' | 'err', text: string): void {
    const c = this.current;
    if (!c || text === '') return;
    c[stream].write(text);
    c.check();
  }

  private end(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.ended) return;
    this.ended = true;
    this.deliver('out', this.outDec.end());
    this.deliver('err', this.errDec.end());
    this.current?.onExit(code, signal);
    this.cleanup();
    this.onDidEnd();
  }

  private cleanup(): void {
    fs.rm(this.dir, { recursive: true, force: true }, () => undefined);
  }
}

export interface SessionExecuteOptions extends ExecuteOptions {
  /**
   * The session's base folder (the runbook's folder): new sessions start here. A cell whose
   * `cwd` differs (a `cwd=` option) runs in its folder for that cell only. Defaults to the `cwd`
   * of the cell that starts the session.
   */
  baseCwd?: string;
}

/**
 * The sessions of one notebook: one per shell kind, started on first use and replaced after
 * they end. cmd has no session mode and runs isolated.
 */
export class SessionPool {
  private readonly sessions = new Map<ShellKind, ShellSession>();
  /** Kinds that have had a session, so a replacement can be announced. */
  private readonly started = new Set<ShellKind>();

  constructor(
    /** Called when a session starts or ends. */
    private readonly onChange: () => void = () => undefined,
    private readonly shellEnv: ShellEnv = nodeShellEnv(),
  ) {}

  /** Labels of the running sessions, e.g. ['bash', 'pwsh']. */
  labels(): string[] {
    return [...this.sessions.values()].filter((s) => s.alive).map((s) => s.shell.label);
  }

  /** The running session for a kind, if any. */
  session(kind: ShellKind): ShellSession | undefined {
    const s = this.sessions.get(kind);
    return s?.alive ? s : undefined;
  }

  async execute(opts: SessionExecuteOptions): Promise<ExecuteResult> {
    const kind = shellKindForLanguage(opts.language);
    if (kind === undefined || kind === 'cmd') return executeCell(opts, this.shellEnv);
    const resolved = resolveShell(kind, opts.settings, this.shellEnv);
    if (!resolved.ok) return executeCell(opts, this.shellEnv); // reports the error
    let s = this.sessions.get(kind);
    if (s && (!s.alive || s.shell.command !== resolved.shell.command)) {
      s.dispose();
      s = undefined;
    }
    if (!s) {
      if (this.started.has(kind)) opts.onStdout('[md-runbook] new session started\n');
      s = this.start(resolved.shell, opts.baseCwd ?? opts.cwd);
    }
    // A cell with its own folder (`cwd=`) runs there without moving the session; other cells
    // run wherever earlier cells left it.
    const cellCwd = path.resolve(opts.cwd) === path.resolve(s.cwd) ? undefined : opts.cwd;
    const r = await s.run({
      source: opts.source,
      env: opts.env,
      cwd: cellCwd,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
      onStdout: opts.onStdout,
      onStderr: opts.onStderr,
    });
    if (r.ended && !r.cancelled && !r.timedOut && r.error === undefined) {
      opts.onStderr(`[md-runbook] session ended (exit ${r.exitCode ?? r.signal}); the next cell starts a new session\n`);
    }
    const { ended: _ended, ...result } = r;
    return { ...result, shell: { ...resolved.shell, label: `${resolved.shell.label} session` } };
  }

  /**
   * Replace every running session with a fresh one in its base folder, with only VS Code's
   * environment. Returns their labels.
   */
  restart(): string[] {
    const running = [...this.sessions.values()].filter((s) => s.alive);
    for (const s of running) {
      s.dispose();
      this.start(s.shell, s.cwd);
    }
    return running.map((s) => s.shell.label);
  }

  /** Stop every session. Returns the labels of those that were running. */
  stop(): string[] {
    const labels = this.labels();
    for (const s of this.sessions.values()) s.dispose();
    this.sessions.clear();
    this.onChange();
    return labels;
  }

  dispose(): void {
    this.stop();
  }

  private start(shell: ResolvedShell, cwd: string): ShellSession {
    const s = new ShellSession(shell, cwd);
    s.onDidEnd = () => {
      if (this.sessions.get(shell.kind) === s) this.sessions.delete(shell.kind);
      this.onChange();
    };
    this.sessions.set(shell.kind, s);
    this.started.add(shell.kind);
    this.onChange();
    return s;
  }
}
