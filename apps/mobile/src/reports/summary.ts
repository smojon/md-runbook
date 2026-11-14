/**
 * The run summary the app sends at the end of a run (core runReport.ts): the runbook's steps as
 * the Steps view lists them, each with how it stands now, and for the ones this run ran how long
 * they took. Names, states and times only: never an output, a value or a secret.
 */
import { isCodeMeta, parse, taskItems } from '@md-runbook/core';
import { parseInterval } from '@md-runbook/core/checks';
import { stepLabel } from '@md-runbook/core/estimate';
import { isManualMark, stepState } from '@md-runbook/core/progress';
import { RunClient, RunStepState, RunSummaryInput, RunSummaryReport, buildRunSummary } from '@md-runbook/core/runReport';
import { textProgress } from '@md-runbook/core/textProgress';
import { Platform } from 'react-native';
import { cellHeadings, checklistText } from '../runbooks/steps';
import { t } from '../i18n';

/** This app's client name in a summary. */
export const appClient = (): RunClient => (Platform.OS === 'ios' ? 'app-ios' : Platform.OS === 'android' ? 'app-android' : 'app-web');

const STATE: Record<ReturnType<typeof stepState>, RunStepState> = {
  done: 'passed',
  failed: 'failed',
  skipped: 'skipped',
  pending: 'not-run',
};

/**
 * The steps of `text` for a summary: checklist items (done by hand when ticked) and code steps,
 * in order. A step whose output says it ran at `since` or later ran in this run (`ran`, `ms`).
 */
export function summarySteps(text: string, since: number): RunSummaryInput['steps'] {
  const cells = parse(text).cells;
  const progress = textProgress(text);
  const headings = cellHeadings(cells);
  const steps: RunSummaryInput['steps'][number][] = [];
  cells.forEach((cell, i) => {
    if (cell.kind === 'markup') {
      for (const item of taskItems(cell.value))
        steps.push({ label: checklistText(cell.value, item.line), state: item.checked ? 'by-hand' : 'not-run' });
      return;
    }
    if (progress.stepOfCell[i] === undefined) return;
    const a = cell.output?.attrs;
    const info = isCodeMeta(cell.meta) ? cell.meta.info : '';
    const state: RunStepState = isManualMark(a) ? 'by-hand' : STATE[stepState(a?.exit, a?.lines !== undefined, a?.check)];
    const ranAt = a?.ran !== undefined ? Date.parse(a.ran) : NaN;
    const ran = Number.isFinite(ranAt) && ranAt >= since - 1000 && !isManualMark(a);
    const ms = ran && a?.duration !== undefined ? parseInterval(a.duration) : undefined;
    steps.push({
      label: stepLabel(info, cell.value, cell.languageId, headings[i]) || t.cellNumber(i + 1),
      state,
      ...(ran ? { ran: true } : {}),
      ...(ms !== undefined ? { ms } : {}),
    });
  });
  return steps;
}

/** The summary of the run that started at `started` and just ended, or undefined when no step ran in it. */
export function appRunSummary(o: {
  file: string;
  text: string;
  who: string;
  started: number;
  ended: number;
  trustedSigner?: string;
  stopped?: boolean;
  /** The run's parameter values: only the alert ones (core ALERT_PARAMS) go into the summary. */
  alertParams?: Readonly<Record<string, string>>;
}): RunSummaryReport | undefined {
  const steps = summarySteps(o.text, o.started);
  if (!steps.some((s) => s.ran)) return undefined;
  return buildRunSummary({
    file: o.file,
    text: o.text,
    who: o.who,
    client: appClient(),
    started: o.started,
    ended: o.ended,
    steps,
    ...(o.stopped ? { stopped: true } : {}),
    ...(o.alertParams ? { alertParams: o.alertParams } : {}),
    ...(o.trustedSigner !== undefined ? { trustedSigner: o.trustedSigner } : {}),
  });
}
