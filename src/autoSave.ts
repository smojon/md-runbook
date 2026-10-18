/** `mdRunbook.output.saveAfterRun`: save the runbook after each run, so outputs are on disk at once. */

import * as vscode from 'vscode';
import { SECTION } from './config';
import { RunPipeline } from './pipeline';

export function registerAutoSave(pipeline: RunPipeline): void {
  pipeline.observers.push({
    onDidRunSequence: async (nb) => {
      if (!vscode.workspace.getConfiguration(SECTION).get<boolean>('output.saveAfterRun', false)) return;
      if (nb.isClosed || nb.isUntitled || !nb.isDirty) return;
      try {
        await nb.save();
      } catch (e) {
        void vscode.window.showWarningMessage(`md-runbook: could not save after the run: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  });
}
