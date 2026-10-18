import * as vscode from 'vscode';
import { DEFAULT_PATTERNS, RedactionPattern, Redactor, ShellSettings, WriteOptions, createRedactor } from './core';
import { knownSecrets } from './knownSecrets';

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
  return { enabled, applyToLiveOutput: c.get<boolean>('redaction.applyToLiveOutput', true), redactor };
}

export function writeOptions(): WriteOptions {
  const c = cfg();
  const r = redactionConfig();
  return {
    persistOutputs: c.get<boolean>('output.persist', true),
    maxOutputLines: Math.max(0, c.get<number>('output.maxLines', 2000)),
    stripAnsi: c.get<boolean>('output.stripAnsi', true),
    // Known secret values are always redacted on disk, even if pattern redaction is off.
    redact: r.enabled ? (s: string) => knownSecrets.redact(r.redactor.redact(s)) : (s: string) => knownSecrets.redact(s),
  };
}

export interface ExecutionConfig {
  timeoutMs: number;
  stopOnFailure: boolean;
  env: Record<string, string>;
  shell: ShellSettings;
}

export function executionConfig(): ExecutionConfig {
  const c = cfg();
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(c.get<Record<string, unknown>>('execution.env', {}))) {
    if (v !== null && v !== undefined) env[k] = String(v);
  }
  return {
    timeoutMs: Math.max(0, c.get<number>('execution.timeoutSeconds', 0)) * 1000,
    stopOnFailure: c.get<boolean>('execution.stopOnFailure', true),
    env,
    shell: {
      bashPath: c.get<string>('shell.bashPath', '') || undefined,
      pwshPath: c.get<string>('shell.pwshPath', '') || undefined,
    },
  };
}
