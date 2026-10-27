/**
 * md-runbook-probe (apps/ops) in the run record: the lines it printed, as saved in a cell's output
 * block, become endpoint checks of that run (target, up or not, the certificate's expiry), which
 * Export Report and the JSON export list next to the timeline. The probe's own log events (in the
 * gate's log) are read by `md-runbook audit` (audit.ts).
 */

/** One target checked by md-runbook-probe. */
export interface EndpointCheck {
  /** `host:port` as the probe printed it. */
  target: string;
  ok: boolean;
  /** The rest of the line: address, timings, the certificate. */
  detail: string;
  /** Days until the certificate expires (negative: expired), and the expiry day (UTC). */
  daysLeft?: number;
  expires?: string;
}

/** A cell that runs the probe (only its output is read as checks). */
export function usesProbe(source: string): boolean {
  return /(^|[\s;|&(])md-runbook-probe(\s|$)/m.test(source);
}

const LINE_RE = /^(OK|FAIL) {2,}(\S+) {2,}(.+)$/;

/** The checks in md-runbook-probe's output, in order. */
export function parseProbeOutput(text: string): EndpointCheck[] {
  const out: EndpointCheck[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = LINE_RE.exec(line.trimEnd());
    if (!m) continue;
    const detail = m[3]!;
    const check: EndpointCheck = { target: m[2]!, ok: m[1] === 'OK', detail };
    const left = /(\d+) days left \((\d{4}-\d\d-\d\d)\)/.exec(detail);
    const soon = /expires in (-?\d+) days \((\d{4}-\d\d-\d\d)\)/.exec(detail);
    const untrusted = /expires (\d{4}-\d\d-\d\d) \((-?\d+) days\)/.exec(detail);
    const expired = /EXPIRED on (\d{4}-\d\d-\d\d) \((\d+) days ago\)/.exec(detail);
    if (left || soon) {
      const g = (left ?? soon)!;
      check.daysLeft = Number(g[1]);
      check.expires = g[2]!;
    } else if (untrusted) {
      check.daysLeft = Number(untrusted[2]);
      check.expires = untrusted[1]!;
    } else if (expired) {
      check.daysLeft = -Number(expired[2]);
      check.expires = expired[1]!;
    }
    out.push(check);
  }
  return out;
}
