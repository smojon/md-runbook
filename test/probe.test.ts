import { strict as assert } from 'node:assert';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import * as tls from 'node:tls';
import { after, before, describe, it } from 'node:test';
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

/**
 * The script itself (apps/ops/md-runbook-probe), against TLS servers this test starts on
 * 127.0.0.1 with two private CAs. SSL_CERT_FILE and SSL_CERT_DIR stand in for the system's CAs
 * (CA B), so what --ca adds to them is visible. The probe needs getent, GNU date and timeout:
 * Linux only, as on the ops host. It runs from a copy whose gate.conf path is in the test's folder.
 */
const PROBE = path.resolve(__dirname, '..', '..', 'apps', 'ops', 'md-runbook-probe');
const probeSkip = ((): string | false => {
  if (process.platform !== 'linux') return 'md-runbook-probe runs on Linux (getent, GNU date)';
  const r = spawnSync('bash', ['-c', 'for c in getent openssl timeout; do command -v "$c" >/dev/null || exit 1; done']);
  return r.status === 0 ? false : 'needs bash, getent, openssl and timeout';
})();

describe('md-runbook-probe, the script', { skip: probeSkip }, () => {
  let dir = '';
  let script = '';
  let gateConf = '';
  const servers: tls.Server[] = [];
  let portA = 0; // certificate from CA A (trusted only with --ca or --ca-only)
  let portB = 0; // certificate from CA B (the "system" CA)

  const openssl = (...args: string[]): void => void execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
  const listen = async (name: string): Promise<number> => {
    const read = (ext: string) => fs.readFileSync(path.join(dir, `${name}.${ext}`));
    const server = tls.createServer({ key: read('key'), cert: read('pem') }, (s) => s.end());
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return (server.address() as AddressInfo).port;
  };
  /** Async: the TLS servers answer from this process. `input` goes to stdin (for `-`). */
  const probe = (args: string[], env: Record<string, string> = {}, input = ''): Promise<{ code: number | null; out: string; err: string }> =>
    new Promise((resolve) => {
      const base = { ...process.env };
      delete base.MD_RUNBOOK_PROBE_LOG;
      const p = spawn('bash', [script, '--timeout', '3', ...args], {
        env: { ...base, SSL_CERT_FILE: path.join(dir, 'ca-b.pem'), SSL_CERT_DIR: path.join(dir, 'no-certs'), ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      p.stdin.on('error', () => undefined);
      p.stdin.end(input);
      let out = '';
      let err = '';
      p.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
      p.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')));
      p.on('close', (code) => resolve({ code, out, err }));
    });

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdrb-probe-'));
    fs.mkdirSync(path.join(dir, 'no-certs'));
    gateConf = path.join(dir, 'gate.conf');
    script = path.join(dir, 'md-runbook-probe');
    fs.writeFileSync(script, fs.readFileSync(PROBE, 'utf8').split('/etc/md-runbook/gate.conf').join(gateConf));
    const ec = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes'];
    for (const ca of ['ca-a', 'ca-b']) openssl('req', '-x509', ...ec, '-keyout', `${ca}.key`, '-out', `${ca}.pem`, '-days', '30', '-subj', `/CN=${ca}`);
    fs.writeFileSync(path.join(dir, 'san.ext'), 'subjectAltName=IP:127.0.0.1\n');
    for (const [srv, ca] of [
      ['srv-a', 'ca-a'],
      ['srv-b', 'ca-b'],
    ]) {
      openssl('req', ...ec, '-keyout', `${srv}.key`, '-out', `${srv}.csr`, '-subj', `/CN=${srv}`);
      openssl('x509', '-req', '-in', `${srv}.csr`, '-CA', `${ca}.pem`, '-CAkey', `${ca}.key`, '-CAcreateserial', '-days', '300', '-extfile', 'san.ext', '-out', `${srv}.pem`);
    }
    portA = await listen('srv-a');
    portB = await listen('srv-b');
  });
  after(() => {
    for (const s of servers) s.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  const caA = () => path.join(dir, 'ca-a.pem');
  const a = () => `tls://127.0.0.1:${portA}`;
  const b = () => `tls://127.0.0.1:${portB}`;
  const verdicts = (out: string): string[] =>
    out
      .trimEnd()
      .split('\n')
      .map((l) => (/certificate trusted/.test(l) ? 'trusted' : /not trusted/.test(l) ? 'untrusted' : l));

  it("--ca adds a CA to the system's; --ca-only trusts that CA alone", async () => {
    const none = await probe([a(), b()]);
    assert.deepEqual([none.code, verdicts(none.out)], [1, ['untrusted', 'trusted']], none.out + none.err);
    const added = await probe(['--ca', caA(), a(), b()]);
    assert.deepEqual([added.code, verdicts(added.out)], [0, ['trusted', 'trusted']], added.out + added.err);
    const only = await probe(['--ca-only', caA(), a(), b()]);
    assert.deepEqual([only.code, verdicts(only.out)], [1, ['trusted', 'untrusted']], only.out + only.err);
    // A missing default folder: s_client would give up on it, so it is left out.
    const noDir = await probe(['--ca', caA(), a(), b()], { SSL_CERT_DIR: path.join(dir, 'missing') });
    assert.deepEqual([noDir.code, verdicts(noDir.out)], [0, ['trusted', 'trusted']], noDir.out + noDir.err);
    assert.equal((await probe(['--ca', caA(), '--ca-only', caA(), a()])).code, 2);
    assert.equal((await probe(['--ca-only', path.join(dir, 'missing.pem'), a()])).code, 2);
  });

  it('the text lines are what the run record reads', async () => {
    const r = await probe(['--ca', caA(), a(), `127.0.0.1:${portA}`]);
    assert.equal(r.code, 0, r.out + r.err);
    const [tlsLine, tcpLine] = r.out.trimEnd().split('\n');
    assert.match(tlsLine!, new RegExp(`^OK {4}127\\.0\\.0\\.1:${portA} +127\\.0\\.0\\.1, tcp \\d+ms, certificate trusted, \\d+ days left \\(\\d{4}-\\d\\d-\\d\\d\\), CN=srv-a, issuer ca-a$`));
    // Not a TLS port: without tls:// only TCP is checked.
    assert.match(tcpLine!, new RegExp(`^OK {4}127\\.0\\.0\\.1:${portA} +127\\.0\\.0\\.1, tcp \\d+ms$`));
    const checks = parseProbeOutput(r.out);
    assert.deepEqual([checks.length, checks[0]!.ok, typeof checks[0]!.daysLeft], [2, true, 'number']);
  });

  it('tls:// and tcp:// decide per target, over --tls and --no-tls', async () => {
    const forced = await probe(['--no-tls', '--ca', caA(), a(), `tcp://127.0.0.1:${portA}`]);
    assert.equal(forced.code, 0, forced.out + forced.err);
    const [tlsLine, tcpLine] = forced.out.trimEnd().split('\n');
    assert.match(tlsLine!, /certificate trusted/);
    assert.match(tcpLine!, /, tcp \d+ms$/);
    const all = await probe(['--tls', `tcp://127.0.0.1:${portA}`]);
    assert.match(all.out, /, tcp \d+ms\n$/);
    // tcp:// has no default port; the rest is as strict as for any target.
    const bad = await probe(['tcp://127.0.0.1', 'tls://-oProxyCommand=x:443', 'tcp://a;b:1']);
    assert.equal(bad.code, 1);
    assert.equal((bad.out.match(/ not a host name, address or URL$/gm) ?? []).length, 3, bad.out);
  });

  it('--format json: one object per target and line, with the labels', async () => {
    const r = await probe(['--format', 'json', '--ca', caA(), '--label', 'component=proxy', '--label', 'note=a "b" \\c', a(), `tcp://127.0.0.1:${portB}`, '127.0.0.1:1', 'a;b']);
    assert.equal(r.code, 1, r.err);
    const objs = r.out
      .trimEnd()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.equal(objs.length, 4);
    const [tlsOk, tcpOk, down, invalid] = objs;
    assert.deepEqual(
      [tlsOk!.target, tlsOk!.ok, tlsOk!.address, tlsOk!.reachable, typeof tlsOk!.tcp_ms, tlsOk!.tls, tlsOk!.trusted, tlsOk!.subject, tlsOk!.issuer],
      [`127.0.0.1:${portA}`, true, '127.0.0.1', true, 'number', true, true, 'srv-a', 'ca-a'],
    );
    assert.match(String(tlsOk!.not_after), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    assert.ok(Number(tlsOk!.days_left) >= 298, String(tlsOk!.days_left));
    assert.match(String(tlsOk!.detail), /^127\.0\.0\.1, tcp \d+ms, certificate trusted, /);
    assert.deepEqual(tlsOk!.labels, { component: 'proxy', note: 'a "b" \\c' });
    assert.deepEqual([tcpOk!.ok, tcpOk!.reachable, tcpOk!.tls, tcpOk!.trusted, tcpOk!.not_after, tcpOk!.days_left], [true, true, false, null, null, null]);
    assert.deepEqual([down!.ok, down!.address, down!.reachable, down!.tcp_ms], [false, '127.0.0.1', false, null]);
    assert.deepEqual([invalid!.ok, invalid!.target, invalid!.detail], [false, 'ab', 'not a host name, address or URL']);
    // --no-verify: trust isn't checked, so it is neither true nor false.
    const nv = await probe(['--format', 'json', '--no-verify', a()]);
    assert.equal((JSON.parse(nv.out) as { trusted: unknown }).trusted, null);
  });

  it('--format prometheus: gauges per target, the labels escaped, a target listed twice once', async () => {
    const r = await probe(['--format=prometheus', '--ca', caA(), '--label', 'component=proxy', '--label', 'note=a "b" \\c', a(), a(), `tcp://127.0.0.1:${portB}`, '127.0.0.1:1']);
    assert.equal(r.code, 1, r.err);
    const lines = r.out.trimEnd().split('\n');
    const families = ['ok', 'reachable', 'certificate_expiry_timestamp_seconds', 'last_run_timestamp_seconds'].map((n) => `md_runbook_probe_${n}`);
    assert.deepEqual(
      lines.filter((l) => l.startsWith('# TYPE ')),
      families.map((f) => `# TYPE ${f} gauge`),
    );
    assert.equal(lines.filter((l) => l.startsWith('# HELP ')).length, 4);
    const samples = new Map<string, number>();
    for (const l of lines.filter((x) => !x.startsWith('#'))) {
      const m = /^([a-z_]+)(\{.*\}) (\d+)$/.exec(l);
      assert.ok(m, l);
      assert.equal(samples.has(m[1]! + m[2]!), false, `twice: ${l}`);
      samples.set(m[1]! + m[2]!, Number(m[3]));
    }
    const at = (port: number) => `{target="127.0.0.1:${port}",component="proxy",note="a \\"b\\" \\\\c"}`;
    assert.equal(samples.get(`md_runbook_probe_ok${at(portA)}`), 1);
    assert.equal(samples.get(`md_runbook_probe_ok${at(portB)}`), 1);
    assert.equal(samples.get(`md_runbook_probe_ok${at(1)}`), 0);
    assert.equal(samples.get(`md_runbook_probe_reachable${at(portB)}`), 1);
    assert.equal(samples.get(`md_runbook_probe_reachable${at(1)}`), 0);
    const expiry = samples.get(`md_runbook_probe_certificate_expiry_timestamp_seconds${at(portA)}`)!;
    assert.ok(expiry > Date.now() / 1000 + 298 * 86400, String(expiry));
    // Only TLS targets with a certificate have an expiry.
    assert.equal(samples.has(`md_runbook_probe_certificate_expiry_timestamp_seconds${at(portB)}`), false);
    assert.ok(Math.abs(samples.get(`md_runbook_probe_last_run_timestamp_seconds${at(1)}`)! - Date.now() / 1000) < 60);
    assert.equal(samples.size, 3 + 3 + 1 + 3);
  });

  it('--format and --label are checked: bad usage is exit 2, before any check', async () => {
    for (const args of [
      ['--format', 'xml'],
      ['--label', '1x=y'],
      ['--label', 'target=x'],
      ['--label', '__name__=x'],
      ['--label', 'novalue'],
      ['--label', 'a='],
      ['--label', 'a-b=c'],
      ['--label', 'a=1', '--label', 'a=2'],
      ['--label', 'a=x\ty'],
      ['--label', 'a=x\ny'],
    ]) {
      const r = await probe([...args, a()], { MD_RUNBOOK_PROBE_LOG: 'stderr' });
      assert.deepEqual([r.code, r.out], [2, ''], `${JSON.stringify(args)}: ${r.err}`);
      assert.doesNotMatch(r.err, /"event":"probe"/);
    }
  });

  it('audit events outside the gate: MD_RUNBOOK_PROBE_LOG names a file or stderr', async () => {
    const file = path.join(dir, 'probe.log');
    const r = await probe(['--ca', caA(), a(), '127.0.0.1:1'], { MD_RUNBOOK_PROBE_LOG: file });
    assert.equal(r.err, '');
    const audit = buildAudit(parseGateLog(fs.readFileSync(file, 'utf8')).events);
    assert.deepEqual(
      audit.probes.map((p) => [p.target, p.ok, typeof p.daysLeft, /^[0-9a-f]{64}$/.test(p.certSha256 ?? '')]),
      [
        [`127.0.0.1:${portA}`, true, 'number', true],
        ['127.0.0.1:1', false, 'undefined', false],
      ],
    );
    const s = await probe([a()], { MD_RUNBOOK_PROBE_LOG: 'stderr' });
    assert.match(s.out, /^FAIL /);
    assert.equal(parseGateLog(s.err).events.filter((e) => e.event === 'probe').length, 1, s.err);
    assert.equal((await probe([a()])).err, '');
  });

  it('labels per target: on a stdin line for its targets, on the command line for the one before; over --label', async () => {
    const tcpB = `tcp://127.0.0.1:${portB}`;
    const lines = [`${a()} component=proxy`, `${tcpB} component=auth`, `${tcpB} component=admin4`, `${tcpB}   component=admin4`, '127.0.0.1:1 127.0.0.1:2 tier=db'];
    const r = await probe(['--format', 'prometheus', '--ca', caA(), '--label', 'cluster=c1', '--label', 'component=default', '-'], {}, lines.join('\n') + '\n');
    assert.equal(r.code, 1, r.err);
    // One series per target and labels: the two mariadb-like lines are two, the repeated one once.
    const ok = r.out.split('\n').filter((l) => l.startsWith('md_runbook_probe_ok{'));
    assert.deepEqual(ok, [
      `md_runbook_probe_ok{target="127.0.0.1:${portA}",cluster="c1",component="proxy"} 1`,
      `md_runbook_probe_ok{target="127.0.0.1:${portB}",cluster="c1",component="auth"} 1`,
      `md_runbook_probe_ok{target="127.0.0.1:${portB}",cluster="c1",component="admin4"} 1`,
      `md_runbook_probe_ok{target="127.0.0.1:1",cluster="c1",component="default",tier="db"} 0`,
      `md_runbook_probe_ok{target="127.0.0.1:2",cluster="c1",component="default",tier="db"} 0`,
    ]);
    assert.equal(r.out.split('\n').filter((l) => l.startsWith('md_runbook_probe_certificate_expiry_timestamp_seconds{')).length, 1);

    const j = await probe(['--format', 'json', '--label', 'cluster=c1', `tcp://127.0.0.1:${portA}`, 'component=proxy', 'note=a "b" \\c', tcpB]);
    assert.equal(j.code, 0, j.err);
    const labels = j.out
      .trimEnd()
      .split('\n')
      .map((l) => (JSON.parse(l) as { labels: unknown }).labels);
    assert.deepEqual(labels, [{ cluster: 'c1', component: 'proxy', note: 'a "b" \\c' }, { cluster: 'c1' }]);

    // Text: no labels; the same target with other labels is another line.
    const t = await probe(['-'], {}, `tcp://127.0.0.1:${portA} component=x\ntcp://127.0.0.1:${portA} component=y\n`);
    assert.equal(t.code, 0, t.err);
    const re = new RegExp(`^OK {4}127\\.0\\.0\\.1:${portA} +127\\.0\\.0\\.1, tcp \\d+ms$`);
    assert.deepEqual(
      t.out
        .trimEnd()
        .split('\n')
        .map((l) => re.test(l)),
      [true, true],
    );
    assert.equal(parseProbeOutput(t.out).length, 2);
  });

  it('labels per target are checked like --label; a word that is no label is a target, checked as before', async () => {
    for (const args of [['component=x', a()], [a(), 'target=x'], [a(), '__a=1'], [a(), 'a=1', 'a=2'], [a(), 'a='], [a(), 'a=x\ty'], ['-', 'a=1']]) {
      const r = await probe([...args, '--format', 'json'], { MD_RUNBOOK_PROBE_LOG: 'stderr' }, `${a()}\n`);
      assert.deepEqual([r.code, r.out], [2, ''], `${JSON.stringify(args)}: ${r.err}`);
      assert.doesNotMatch(r.err, /"event":"probe"/);
    }
    for (const input of ['component=x 127.0.0.1:1\n', '127.0.0.1:1 a=1 a=2\n', '127.0.0.1:1 target=x\n']) {
      const r = await probe(['-'], {}, input);
      assert.deepEqual([r.code, r.out], [2, ''], `${JSON.stringify(input)}: ${r.err}`);
    }
    // Not NAME= at the start: a target, which fails the check. No globbing of words from stdin.
    const odd = await probe(['--format', 'json', '-'], {}, '127.0.0.1:1 1x=y a-b=c c=*\n');
    assert.equal(odd.code, 1);
    const objs = odd.out
      .trimEnd()
      .split('\n')
      .map((l) => JSON.parse(l) as { target: string; detail: string; labels: unknown });
    assert.deepEqual(
      objs.map((o) => [o.target, o.labels]),
      [
        ['127.0.0.1:1', { c: '*' }],
        ['1xy', { c: '*' }],
        ['a-bc', { c: '*' }],
      ],
    );
    assert.equal(objs[1]!.detail, 'not a host name, address or URL');
  });

  it("an audit log it can't write: one warning on stderr, the output and exit code as without", async () => {
    const log = path.join(dir, 'missing', 'probe.log');
    const r = await probe(['--format', 'json', a(), b()], { MD_RUNBOOK_PROBE_LOG: log });
    assert.equal(r.code, 1);
    assert.equal(r.out.trimEnd().split('\n').length, 2);
    assert.equal(r.err, `md-runbook-probe: can't write the audit log ${log}: these checks are not logged\n`);
  });

  it('where the gate runs it, gate.conf decides and MD_RUNBOOK_PROBE_LOG changes nothing', async () => {
    const gateLog = path.join(dir, 'gate.log');
    const envLog = path.join(dir, 'env.log');
    fs.writeFileSync(gateConf, `unsigned = allow\nlog = ${gateLog}\n`);
    try {
      const r = await probe([b()], { MD_RUNBOOK_PROBE_LOG: envLog, MD_RUNBOOK_GATE_RUN: 'r1' });
      assert.equal(r.code, 0, r.out + r.err);
      assert.equal(fs.existsSync(envLog), false);
      const [ev] = parseGateLog(fs.readFileSync(gateLog, 'utf8')).events;
      assert.deepEqual([ev?.event, ev?.run, ev?.result], ['probe', 'r1', 'ok']);
      assert.equal((await probe([b()], { MD_RUNBOOK_PROBE_LOG: 'stderr' })).err, '');
    } finally {
      fs.rmSync(gateConf);
    }
  });
});
