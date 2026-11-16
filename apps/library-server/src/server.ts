/**
 * md-runbook's library server: behind the same reverse proxy as the web app, which keeps serving
 * the library folder read-only at /runbooks/.
 *
 *   GET    /healthz                          200 "ok"
 *   GET    /v1/server-info                   {"name":"md-runbook-library-server","protocol":1,"version":…,"capabilities":[…]}
 *   POST   /v1/library/runbooks/<path>       a signed runbook (upload token)
 *   DELETE /v1/library/runbooks/<path>       with LIBRARY_ALLOW_DELETE=true (upload token)
 *   POST   /v1/runs                          a run summary, or its signed envelope (RUNS_TOKENS / RUNS_GATE_TOKENS / RUNS_SEPARATED_GATE_TOKENS when set)
 *   GET    /v1/runs?runbook=…&limit=…        recent runs (read token)
 *   GET    /v1/runs/last-green?runbook=…     the last green run (read token)
 *   POST   /v1/alerts                        Alertmanager's webhook (ALERTS_TOKENS when set)
 *   GET    /v1/alerts/recent?limit=…         recent alerts with their links (read token)
 *   POST   /v1/devices                       a phone that gets firing alerts as pushes (device token)
 *   DELETE /v1/devices/<id>                  that phone no longer (device token)
 *
 * Tokens travel as `Authorization: Bearer …` only, never in URLs, and are never logged; each is
 * logged by its name (`label:token`) or a short hash. Bodies are capped, clients rate-limited,
 * and a client that fails the token check too often is refused for a while.
 */
import { IncomingMessage, Server, ServerResponse, createServer } from 'node:http';
import { Alerts, Notify } from './alerts';
import type { ServerConfig, Token } from './config';
import { DEVICE_ID_RE, Devices, parseRegistration, tokenDigest } from './devices';
import { HttpError, LogEvent, RateLimit, bearer, clientOf, limitOf, readBody, sendJson, tokenSet } from './http';
import { Library, decodePath } from './library';
import { ApnsSender, FcmSender, PushService, Senders } from './push';
import { Runs } from './runs';

export const PROTOCOL = 1;

export interface LibraryServer {
  server: Server;
  library?: Library;
  runs?: Runs;
  alerts?: Alerts;
  push?: PushService;
  close(): Promise<void>;
}

export interface ServerOptions {
  log?: (e: LogEvent) => void;
  /** What happens with a firing alert that has a link (default: the pushes, when they are set up). */
  notify?: Notify;
  /** The push senders (default: FCM and APNs from the settings); tests give other addresses. */
  senders?: Senders;
}

const LIBRARY_PREFIX = '/v1/library/runbooks/';
const DEVICES_PREFIX = '/v1/devices/';

