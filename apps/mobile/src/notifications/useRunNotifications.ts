/**
 * The runbook screen's run, as notifications (runs.ts): when it ends or starts waiting for an
 * answer while the app is away, and the "paused" one when the app goes away during it.
 */
import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { t } from '../i18n';
import { cancelPaused, notifyRun, runWentAway } from './runs';

export type RunPhase =
  | { kind: 'idle' }
  /** A cell runs, or Run all is between two cells. */
  | { kind: 'running'; cellIndex?: number }
  /** A card waits for an answer under this cell (`what`: its question). */
  | { kind: 'waiting'; cellIndex: number; what: string };

/** What the run bar says once a run is over (the step to open at); undefined: nothing to say. */
export type EndedNote = { body: string; cellIndex?: number } | undefined;

/** A notification line stays short: a long checklist item is cut. */
const MAX_WHAT = 120;
const clip = (s: string): string => {
  const line = s.replace(/\s+/g, ' ').trim();
  return line.length > MAX_WHAT ? `${line.slice(0, MAX_WHAT - 1).trimEnd()}…` : line;
};

export function useRunNotifications(runbook: { id: string; title: string } | undefined, phase: RunPhase, ended: () => EndedNote): void {
  const id = runbook?.id;
  const latest = useRef({ phase, ended, title: runbook?.title ?? '' });
  useEffect(() => {
    latest.current = { phase, ended, title: runbook?.title ?? '' };
  });
  const before = useRef<RunPhase>({ kind: 'idle' });
  const key = phase.kind === 'waiting' ? `waiting:${phase.cellIndex}:${phase.what}` : phase.kind;
  useEffect(() => {
    if (!id) return;
    const was = before.current;
    before.current = phase;
    const title = latest.current.title;
    if (phase.kind === 'waiting') {
      void notifyRun({ runbookId: id, cellIndex: phase.cellIndex }, t.notifyWaits(title), clip(phase.what));
      return;
    }
    if (phase.kind === 'running') {
      // Started while away (Run all went on in a runbook call's copy): it pauses too.
      if (was.kind === 'idle' && AppState.currentState === 'background')
        void runWentAway({ runbookId: id, ...(phase.cellIndex !== undefined ? { cellIndex: phase.cellIndex } : {}) }, title);
      return;
    }
    if (was.kind === 'idle') return;
    // Over: once the screen has caught up (the output block, the notice), in the run bar's words.
    const timer = setTimeout(() => {
      if (latest.current.phase.kind !== 'idle') return;
      const note = latest.current.ended();
      if (!note) return void cancelPaused(id);
      void notifyRun({ runbookId: id, ...(note.cellIndex !== undefined ? { cellIndex: note.cellIndex } : {}) }, title, note.body);
    }, 0);
    return () => clearTimeout(timer);
    // `key` stands for the phase (a new object each render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, key]);
  // The app goes away during a run: "paused", unless the run ends or waits first; back: taken back.
  useEffect(() => {
    if (!id) return;
    const sub = AppState.addEventListener('change', (state) => {
      const { phase: now, title } = latest.current;
      if (state === 'active') void cancelPaused(id);
      else if (state === 'background' && now.kind === 'running')
        void runWentAway({ runbookId: id, ...(now.cellIndex !== undefined ? { cellIndex: now.cellIndex } : {}) }, title);
    });
    return () => {
      sub.remove();
      void cancelPaused(id);
    };
  }, [id]);
}
