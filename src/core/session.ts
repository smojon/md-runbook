/**
 * Persistent shell sessions: one long-lived bash or PowerShell process runs cell after cell, so
 * `cd`, variables, functions and logins carry over.
 *
 * Each cell is written to a temp script and sourced by a one-line command, followed by a
 * sentinel line `\n__MDRB_<id>__ <exit>\n` on stdout and on stderr. Seeing the sentinel on both
 * streams means the cell's output is complete; the sentinel itself is stripped.
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

/**
 * Passes a stream through until the sentinel line for one cell, which it strips (with the
 * newline before it). Only a trailing partial line that could still become the sentinel is
 * held back.
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
    this.needle = '\n' + marker + ' ';
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
      const end = p.indexOf('\n', 1);
      if (end >= 0) {
        const code = Number.parseInt(p.slice(this.needle.length, end), 10);
        this.code = Number.isNaN(code) ? 1 : code;
        p = '';
      }
      this.pending = p;
      return;
    }
    // The needle has a single '\n', at its start: only the text from the last '\n' can be a prefix.
    const nl = p.lastIndexOf('\n');
    const hold = nl >= 0 && this.needle.startsWith(p.slice(nl)) ? nl : p.length;
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

const sq = (s: string): string => "'" + s.replace(/'/g, "'\\''") + "'";
const psq = (s: string): string => "'" + s.replace(/'/g, "''") + "'";

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
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8\n'
  );
}

function cellCommand(kind: ShellKind, id: string, ext: string, withEnv: boolean): string {
  const marker = `__MDRB_${id}__`;
  if (kind === 'bash') {
    // stdin is the command stream, so the cell reads from /dev/null like an isolated run.
    const env = withEnv ? `. "$__mdrb_dir/${id}.env${ext}" </dev/null; ` : '';
    return (
      `${env}. "$__mdrb_dir/${id}${ext}" </dev/null; __mdrb_rc=$?; ` +
      `printf '\\n%s %s\\n' ${marker} "$__mdrb_rc"; printf '\\n%s %s\\n' ${marker} "$__mdrb_rc" >&2\n`
    );
  }
  // Two lines: a terminating error aborts only the first, and the exit code follows the same rules
  // as isolated mode (pwshWrapper): last native exit code, else 1 if the script failed.
  const env = withEnv ? `. "$__mdrbDir/${id}.env${ext}"; ` : '';
  return (
    `$global:LASTEXITCODE = 0; $__mdrbOk = $false; ${env}. "$__mdrbDir/${id}${ext}"; $__mdrbOk = $?\n` +
    '$__mdrbRc = if ($LASTEXITCODE) { $LASTEXITCODE } elseif (-not $__mdrbOk) { 1 } else { 0 }; ' +
    `[Console]::Out.Write("\`n${marker} $__mdrbRc\`n"); [Console]::Error.Write("\`n${marker} $__mdrbRc\`n")\n`
  );
}

function envScript(kind: ShellKind, env: Record<string, string>): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (kind === 'pwsh') lines.push(`[Environment]::SetEnvironmentVariable(${psq(k)}, ${psq(v)})`);
    else if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) lines.push(`export ${k}=${sq(v)}`);
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
    readonly cwd: string,
    readonly env: Record<string, string> = {},
    private readonly platform: NodeJS.Platform = process.platform,
  ) {
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-runbook-session-'));
    // Git Bash takes C:/x/y paths; backslashes could be read as escapes.
    const dirForShell = platform === 'win32' && shell.kind === 'bash' ? this.dir.replace(/\\/g, '/') : this.dir;
    const spawnEnv: NodeJS.ProcessEnv = { ...process.env, ...env, [DIR_ENV]: dirForShell };
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
      const withEnv = Object.keys(env).length > 0;
      try {
        const script = path.join(this.dir, id + ext);
        files.push(script);
        fs.writeFileSync(script, this.shell.script(opts.source), 'utf8');
        if (withEnv) {
          const envFile = path.join(this.dir, `${id}.env${ext}`);
          files.push(envFile);
          fs.writeFileSync(envFile, this.shell.script(envScript(this.shell.kind, env)), 'utf8');
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
      this.child.stdin.write(cellCommand(this.shell.kind, id, ext, withEnv));
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

  async execute(opts: ExecuteOptions): Promise<ExecuteResult> {
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
      s = this.start(resolved.shell, opts.cwd, opts.env);
    }
    const r = await s.run({
      source: opts.source,
      env: opts.env,
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

  /** Replace every running session with a fresh one in its original folder. Returns their labels. */
  restart(): string[] {
    const running = [...this.sessions.values()].filter((s) => s.alive);
    for (const s of running) {
      s.dispose();
      this.start(s.shell, s.cwd, s.env);
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

  private start(shell: ResolvedShell, cwd: string, env: Record<string, string> = {}): ShellSession {
    const s = new ShellSession(shell, cwd, env);
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
