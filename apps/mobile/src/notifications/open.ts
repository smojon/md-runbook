/**
 * A tap on a run's notification opens that runbook at the step it names. The run lives in the
 * runbook's open screen, so when one is open it is brought back (not a second one pushed), and the
 * screen scrolls to the step; otherwise the runbook opens (after a restart, the run is over).
 * A tap on an alert's push opens the alert's link (alertPush.ts).
 */
import { router, useRootNavigationState } from 'expo-router';
import { useEffect, useRef } from 'react';
import { openAlertTap, useAlertPushUpkeep } from './alertPush';
import * as platform from './platform';
import type { RunTarget } from './runs';

type Params = Record<string, string | string[]>;

/** The runbook screens open now (by runbook id): their route params, and whether one is on top. */
const routes = new Map<string, { params: Params; focused: boolean }>();

/** The step a tap asked for, until its runbook's screen takes it. */
let request: RunTarget | undefined;
const listeners = new Set<() => void>();

/** Opens the runbook (or goes back to its open screen) and has it scroll to the cell. */
export function openRunbookAt(target: RunTarget): void {
  const route = routes.get(target.runbookId);
  if (!route) router.push({ pathname: '/runbook/[id]', params: { id: target.runbookId } });
  else if (!route.focused) router.dismissTo({ pathname: '/runbook/[id]', params: { ...route.params, id: target.runbookId } });
  request = target;
  listeners.forEach((l) => l());
}

/** The notification's data as a target (anything else is ignored). */
export function targetOf(data: Record<string, unknown>): RunTarget | undefined {
  const id = data.runbookId;
  if (typeof id !== 'string' || id === '') return undefined;
  const cell = typeof data.cellIndex === 'string' ? Number(data.cellIndex) : data.cellIndex;
  return { runbookId: id, ...(typeof cell === 'number' && Number.isInteger(cell) && cell >= 0 ? { cellIndex: cell } : {}) };
}

/** The runbook route: which runbooks are open, and whether on top (for openRunbookAt). */
export function useRunbookRoute(id: string | undefined, params: Params, focused: boolean): void {
  useEffect(() => {
    if (!id) return;
    const mine = { params, focused };
    routes.set(id, mine);
    return () => {
      if (routes.get(id) === mine) routes.delete(id);
    };
  }, [id, params, focused]);
}

/** The runbook screen: `go(cell)` when a tap asks for this runbook (at once if one already did). */
export function useOpenRequest(id: string | undefined, go: (cellIndex: number | undefined) => void): void {
  const goRef = useRef(go);
  useEffect(() => {
    goRef.current = go;
  });
  useEffect(() => {
    if (!id) return;
    const take = (): void => {
      if (request?.runbookId !== id) return;
      const cell = request.cellIndex;
      request = undefined;
      goRef.current(cell);
    };
    listeners.add(take);
    take();
    return () => {
      listeners.delete(take);
    };
  }, [id]);
}

/** The root layout: taps on notifications open their runbook, once the navigator is up. */
export function useNotificationTaps(): void {
  const ready = useRootNavigationState()?.key !== undefined;
  useAlertPushUpkeep();
  useEffect(() => {
    if (!ready) return;
    return platform.onTap((data) => {
      const target = targetOf(data);
      if (target) openRunbookAt(target);
      else void openAlertTap(data);
    });
  }, [ready]);
}

/** Tests. */
export function resetOpenRequests(): void {
  request = undefined;
  routes.clear();
}
