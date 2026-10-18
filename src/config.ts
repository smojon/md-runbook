import * as vscode from 'vscode';
import { DEFAULT_PATTERNS, RedactionPattern, Redactor, WriteOptions, createRedactor } from './core';

export const SECTION = 'mdRunbook';

export interface RedactionConfig {
  enabled: boolean;
  applyToLiveOutput: boolean;
  redactor: Redactor;
}

function cfg(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(SECTION);
}

let lastReportedErrors = '';

export function redactionConfig(): RedactionConfig {
  const c = cfg();
  const enabled = c.get<boolean>('redaction.enabled', true);
  const patterns: Array<string | RedactionPattern> = [];
  if (c.get<boolean>('redaction.useDefaultPatterns', true)) patterns.push(...DEFAULT_PATTERNS);
  patterns.push(...c.get<Array<string | RedactionPattern>>('redaction.patterns', []));
  const redactor = createRedactor(patterns);
  const errors = redactor.errors.join('\n');
  if (errors && errors !== lastReportedErrors) {
    void vscode.window.showWarningMessage(`md-runbook: invalid redaction pattern(s) ignored:\n${errors}`);
  }
  lastReportedErrors = errors;
  return { enabled, applyToLiveOutput: c.get<boolean>('redaction.applyToLiveOutput', false), redactor };
}

export function writeOptions(): WriteOptions {
  const c = cfg();
  const r = redactionConfig();
  return {
    persistOutputs: c.get<boolean>('output.persist', true),
    maxOutputLines: Math.max(0, c.get<number>('output.maxLines', 2000)),
    stripAnsi: c.get<boolean>('output.stripAnsi', true),
    redact: r.enabled ? (s: string) => r.redactor.redact(s) : undefined,
  };
}
