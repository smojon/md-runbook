/**
 * Alertmanager's webhook receiver: each alert is matched against the alert map (alertname and
 * label matchers) to a runbook in the library, and recorded, append-only, with the md-runbook link
 * that opens that runbook with the alert's details as parameters:
 *
 *   <PUBLIC_URL>/open?url=<PUBLIC_URL><library path><runbook>&sha256=<its hash now>&host=…&p.NAME=…
 *
 * A link only opens the runbook and fills in its parameters; it never runs anything (the app
 * checks the hash, and a signed runbook's patterns; md-runbook-gate checks them again).
 *
 * Nothing is pushed to phones yet: `notify(firing)` is the place for it (README.md says what a
 * push sender needs).
 */
import { readFileSync } from 'node:fs';
import { RE2JS } from 're2js';
import type { AlertsConfig } from './config';
import { VAR_NAME_RE, formatRunbookLink, sha256Hex } from './core';
import { HttpError, JsonLog } from './http';
import { pathProblem, readLibraryFile } from './library';

type Op = '=' | '!=' | '=~' | '!~';

interface Matcher {
  label: string;
  op: Op;
  value: string;
  re?: RE2JS;
}

export interface Route {
  alertname?: string;
  matchers: Matcher[];
  /** The runbook's path in the library. */
  runbook: string;
  /** Template of the host to run on (a host name the app has), and of each parameter. */
  host?: string;
  params: Record<string, string>;
  /** Labels passed as ALERT_LABELS (`name=value,…`), which the run summary keeps. */
  alertLabels: string[];
}

export interface AlertMap {
  routes: Route[];
}

/** Parameters every link gets from the alert itself. */
export const ALERT_LINK_PARAMS = ['ALERT', 'ALERT_FINGERPRINT', 'ALERT_STARTS_AT', 'ALERT_LABELS'] as const;
const TEMPLATE_RE = /\{\{\s*([^}]*?)\s*\}\}/g;
const TEMPLATE_PART_RE = /^\$(labels|annotations)\.([A-Za-z_][A-Za-z0-9_]*)$/;
const HOST_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const LABEL_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FINGERPRINT_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const MATCHER_RE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(=~|!~|!=|=)\s*"((?:[^"\\]|\\.)*)"\s*$/;

function checkTemplate(t: string, where: string): void {
  for (const m of t.matchAll(TEMPLATE_RE))
    if (!TEMPLATE_PART_RE.test(m[1]!)) throw new Error(`${where}: {{ ${m[1]} }} is not {{ $labels.NAME }} or {{ $annotations.NAME }}`);
}

