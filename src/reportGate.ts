/**
 * Run reports in VS Code, the decisions (runReports.ts asks and sends): whether a run may start,
 * and whether its summary goes signed. As the command line (cli/report.ts) and the app
 * (apps/mobile/src/reports/send.ts): `report-runs-signed`, when honoured, needs a signing key on
 * its own, whether or not the report is also required.
 */

import type { ReportPlan } from '@md-runbook/core/runReport';

export type ReportGate = { kind: 'go' } | { kind: 'ask' } | { kind: 'refuse'; why: 'key' };

/**
 * Before a run: a runbook that requires signed reports doesn't start without a key; one that
 * requires reporting waits for Run on its notice (unless agreed to this session).
 */
export function reportGate(plan: Pick<ReportPlan, 'required' | 'signed'> | undefined, o: { keySet: boolean; agreed: boolean }): ReportGate {
  if (!plan) return { kind: 'go' };
  if (plan.signed && !o.keySet) return { kind: 'refuse', why: 'key' };
  if (plan.required && !o.agreed) return { kind: 'ask' };
  return { kind: 'go' };
}

/** After a run: signed when a key is set; nothing unsigned goes out when the runbook requires it signed. */
export function summarySigning(plan: Pick<ReportPlan, 'signed'>, keySet: boolean): 'sign' | 'unsigned' | 'refuse' {
  if (keySet) return 'sign';
  return plan.signed ? 'refuse' : 'unsigned';
}

/** Why the run doesn't start without a key, and how to set one up (the command line's words, for VS Code). */
export const SIGNING_KEY_MISSING =
  "md-runbook: this signed runbook runs only if its run summary is signed with your SSH key, and none is set. Set mdRunbook.signing.key to your key (a key file, or a .pub whose key is in the SSH agent), and give your server's allowed runners file its line (namespace md-runbook-run).";

/** The run's cancel reason when the key is missing. */
export const SIGNING_KEY_MISSING_CANCEL = 'md-runbook: not run: the runbook requires a signed run report, and mdRunbook.signing.key is not set';
