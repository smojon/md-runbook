/**
 * A quick check, shown on the home screen, that the shared core works on this platform: the
 * parser and writer round-trip a runbook byte for byte, and RE2 regular expressions run (CI's
 * device tests look for it). Pure, so Jest tests it too.
 */
import { DEFAULT_WRITE_OPTIONS, parse, serialize, toCellInputs } from '@md-runbook/core';
import { parseCellOptions } from '@md-runbook/core/cellOptions';
import { evaluateChecks } from '@md-runbook/core/checks';
import { splitSteps } from '@md-runbook/core/steps';
import { SAMPLE_RUNBOOK } from './runbooks/sample';

export type CoreCheck = { ok: true } | { ok: false; why: string };

export function checkCore(text: string = SAMPLE_RUNBOOK): CoreCheck {
  try {
    const doc = parse(text);
    if (serialize(doc.meta, toCellInputs(doc), DEFAULT_WRITE_OPTIONS) !== text) return { ok: false, why: 'the writer changed the runbook' };
    const checks = parseCellOptions('bash expect=/active\\s\\(running\\)/').checks;
    if (!checks || !evaluateChecks(checks, 0, 'Active: active (running) since Mon', '').ok)
      return { ok: false, why: 'RE2 check did not match' };
    if (splitSteps('echo a\necho b', 'bash').length !== 2) return { ok: false, why: 'line splitting' };
    return { ok: true };
  } catch (e) {
    return { ok: false, why: e instanceof Error ? e.message : String(e) };
  }
}
