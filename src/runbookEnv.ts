/**
 * What a runbook's front matter adds to its cells' environment (core/node/runbookEnv.ts):
 * `kube-context-mode: pin` gives each cell a KUBECONFIG that pins its kube-context, and
 * `git-bash-path-conversion: off` stops Git Bash rewriting paths on Windows. Registered after
 * every preparer that sets plan.env (the read-only credentials of assistant cells included), so
 * the pin goes in front of the kubeconfig the cell would really use.
 */

import * as vscode from 'vscode';
import { isCodeMeta } from '@md-runbook/core';
import { parseCellOptions } from '@md-runbook/core/cellOptions';
import { wantedKubeContext } from '@md-runbook/core/kubeContext';
import { KubeconfigPins, runbookEnv } from '@md-runbook/core/node/runbookEnv';
import { SECTION } from './config';
import { frontMatterOf } from './controller';
import { META_KEY } from './outputs';
import { CellPreparer } from './pipeline';

export function registerRunbookEnv(context: vscode.ExtensionContext): CellPreparer {
  // One set of pin files per open runbook, removed when it closes: a session shell keeps the
  // KUBECONFIG it was given, so the files must outlive the cell.
  const pins = new Map<string, KubeconfigPins>();
  const drop = (key: string): void => {
    pins.get(key)?.dispose();
    pins.delete(key);
  };
  context.subscriptions.push(
    { dispose: () => [...pins.keys()].forEach(drop) },
    vscode.workspace.onDidCloseNotebookDocument((nb) => drop(nb.uri.toString())),
  );
  return {
    prepare(plan, { cell, notebook }) {
      if (plan.skip !== undefined) return;
      const fm = frontMatterOf(notebook);
      if (fm?.kubeContextMode === undefined && fm?.gitBashPathConversion === undefined) return;
      const meta: unknown = cell.metadata?.[META_KEY];
      // Off: a runbook asking for pin gets the check instead (its cells run only on that context).
      const pinAllowed = vscode.workspace.getConfiguration(SECTION).get<boolean>('execution.kubeContextPin', true);
      const key = notebook.uri.toString();
      if (pinAllowed && fm.kubeContextMode === 'pin' && !pins.has(key)) pins.set(key, new KubeconfigPins());
      const added = runbookEnv({
        language: plan.language,
        frontMatter: fm,
        kubeContext: wantedKubeContext(parseCellOptions(isCodeMeta(meta) ? meta.info : ''), fm),
        env: { ...process.env, ...plan.env },
        pins: pinAllowed ? pins.get(key) : undefined,
      });
      Object.assign(plan.env, added.env);
      plan.kubeContextPinned = added.pinned;
    },
  };
}