export function parseMatcher(s: string, where: string): Matcher {
  const m = MATCHER_RE.exec(s);
  if (!m) throw new Error(`${where}: ${JSON.stringify(s)} is not a matcher such as severity="critical" or namespace=~"prod-.*"`);
  const op = m[2] as Op;
  const value = m[3]!.replace(/\\(.)/g, '$1');
  if (op === '=~' || op === '!~') {
    try {
      // Anchored, as Alertmanager's: the whole value must match. RE2: no backtracking blow-ups.
      return { label: m[1]!, op, value, re: RE2JS.compile(value) };
    } catch (e) {
      throw new Error(`${where}: ${JSON.stringify(value)} is not a regular expression (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  return { label: m[1]!, op, value };
}

/** The alert map from its JSON; throws, naming the route, on anything it can't use. */
export function parseAlertMap(json: string): AlertMap {
  let x: unknown;
  try {
    x = JSON.parse(json);
  } catch (e) {
    throw new Error(`the alert map is not JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  const list = Array.isArray(x) ? x : typeof x === 'object' && x !== null ? (x as { routes?: unknown }).routes : undefined;
  if (!Array.isArray(list)) throw new Error('the alert map: expected { "routes": [ … ] }');
  const routes = list.map((r: unknown, i): Route => {
    const where = `routes[${i}]`;
    if (typeof r !== 'object' || r === null || Array.isArray(r)) throw new Error(`${where}: expected an object`);
    const o = r as Record<string, unknown>;
    for (const k of Object.keys(o)) if (!['alertname', 'matchers', 'runbook', 'host', 'params', 'alertLabels'].includes(k)) throw new Error(`${where}: unknown field "${k}"`);
    if (o.alertname !== undefined && (typeof o.alertname !== 'string' || o.alertname === '')) throw new Error(`${where}.alertname: expected text`);
    if (typeof o.runbook !== 'string') throw new Error(`${where}.runbook: expected the runbook's path in the library`);
    const why = pathProblem(o.runbook);
    if (why) throw new Error(`${where}.runbook: ${why}`);
    if (o.matchers !== undefined && (!Array.isArray(o.matchers) || o.matchers.some((m) => typeof m !== 'string'))) throw new Error(`${where}.matchers: expected a list of matchers`);
    if (o.alertname === undefined && (o.matchers === undefined || (o.matchers as unknown[]).length === 0)) throw new Error(`${where}: give an alertname, matchers, or both`);
    if (o.host !== undefined) {
      if (typeof o.host !== 'string') throw new Error(`${where}.host: expected text`);
      checkTemplate(o.host, `${where}.host`);
    }
    const params: Record<string, string> = {};
    if (o.params !== undefined) {
      if (typeof o.params !== 'object' || o.params === null || Array.isArray(o.params)) throw new Error(`${where}.params: expected NAME: template`);
      for (const [k, v] of Object.entries(o.params)) {
        if (!VAR_NAME_RE.test(k)) throw new Error(`${where}.params: ${k} is not a parameter name`);
        if ((ALERT_LINK_PARAMS as readonly string[]).includes(k)) throw new Error(`${where}.params: ${k} is filled from the alert itself`);
        if (typeof v !== 'string') throw new Error(`${where}.params.${k}: expected text`);
        checkTemplate(v, `${where}.params.${k}`);
        params[k] = v;
      }
    }
    const alertLabels = o.alertLabels === undefined ? [] : o.alertLabels;
    if (!Array.isArray(alertLabels) || alertLabels.some((l) => typeof l !== 'string' || !LABEL_NAME_RE.test(l))) throw new Error(`${where}.alertLabels: expected label names`);
    return {
      ...(o.alertname !== undefined ? { alertname: o.alertname as string } : {}),
      matchers: ((o.matchers as string[] | undefined) ?? []).map((m, k) => parseMatcher(m, `${where}.matchers[${k}]`)),
      runbook: o.runbook,
      ...(o.host !== undefined ? { host: o.host as string } : {}),
      params,
      alertLabels: alertLabels as string[],
    };
  });
  return { routes };
}

export interface Alert {
  status: 'firing' | 'resolved';
  labels: Record<string, string>;
  annotations: Record<string, string>;
  startsAt?: string;
  endsAt?: string;
  fingerprint?: string;
}

const matches = (m: Matcher, labels: Record<string, string>): boolean => {
  const v = labels[m.label] ?? '';
  switch (m.op) {
    case '=':
      return v === m.value;
    case '!=':
      return v !== m.value;
    case '=~':
      return m.re!.matches(v);
    case '!~':
      return !m.re!.matches(v);
  }
};

/** The first route that takes the alert. */
export const routeOf = (map: AlertMap, a: Alert): Route | undefined =>
  map.routes.find((r) => (r.alertname === undefined || a.labels.alertname === r.alertname) && r.matchers.every((m) => matches(m, a.labels)));

/** A template filled from the alert: `{{ $labels.x }}`, `{{ $annotations.y }}`; one line, at most 500 characters. */
export function fill(template: string, a: Alert): string {
  const filled = template.replace(TEMPLATE_RE, (_all, part: string) => {
    const m = TEMPLATE_PART_RE.exec(part)!;
    return (m[1] === 'labels' ? a.labels : a.annotations)[m[2]!] ?? '';
  });
  return filled.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 500);
}

/** An alert as recorded: what fired, which runbook answers it, and the link. */
export interface Firing {
  received: string;
  status: 'firing' | 'resolved';
  alertname: string;
  fingerprint?: string;
  startsAt?: string;
  endsAt?: string;
  labels: Record<string, string>;
  receiver?: string;
  /** The runbook's path in the library (no route: absent). */
  runbook?: string;
  link?: string;
  /** Why the link is missing something (the runbook isn't in the library: no sha256; a host that isn't a host name). */
  problem?: string;
}

/** Where a firing goes next: a push to phones, a chat message. Nothing yet (README.md, "Push"). */
export type Notify = (firing: Firing) => Promise<void>;

const strings = (x: unknown, max: number): Record<string, string> => {
  const out: Record<string, string> = {};
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return out;
  for (const [k, v] of Object.entries(x).slice(0, max)) if (LABEL_NAME_RE.test(k) && typeof v === 'string') out[k] = v.slice(0, 1000);
  return out;
};

/** The alerts of an Alertmanager webhook body (version 4), or an HttpError. */
export function parseWebhook(json: string): { receiver?: string; alerts: Alert[] } {
  let x: unknown;
  try {
    x = JSON.parse(json);
  } catch {
    throw new HttpError(400, 'not JSON');
  }
  if (typeof x !== 'object' || x === null || !Array.isArray((x as { alerts?: unknown }).alerts)) throw new HttpError(400, "not an Alertmanager webhook: expected { \"alerts\": [ … ] }");
  const body = x as { receiver?: unknown; alerts: unknown[] };
  if (body.alerts.length > 500) throw new HttpError(413, 'more than 500 alerts in one webhook (set max_alerts in Alertmanager)');
  const alerts: Alert[] = [];
  for (const a of body.alerts) {
    if (typeof a !== 'object' || a === null) continue;
    const o = a as Record<string, unknown>;
    if (o.status !== 'firing' && o.status !== 'resolved') continue;
    alerts.push({
      status: o.status,
      labels: strings(o.labels, 50),
      annotations: strings(o.annotations, 50),
      ...(typeof o.startsAt === 'string' ? { startsAt: o.startsAt.slice(0, 40) } : {}),
      ...(typeof o.endsAt === 'string' && !o.endsAt.startsWith('0001-') ? { endsAt: o.endsAt.slice(0, 40) } : {}),
      ...(typeof o.fingerprint === 'string' && FINGERPRINT_RE.test(o.fingerprint) ? { fingerprint: o.fingerprint } : {}),
    });
  }
  return { ...(typeof body.receiver === 'string' ? { receiver: body.receiver.slice(0, 200) } : {}), alerts };
}

const encodePath = (p: string): string => p.split('/').map(encodeURIComponent).join('/');

export class Alerts {
  readonly log: JsonLog;
  private map: AlertMap;

  constructor(
    readonly config: AlertsConfig,
    private readonly notify: Notify = async () => undefined,
    private readonly onError: (e: unknown, f: Firing) => void = () => undefined,
  ) {
    this.log = new JsonLog(config.dir, 'alerts');
    this.map = parseAlertMap(readFileSync(config.map, 'utf8'));
  }

  /** Read the alert map again (SIGHUP): a broken one keeps the old map and throws. */
  reload(): void {
    this.map = parseAlertMap(readFileSync(this.config.map, 'utf8'));
  }

  /** The link that opens `route`'s runbook for alert `a`, and what it is missing. */
  async linkFor(route: Route, a: Alert): Promise<{ link: string; problem?: string }> {
    const problems: string[] = [];
    let sha256: string | undefined;
    if (this.config.libraryDir) {
      const text = await readLibraryFile(this.config.libraryDir, route.runbook);
      if (text === undefined) problems.push(`${route.runbook} is not in the library`);
      else sha256 = sha256Hex(text.replace(/^﻿/, ''));
    }
    let host: string | undefined;
    if (route.host !== undefined) {
      host = fill(route.host, a);
      if (!HOST_NAME_RE.test(host)) {
        problems.push(`host ${JSON.stringify(host.slice(0, 64))} is not a host name: left out`);
        host = undefined;
      }
    }
    const params: Record<string, string> = {};
    for (const [k, t] of Object.entries(route.params)) params[k] = fill(t, a);
    const line = (s: string): string => s.replace(/[\r\n\t]+/g, ' ').trim();
    if (a.labels.alertname) params.ALERT = line(a.labels.alertname).slice(0, 200);
    if (a.fingerprint) params.ALERT_FINGERPRINT = a.fingerprint;
    if (a.startsAt) params.ALERT_STARTS_AT = line(a.startsAt);
    const pairs = route.alertLabels.flatMap((l) => (a.labels[l] ? [`${l}=${a.labels[l]!.replace(/[,=\r\n]+/g, ' ')}`] : []));
    if (pairs.length > 0) params.ALERT_LABELS = pairs.join(',');
    const url = `${this.config.publicUrl}${this.config.libraryPath}${encodePath(route.runbook)}`;
    const link = formatRunbookLink({ url, ...(sha256 ? { sha256 } : {}), ...(host ? { host } : {}), params }, `${this.config.publicUrl}/open`);
    return { link, ...(problems.length > 0 ? { problem: problems.join('; ') } : {}) };
  }

  /** Record each alert of a webhook, with its link when a route takes it; firing ones go to notify(). */
  async receive(body: string, now = new Date()): Promise<Firing[]> {
    const { receiver, alerts } = parseWebhook(body);
    const out: Firing[] = [];
    for (const a of alerts) {
      const route = routeOf(this.map, a);
      const linked = route ? await this.linkFor(route, a) : undefined;
      const firing: Firing = {
        received: now.toISOString(),
        status: a.status,
        alertname: (a.labels.alertname ?? '').slice(0, 200),
        ...(a.fingerprint ? { fingerprint: a.fingerprint } : {}),
        ...(a.startsAt ? { startsAt: a.startsAt } : {}),
        ...(a.endsAt ? { endsAt: a.endsAt } : {}),
        labels: a.labels,
        ...(receiver ? { receiver } : {}),
        ...(route ? { runbook: route.runbook } : {}),
        ...(linked ? { link: linked.link } : {}),
        ...(linked?.problem ? { problem: linked.problem } : {}),
      };
      await this.log.append(firing, now);
      out.push(firing);
      if (firing.status === 'firing' && firing.link) {
        try {
          await this.notify(firing);
        } catch (e) {
          this.onError(e, firing);
        }
      }
    }
    return out;
  }

  /** The newest alerts recorded, newest first (only those of `alertname`, when given). */
  recent(limit: number, alertname?: string): Promise<Firing[]> {
    return this.log.recent<Firing>((f) => typeof f?.alertname === 'string' && (alertname === undefined || f.alertname === alertname), limit);
  }
}
