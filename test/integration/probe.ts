/**
 * Why do some opens hang on macOS runners? The tests run in the extension host, the same process
 * as the extension, so this measures it from here: event-loop stalls and CPU time of this process,
 * the round trip to VS Code's window (renderer), and how long the extension spent in its own open
 * work (src/timings.ts). Slow opens print a line with all of it; `summary()` ends the run.
 */
import * as vscode from 'vscode';

interface Stall {
  at: number;
  ms: number;
}

const TICK_MS = 100;
const stalls: Stall[] = [];
let last = Date.now();
const timer = setInterval(() => {
  const now = Date.now();
  const gap = now - last - TICK_MS;
  if (gap > 300) stalls.push({ at: last, ms: gap });
  last = now;
}, TICK_MS);
timer.unref?.();

interface ExtensionTiming {
  what: string;
  file: string;
  at: number;
  ms: number;
}
/** Filled by the extension (src/timings.ts) when MD_RUNBOOK_TEST is set. */
const extensionTimings = (): ExtensionTiming[] => ((globalThis as { __mdRunbookTimings?: ExtensionTiming[] }).__mdRunbookTimings ?? []);

/** Round trip to the window (a command answered by the renderer). */
export async function pingWindow(): Promise<number> {
  const started = Date.now();
  await vscode.commands.getCommands(true);
  return Date.now() - started;
}

export interface OpenRecord {
  file: string;
  ms: number;
  settled: boolean;
  attempts: number;
  detail: string;
}
const opens: OpenRecord[] = [];

/** Start measuring one open; call the returned function when it is done (or given up). */
export function measureOpen(file: string): (r: { settled: boolean; attempts: number }) => Promise<OpenRecord> {
  const started = Date.now();
  const cpu = process.cpuUsage();
  return async ({ settled, attempts }) => {
    const ms = Date.now() - started;
    const used = process.cpuUsage(cpu);
    const inWindow = stalls.filter((s) => s.at >= started - TICK_MS);
    // Opens run one at a time, so the extension's work since `started` belongs to this open.
    const ext = new Map<string, { n: number; ms: number }>();
    for (const t of extensionTimings().filter((t) => t.at >= started)) {
      const e = ext.get(t.what) ?? { n: 0, ms: 0 };
      ext.set(t.what, { n: e.n + 1, ms: e.ms + t.ms });
    }
    const ping = await pingWindow();
    const detail = [
      `ext-host cpu ${Math.round((used.user + used.system) / 1000)} ms`,
      `stalls ${inWindow.length}${inWindow.length ? ` (max ${Math.max(...inWindow.map((s) => s.ms))} ms)` : ''}`,
      `window ping ${ping} ms`,
      ...[...ext].map(([what, e]) => `${what} ${e.ms} ms${e.n > 1 ? ` (${e.n}×)` : ''}`),
    ].join(', ');
    const rec = { file, ms, settled, attempts, detail };
    opens.push(rec);
    return rec;
  };
}

export function summary(): string {
  const slow = opens.filter((o) => o.ms > 5000 || !o.settled || o.attempts > 1);
  const lines = [`open probe: ${opens.length} opens, ${slow.length} slow (> 5 s, retried or never settled)`];
  for (const o of slow) lines.push(`  ${o.file}: ${o.ms} ms, ${o.settled ? 'settled' : 'NOT settled'}, attempts ${o.attempts}; ${o.detail}`);
  const all = stalls.filter((s) => s.ms > 1000);
  lines.push(`  ext-host stalls > 1 s during the whole run: ${all.length}${all.length ? ` (max ${Math.max(...all.map((s) => s.ms))} ms)` : ''}`);
  return lines.join('\n');
}
