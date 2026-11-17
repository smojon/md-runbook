/**
 * Remote hosts (docs/design/vscode-hosts.md): cells run over SSH on the hosts of
 * `mdRunbook.hosts`, as the app runs them. A `host=` cell runs on its host, Run on a Group… runs a
 * cell on each host of a group, Practice on a Host… sends every cell of a runbook to one host.
 *
 * - Keys: the SSH agent's, else md-runbook's own (SecretStorage). Nothing else.
 * - Host keys: pinned after a modal with the fingerprint; checked before any credential is sent.
 * - Output, checks, captures, redaction: the controller's, through the executor here.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { KeyPair } from '@microsoft/dev-tunnels-ssh';
import { ExecuteResult, RunbookShells, isCodeMeta, shellKindForLanguage } from '@md-runbook/core';
import { isCallLanguage } from '@md-runbook/core/call';
import { parseCellOptions } from '@md-runbook/core/cellOptions';
import { evaluateChecks } from '@md-runbook/core/checks';
import { proposalOf } from '@md-runbook/core/proposal';
import { reportTrustProblem } from '@md-runbook/core/runReport';
import { findRefs, parseFrontMatter } from '@md-runbook/core/secrets';
import type { RemoteRunOptions, RemoteSession } from '@md-runbook/ssh';
import { SECTION } from './config';
import {
  CellTarget,
  GroupPart,
  HostEntry,
  HostPlatform,
  RemotePlan,
  SshConfigHost,
  cellTarget,
  findHost,
  groupFooter,
  groupHeader,
  groupMembers,
  groupResult,
  hostGroups,
  hostLabel,
  hostProblems,
  hostSetting,
  parseSshConfig,
  pinKeyOf,
  practiceChoice,
  readHosts,
  remoteEnv,
} from './hostList';
import { runbookSignerFiles, signerOf } from './libraryTrust';
import { META_KEY } from './outputs';
import type { CellExecutor, CellPreparer, ExecuteIO, PrepareContext, RunPipeline } from './pipeline';
import { NOTEBOOK_TYPE, notebookTextWithOutputs } from './serializer';
import { CANT_CHECK_SIGNATURES, SignerCheck, signerCheckOf } from './signerCheck';

const PINS_KEY = 'mdRunbook.hosts.pins';
const PLATFORMS_KEY = 'mdRunbook.hosts.platforms';
const OWN_KEY = 'mdRunbook.hosts.key';
/** Servers allow about six login attempts: the agent's first keys, then md-runbook's own. */
const MAX_AGENT_KEYS = 5;

/** The SSH client, loaded on first use (not while VS Code starts the extension). */
let loaded: Promise<typeof import('@md-runbook/ssh') & typeof import('@md-runbook/ssh/node')> | undefined;
const ssh = (): NonNullable<typeof loaded> => (loaded ??= Promise.all([import('@md-runbook/ssh'), import('@md-runbook/ssh/node')]).then(([a, b]) => ({ ...a, ...b })));

/** `type base64` of a public key line, without the comment: what a pin compares (as packages/ssh hostKeyId). */
const hostKeyId = (line: string): string => line.trim().split(/\s+/).slice(0, 2).join(' ');

const cfg = (): vscode.WorkspaceConfiguration => vscode.workspace.getConfiguration(SECTION);

function infoOf(cell: vscode.NotebookCell): string {
  const meta: unknown = cell.metadata?.[META_KEY];
  return isCodeMeta(meta) ? meta.info : '';
}

/** The usable hosts of `mdRunbook.hosts` (user settings only: the setting is machine-scoped). */
export function configuredHosts(): HostEntry[] {
  return readHosts(cfg().get<unknown>('hosts', [])).hosts;
}

// The practice host per runbook: picked (Practice on a Host…), and the one in effect for the run.
const picked = new Map<string, string>();
const inEffect = new Map<string, string>();

/** The practice host in effect for a runbook's run, if any. */
export function practiceOf(nb: vscode.NotebookDocument): string | undefined {
  return picked.get(nb.uri.toString()) ?? inEffect.get(nb.uri.toString());
}

/** Where a cell runs: this machine, a host of the list, or nowhere (its host= isn't listed). */
export function targetOf(cell: vscode.NotebookCell): CellTarget {
  if (cell.kind !== vscode.NotebookCellKind.Code || isCallLanguage(cell.document.languageId)) return { kind: 'local' };
  const o = parseCellOptions(infoOf(cell));
  return cellTarget(configuredHosts(), o.host, practiceOf(cell.notebook));
}

/**
 * Whether a block with this info string is passed over (progress, estimates, values asked first):
 * its host= names no host of the list, and the runbook doesn't practise.
 */
export function hostSkipped(info: string, nb?: vscode.NotebookDocument): boolean {
  return hostOptionSkipped(parseCellOptions(info).host, nb);
}

/** The same, for a block's host= value (undefined: none). */
export function hostOptionSkipped(host: string | undefined, nb?: vscode.NotebookDocument): boolean {
  if (host === undefined) return false;
  if (nb && practiceOf(nb) !== undefined) return false;
  return findHost(configuredHosts(), host) === undefined;
}

/** SHA256:… of a public key line, as ssh-keygen -l prints it. */
export function fingerprintOf(line: string): string {
  const b64 = line.trim().split(/\s+/)[1] ?? '';
  return `SHA256:${crypto.createHash('sha256').update(Buffer.from(b64, 'base64')).digest('base64').replace(/=+$/, '')}`;
}

interface Connection {
  session: RemoteSession;
  signature: string;
  /** Set while connecting when the server's key is not the pinned one (or none is pinned). */
  unknownHostKey?: string;
  changed?: boolean;
}

