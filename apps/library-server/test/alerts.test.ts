import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { parseRunbookLink } from '../../../packages/core/src/runbookLink';
import { sha256Hex } from '../../../packages/core/src/sha256';
import type { AlertsConfig } from '../src/config';
import { Alert, Firing, fill, parseAlertMap, routeOf } from '../src/alerts';
import { call, config, start, tok } from './helpers';

const READ = 'read-token-of-at-least-24-chars';
const AM = 'alertmanager-token-of-at-least-24';

const MAP = {
  routes: [
    {
      alertname: 'KubePodCrashLooping',
      matchers: ['namespace=~"prod-.*"', 'severity!="info"'],
      runbook: 'k8s/crashloop.md',
      host: '{{ $labels.cluster }}',
      params: { NAMESPACE: '{{ $labels.namespace }}', POD: '{{ $labels.pod }}', SUMMARY: '{{ $annotations.summary }}' },
      alertLabels: ['namespace', 'pod'],
    },
    { alertname: 'KubePodCrashLooping', runbook: 'k8s/crashloop-staging.md' },
    { matchers: ['team="db"'], runbook: 'db/restore.md' },
  ],
};

const alert = (labels: Record<string, string>, over: Partial<Alert> = {}): Alert => ({ status: 'firing', labels, annotations: {}, ...over });

describe('alerts: the alert map', () => {
  it('first route that takes the alert wins; regex matchers are anchored', () => {
    const map = parseAlertMap(JSON.stringify(MAP));
    assert.equal(routeOf(map, alert({ alertname: 'KubePodCrashLooping', namespace: 'prod-eu', severity: 'critical' }))?.runbook, 'k8s/crashloop.md');
    // "xprod-eu" doesn't match prod-.* (anchored), severity info is excluded: the next route.
    assert.equal(routeOf(map, alert({ alertname: 'KubePodCrashLooping', namespace: 'xprod-eu' }))?.runbook, 'k8s/crashloop-staging.md');
    assert.equal(routeOf(map, alert({ alertname: 'KubePodCrashLooping', namespace: 'prod-eu', severity: 'info' }))?.runbook, 'k8s/crashloop-staging.md');
    assert.equal(routeOf(map, alert({ alertname: 'DiskFull', team: 'db' }))?.runbook, 'db/restore.md');
    assert.equal(routeOf(map, alert({ alertname: 'DiskFull', team: 'web' })), undefined);
  });

  it('refuses a map it can not use, naming the route', () => {
    const bad = (routes: unknown[]): string => {
      try {
        parseAlertMap(JSON.stringify({ routes }));
        return '';
      } catch (e) {
        return (e as Error).message;
      }
    };
    assert.match(bad([{ alertname: 'A', runbook: '../etc/passwd.md' }]), /routes\[0\]\.runbook/);
    assert.match(bad([{ runbook: 'a.md' }]), /alertname, matchers, or both/);
    assert.match(bad([{ alertname: 'A', runbook: 'a.md', params: { 'bad name': 'x' } }]), /not a parameter name/);
    assert.match(bad([{ alertname: 'A', runbook: 'a.md', params: { ALERT: 'x' } }]), /filled from the alert itself/);
    assert.match(bad([{ alertname: 'A', runbook: 'a.md', params: { X: '{{ .Labels.x }}' } }]), /is not \{\{ \$labels.NAME \}\}/);
    assert.match(bad([{ alertname: 'A', runbook: 'a.md', matchers: ['severity==critical'] }]), /is not a matcher/);
    assert.match(bad([{ alertname: 'A', runbook: 'a.md', matchers: ['x=~"("'] }]), /not a regular expression/);
    assert.match(bad([{ alertname: 'A', runbook: 'a.md', extra: 1 }]), /unknown field "extra"/);
    assert.throws(() => parseAlertMap('routes: []'), /not JSON/);
  });

  it('the example map in the README is one the server reads', () => {
    const example = path.join(__dirname, '..', '..', '..', '..', 'alert-map.example.json');
    assert.equal(parseAlertMap(fs.readFileSync(example, 'utf8')).routes.length, 3);
  });

  it('templates take labels and annotations, one line', () => {
    assert.equal(fill('{{ $labels.a }}-{{$annotations.b}}-{{ $labels.missing }}', alert({ a: 'x' }, { annotations: { b: 'two\nlines' } })), 'x-two lines-');
  });
});

