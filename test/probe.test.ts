import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { buildAudit, parseGateLog, renderAuditReport } from '@md-runbook/core/audit';
import { buildTimeline } from '@md-runbook/core/incident';
import { parseProbeOutput, usesProbe } from '@md-runbook/core/probe';
import { recordJson, renderReport } from '@md-runbook/core/report';

/** md-runbook-probe's lines, as apps/ops/md-runbook-probe prints them. */
const PROBE_OUT = [
  'OK    kubernetes.default.svc:443                10.96.0.1, tcp 3ms, certificate trusted, 364 days left (2027-10-27), CN=kube-apiserver, issuer kubernetes',
  'FAIL  shop.example.net:443                      203.0.113.9, tcp 20ms, certificate expires in 9 days (2026-11-05), under 14, CN=shop.example.net, issuer R11',
  'FAIL  old.example.net:443                       203.0.113.10, tcp 21ms, certificate EXPIRED on 2026-10-01 (26 days ago), CN=old.example.net, issuer R11',
  'FAIL  db.internal:5432                          10.0.3.4, no TCP connection within 5s (down, or a firewall)',
  'FAIL  no-such.invalid:443                       no address: the name doesn\'t resolve here (DNS)',
].join('\n');

const runbook = (cmd: string, output: string): string =>
  '---\nincident: INC-7\n---\n\n# Check\n\n```bash name="Endpoints"\n' +
  cmd +
  '\n```\n\n<!-- md-runbook:output start exit=1 ran=2026-10-27T10:00:00+01:00 ended=2026-10-27T10:00:04+01:00 duration=4.000s by=alice on=ops@ops-host -->\n```text\n' +
  output +
  '\n```\n<!-- md-runbook:output end -->\n';

describe('md-runbook-probe in the record', () => {
  it('reads each endpoint, its result and the certificate expiry from the probe lines', () => {
    const checks = parseProbeOutput(PROBE_OUT + '\nsomething else\n');
    assert.deepEqual(
      checks.map((c) => [c.target, c.ok, c.daysLeft, c.expires]),
      [
        ['kubernetes.default.svc:443', true, 364, '2027-10-27'],
        ['shop.example.net:443', false, 9, '2026-11-05'],
        ['old.example.net:443', false, -26, '2026-10-01'],
        ['db.internal:5432', false, undefined, undefined],
        ['no-such.invalid:443', false, undefined, undefined],
      ],
    );
    assert.deepEqual(parseProbeOutput('FAIL  x:1  y not trusted: self-signed certificate, expires 2027-01-02 (66 days), CN=x')[0]?.daysLeft, 66);
    assert.ok(usesProbe('kubectl get ingress | md-runbook-probe -'));
    assert.ok(!usesProbe('echo md-runbook-probe-like'));
  });

  it('the timeline, the report and the JSON export carry the checks (only of cells that run the probe)', () => {
    const text = runbook('md-runbook-probe --ca ca.crt kubernetes.default.svc shop.example.net', PROBE_OUT);
    const t = buildTimeline(text);
    assert.equal(t.events[0]?.checks?.length, 5);
    assert.deepEqual(t.summary.endpointChecks, { total: 5, failed: 4 });
    assert.equal(buildTimeline(runbook('cat saved.txt', PROBE_OUT)).events[0]?.checks, undefined);

    const html = renderReport(text, { generatedAt: new Date('2026-10-27T10:05:00Z') });
    assert.match(html, /<dt>Endpoint checks<\/dt><dd>5 · 4 failed<\/dd>/);
    assert.match(html, /<h3>Endpoint checks<\/h3>/);
    assert.match(html, /<code>shop\.example\.net:443<\/code><\/td><td><span class="badge fail">failed<\/span><\/td><td>2026-11-05 \(9 days\)<\/td>/);
    assert.match(html, /2026-10-01 \(expired 26 days ago\)/);

    const json = JSON.parse(recordJson(text, { file: 'check.md', generatedAt: new Date(), redact: (s) => s.replace('203.0.113.9', '[IP]') })) as {
      summary: { endpointChecks: unknown };
      events: { checks?: { target: string; detail: string }[] }[];
    };
    assert.deepEqual(json.summary.endpointChecks, { total: 5, failed: 4 });
    assert.match(json.events[0]!.checks![1]!.detail, /^\[IP\], tcp 20ms/);
  });

  it('md-runbook audit lists the probe events, tied to the signed run that checked them', () => {
    const ev = (o: Record<string, unknown>): string => JSON.stringify({ account: 'ops', who: 'SHA256:key', client: '10.0.0.7', ...o });
    const log = [
      ev({ time: '2026-10-27T09:00:00Z', event: 'run', id: 'a1', runbook: 'ops/check', version: '2', hash: 'h', signer: 'ops@example.net', cell: '1', step: '' }),
      ev({ time: '2026-10-27T09:00:01Z', event: 'probe', run: 'a1', target: 'shop.example.net:443', address: '203.0.113.9', result: 'fail', detail: 'certificate expires in 9 days', days_left: '9', not_after: '2026-11-05T12:00:00Z', cert_sha256: 'ab12' }),
      '{"time":"2026-10-27T09:00:02Z","event":"end","id":"a1","exit":1}',
      ev({ time: '2026-10-27T09:10:00Z', event: 'probe', target: 'db.internal:5432', address: '10.0.3.4', result: 'ok', detail: '10.0.3.4, tcp 2ms' }),
    ].join('\n');
    const a = buildAudit(parseGateLog(log).events);
    assert.equal(a.probes.length, 2);
    assert.deepEqual([a.probes[0]!.ok, a.probes[0]!.daysLeft, a.probes[0]!.run?.runbook, a.probes[0]!.certSha256], [false, 9, 'ops/check', 'ab12']);
    assert.equal(a.probes[1]!.run, undefined);
    const html = renderAuditReport(a, [], { generatedAt: new Date(), sources: ['gate.log'] });
    assert.match(html, /<h2>Endpoint checks<\/h2>/);
    assert.match(html, /<td>ops\/check v2, block 1<\/td>/);
    assert.match(html, /<td>unsigned or by hand<\/td>/);
    assert.match(html, /sha256 ab12/);
  });
});
