import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { buildAudit, filterAudit, matchRecord, parseGateLog, renderAuditReport } from '@md-runbook/core/audit';
import { buildManifest, formatManifest, withSignature } from '@md-runbook/core/signing';
import { auditCommand, parseAuditArgs } from '../src/cli/audit';

/** Lines as md-runbook-gate writes them (log_event, and the account shell's end line). */
const ev = (o: Record<string, unknown>): string => JSON.stringify({ account: 'support', who: 'SHA256:abc', client: '10.0.0.7', ...o });
const LOG = [
  ev({ time: '2026-10-26T21:01:00Z', event: 'session', unsigned: 'deny', scopes: 'web', key_scopes: '' }),
  ev({ time: '2026-10-26T21:01:02Z', event: 'load', id: '1', runbook: 'ops/restart', version: '3', hash: 'h3', signer: 'ops@example.net' }),
  ev({ time: '2026-10-26T21:01:03Z', event: 'param', id: '2', runbook: 'ops/restart', name: 'SERVICE', value: 'api' }),
  // syslog's prefix, as /var/log/syslog has it
  `Oct 26 21:02:00 web-1 md-runbook-gate[812]: ${ev({ time: '2026-10-26T21:02:00Z', event: 'run', id: '3', runbook: 'ops/restart', version: '3', hash: 'h3', signer: 'ops@example.net', cell: '1', step: '' })}`,
  '{"time":"2026-10-26T21:02:04Z","event":"end","id":"3","exit":0}',
  ev({ time: '2026-10-26T21:03:00Z', event: 'run', id: '4', runbook: 'ops/restart', version: '3', hash: 'h3', signer: 'ops@example.net', cell: '2', step: '' }),
  '{"time":"2026-10-26T21:03:01Z","event":"end","id":"4","exit":3}',
  ev({ time: '2026-10-26T21:04:00Z', event: 'refused', id: '5', reason: 'this server runs signed runbooks only' }),
  'Oct 26 21:05:00 web-1 sshd[900]: Disconnected from user support',
  ev({ time: '2026-10-26T21:05:01Z', event: 'end-session' }),
].join('\n');

const fence = (info: string, body: string): string => '```' + info + '\n' + body + '\n```\n';
const out = (ran: string, exit: string) => `<!-- md-runbook:output start exit=${exit} ran=${ran} -->\n\`\`\`text\nx\n\`\`\`\n<!-- md-runbook:output end -->\n\n`;
const RUNBOOK = '# Restart\n\n' + fence('bash', 'systemctl restart ${param:SERVICE}') + '\n' + fence('bash', 'systemctl status ${param:SERVICE}') + '\n';
const signed = (): string => {
  const m = buildManifest(RUNBOOK, { name: 'ops/restart', version: 3, scopes: ['web'], patterns: { SERVICE: '[a-z]+' } });
  if ('errors' in m) throw new Error(m.errors.join('; '));
  return withSignature(RUNBOOK, { signer: 'ops@example.net', signed: '2026-10-20', manifest: formatManifest(m.manifest), signature: 'U1NIU0lHAAAAAQ' + 'A'.repeat(150) });
};
/** The incident copy: step 1 ran at 22:02:01 local (21:02:01 UTC), step 2 at 22:30 (the log has none). */
const record = (): string =>
  signed()
    .replace(fence('bash', 'systemctl restart ${param:SERVICE}'), fence('bash', 'systemctl restart ${param:SERVICE}') + out('2026-10-26T22:02:01+01:00', '0'))
    .replace(fence('bash', 'systemctl status ${param:SERVICE}'), fence('bash', 'systemctl status ${param:SERVICE}') + out('2026-10-26T22:30:00+01:00', '0'));

