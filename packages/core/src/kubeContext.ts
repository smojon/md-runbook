/**
 * The wrong-cluster guard: a runbook (`kube-context: prod-eu` in its front matter) or a cell
 * (`kube-context=prod-eu`) names the Kubernetes context it is written for, and a cell runs only
 * while `kubectl config current-context` says that context. The check runs where the cell runs
 * (its session shell, or the SSH host), before each cell, so a `kubectl config use-context` in an
 * earlier cell is caught too.
 */

/** Prints the current context's name (exit 1 when none is set). */
export const KUBE_CONTEXT_COMMAND = 'kubectl config current-context';

/** A context name as kubectl allows it: no spaces or quotes. */
const CONTEXT_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]*$/;

/** Whether `name` can be a context name (lint and the parsers refuse others). */
export function isKubeContextName(name: string): boolean {
  return name.length <= 253 && CONTEXT_RE.test(name);
}

const PARAM_RE = /^\$\{param:([A-Za-z_][A-Za-z0-9_]*)\}$/;

/** `${param:NAME}` as a kube-context (one runbook for a lab and PROD): NAME, else undefined. */
export function kubeContextParam(value: string | undefined): string | undefined {
  return value === undefined ? undefined : PARAM_RE.exec(value)?.[1];
}

/** Whether `value` can be a kube-context as written: a context name, or `${param:NAME}`. */
export function isKubeContextValue(value: string): boolean {
  return isKubeContextName(value) || kubeContextParam(value) !== undefined;
}

/**
 * The context a cell must run against, as written: its own `kube-context=`, else the runbook's
 * `kube-context:` (a name or `${param:NAME}`; resolveKubeContext fills the parameter in).
 */
export function wantedKubeContext(cell: { kubeContext?: string }, frontMatter: { kubeContext?: string } | undefined): string | undefined {
  return cell.kubeContext ?? frontMatter?.kubeContext;
}

/**
 * The context `want` names, its `${param:NAME}` filled in with `param(NAME)`. Throws, so nothing
 * runs, when the parameter has no value or its value is no context name (a value goes into
 * kubectl's command line and the pinned kubeconfig: only a name kubectl allows does).
 */
export function resolveKubeContext(want: string | undefined, param: (name: string) => string | undefined): string | undefined {
  const name = kubeContextParam(want);
  if (name === undefined) return want;
  const value = param(name);
  if (value === undefined) throw new Error(`md-runbook: kube-context \${param:${name}} has no value: nothing ran`);
  if (!isKubeContextName(value)) {
    throw new Error(`md-runbook: kube-context \${param:${name}} is ${JSON.stringify(value)}, which is not a Kubernetes context name: nothing ran`);
  }
  return value;
}

/** The `${param:NAME}` reference text of a parameterised kube-context, for the lists of references (cellRefs). */
export function kubeContextRefText(want: string | undefined): string {
  const name = kubeContextParam(want);
  return name === undefined ? '' : `\${param:${name}}`;
}

/** What running KUBE_CONTEXT_COMMAND gave. */
export interface KubeContextProbe {
  exitCode: number | null;
  /** stdout (the context's name on its first line). */
  stdout: string;
  /** stderr, or why it couldn't run. */
  stderr?: string;
}

/** Why the cell must not run, or undefined when the current context is `want`. */
export function kubeContextRefusal(want: string, probe: KubeContextProbe): string | undefined {
  const got = probe.stdout.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== '');
  if (probe.exitCode === 0 && got === want) return undefined;
  const head = `md-runbook: this runbook is for the Kubernetes context ${want}`;
  if (probe.exitCode === 0 && got !== undefined) {
    return `${head}, and kubectl's current context is ${got}: nothing ran. Switch with \`kubectl config use-context ${want}\`, or open the runbook meant for ${got}.`;
  }
  const why = (probe.stderr ?? '').split(/\r?\n/).map((l) => l.trim()).find((l) => l !== '');
  return `${head}, and \`${KUBE_CONTEXT_COMMAND}\` ${why ? `failed (${why})` : 'named no context'}: nothing ran.`;
}

