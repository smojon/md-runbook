/**
 * Remote hosts in VS Code, the parts without vscode (unit-tested): the `mdRunbook.hosts` list and
 * its checks, `~/.ssh/config` entries offered as candidates, groups, where a cell runs (its
 * `host=`, or the practice host), and a group run's output. As the app has them (apps/mobile
 * src/hosts/store.ts, RunbookView.tsx): names compare case-insensitively.
 */

import type { CellChecks } from '@md-runbook/core/checks';
import type { OsName } from '@md-runbook/core/os';

export interface HostEntry {
  name: string;
  hostname: string;
  port: number;
  user: string;
  /** A customer, a site, a team: Run on a Group runs a cell on each host of one. */
  group?: string;
}

/** What the server runs, learnt on the first connection (as in the app). */
export type HostPlatform = 'posix' | 'windows';

const NAME_MAX = 64;

/** Problems with one host, one line each; [] when it can be saved. `others`: the other hosts' names. */
export function hostProblems(h: { name?: unknown; hostname?: unknown; port?: unknown; user?: unknown; group?: unknown }, others: readonly string[] = []): string[] {
  const p: string[] = [];
  const name = typeof h.name === 'string' ? h.name.trim() : '';
  if (name === '') p.push('name: missing');
  else if (name.length > NAME_MAX || /[\r\n\t]/.test(name)) p.push(`name: at most ${NAME_MAX} characters, on one line`);
  else if (others.some((o) => o.toLowerCase() === name.toLowerCase())) p.push(`name: ${name} is taken`);
  const hostname = typeof h.hostname === 'string' ? h.hostname.trim() : '';
  if (hostname === '') p.push('hostname: missing');
  // Never something an ssh command line could read as an option, nor two words.
  else if (hostname.startsWith('-') || /\s/.test(hostname) || hostname.length > 253) p.push('hostname: one word, not starting with -');
  const port = h.port === undefined ? 22 : h.port;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) p.push('port: 1 to 65535');
  const user = typeof h.user === 'string' ? h.user.trim() : '';
  if (user === '') p.push('user: missing');
  else if (user.startsWith('-') || /\s/.test(user) || user.length > 64) p.push('user: one word, not starting with -');
  if (h.group !== undefined && (typeof h.group !== 'string' || /[\r\n\t]/.test(h.group) || h.group.length > NAME_MAX)) p.push('group: one line of text');
  return p;
}

/** The setting's hosts that can be used, and why the others can't (they are left out). */
export function readHosts(raw: unknown): { hosts: HostEntry[]; problems: string[] } {
  const hosts: HostEntry[] = [];
  const problems: string[] = [];
  if (!Array.isArray(raw)) return { hosts, problems: raw === undefined || raw === null ? [] : ['mdRunbook.hosts: expected a list'] };
  raw.forEach((item: unknown, i) => {
    if (typeof item !== 'object' || item === null) return void problems.push(`host ${i + 1}: expected { name, hostname, user }`);
    const h = item as Record<string, unknown>;
    const bad = hostProblems(h, hosts.map((x) => x.name));
    if (bad.length > 0) return void problems.push(`host ${i + 1}${typeof h.name === 'string' && h.name.trim() ? ` (${h.name.trim()})` : ''}: ${bad.join('; ')}`);
    const group = typeof h.group === 'string' ? h.group.trim() : '';
    hosts.push({
      name: (h.name as string).trim(),
      hostname: (h.hostname as string).trim(),
      port: (h.port as number | undefined) ?? 22,
      user: (h.user as string).trim(),
      ...(group ? { group } : {}),
    });
  });
  return { hosts, problems };
}

/** As the setting stores it (port 22 and an empty group left out). */
export function hostSetting(h: HostEntry): Record<string, string | number> {
  return { name: h.name, hostname: h.hostname, ...(h.port !== 22 ? { port: h.port } : {}), user: h.user, ...(h.group ? { group: h.group } : {}) };
}

export function findHost(hosts: readonly HostEntry[], name: string | undefined): HostEntry | undefined {
  if (name === undefined) return undefined;
  const n = name.trim().toLowerCase();
  return hosts.find((h) => h.name.toLowerCase() === n);
}

/** `user@host`, `user@host:port` when the port is not 22. */
export const hostLabel = (h: HostEntry): string => `${h.user}@${h.hostname}${h.port === 22 ? '' : `:${h.port}`}`;