describe('alerts: the webhook', () => {
  let dir: string;
  let lib: string;
  const crashloop = '# Crash loop\n\n```bash\nkubectl -n ${param:NAMESPACE} delete pod ${param:POD}\n```\n';
  const alertsConfig = (over: Partial<AlertsConfig> = {}): AlertsConfig => ({
    map: path.join(dir, 'alert-map.json'),
    dir: path.join(dir, 'alerts'),
    tokens: [tok(AM, 'alertmanager')],
    readTokens: [tok(READ, 'team')],
    publicUrl: 'https://runbooks.example.net',
    libraryPath: '/runbooks/',
    libraryDir: lib,
    maxBytes: 64 * 1024,
    ...over,
  });
  const webhook = (alerts: unknown[]): string =>
    JSON.stringify({ version: '4', status: 'firing', receiver: 'md-runbook', groupKey: '{}:{}', groupLabels: {}, commonLabels: {}, commonAnnotations: {}, externalURL: 'http://am', alerts });

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdrb-alerts-'));
    lib = path.join(dir, 'library');
    fs.mkdirSync(path.join(lib, 'k8s'), { recursive: true });
    fs.writeFileSync(path.join(lib, 'k8s', 'crashloop.md'), '﻿' + crashloop);
    fs.writeFileSync(path.join(dir, 'alert-map.json'), JSON.stringify(MAP));
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('records each alert with the link that opens its runbook, pinned to the hash, with the alert as parameters', async () => {
    const notified: Firing[] = [];
    const { s, url, logs } = await start(config(dir, { alerts: alertsConfig() }), { notify: async (f) => void notified.push(f) });
    try {
      const body = webhook([
        {
          status: 'firing',
          labels: { alertname: 'KubePodCrashLooping', namespace: 'prod-eu', pod: 'api-7f9', cluster: 'prod-eu-1', severity: 'critical' },
          annotations: { summary: 'Pod api-7f9 restarts & fails' },
          startsAt: '2026-11-14T08:58:00.123Z',
          endsAt: '0001-01-01T00:00:00Z',
          fingerprint: '5f3c9e1a2b',
        },
        { status: 'firing', labels: { alertname: 'Unmapped' }, annotations: {}, startsAt: '2026-11-14T08:59:00Z', fingerprint: 'aa' },
        { status: 'resolved', labels: { alertname: 'KubePodCrashLooping', namespace: 'staging' }, annotations: {}, fingerprint: 'bb' },
      ]);
      assert.equal((await call(`${url}/v1/alerts`, 'POST', body)).status, 401);
      const r = await call(`${url}/v1/alerts`, 'POST', body, AM);
      assert.deepEqual([r.status, r.json], [200, { recorded: 3, linked: 2 }]);

      const recent = await call(`${url}/v1/alerts/recent`, 'GET', undefined, READ);
      assert.equal(recent.status, 200);
      const [resolved, unmapped, firing] = recent.json.alerts as Firing[];
      assert.deepEqual([resolved!.status, resolved!.runbook], ['resolved', 'k8s/crashloop-staging.md']);
      assert.equal(resolved!.problem, 'k8s/crashloop-staging.md is not in the library');
      assert.equal(unmapped!.link, undefined);
      assert.equal(firing!.runbook, 'k8s/crashloop.md');
      assert.equal(firing!.endsAt, undefined, "Alertmanager's zero time is left out");

      const parsed = parseRunbookLink(firing!.link!);
      assert.ok(parsed.ok);
      assert.ok(firing!.link!.startsWith('https://runbooks.example.net/open?url='));
      assert.deepEqual(parsed.link, {
        url: 'https://runbooks.example.net/runbooks/k8s/crashloop.md',
        sha256: sha256Hex(crashloop),
        host: 'prod-eu-1',
        params: {
          NAMESPACE: 'prod-eu',
          POD: 'api-7f9',
          SUMMARY: 'Pod api-7f9 restarts & fails',
          ALERT: 'KubePodCrashLooping',
          ALERT_FINGERPRINT: '5f3c9e1a2b',
          ALERT_STARTS_AT: '2026-11-14T08:58:00.123Z',
          ALERT_LABELS: 'namespace=prod-eu,pod=api-7f9',
        },
      });
      // Only firing alerts with a link go to notify().
      assert.deepEqual(
        notified.map((f) => f.fingerprint),
        ['5f3c9e1a2b'],
      );
      assert.equal((await call(`${url}/v1/alerts/recent?alertname=Unmapped`, 'GET', undefined, READ)).json.alerts.length, 1);
      assert.equal((await call(`${url}/v1/alerts/recent`, 'GET')).status, 401);
      assert.ok(logs.some((e) => e.event === 'alert' && e.alertname === 'KubePodCrashLooping' && e.runbook === 'k8s/crashloop.md'));
    } finally {
      await s.close();
    }
  });

  it('a host that is not a host name is left out; a notify that fails is logged, the alert still recorded', async () => {
    const { s, url, logs } = await start(config(dir, { alerts: alertsConfig({ tokens: [] }) }), {
      notify: async () => {
        throw new Error('no push credentials');
      },
    });
    try {
      const body = webhook([{ status: 'firing', labels: { alertname: 'KubePodCrashLooping', namespace: 'prod-x', cluster: 'bad host; rm' }, annotations: {} }]);
      assert.equal((await call(`${url}/v1/alerts`, 'POST', body)).status, 200);
      const [f] = (await call(`${url}/v1/alerts/recent?limit=1`, 'GET', undefined, READ)).json.alerts as Firing[];
      assert.match(f!.problem!, /is not a host name: left out/);
      assert.ok(parseRunbookLink(f!.link!).ok);
      assert.equal((parseRunbookLink(f!.link!) as { link: { host?: string } }).link.host, undefined);
      assert.ok(logs.some((e) => e.event === 'notify-failed' && e.why === 'no push credentials'));
      assert.equal((await call(`${url}/v1/alerts`, 'POST', '{"nope":1}')).status, 400);
    } finally {
      await s.close();
    }
  });
});
