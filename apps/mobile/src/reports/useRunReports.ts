/**
 * The runbook screen's run reports: when a run is over (nothing runs or waits any more, and its
 * last output is in the runbook), the summary of what it ran goes to the runbook's `report-runs:`
 * address, once allowed. Sending never holds up the run: it starts after the run is over and is
 * not waited for. The run also goes on this device's run history (Show Runs…, runbooks/runLog.ts).
 */
import { useEffect, useRef, useState } from 'react';
import type { ReportPlan, RunSummaryReport } from '@md-runbook/core/runReport';
import { reportConsentText } from '@md-runbook/core/runReport';
import { recordRun, runEntry } from '../runbooks/runLog';
import { getRunbook } from '../runbooks/store';
import { signerName } from '../settings/store';
import { t } from '../i18n';
import { appRunSummary } from './summary';
import { consentFor, planOf, rememberConsent, retryReports, sendReport } from './send';

export interface ReportAsk {
  text: string;
  plan: ReportPlan;
  summary: RunSummaryReport;
}

/** The runbook's file name for a summary (a bundled runbook has none: its title). */
const fileOf = (r: { fileName?: string; title: string }): string => r.fileName ?? `${r.title}.md`;

export interface RunReports {
  /** The end-of-run question (Allow / Not now / Never), while it is up. */
  ask: ReportAsk | undefined;
  answer(a: 'allow' | 'not-now' | 'never'): void;
  /** A run starts (a cell, Run all with `fresh`): the summary counts the steps run from now. */
  begin(fresh?: boolean): void;
  /** A run that started at `started` is over (a group run, which has no run phase). */
  ended(started: number): void;
  /** When the run being reported started (useReportWhenOver). */
  started: { current: number | undefined };
  handedOn(): boolean;
}

/**
 * The reports of the runbook screen's runs. Called before the screen's run functions (they call
 * `begin`); useReportWhenOver, once the screen knows its run phase, says when a run is over.
 */
export function useRunReports(
  runbook: { id: string; title: string; fileName?: string; text: string } | undefined,
  /** The run went on in a runbook call's copy: that run reports itself. */
  handedOn: () => boolean,
  /**
   * The runbook's parameter values (the front matter's defaults, then those typed or set by a
   * link's p.*): the summary takes only the alert ones (ALERT, ALERT_FINGERPRINT, …).
   */
  params: () => Readonly<Record<string, string>> = () => ({}),
): RunReports {
  const [ask, setAsk] = useState<ReportAsk | undefined>();
  const started = useRef<number | undefined>(undefined);
  const latest = useRef({ runbook, handedOn, params });
  useEffect(() => {
    latest.current = { runbook, handedOn, params };
  });

  const ended = (at: number): void => {
    const r = latest.current.runbook;
    if (!r) return;
    const text = getRunbook(r.id)?.text;
    if (text === undefined) return;
    // Show Runs…: the run on this device's record (steps, states and times only).
    const entry = runEntry(text, at, Date.now(), signerName() || undefined);
    if (entry) void recordRun(r, entry).catch(() => undefined);
    void (async () => {
      const report = await planOf(text, r.id);
      const summary =
        report &&
        appRunSummary({
          file: fileOf(r),
          text,
          who: signerName() || t.reportWhoDefault,
          started: at,
          ended: Date.now(),
          ...(report.signer !== undefined ? { trustedSigner: report.signer } : {}),
          alertParams: latest.current.params(),
        });
      if (report && summary) {
        // Required (a trusted signature, agreed to before the run): sent; else as allowed.
        const consent = report.plan.required ? 'allow' : await consentFor(report.plan);
        if (consent === 'allow') await sendReport(report.plan, summary);
        else if (consent === 'ask') setAsk({ text: reportConsentText(report.plan), plan: report.plan, summary });
      }
      // And the ones that couldn't be sent before.
      await retryReports();
    })().catch(() => undefined);
  };

  const answer = (a: 'allow' | 'not-now' | 'never'): void => {
    const now = ask;
    setAsk(undefined);
    if (!now || a === 'not-now') return;
    void rememberConsent(now.plan, a).then(() => (a === 'allow' ? sendReport(now.plan, now.summary) : undefined));
  };
  const begin = (fresh = false): void => {
    if (fresh || started.current === undefined) started.current = Date.now();
  };
  return { ask, answer, begin, ended, started, handedOn: () => latest.current.handedOn() };
}

/**
 * Over: nothing runs or waits, and the output is in (a run writes it as it ends). Not taken back
 * when the screen closes right after, so a run that ended is reported.
 */
export function useReportWhenOver(reports: RunReports, phase: 'idle' | 'running' | 'waiting', text: string | undefined): void {
  const latest = useRef(reports);
  useEffect(() => {
    latest.current = reports;
  });
  useEffect(() => {
    const { started, ended, handedOn } = latest.current;
    if (phase !== 'idle') {
      started.current ??= Date.now();
      return;
    }
    const at = started.current;
    if (at === undefined) return;
    started.current = undefined;
    if (handedOn()) return;
    setTimeout(() => ended(at), 0);
  }, [phase, text]);
}