export function createLibraryServer(config: ServerConfig, version: string, opts: ServerOptions = {}): LibraryServer {
  const log = opts.log ?? defaultLog;
  const library = config.library ? new Library(config.library, config.stateDir, config.sshKeygen) : undefined;
  const runs = config.runs ? new Runs(config.runs, config.sshKeygen) : undefined;
  const push =
    config.push && config.alerts
      ? new PushService(
          config.push,
          new Devices(config.push.file, config.push.maxDevices, config.push.maxDevicesPerToken, new Map(config.push.tokens.map((t) => [tokenDigest(t.value), t.label]))),
          opts.senders ?? {
            ...(config.push.fcm ? { android: new FcmSender(config.push.fcm) } : {}),
            ...(config.push.apns ? { ios: new ApnsSender(config.push.apns) } : {}),
          },
          log,
        )
      : undefined;
  const alerts = config.alerts
    ? new Alerts(config.alerts, opts.notify ?? push?.notify,(e, f) => log({ event: 'notify-failed', alertname: f.alertname, why: e instanceof Error ? e.message : String(e) }))
    : undefined;

  const check = {
    upload: tokenSet(config.library?.uploadTokens ?? []),
    runs: tokenSet(config.runs?.tokens ?? []),
    gate: tokenSet(config.runs?.gateTokens ?? []),
    separatedGate: tokenSet(config.runs?.separatedGateTokens ?? []),
    runsRead: tokenSet(config.runs?.readTokens ?? []),
    alerts: tokenSet(config.alerts?.tokens ?? []),
    alertsRead: tokenSet(config.alerts?.readTokens ?? []),
    devices: tokenSet(config.push?.tokens ?? []),
  };
  const rate = new RateLimit(config.ratePerMinute, 60_000);
  const failures = new RateLimit(0, config.failWindowMs);
  const capabilities = [...(library ? ['library'] : []), ...(runs ? ['runs'] : []), ...(alerts ? ['alerts'] : []), ...(push ? ['push'] : [])];

  const corsOrigin = (origin: string | undefined): string | undefined => (origin && config.origins.includes(origin) ? origin : undefined);

  /** The token a request must carry, from one of `sets`; 401 (counted as a failure) otherwise. */
  const need = (req: IncomingMessage, client: string, what: string, ...sets: ((t: string | undefined) => Token | undefined)[]): Token => {
    const given = bearer(req);
    for (const s of sets) {
      const t = s(given);
      if (t) return t;
    }
    failures.add(client);
    throw new HttpError(401, given === undefined ? `${what} needs a token (Authorization: Bearer …)` : `${what}: the token is not one this server accepts`);
  };

  async function handle(req: IncomingMessage, res: ServerResponse, client: string, headers: Record<string, string>): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://library');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (method === 'GET' && path === '/healthz') return void res.writeHead(200, { ...headers, 'content-type': 'text/plain' }).end('ok');
    if (method === 'GET' && path === '/v1/server-info') return sendJson(res, 200, { name: 'md-runbook-library-server', protocol: PROTOCOL, version, capabilities }, headers);
    if (!path.startsWith('/v1/')) throw new HttpError(404, 'not found');

    if (failures.count(client) >= config.maxFailures) throw new HttpError(429, 'too many failed tokens: try again later');
    if (!rate.take(client)) throw new HttpError(429, 'too many requests: try again in a minute');

    // ---- publishing ----
    if (path.startsWith(LIBRARY_PREFIX)) {
      if (!library) throw new HttpError(404, 'this server has no library (LIBRARY_DIR)');
      if (method !== 'POST' && method !== 'DELETE') throw new HttpError(405, 'POST or DELETE');
      const token = need(req, client, 'publishing', check.upload);
      const rel = decodePath(path.slice(LIBRARY_PREFIX.length));
      if (method === 'DELETE') {
        if (!library.config.allowDelete) throw new HttpError(405, 'deleting is off on this server (LIBRARY_ALLOW_DELETE)');
        const r = await library.remove(rel);
        log({ event: 'delete', client, token: token.label, path: r.path, version: r.version });
        return sendJson(res, 200, { deleted: r.path, version: r.version }, headers);
      }
      const text = await readBody(req, library.config.maxBytes);
      try {
        const r = await library.publish(rel, text);
        log({ event: r.unchanged ? 'publish-unchanged' : 'publish', client, token: token.label, path: r.path, name: r.name, version: r.version, previous: r.previous, signer: r.signer, manifest: r.manifest });
        return sendJson(res, r.unchanged ? 200 : 201, { path: r.path, name: r.name, version: r.version, previous: r.previous, signer: r.signer, manifest: r.manifest, manifestVersion: r.manifestVersion, ...(r.unchanged ? { unchanged: true } : {}) }, headers);
      } catch (e) {
        if (e instanceof HttpError) log({ event: 'publish-refused', client, token: token.label, path: rel, status: e.status, why: e.message });
        throw e;
      }
    }

    // ---- run summaries ----
    if (path === '/v1/runs' || path === '/v1/runs/last-green') {
      if (!runs) throw new HttpError(404, 'this server keeps no run summaries (RUNS_DIR)');
      if (method === 'POST' && path === '/v1/runs') {
        let token: { label: string; gate: boolean; separated?: boolean } | undefined;
        const given = bearer(req);
        // A separated gate's token is a gate token too; only it may send gate_mode separated.
        const separatedGate = check.separatedGate(given);
        const gate = separatedGate ? undefined : check.gate(given);
        if (separatedGate) token = { label: separatedGate.label, gate: true, separated: true };
        else if (gate) token = { label: gate.label, gate: true };
        else if (runs.config.tokens.length > 0) token = { label: need(req, client, 'sending a run summary', check.runs).label, gate: false };
        else if (given !== undefined) {
          // No tokens asked for: a token sent anyway is only a name for the log, if it is one.
          const t = check.runs(given);
          if (t) token = { label: t.label, gate: false };
        }
        const body = await readBody(req, runs.config.maxBytes);
        try {
          const r = await runs.receive(body, { from: client, ...(token ? { token } : {}) });
          const s = r.summary;
          log({ event: 'run', client, token: token?.label, runbook: s.runbook.signed?.name ?? s.runbook.file, version: s.runbook.signed?.version, who: s.who, from: s.client, green: s.green, trust: r.trust, gateMode: r.gateMode, runner: r.runner });
          return sendJson(res, 202, { received: r.received, trust: r.trust, verified: r.verified, ...(r.gateMode ? { gateMode: r.gateMode } : {}), ...(r.runner ? { runner: r.runner } : {}), ...(r.why ? { why: r.why } : {}) }, headers);
        } catch (e) {
          if (e instanceof HttpError) log({ event: 'run-refused', client, token: token?.label, status: e.status, why: e.message });
          throw e;
        }
      }
      if (method !== 'GET') throw new HttpError(405, path === '/v1/runs' ? 'POST or GET' : 'GET');
      if (runs.config.readTokens.length === 0) throw new HttpError(403, 'reading runs is off on this server (RUNS_READ_TOKENS)');
      need(req, client, 'reading runs', check.runsRead);
      const q = url.searchParams.get('runbook') ?? undefined;
      if (path === '/v1/runs/last-green') {
        if (!q) throw new HttpError(400, 'runbook=: a signed name or a path in the library');
        // The library's copy may ask for a gate in separated mode (report-runs-required: separated).
        const separated = library ? await library.separatedRequired(q) : false;
        return sendJson(res, 200, { runbook: q, ...(await runs.lastGreen(q, { separated })) }, headers);
      }
      return sendJson(res, 200, { runbook: q, runs: await runs.list(q, limitOf(url, 50, 500)) }, headers);
    }

    // ---- alerts ----
    if (path === '/v1/alerts' || path === '/v1/alerts/recent') {
      if (!alerts) throw new HttpError(404, 'this server takes no alerts (ALERT_MAP)');
      if (path === '/v1/alerts') {
        if (method !== 'POST') throw new HttpError(405, 'POST');
        if (alerts.config.tokens.length > 0) need(req, client, 'sending alerts', check.alerts);
        const firings = await alerts.receive(await readBody(req, alerts.config.maxBytes));
        for (const f of firings) log({ event: 'alert', client, status: f.status, alertname: f.alertname, fingerprint: f.fingerprint, runbook: f.runbook, problem: f.problem });
        return sendJson(res, 200, { recorded: firings.length, linked: firings.filter((f) => f.link).length }, headers);
      }
      if (method !== 'GET') throw new HttpError(405, 'GET');
      if (alerts.config.readTokens.length === 0) throw new HttpError(403, 'reading alerts is off on this server (ALERTS_READ_TOKENS or RUNS_READ_TOKENS)');
      need(req, client, 'reading alerts', check.alertsRead);
      return sendJson(res, 200, { alerts: await alerts.recent(limitOf(url, 50, 500), url.searchParams.get('alertname') ?? undefined) }, headers);
    }

    // ---- phones that get pushes ----
    if (path === '/v1/devices' || path.startsWith(DEVICES_PREFIX)) {
      if (!push) throw new HttpError(404, 'this server sends no pushes (PUSH_FCM_SERVICE_ACCOUNT_FILE, PUSH_APNS_KEY_FILE)');
      if (path === '/v1/devices') {
        if (method !== 'POST') throw new HttpError(405, 'POST');
        const token = need(req, client, 'registering for pushes', check.devices);
        const r = parseRegistration(await readBody(req, 16 * 1024));
        if (!push.senders[r.platform])
          throw new HttpError(
            400,
            r.platform === 'ios'
              ? "this server has no APNs key: it can't push to iPhones (PUSH_APNS_KEY_FILE)"
              : "this server has no Firebase service account: it can't push to Android (PUSH_FCM_SERVICE_ACCOUNT_FILE)",
          );
        const { device, created } = await push.devices.register(r, token);
        log({ event: created ? 'device' : 'device-updated', client, token: token.label, device: device.id, platform: device.platform });
        return sendJson(
          res,
          created ? 201 : 200,
          { id: device.id, platform: device.platform, ...(device.alertnames ? { alertnames: device.alertnames } : {}), ...(device.runbooks ? { runbooks: device.runbooks } : {}) },
          headers,
        );
      }
      if (method !== 'DELETE') throw new HttpError(405, 'DELETE');
      const token = need(req, client, 'unregistering', check.devices);
      const id = path.slice(DEVICES_PREFIX.length);
      if (!DEVICE_ID_RE.test(id)) throw new HttpError(400, 'expected /v1/devices/<id>: the id POST /v1/devices answered');
      // Only the token it registered with: another token's holder can't take a phone off.
      if (!(await push.devices.removeOwn(id, token))) throw new HttpError(404, 'no such device');
      log({ event: 'device-removed', client, token: token.label, device: id });
      return sendJson(res, 200, { deleted: id }, headers);
    }

    throw new HttpError(404, 'not found');
  }

  const server = createServer((req, res) => {
    const client = clientOf(req, config.trustProxy);
    const headers: Record<string, string> = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
    const allow = corsOrigin(req.headers.origin);
    if (allow) Object.assign(headers, { 'access-control-allow-origin': allow, vary: 'Origin' });
    if (req.method === 'OPTIONS') {
      if (allow) Object.assign(headers, { 'access-control-allow-methods': 'GET, POST, DELETE', 'access-control-allow-headers': 'authorization, content-type', 'access-control-max-age': '600' });
      return void res.writeHead(allow ? 204 : 403, headers).end();
    }
    handle(req, res, client, headers).catch((e: unknown) => {
      const status = e instanceof HttpError ? e.status : 500;
      if (!(e instanceof HttpError)) log({ event: 'error', client, path: (req.url ?? '').split('?')[0], why: e instanceof Error ? e.message : String(e) });
      if (res.headersSent) return void res.end();
      // An unread body: answer, then close, rather than reading on.
      if (!req.complete) headers.connection = 'close';
      sendJson(res, status, { error: e instanceof HttpError ? e.message : 'internal error', ...(e instanceof HttpError && e.problems ? { problems: e.problems.slice(0, 50) } : {}) }, headers);
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;

  return {
    server,
    ...(library ? { library } : {}),
    ...(runs ? { runs } : {}),
    ...(alerts ? { alerts } : {}),
    ...(push ? { push } : {}),
    close: () =>
      new Promise<void>((resolve) => {
        push?.close();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

function defaultLog(e: LogEvent): void {
  console.log(JSON.stringify({ t: new Date().toISOString(), ...e }));
}
