/**
 * The options of a block run from the text editor's CodeLens (codeLens.ts), applied like the
 * notebook's: the front matter's `cwd:` and `timeout:` (controller.ts runbookDefaults), then the
 * fence options. `mdRunbook.cellOptions.enabled` off turns off both, as in the notebook; the
 * front matter's `shell:` still applies (it is the whole runbook's, as in the notebook).
 */

import * as path from 'node:path';
import type { ShellSettings } from '@md-runbook/core';
import { parseCellOptions } from '@md-runbook/core/cellOptions';
import { parseFrontMatter } from '@md-runbook/core/secrets';
import type { ExecutionConfig } from './config';

export interface RunOptions {
  skip: boolean;
  cwd: string;
  timeoutMs: number;
  env: Record<string, string>;
  /** The user's shell settings with the runbook's `shell:`. */
  shell: ShellSettings;
  /** Invalid cell options: the block fails with this message instead of running. */
  error?: string;
}

/**
 * The fence options of a block (`skip`, `cwd=`, `timeout=`, `env.*`) over the front matter's
 * `cwd:` / `timeout:`: cwd relative to the .md file's folder, invalid options fail the block.
 * `optionsOn` is `mdRunbook.cellOptions.enabled`.
 */
export function editorRunOptions(info: string, baseDir: string, cfg: Pick<ExecutionConfig, 'timeoutMs' | 'env' | 'shell'>, docText: string, optionsOn: boolean): RunOptions {
  const fm = parseFrontMatter(docText);
  const shell = fm?.shell ? { ...cfg.shell, runbook: fm.shell } : cfg.shell;
  const out: RunOptions = { skip: false, cwd: baseDir, timeoutMs: cfg.timeoutMs, env: { ...cfg.env }, shell };
  if (!optionsOn) return out;
  if (fm?.cwd) out.cwd = path.resolve(baseDir, fm.cwd);
  if (fm?.timeoutSeconds !== undefined) out.timeoutMs = fm.timeoutSeconds * 1000;
  const o = parseCellOptions(info);
  if (o.errors.length > 0) out.error = `md-runbook: invalid cell option ${o.errors.join('; ')}`;
  if (o.skip && out.error === undefined) out.skip = true;
  if (o.timeoutSeconds !== undefined) out.timeoutMs = o.timeoutSeconds * 1000;
  if (o.cwd !== undefined) out.cwd = path.resolve(baseDir, o.cwd);
  Object.assign(out.env, o.env);
  return out;
}