export interface RemoteTargets {
  target(cell: vscode.NotebookCell): CellTarget;
  /** What the host runs, once known (learnt on the first connection). */
  platform(host: HostEntry): HostPlatform | undefined;
  /** The hosts, a pin or the practice host changed: cell status items redraw. */
  readonly onDidChange: vscode.Event<void>;
  /** Early (after the cell options): where the cell runs; a runbook's host= is asked about once. */
  readonly preparer: CellPreparer;
  /** Late (after secrets): a group run's checks and retry= move to each host. */
  readonly late: CellPreparer;
}

class RemoteHosts implements RemoteTargets, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly connections = new Map<string, Connection>();
  /** host= hosts agreed to per runbook (asked once per runbook and host, as the app does). */
  private readonly allowed = new Set<string>();
  /** Front matter practice: agreed to per runbook and name. */
  private readonly practiceAgreed = new Set<string>();
  /** Run on a Group…: the group the next run of a cell goes to. */
  private readonly pendingGroup = new Map<vscode.NotebookCell, string>();
  private readonly status = Object.assign(vscode.window.createStatusBarItem('mdRunbook.practice', vscode.StatusBarAlignment.Left, 99), { name: 'md-runbook practice' });

  readonly preparer: CellPreparer = { prepare: (plan, ctx) => this.prepare(plan, ctx) };
  readonly late: CellPreparer = {
    prepare: (plan) => {
      const r = plan.remote;
      if (plan.skip !== undefined || !r || r.by !== 'group') return;
      if (plan.checks) r.checks = plan.checks;
      if (plan.retry) r.retry = plan.retry;
      plan.checks = undefined;
      plan.retry = undefined;
    },
  };

  constructor(
    private readonly context: vscode.ExtensionContext,
    /** Under the extension test runner: a command's host or group argument is taken without asking. */
    private readonly testMode = false,
  ) {}

  /** Test hook askArguments: answers those questions as outside the test runner; `asked` lists them. */
  private answerHook: boolean | undefined;
  private readonly asked: string[] = [];

  /**
   * A host or group named by a command's argument (a keybinding, another extension): asked first,
   * except under the test runner. Only the menus' own picks need no question.
   */
  private async agreed(question: string, points: string[], button: string): Promise<boolean> {
    if (this.answerHook !== undefined) {
      this.asked.push(question);
      return this.answerHook;
    }
    if (this.testMode) return true;
    return (await vscode.window.showWarningMessage(question, { modal: true, detail: points.map((p) => `- ${p}`).join('\n') }, button)) === button;
  }

  target(cell: vscode.NotebookCell): CellTarget {
    return targetOf(cell);
  }

  platform(host: HostEntry): HostPlatform | undefined {
    return this.context.globalState.get<Record<string, HostPlatform>>(PLATFORMS_KEY, {})[pinKeyOf(host)];
  }

  private pin(host: HostEntry): string | undefined {
    return this.context.globalState.get<Record<string, string>>(PINS_KEY, {})[pinKeyOf(host)];
  }

  private async setPin(host: Pick<HostEntry, 'hostname' | 'port'>, key: string | undefined): Promise<void> {
    const pins = { ...this.context.globalState.get<Record<string, string>>(PINS_KEY, {}) };
    if (key === undefined) delete pins[pinKeyOf(host)];
    else pins[pinKeyOf(host)] = key;
    await this.context.globalState.update(PINS_KEY, pins);
    this.changed.fire();
  }

  private async setPlatform(host: HostEntry, platform: HostPlatform): Promise<void> {
    if (this.platform(host) === platform) return;
    await this.context.globalState.update(PLATFORMS_KEY, { ...this.context.globalState.get<Record<string, HostPlatform>>(PLATFORMS_KEY, {}), [pinKeyOf(host)]: platform });
    this.changed.fire();
  }

  // ---- keys ----

  /** md-runbook's own key, made on first use when `make` (its private half stays in SecretStorage). */
  private async ownKey(make: boolean): Promise<KeyPair | undefined> {
    const pem = await this.context.secrets.get(OWN_KEY);
    const { generateKey, importPrivateKey, privateKeyPem } = await ssh();
    if (pem) return importPrivateKey(pem);
    if (!make) return undefined;
    const key = await generateKey();
    await this.context.secrets.store(OWN_KEY, await privateKeyPem(key));
    return key;
  }

  /** The agent's keys (a few), then md-runbook's own if there is one. */
  private async keys(): Promise<KeyPair[]> {
    let fromAgent: KeyPair[] = [];
    try {
      const { agentKeys, agentPath } = await ssh();
      fromAgent = (await agentKeys(agentPath())).slice(0, MAX_AGENT_KEYS);
    } catch {
      // No agent running: md-runbook's own key, if there is one.
    }
    const own = await this.ownKey(false);
    return own ? [...fromAgent, own] : fromAgent;
  }

  // ---- connections ----

  private connectionKey(nb: vscode.NotebookDocument, host: HostEntry): string {
    return `${nb.uri.toString()}\n${pinKeyOf(host)}\n${host.user}`;
  }

  /** One session per runbook and host, kept between cells; replaced when the host, its pin or `shell:` changed. */
  private async connection(nb: vscode.NotebookDocument, host: HostEntry): Promise<Connection> {
    const shells: RunbookShells | undefined = frontMatterShells(nb);
    const pinned = this.pin(host);
    const signature = `${pinKeyOf(host)}:${host.user}:${pinned ?? ''}:${shells?.unix ?? ''}:${shells?.powershell ?? ''}`;
    const id = this.connectionKey(nb, host);
    const existing = this.connections.get(id);
    if (existing?.signature === signature) return existing;
    if (existing) void existing.session.close().catch(() => undefined);
    const keys = await this.keys();
    if (keys.length === 0) {
      throw new Error('No SSH key: add yours to the SSH agent (ssh-add), or use Hosts… → Copy md-runbook Public Key and add it to the host.');
    }
    const { RemoteSession, agentAlgorithms, connectTcp } = await ssh();
    const conn: Connection = {
      signature,
      session: new RemoteSession(() => connectTcp(host.hostname, host.port), {
        username: host.user,
        key: keys[0]!,
        moreKeys: keys.slice(1),
        configure: agentAlgorithms,
        ...(shells ? { shells } : {}),
        // Refused before any credential is sent: an unknown or changed key ends the connection here.
        verifyHostKey: (line) => {
          if (pinned !== undefined && hostKeyId(line) === pinned) return true;
          conn.unknownHostKey = line;
          conn.changed = pinned !== undefined;
          return false;
        },
      }),
    };
    this.connections.set(id, conn);
    return conn;
  }

  private drop(id: string): void {
    const c = this.connections.get(id);
    this.connections.delete(id);
    void c?.session.close().catch(() => undefined);
  }

  /** Close the sessions of a runbook, or of hosts no longer in the list, or all. */
  closeWhere(keep: (id: string) => boolean): void {
    for (const id of [...this.connections.keys()]) if (!keep(id)) this.drop(id);
  }

  /**
   * Connect, asking to trust an unknown host key when `ask` (a group run doesn't: those hosts are
   * skipped). Resolves undefined when connected; else why not, and whether the key was the problem.
   */
  private async connect(nb: vscode.NotebookDocument, host: HostEntry, ask: boolean): Promise<{ conn: Connection } | { error: string; untrusted?: boolean }> {
    for (let attempt = 0; attempt < 2; attempt++) {
      let conn: Connection;
      try {
        conn = await this.connection(nb, host);
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
      conn.unknownHostKey = undefined;
      try {
        await conn.session.connect();
        const platform = conn.session.platform;
        if (platform) await this.setPlatform(host, platform);
        return { conn };
      } catch (e) {
        // Set by verifyHostKey during connect() (TypeScript can't see that).
        const line = conn.unknownHostKey as string | undefined;
        this.drop(this.connectionKey(nb, host));
        if (line === undefined) {
          const why = e instanceof Error ? e.message : String(e);
          const hint = /authentication failed/.test(why) ? '. Is your key in the SSH agent (ssh-add -l), or md-runbook’s key in the host’s authorized_keys?' : '';
          return { error: `${host.name} (${hostLabel(host)}): ${why}${hint}` };
        }
        if (conn.changed) {
          return {
            error: [
              `The host key of ${host.name} (${hostLabel(host)}) changed: nothing was sent.`,
              `- Now: ${fingerprintOf(line)}`,
              '- Another machine may answer at this address.',
              '- If the server was reinstalled: Hosts… → Forget Host Key, then run again.',
            ].join('\n'),
          };
        }
        if (!ask || attempt > 0) return { error: `The host key of ${host.name} is not trusted yet: run a cell there first.`, untrusted: true };
        const trust = `Trust ${host.name}`;
        const answer = await vscode.window.showWarningMessage(
          `Trust the host key of ${host.name}?`,
          {
            modal: true,
            detail: [
              `- Account: ${hostLabel(host)}`,
              `- Key: ${line.trim().split(/\s+/)[0]}`,
              `- Fingerprint: ${fingerprintOf(line)}`,
              '- Compare it with the server’s: ssh-keygen -lf /etc/ssh/ssh_host_*_key.pub',
            ].join('\n'),
          },
          trust,
        );
        if (answer !== trust) return { error: `Not run: the host key of ${host.name} was not trusted.` };
        await this.setPin(host, hostKeyId(line));
      }
    }
    return { error: `Could not connect to ${host.name}.` };
  }

  // ---- preparing ----

  private async prepare(plan: import('./pipeline').CellPlan, ctx: PrepareContext): Promise<void> {
    if (plan.skip !== undefined || isCallLanguage(plan.language)) return;
    const { cell, notebook } = ctx;
    const info = infoOf(cell);
    const o = parseCellOptions(info);
    const optionsOn = cfg().get<boolean>('cellOptions.enabled', true);
    const base = (): Omit<RemotePlan, 'hosts' | 'by'> => ({
      envNames: [...new Set([...Object.keys(o.env ?? {}), ...safeRefNames(cell.document.getText())])],
      cellEnv: optionsOn ? { ...(o.env ?? {}) } : {},
      ...(o.cwd !== undefined && optionsOn ? { cwd: o.cwd } : {}),
    });
    const group = this.pendingGroup.get(cell);
    this.pendingGroup.delete(cell);
    if (group !== undefined) {
      const members = groupMembers(configuredHosts(), group);
      if (members.length === 0) throw new Error(`md-runbook: the group ${group} has no hosts`);
      plan.remote = { ...base(), hosts: members, by: 'group', group };
      return;
    }
    const t = this.target(cell);
    if (t.kind === 'local') return;
    if (t.kind === 'missing') {
      // host= with no such host is excluded before this (safety.ts); a practice host is checked at the start of the run.
      throw new Error(`md-runbook: no host named ${t.name}${t.by === 'practice' ? ' to practise on' : ''}: add it with Hosts…`);
    }
    if (t.by === 'host=') {
      const key = `${notebook.uri.toString()}\n${t.host.name.toLowerCase()}`;
      if (!this.allowed.has(key)) {
        const run = `Run on ${t.host.name}`;
        const answer = await vscode.window.showWarningMessage(
          `Run this runbook's host= cells on ${t.host.name}?`,
          { modal: true, detail: [`- Account: ${hostLabel(t.host)}`, `- The cell's host=${o.host} picks it from your hosts.`, '- Asked once per runbook and host.'].join('\n') },
          run,
        );
        if (answer !== run) {
          plan.skip = `not run on ${t.host.name}`;
          plan.skipExit = 'declined';
          plan.stopSequence = true;
          return;
        }
        this.allowed.add(key);
      }
    }
    plan.remote = { ...base(), hosts: [t.host], by: t.by };
  }

  // ---- running ----

  /** Wraps the notebook's executor: cells with a remote plan run on their host(s). */
  executor(fallback: (nb: vscode.NotebookDocument) => CellExecutor): (nb: vscode.NotebookDocument) => CellExecutor {
    return (nb) => ({
      execute: (plan, io, ctx) => {
        const r = plan.remote;
        if (!r) return fallback(nb).execute(plan, io, ctx);
        return r.by === 'group' ? this.runGroup(plan, r, io, ctx) : this.runOn(r.hosts[0]!, plan, r, io, ctx, true);
      },
    });
  }

  private async runOn(
    host: HostEntry,
    plan: import('./pipeline').CellPlan,
    r: RemotePlan,
    io: ExecuteIO,
    ctx: PrepareContext,
    ask: boolean,
  ): Promise<ExecuteResult & { untrusted?: boolean }> {
    const failed = (error: string, untrusted?: boolean): ExecuteResult & { untrusted?: boolean } => ({
      exitCode: null,
      signal: null,
      timedOut: false,
      cancelled: false,
      durationMs: 0,
      error,
      ...(untrusted ? { untrusted } : {}),
    });
    const kind = shellKindForLanguage(plan.language) ?? 'bash';
    const { wrongPlatform } = await ssh();
    const known = this.platform(host);
    const wrongBefore = known ? wrongPlatform(known, kind) : undefined;
    if (wrongBefore) return failed(`${host.name}: ${wrongBefore}`);
    const got = await this.connect(ctx.notebook, host, ask);
    if ('error' in got) return failed(got.error, got.untrusted);
    const session = got.conn.session;
    const wrong = session.platform ? wrongPlatform(session.platform, kind) : undefined;
    if (wrong) return failed(`${host.name}: ${wrong}`);
    const fm = frontMatterShells(ctx.notebook);
    const byAssistant = proposalOf(infoOf(ctx.cell)).by !== undefined;
    const opts: RemoteRunOptions = {
      shell: kind,
      // An approved proposal was checked as bash, or as zsh with `shell: zsh` (as in the app).
      ...(byAssistant && kind === 'bash' ? { checkedAs: fm?.unix === 'zsh' ? ('zsh' as const) : ('bash' as const) } : {}),
      env: remoteEnv(r.cellEnv, plan.refValues ?? {}, r.envNames),
      ...(r.cwd !== undefined ? { cwd: r.cwd } : {}),
      ...(plan.timeoutMs > 0 ? { timeoutMs: plan.timeoutMs } : {}),
      signal: io.signal,
      onStdout: io.onStdout,
      onStderr: io.onStderr,
      // A gate's Kubernetes pod starting: said apart from the output (the time limit waits for it).
      ...(io.onNotice ? { onNotice: io.onNotice } : {}),
    };
    try {
      const res = plan.probe === 'kube-context' ? await session.kubeContext(opts) : await session.run(plan.source, opts);
      if (res.newShell && plan.probe === undefined) io.onStderr(`[md-runbook] ${host.name}: this ran in a new shell (the last one ended): the folder and variables of earlier cells are gone\n`);
      if (res.shellEnded && res.exitCode !== null && res.error === undefined && !res.timedOut && !res.cancelled && plan.probe === undefined) {
        io.onStderr(`[md-runbook] ${host.name}: the shell ended (exit ${res.exitCode}); the next cell opens a new one\n`);
      }
      return { exitCode: res.exitCode, signal: res.signal, timedOut: res.timedOut, cancelled: res.cancelled, durationMs: res.durationMs, ...(res.error !== undefined ? { error: `${host.name}: ${res.error}` } : {}) };
    } catch (e) {
      return failed(`${host.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** The cell on each host of the group in turn: a section per host, checks judged per host. */
  private async runGroup(plan: import('./pipeline').CellPlan, r: RemotePlan, io: ExecuteIO, ctx: PrepareContext): Promise<ExecuteResult> {
    const started = Date.now();
    if (plan.probe === 'kube-context') {
      // Every host must be on the context: the first one that isn't answers for the group.
      const outs: { host: HostEntry; out: string; res: ExecuteResult }[] = [];
      for (const h of r.hosts) {
        if (!this.pin(h)) continue;
        let out = '';
        const res = await this.runOn(h, plan, r, { ...io, onStdout: (t) => (out += t) }, ctx, false);
        outs.push({ host: h, out, res });
      }
      const first = outs[0];
      if (!first) return { exitCode: 0, signal: null, timedOut: false, cancelled: false, durationMs: 0 };
      const odd = outs.find((o) => o.out.trim() !== first.out.trim() || o.res.exitCode !== 0);
      const pick = odd ?? first;
      io.onStdout(pick.out);
      return { ...pick.res, durationMs: Date.now() - started };
    }
    const parts: GroupPart[] = [];
    const attempts = r.retry?.attempts ?? 1;
    for (const h of r.hosts) {
      if (io.signal.aborted) break;
      io.onStdout(groupHeader(h));
      if (!this.pin(h)) {
        io.onStdout(`[md-runbook] skipped: the host key of ${h.name} is not trusted yet (run a cell there first)\n`);
        const part: GroupPart = { host: h, exit: 'skipped', text: '' };
        parts.push(part);
        io.onStdout(groupFooter(part));
        continue;
      }
      let part: GroupPart | undefined;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        let all = '';
        let stdout = '';
        const res = await this.runOn(
          h,
          plan,
          r,
          {
            signal: io.signal,
            onStdout: (t) => {
              all += t;
              stdout += t;
              io.onStdout(t);
            },
            onStderr: (t) => {
              all += t;
              io.onStderr(t);
            },
          },
          ctx,
          false,
        );
        if (res.error !== undefined) io.onStderr(res.error + '\n');
        if (res.timedOut) io.onStderr(`[md-runbook] ${h.name}: timed out\n`);
        const exit = res.timedOut ? 'timeout' : res.cancelled ? 'cancelled' : res.error !== undefined ? (res.untrusted ? 'skipped' : 'error') : String(res.exitCode ?? 'unknown');
        const outcome = r.checks && res.exitCode !== null && res.error === undefined && !res.timedOut && !res.cancelled ? evaluateChecks(r.checks, res.exitCode, all, stdout) : undefined;
        for (const f of outcome && !outcome.ok ? outcome.failures : []) io.onStderr(`[md-runbook] check failed: ${f}\n`);
        part = { host: h, exit, ...(outcome ? { check: outcome.ok ? ('ok' as const) : ('failed' as const) } : {}), text: '' };
        const passed = outcome ? outcome.ok : exit === '0';
        if (passed || attempt >= attempts || res.cancelled || io.signal.aborted || res.error !== undefined) break;
        io.onStderr(`[md-runbook] ${h.name}: attempt ${attempt}/${attempts} failed; trying again\n`);
        if (!(await sleep(r.retry?.everyMs ?? 0, io.signal))) break;
      }
      parts.push(part!);
      io.onStdout(groupFooter(part!));
    }
    const { exitCode, attrs } = groupResult(r.group ?? '', parts);
    Object.assign(plan.attrs, attrs, parts.some((p) => p.check) ? { check: parts.some((p) => p.check === 'failed') ? 'failed' : 'ok' } : {});
    const cancelled = io.signal.aborted;
    return { exitCode: cancelled ? null : exitCode, signal: null, timedOut: false, cancelled, durationMs: Date.now() - started };
  }

  // ---- before a run: the practice host ----

  async willRun(nb: vscode.NotebookDocument): Promise<void | { cancel: string }> {
    const key = nb.uri.toString();
    inEffect.delete(key);
    const fm = frontMatterOf(nb)?.practice;
    const signed = fm !== undefined && !picked.has(key) ? await this.signedOk(nb) : { ok: false };
    const choice = practiceChoice(configuredHosts(), picked.get(key), fm, signed.ok, fm !== undefined && this.practiceAgreed.has(`${key}\n${fm.toLowerCase()}`));
    this.refreshStatus();
    if (choice.kind === 'none') return undefined;
    if (choice.kind === 'missing') {
      const open = 'Hosts…';
      void vscode.window.showErrorMessage(`md-runbook: no host named ${choice.name} to practise on (practice:). Add it with Hosts….`, open).then((a) => {
        if (a === open) void vscode.commands.executeCommand('mdRunbook.hosts');
      });
      return { cancel: `md-runbook: not run: no practice host ${choice.name}` };
    }
    if (choice.ask) {
      const go = `Practice on ${choice.host.name}`;
      const answer = await vscode.window.showWarningMessage(
        `Practice on ${choice.host.name}?`,
        {
          modal: true,
          detail: [
            `- The front matter says practice: ${fm}.`,
            `- Every cell then runs on ${hostLabel(choice.host)}, whatever host= says.`,
            signed.cantCheck ? `- Asked because md-runbook ${CANT_CHECK_SIGNATURES}.` : '- Asked because the runbook is not signed by a signer you trust.',
          ].join('\n'),
        },
        go,
      );
      if (answer !== go) return { cancel: 'md-runbook: not run (practice host not agreed)' };
      this.practiceAgreed.add(`${key}\n${fm!.toLowerCase()}`);
    }
    inEffect.set(key, choice.host.name);
    this.refreshStatus();
    this.changed.fire();
    return undefined;
  }

  /**
   * The whole runbook is signed by a trusted signer, unchanged, not expired: one of
   * mdRunbook.signing.allowedSigners, or, for your copy of a library runbook, one trusted from that
   * library (src/libraryTrust.ts), as run reports check it.
   */
  private async signedOk(nb: vscode.NotebookDocument): Promise<{ ok: boolean; cantCheck?: true }> {
    const own = cfg().get<string>('signing.allowedSigners', '').trim().replace(/^~(?=$|[\\/])/, os.homedir());
    const files = runbookSignerFiles(own, this.context.globalStorageUri.fsPath, nb.uri.scheme === 'file' ? nb.uri.fsPath : undefined);
    if (files.length === 0) return { ok: false };
    const text = notebookTextWithOutputs(nb);
    if (!/md-runbook:signature v1/.test(text)) return { ok: false };
    const got = await signerOf(text, files, (t, f) => signerCheckOf(t, f).catch(() => ({}) as SignerCheck));
    return { ok: reportTrustProblem(text, got.signer) === undefined, ...(got.cantCheck ? { cantCheck: true } : {}) };
  }

  notify(): void {
    this.changed.fire();
  }

  refreshStatus(): void {
    const nb = vscode.window.activeNotebookEditor?.notebook;
    if (!nb || nb.notebookType !== NOTEBOOK_TYPE) return void this.status.hide();
    const key = nb.uri.toString();
    const name = picked.get(key) ?? inEffect.get(key) ?? frontMatterOf(nb)?.practice;
    if (name === undefined) return void this.status.hide();
    const host = findHost(configuredHosts(), name);
    const pending = !picked.has(key) && !inEffect.has(key);
    this.status.text = host ? `$(beaker) Practice on ${host.name}` : `$(warning) Practice host ${name} missing`;
    this.status.tooltip = host
      ? `Every cell runs on ${hostLabel(host)}, whatever host= says.${pending ? '\nFrom the front matter (practice:): asked at the next run.' : ''}\nClick to change or stop.`
      : `The front matter names ${name}, which is not in your hosts: nothing runs. Add it with Hosts….`;
    this.status.command = host ? 'mdRunbook.practiceOnHost' : 'mdRunbook.hosts';
    this.status.show();
  }

  // ---- commands ----

  /** Practice on a Host…: pick the host every cell of this runbook runs on, or stop practising. */
  async practiceCommand(arg?: unknown): Promise<void> {
    const nb = vscode.window.activeNotebookEditor?.notebook;
    if (!nb || nb.notebookType !== NOTEBOOK_TYPE) return void vscode.window.showInformationMessage('md-runbook: open a runbook first.');
    const key = nb.uri.toString();
    const hosts = configuredHosts();
    if (typeof arg === 'string') {
      // Tests and keybindings: a host's name (asked first), or '' to stop.
      const host = arg === '' ? undefined : findHost(hosts, arg);
      if (arg !== '' && !host) return void vscode.window.showErrorMessage(`md-runbook: no host named ${arg}.`);
      if (host) {
        const go = `Practice on ${host.name}`;
        if (!(await this.agreed(`Practice this runbook on ${host.name}?`, [`Account: ${hostLabel(host)}`, 'Every cell runs there, whatever host= says.'], go))) return;
        picked.set(key, host.name);
      } else picked.delete(key);
      this.refreshStatus();
      return void this.changed.fire();
    }
    if (hosts.length === 0) return this.noHosts();
    type Item = vscode.QuickPickItem & { host?: HostEntry; stop?: boolean };
    const current = practiceOf(nb);
    const items: Item[] = [
      ...hosts.map((h) => ({ label: h.name, description: hostLabel(h), ...(current?.toLowerCase() === h.name.toLowerCase() ? { detail: '$(check) practising here now' } : {}), host: h })),
      ...(current !== undefined ? [{ label: '$(debug-stop) Stop Practice', description: 'cells run on this machine or their host= again', stop: true }] : []),
    ];
    const pick = await vscode.window.showQuickPick(items, { title: 'Practice on a Host', placeHolder: 'Every cell of this runbook runs there, whatever host= says' });
    if (!pick) return;
    if (pick.stop) {
      picked.delete(key);
      inEffect.delete(key);
    } else picked.set(key, pick.host!.name);
    this.refreshStatus();
    this.changed.fire();
  }

  /** Run on a Group…: the cell on each host of a group. */
  async groupCommand(run: (cell: vscode.NotebookCell) => Promise<void>, arg?: unknown, groupArg?: unknown): Promise<void> {
    const cell = cellArg(arg);
    if (!cell) return void vscode.window.showInformationMessage('md-runbook: select a code cell first.');
    if (practiceOf(cell.notebook) !== undefined) return void vscode.window.showInformationMessage('md-runbook: in practice, every cell runs on the practice host.');
    const hosts = configuredHosts();
    const groups = hostGroups(hosts);
    if (groups.length === 0) {
      const open = 'Hosts…';
      const a = await vscode.window.showInformationMessage('md-runbook: no host groups yet. Give hosts a group in Hosts….', open);
      if (a === open) await this.hostsCommand();
      return;
    }
    let group = typeof groupArg === 'string' ? groups.find((g) => g === groupArg) : undefined;
    if (group !== undefined) {
      // Named by the command's argument, not picked: asked first.
      const members = groupMembers(hosts, group);
      const go = `Run on ${group}`;
      if (!(await this.agreed(`Run this cell on each host of ${group}?`, [`Hosts: ${members.map((h) => h.name).join(', ')}`, 'One after another, now.'], go))) return;
    } else {
      const pick = await vscode.window.showQuickPick(
        groups.map((g) => {
          const members = groupMembers(hosts, g);
          const untrusted = members.filter((h) => !this.pin(h)).length;
          return { label: g, description: members.map((h) => h.name).join(', '), ...(untrusted > 0 ? { detail: `${untrusted} not trusted yet: skipped` } : {}) };
        }),
        { title: 'Run on a Group', placeHolder: 'The cell runs on each host of the group in turn' },
      );
      group = pick?.label;
    }
    if (group === undefined) return;
    this.pendingGroup.set(cell, group);
    try {
      await run(cell);
    } finally {
      this.pendingGroup.delete(cell);
    }
  }

  private async noHosts(): Promise<void> {
    const add = 'Add Host…';
    if ((await vscode.window.showInformationMessage('md-runbook: no hosts yet.', add)) === add) await this.editHost(undefined);
  }

  /** Hosts…: add, edit, remove; forget a host key; md-runbook's public key. */
  async hostsCommand(): Promise<void> {
    type Item = vscode.QuickPickItem & { action: () => Promise<void> };
    const hosts = configuredHosts();
    const { problems } = readHosts(cfg().get<unknown>('hosts', []));
    const items: Item[] = [
      ...hosts.map((h) => ({
        label: `$(server) ${h.name}`,
        description: `${hostLabel(h)}${h.group ? ` · ${h.group}` : ''}`,
        detail: this.pin(h) ? `Host key trusted · ${this.platform(h) === 'windows' ? 'Windows' : this.platform(h) === 'posix' ? 'Linux/macOS' : 'not connected yet'}` : 'Host key not trusted yet',
        action: () => this.hostMenu(h),
      })),
      { label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => undefined },
      { label: '$(add) Add Host…', action: () => this.editHost(undefined) },
      { label: '$(file-text) Add from ~/.ssh/config…', action: () => this.addFromSshConfig() },
      { label: '$(key) Copy md-runbook Public Key', description: 'for the hosts’ authorized_keys', action: () => this.copyPublicKey() },
      { label: '$(gear) Open Settings', description: 'mdRunbook.hosts', action: async () => void vscode.commands.executeCommand('workbench.action.openSettings', `${SECTION}.hosts`) },
    ];
    const pick = await vscode.window.showQuickPick(items, {
      title: 'Hosts',
      placeHolder: problems.length > 0 ? `${problems.length} host(s) in the settings can't be used: ${problems[0]}` : 'Cells with host=, Run on a Group and Practice run on these over SSH',
    });
    await pick?.action();
  }

  private async hostMenu(h: HostEntry): Promise<void> {
    type Item = vscode.QuickPickItem & { action: () => Promise<void> };
    const items: Item[] = [
      { label: '$(edit) Edit…', action: () => this.editHost(h) },
      ...(this.pin(h) ? [{ label: '$(unlock) Forget Host Key', description: 'asked again on the next run', action: () => this.forget(h) }] : []),
      { label: '$(trash) Remove', action: () => this.removeHost(h) },
    ];
    const pick = await vscode.window.showQuickPick(items, { title: `${h.name} (${hostLabel(h)})` });
    await pick?.action();
  }

  private async forget(h: HostEntry): Promise<void> {
    await this.setPin(h, undefined);
    this.closeWhere((id) => !id.includes(`\n${pinKeyOf(h)}\n`));
    vscode.window.setStatusBarMessage(`md-runbook: the host key of ${h.name} is forgotten`, 5000);
  }

  private async removeHost(h: HostEntry): Promise<void> {
    const remove = 'Remove';
    if ((await vscode.window.showWarningMessage(`Remove ${h.name}?`, { modal: true, detail: `- ${hostLabel(h)}\n- Its host= cells are passed over again.` }, remove)) !== remove) return;
    await this.save(configuredHosts().filter((x) => x.name.toLowerCase() !== h.name.toLowerCase()));
  }

  private async save(hosts: readonly HostEntry[]): Promise<void> {
    await cfg().update('hosts', hosts.map(hostSetting), vscode.ConfigurationTarget.Global);
  }

  /** Add (old undefined) or edit a host, one field at a time. */
  private async editHost(old: HostEntry | undefined, from?: SshConfigHost): Promise<void> {
    const hosts = configuredHosts();
    const others = hosts.filter((x) => x !== old && x.name.toLowerCase() !== old?.name.toLowerCase()).map((x) => x.name);
    const title = old ? `Edit ${old.name}` : 'Add Host';
    const ask = (prompt: string, value: string, field: 'name' | 'hostname' | 'user' | 'port' | 'group', placeHolder?: string): Thenable<string | undefined> =>
      vscode.window.showInputBox({
        title,
        prompt,
        value,
        ...(placeHolder ? { placeHolder } : {}),
        ignoreFocusOut: true,
        validateInput: (v) => {
          const probe = { name: 'n', hostname: 'h', user: 'u', port: 22, [field]: field === 'port' ? (v.trim() === '' ? 22 : Number(v)) : field === 'group' ? v : v };
          return hostProblems(probe, field === 'name' ? others : []).find((p) => p.startsWith(`${field}:`));
        },
      });
    const name = await ask('Name (what host= and practice: use)', old?.name ?? from?.alias ?? '', 'name', 'web-1');
    if (name === undefined) return;
    const hostname = await ask('Hostname or address', old?.hostname ?? from?.hostname ?? '', 'hostname', 'web-1.example.net');
    if (hostname === undefined) return;
    const user = await ask('User', old?.user ?? from?.user ?? os.userInfo().username, 'user');
    if (user === undefined) return;
    const port = await ask('Port', String(old?.port ?? from?.port ?? 22), 'port');
    if (port === undefined) return;
    const group = await ask('Group (optional: for Run on a Group)', old?.group ?? '', 'group', 'e.g. eu-web');
    if (group === undefined) return;
    const entry: HostEntry = { name: name.trim(), hostname: hostname.trim(), user: user.trim(), port: port.trim() === '' ? 22 : Number(port), ...(group.trim() ? { group: group.trim() } : {}) };
    const bad = hostProblems(entry, others);
    if (bad.length > 0) return void vscode.window.showErrorMessage(`md-runbook: not saved: ${bad.join('; ')}`);
    await this.save(old ? hosts.map((x) => (x.name.toLowerCase() === old.name.toLowerCase() ? entry : x)) : [...hosts, entry]);
    vscode.window.setStatusBarMessage(`md-runbook: ${entry.name} saved`, 5000);
  }

  private async addFromSshConfig(): Promise<void> {
    const file = path.join(os.homedir(), '.ssh', 'config');
    let text = '';
    try {
      text = await fs.promises.readFile(file, 'utf8');
    } catch {
      return void vscode.window.showInformationMessage(`md-runbook: no ${file}.`);
    }
    const listed = new Set(configuredHosts().map((h) => h.name.toLowerCase()));
    const candidates = parseSshConfig(text).filter((c) => !listed.has(c.alias.toLowerCase()));
    if (candidates.length === 0) return void vscode.window.showInformationMessage('md-runbook: no Host entries to add from ~/.ssh/config (patterns are left out).');
    const pick = await vscode.window.showQuickPick(
      candidates.map((c) => ({ label: c.alias, description: `${c.user ? `${c.user}@` : ''}${c.hostname}${c.port === 22 ? '' : `:${c.port}`}`, c })),
      { title: 'Add from ~/.ssh/config', placeHolder: 'Only the address and user are taken; keys come from your SSH agent' },
    );
    if (pick) await this.editHost(undefined, pick.c);
  }

  private async copyPublicKey(): Promise<void> {
    const line = await (await ssh()).publicKeyLine((await this.ownKey(true))!, `md-runbook-vscode@${os.hostname()}`);
    await vscode.env.clipboard.writeText(line);
    void vscode.window.showInformationMessage('md-runbook: public key copied. Add it to ~/.ssh/authorized_keys on each host.', { modal: false });
  }

  /** Tests only: pin a host key, allow a host for a runbook, md-runbook's public key line. */
  async testHook(op: unknown, a?: unknown, b?: unknown): Promise<unknown> {
    if (op === 'pin' && typeof a === 'string' && typeof b === 'string') {
      const [hostname = '', port = '22'] = a.split(':');
      await this.setPin({ hostname, port: Number(port) }, hostKeyId(b));
      return true;
    }
    if (op === 'allow' && typeof a === 'string' && typeof b === 'string') return void this.allowed.add(`${a}\n${b.toLowerCase()}`);
    if (op === 'publicKey') return (await ssh()).publicKeyLine((await this.ownKey(true))!, 'md-runbook-test');
    if (op === 'agreePractice' && typeof a === 'string' && typeof b === 'string') return void this.practiceAgreed.add(`${a}\n${b.toLowerCase()}`);
    if (op === 'askArguments') {
      this.answerHook = typeof a === 'boolean' ? a : undefined;
      return void (this.asked.length = 0);
    }
    if (op === 'asked') return [...this.asked];
    if (op === 'practice') {
      const nb = vscode.window.activeNotebookEditor?.notebook;
      return nb ? practiceOf(nb) : undefined;
    }
    return undefined;
  }

  dispose(): void {
    this.closeWhere(() => false);
    this.status.dispose();
    this.changed.dispose();
  }
}

