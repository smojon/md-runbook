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

/** The context a cell must run against: its own `kube-context=`, else the runbook's `kube-context:`. */
export function wantedKubeContext(cell: { kubeContext?: string }, frontMatter: { kubeContext?: string } | undefined): string | undefined {
  return cell.kubeContext ?? frontMatter?.kubeContext;
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
 * must not run, or undefined. Nothing is checked when `want` is undefined.
 */
export async function checkKubeContext(want: string | undefined, run: (command: string) => Promise<KubeContextProbe>): Promise<string | undefined> {
  if (want === undefined) return undefined;
  let probe: KubeContextProbe;
  try {
    probe = await run(KUBE_CONTEXT_COMMAND);
  } catch (e) {
    probe = { exitCode: null, stdout: '', stderr: e instanceof Error ? e.message : String(e) };
  }
  return kubeContextRefusal(want, probe);
}
