/**
 * `mdRunbook.output.saveAfterRun`: save the runbook after each run, so outputs are on disk at once.
 * `"copies"` (default) saves only run copies, the files Run All as Copy makes as the record of a run;
 * `true` saves every runbook, which writes output into the user's file without an explicit save.
 */

import * as vscode from 'vscode';
import { SECTION } from './config';
import { isCopy } from './history';
import { RunPipeline } from './pipeline';

export function registerAutoSave(pipeline: RunPipeline): void {
  pipeline.observers.push({
    onDidRunSequence: async (nb) => {
      const mode = vscode.workspace.getConfiguration(SECTION).get<boolean | string>('output.saveAfterRun', 'copies');
      if (mode === 'copies' ? !isCopy(nb.uri) : mode !== true) return;
      if (nb.isClosed || nb.isUntitled || !nb.isDirty) return;
      try {
        await nb.save();
      } catch (e) {
        void vscode.window.showWarningMessage(`md-runbook: could not save after the run: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  });
}