describe('gate audit (core)', () => {
  it('reads gate lines, alone or after a syslog prefix, and skips the rest', () => {
    const { events, skipped } = parseGateLog(LOG);
    assert.equal(events.length, 9);
    assert.equal(skipped, 1);
  });

  it('a run has who, where, the runbook, the parameters, its exit and duration', () => {
    const a = buildAudit(parseGateLog(LOG).events);
    assert.equal(a.sessions, 1);
    assert.deepEqual(
      a.runs.map((r) => [r.time, r.who, r.client, r.runbook, r.version, r.signer, r.cell, r.params, r.exit, r.durationSeconds]),
      [
        ['2026-10-26T21:02:00Z', 'SHA256:abc', '10.0.0.7', 'ops/restart', '3', 'ops@example.net', '1', { SERVICE: 'api' }, 0, 4],
        ['2026-10-26T21:03:00Z', 'SHA256:abc', '10.0.0.7', 'ops/restart', '3', 'ops@example.net', '2', { SERVICE: 'api' }, 3, 1],
      ],
    );
    assert.deepEqual(a.findings.map((f) => [f.kind, f.detail]), [['refused', 'this server runs signed runbooks only']]);
    assert.equal(filterAudit(a, { since: new Date('2026-10-26T21:02:30Z') }).runs.length, 1);
    assert.equal(filterAudit(a, { runbook: 'ops/other' }).runs.length, 0);
  });

  it('matches a run record: the log confirms step 1 (local time vs UTC), not step 2', () => {
    const a = buildAudit(parseGateLog(LOG).events);
    const m = matchRecord(a, 'restart.2026-10-26.md', record());
    assert.equal(m.runbook, 'ops/restart');
    assert.deepEqual(m.confirmed.map((c) => c.step), [1]);
    assert.deepEqual(m.missing.map((c) => c.step), [2]);
    assert.deepEqual(a.runs[0]!.matched, { file: 'restart.2026-10-26.md', step: 1 });
    const html = renderAuditReport(a, [m], { generatedAt: new Date('2026-10-27T00:00:00Z'), sources: ['gate.log'] });
    assert.match(html, /<title>Gate audit<\/title>/);
    assert.match(html, /SERVICE=api/);
    assert.match(html, /not in the log<\/strong>: step 2/);
    assert.doesNotMatch(html, /<script/);
  });
});

describe('cli: md-runbook audit', () => {
  it('writes the report, says what it found, and exits 1 on findings', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdrb-audit-'));
    try {
      const log = path.join(dir, 'gate.log');
      fs.writeFileSync(log, LOG);
      const rec = path.join(dir, 'restart.2026-10-26.md');
      fs.writeFileSync(rec, record());
      const lines: string[] = [];
      const json = path.join(dir, 'audit.json');
      assert.equal(await auditCommand([log, '--record', rec, '--out', json], (l) => lines.push(l)), 1);
      assert.match(lines[0]!, /^2 runs in 1 session, 1 failed, 1 finding$/);
      assert.ok(lines.some((l) => /restart\.2026-10-26\.md: 1 recorded run confirmed by the log, 1 not in it \(steps 2\)/.test(l)), lines.join('\n'));
      const data = JSON.parse(fs.readFileSync(json, 'utf8'));
      assert.equal(data.format, 'md-runbook gate audit v1');
      assert.equal(data.runs.length, 2);
      // Only the clean part of the log: nothing to flag.
      lines.length = 0;
      assert.equal(await auditCommand(['-', '--until', '2026-10-26T21:02:30Z', '--out', path.join(dir, 'a.html')], (l) => lines.push(l), () => LOG), 0);
      assert.ok(fs.readFileSync(path.join(dir, 'a.html'), 'utf8').includes('Gate audit'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    assert.throws(() => parseAuditArgs([]), /missing the gate log/);
    assert.throws(() => parseAuditArgs(['x.log', '--out', 'a.txt']), /\.html, \.pdf or \.json/);
    assert.throws(() => parseAuditArgs(['x.log', '--since', 'yesterday']), /date or time/);
  });
});