/** The names of a cell's placeholders (none when the text is malformed: the run reports it). */
function safeRefNames(source: string): string[] {
  try {
    return findRefs(source).map((r) => r.name);
  } catch {
    return [];
  }
}

function frontMatterOf(nb: vscode.NotebookDocument): ReturnType<typeof parseFrontMatter> {
  const first = nb.cellCount > 0 ? nb.cellAt(0) : undefined;
  return first?.kind === vscode.NotebookCellKind.Markup ? parseFrontMatter(first.document.getText()) : undefined;
}

const frontMatterShells = (nb: vscode.NotebookDocument): RunbookShells | undefined => frontMatterOf(nb)?.shell;

/** A cell from a cell menu's argument, else the selected code cell of the active runbook. */
function cellArg(arg: unknown): vscode.NotebookCell | undefined {
  const isCell = (c: unknown): c is vscode.NotebookCell => typeof c === 'object' && c !== null && 'notebook' in c && 'document' in c && 'index' in c;
  if (isCell(arg)) return arg.kind === vscode.NotebookCellKind.Code ? arg : undefined;
  const editor = vscode.window.activeNotebookEditor;
  if (!editor || editor.notebook.notebookType !== NOTEBOOK_TYPE) return undefined;
  if (typeof arg === 'number') return editor.notebook.cellAt(arg);
  const i = editor.selections[0]?.start;
  const c = i !== undefined && i < editor.notebook.cellCount ? editor.notebook.cellAt(i) : undefined;
  return c?.kind === vscode.NotebookCellKind.Code ? c : undefined;
}