/**
 * Run the check with `run` (which runs a command where the cell would run) and say why the cell
 * must not run, or undefined. Nothing is checked when `want` is undefined. `pinned`: the cell's
 * KUBECONFIG pins `want` (kube-context-mode: pin), so the check is that the context exists.
 */
export async function checkKubeContext(
  want: string | undefined,
  run: (command: string) => Promise<KubeContextProbe>,
  pinned = false,
): Promise<string | undefined> {
  if (want === undefined) return undefined;
  let probe: KubeContextProbe;
  try {
    probe = await run(pinned ? kubePinCommand(want) : KUBE_CONTEXT_COMMAND);
  } catch (e) {
    probe = { exitCode: null, stdout: '', stderr: e instanceof Error ? e.message : String(e) };
  }
  return pinned ? kubePinRefusal(want, probe) : kubeContextRefusal(want, probe);
}

/**
 * `kube-context-mode:` in the front matter. `check` (the default): the guard above. `pin`: the
 * runbook's and its cells' `kube-context` become the cell's current context, whatever yours is.
 * md-runbook gives each local cell a KUBECONFIG whose first file holds only `current-context:
 * NAME`, followed by your own kubeconfig files (node/runbookEnv.ts). kubeconfig merging takes the
 * current context from the first file that sets one, so kubectl, helm, k9s and every client-go
 * tool use NAME, nothing is copied out of your kubeconfig, and a `kubectl config use-context` in a
 * cell changes that file, never your default. Cells on an SSH host (`host=`, the app) are only
 * checked.
 */
export const KUBE_CONTEXT_MODES = ['check', 'pin'] as const;
export type KubeContextMode = (typeof KUBE_CONTEXT_MODES)[number];

/** The first file of a pinned cell's KUBECONFIG: a current context and nothing else, no credential. */
export function pinnedKubeconfig(name: string): string {
  return (
    '# md-runbook: the Kubernetes context of a runbook with kube-context-mode: pin.\n' +
    '# Only the current context is here; clusters, users and credentials come from your own kubeconfig.\n' +
    'apiVersion: v1\nkind: Config\npreferences: {}\nclusters: []\ncontexts: []\nusers: []\n' +
    `current-context: ${JSON.stringify(name)}\n`
  );
}

/** KUBECONFIG for a pinned cell: the pin file, then your own list, with the platform's separator. */
export function pinnedKubeconfigList(pinFile: string, userList: string, platform: string): string {
  return pinFile + (platform === 'win32' ? ';' : ':') + userList;
}

/**
 * Pin mode's check: lists the context, marked `*` in the CURRENT column when it is the current one.
 * So the cell runs only if your kubeconfig has the context and the pin is in effect.
 */
export function kubePinCommand(name: string): string {
  return `kubectl config get-contexts ${name}`;
}

/** Why a pinned cell must not run (the probe ran kubePinCommand), or undefined. */
export function kubePinRefusal(want: string, probe: KubeContextProbe): string | undefined {
  const rows = probe.stdout.split(/\r?\n/).map((l) => l.trim().split(/\s+/));
  if (probe.exitCode === 0 && rows.some((r) => r[0] === '*' && r[1] === want)) return undefined;
  const head = `md-runbook: this runbook pins the Kubernetes context ${want}`;
  if (probe.exitCode === 0 && rows.some((r) => r[0] === want)) {
    return `${head}, and kubectl's current context in the cell is another one (does KUBECONFIG change before kubectl runs?): nothing ran.`;
  }
  const why = (probe.stderr ?? '').split(/\r?\n/).map((l) => l.trim()).find((l) => l !== '');
  // kubectl: `error: context lab not found`.
  if (why !== undefined && /\bcontext\b.*\bnot found\b/i.test(why)) {
    return `${head}, and your kubeconfig has no context ${want} (${why}): nothing ran. \`kubectl config get-contexts\` lists the ones you have.`;
  }
  return `${head}, and \`${kubePinCommand(want)}\` ${why ? `failed (${why})` : 'did not list it'}: nothing ran.`;
}