/** The account a cell runs as, the way questions name it: `user@NAME`. */
export const accountLabel = (h: HostEntry): string => `${h.user}@${h.name}`;

/** Where a host key is pinned: the server's address (another address may be another server). */
export const pinKeyOf = (h: Pick<HostEntry, 'hostname' | 'port'>): string => `${h.hostname.toLowerCase()}:${h.port}`;

/** The groups of the list, sorted. */
export function hostGroups(hosts: readonly HostEntry[]): string[] {
  return [...new Set(hosts.flatMap((h) => (h.group ? [h.group] : [])))].sort((a, b) => a.localeCompare(b));
}

/** The hosts of a group, in list order (groups compare as written, as in the app). */
export function groupMembers(hosts: readonly HostEntry[], group: string): HostEntry[] {
  return hosts.filter((h) => h.group === group);
}

/** One host of `~/.ssh/config`, as a candidate to add. */
export interface SshConfigHost {
  alias: string;
  hostname: string;
  port: number;
  user?: string;
}

/**
 * The literal `Host` entries of an OpenSSH client config: patterns (`*`, `?`, `!`) are left out,
 * as are `Match` blocks; `Include` is not followed. Options before any `Host` line apply to all,
 * and the first value of an option wins, as for ssh.
 */
export function parseSshConfig(text: string): SshConfigHost[] {
  type Block = { aliases: string[]; opts: Map<string, string> };
  const global: Block = { aliases: [], opts: new Map() };
  const blocks: Block[] = [];
  let current: Block | undefined = global;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const m = /^(\S+?)\s*(?:=\s*|\s+)(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = m[2]!.replace(/\s+#.*$/, '').trim();
    if (key === 'host') {
      const words = value.split(/\s+/).map((w) => w.replace(/^"|"$/g, ''));
      current = { aliases: words.filter((w) => w !== '' && !/[*?!]/.test(w)), opts: new Map() };
      blocks.push(current);
    } else if (key === 'match') {
      current = undefined;
    } else if (current && !current.opts.has(key)) current.opts.set(key, value.replace(/^"|"$/g, ''));
  }
  const out: SshConfigHost[] = [];
  const seen = new Set<string>();
  for (const b of blocks) {
    const opt = (k: string): string | undefined => b.opts.get(k) ?? global.opts.get(k);
    for (const alias of b.aliases) {
      if (seen.has(alias.toLowerCase())) continue;
      seen.add(alias.toLowerCase());
      // %h is the alias itself; other tokens can't be expanded here.
      const hostname = (opt('hostname') ?? alias).replace(/%h/g, alias);
      const port = Number(opt('port') ?? '22');
      const user = opt('user');
      if (/%/.test(hostname) || hostProblems({ name: alias, hostname, port, user: user ?? 'x' }).length > 0) continue;
      out.push({ alias, hostname, port, ...(user && !/%/.test(user) ? { user } : {}) });
    }
  }
  return out;
}

/** Where a cell runs: on this machine, on a listed host, or nowhere (its host= isn't listed). */
export type CellTarget = { kind: 'local' } | { kind: 'host'; host: HostEntry; by: 'host=' | 'practice' } | { kind: 'missing'; name: string; by: 'host=' | 'practice' };

/**
 * A cell's target: the practice host when the runbook practises (whatever host= says, so a drill
 * can't reach production), else its host= (when listed), else this machine.
 */
export function cellTarget(hosts: readonly HostEntry[], hostOption: string | undefined, practice: string | undefined): CellTarget {
  if (practice !== undefined) {
    const p = findHost(hosts, practice);
    return p ? { kind: 'host', host: p, by: 'practice' } : { kind: 'missing', name: practice, by: 'practice' };
  }
  if (hostOption === undefined) return { kind: 'local' };
  const h = findHost(hosts, hostOption);
  return h ? { kind: 'host', host: h, by: 'host=' } : { kind: 'missing', name: hostOption, by: 'host=' };
}

/**
 * The practice host of a run: the one picked (Practice on a Host…), else the front matter's
 * `practice:`. That one is used without asking only when the whole runbook is signed by a
 * trusted signer and unchanged (`signedOk`): else a runbook could send every cell to a host of
 * its choosing. `missing`: the name is not in the list (the run stops, as in the app).
 */
export type PracticeChoice =
  | { kind: 'none' }
  | { kind: 'host'; host: HostEntry; from: 'picked' | 'front matter'; ask: boolean }
  | { kind: 'missing'; name: string };

export function practiceChoice(hosts: readonly HostEntry[], picked: string | undefined, frontMatter: string | undefined, signedOk: boolean, agreed: boolean): PracticeChoice {
  const name = picked ?? frontMatter;
  if (name === undefined) return { kind: 'none' };
  const h = findHost(hosts, name);
  if (!h) return { kind: 'missing', name };
  if (picked !== undefined) return { kind: 'host', host: h, from: 'picked', ask: false };
  return { kind: 'host', host: h, from: 'front matter', ask: !signedOk && !agreed };
}

/** Whether a block's `os=` lets it run on a server of this platform (unknown: the cell's shell decides, as in the app). */
export function osAllows(os: readonly OsName[] | undefined, platform: HostPlatform): boolean {
  if (!os) return true;
  return platform === 'windows' ? os.includes('windows') : os.some((o) => o !== 'windows');
}

/** One host's part of a group run. */
export interface GroupPart {
  host: HostEntry;
  /** exit= of its run: 0, a code, skipped, error, timeout, cancelled. */
  exit: string;
  check?: 'ok' | 'failed';
  text: string;
}

const partOk = (p: GroupPart): boolean => p.exit === '0' && p.check !== 'failed';

/** A host's section of a group run's output starts with this line. */
export const groupHeader = (h: HostEntry): string => `── ${h.name} (${hostLabel(h)}) ──\n`;

/** And ends with this one: how it ended there. */
export function groupFooter(p: GroupPart): string {
  const how = p.check === 'failed' ? 'check failed' : p.exit === '0' ? 'exit 0' : p.exit === 'skipped' ? 'skipped' : p.exit === 'error' ? 'not run' : /^\d+$/.test(p.exit) ? `exit ${p.exit}` : p.exit;
  return `── ${p.host.name}: ${how} ──\n`;
}

/**
 * The group run's result: exit 0 when every host passed, else the first failure's code (1 for a
 * check that failed, and for a host that was skipped or could not run); its marker attributes.
 */
export function groupResult(group: string, parts: readonly GroupPart[]): { exitCode: number; attrs: Record<string, string> } {
  const failed = parts.filter((p) => !partOk(p));
  const first = failed[0];
  const code = first === undefined ? 0 : /^\d+$/.test(first.exit) && first.exit !== '0' ? Number(first.exit) : 1;
  return {
    exitCode: code,
    attrs: {
      group,
      hosts: parts.map((p) => p.host.name).join(','),
      ...(failed.length > 0 ? { failed: failed.map((p) => p.host.name).join(',') } : {}),
    },
  };
}

/**
 * Environment variables a remote cell gets: its own env= values as written and the values of its
 * placeholders (they win, as on this machine), nothing of this machine's. Never built from the
 * plan's env: later preparers put injected secrets and .env values there under the same names.
 */
export function remoteEnv(
  cellEnv: Readonly<Record<string, string>>,
  refValues: Readonly<Record<string, string>>,
  names: Iterable<string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of names) {
    const v = Object.prototype.hasOwnProperty.call(refValues, n) ? refValues[n] : Object.prototype.hasOwnProperty.call(cellEnv, n) ? cellEnv[n] : undefined;
    if (v !== undefined) out[n] = v;
  }
  return out;
}

/** Set on a cell's plan when it runs on a host (or on a group of hosts) instead of this machine. */
export interface RemotePlan {
  hosts: HostEntry[];
  /** Why there: the cell's host=, the practice host, or Run on a Group. */
  by: 'host=' | 'practice' | 'group';
  group?: string;
  /** The environment variables sent: the cell's env= and its placeholders' names. */
  envNames: string[];
  /** The cell's env= values as written (none when cell options are off): what is sent for them. */
  cellEnv: Record<string, string>;
  /** The cell's cwd= as written (a folder on the host), not this machine's folder. */
  cwd?: string;
  /** A group run: its checks and retry=, judged on each host (moved off the plan). */
  checks?: CellChecks;
  retry?: { attempts: number; everyMs: number };
}

/** How the status line and on= name where a run went. */
export function remoteLabel(r: Pick<RemotePlan, 'hosts' | 'group'>): string {
  return r.group !== undefined ? `group ${r.group}` : r.hosts.map((h) => h.name).join(', ');
}