const sleep = (ms: number, signal: AbortSignal): Promise<boolean> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve(false);
    const timer = setTimeout(() => resolve(true), ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve(false);
      },
      { once: true },
    );
  });

export interface RemoteHostsInfo extends RemoteTargets {
  /** Wrap the pipeline's executor (after session and terminal mode set theirs). */
  wrapExecutor(pipeline: RunPipeline): void;
  /** The commands that run cells, once the controller exists. */
  attach(run: (cell: vscode.NotebookCell) => Promise<void>): void;
}

export function registerRemoteHosts(context: vscode.ExtensionContext, pipeline: RunPipeline, testMode: boolean): RemoteHostsInfo {
  const f = new RemoteHosts(context, testMode);
  let runCell: ((cell: vscode.NotebookCell) => Promise<void>) | undefined;
  pipeline.observers.push({ onWillRunSequence: (nb) => f.willRun(nb) });
  context.subscriptions.push(
    f,
    vscode.commands.registerCommand('mdRunbook.hosts', () => f.hostsCommand()),
    vscode.commands.registerCommand('mdRunbook.practiceOnHost', (arg?: unknown) => f.practiceCommand(arg)),
    vscode.commands.registerCommand('mdRunbook.runOnGroup', (arg?: unknown, group?: unknown) => (runCell ? f.groupCommand(runCell, arg, group) : undefined)),
    vscode.window.onDidChangeActiveNotebookEditor(() => f.refreshStatus()),
    vscode.workspace.onDidCloseNotebookDocument((nb) => {
      const key = nb.uri.toString();
      picked.delete(key);
      inEffect.delete(key);
      f.closeWhere((id) => !id.startsWith(`${key}\n`));
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration(`${SECTION}.hosts`)) return;
      // A host removed or moved: its sessions close (an edited one reconnects on its next cell).
      const now = new Set(configuredHosts().map((h) => `\n${pinKeyOf(h)}\n${h.user}`));
      f.closeWhere((id) => [...now].some((k) => id.endsWith(k)));
      f.refreshStatus();
      f.notify();
    }),
  );
  if (testMode) context.subscriptions.push(vscode.commands.registerCommand('mdRunbook._hostsTest', (op: unknown, a?: unknown, b?: unknown) => f.testHook(op, a, b)));
  f.refreshStatus();
  return {
    target: (cell) => f.target(cell),
    platform: (h) => f.platform(h),
    onDidChange: f.onDidChange,
    preparer: f.preparer,
    late: f.late,
    wrapExecutor: (p) => {
      p.executorFor = f.executor(p.executorFor);
    },
    attach: (run) => {
      runCell = run;
    },
  };
}
