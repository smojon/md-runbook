/** md-runbook run's run reports and md-runbook verify-run (src/cli/report.ts), against a local server. */
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { buildManifest, formatManifest, withSignature } from '@md-runbook/core/signing';
import { sshSign } from '@md-runbook/core/node';
import { allowedAddresses, prepareReport, sendCliReport, summarySteps, verifyRunCommand } from '../src/cli/report';
import type { StepResult } from '../src/cli/run';

const fence = (info: string, body: string): string => '```' + info + '\n' + body + '\n```\n\n';
const step = (n: number, line: number, status: StepResult['status'], durationMs = 10): StepResult => ({ step: n, line, language: 'bash', title: `Step ${n}`, status, exit: '0', durationMs, output: 'SECRET-OUTPUT' });

describe('md-runbook run: run reports', () => {
  let dir: string;
  let key: string;
  let allowedSigners: string;
  let server: http.Server;
  let url = '';
  const got: { auth?: string; body: string }[] = [];
  let answer = 200;

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdrb-clireport-'));
    key = path.join(dir, 'key');
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'ana@example.net', '-f', key]);
    const pub = fs.readFileSync(key + '.pub', 'utf8').trim().split(' ').slice(0, 2).join(' ');
    allowedSigners = path.join(dir, 'allowed_signers');
    fs.writeFileSync(allowedSigners, `ana@example.net namespaces="md-runbook" ${pub}\n`);
    fs.writeFileSync(path.join(dir, 'allowed_runners'), `ana@example.net namespaces="md-runbook-run" ${pub}\n`);
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d: Buffer) => (body += d.toString('utf8')));
      req.on('end', () => {
        got.push({ ...(req.headers.authorization ? { auth: req.headers.authorization } : {}), body });
        res.statusCode = answer;
        res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}/runs`;
  });
  after(() => {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const runbook = (fm: string): string => `---\nreport-runs: ${url}\n${fm}---\n\n# Restart\n\n- [x] Tell the channel\n\n` + fence('bash', 'echo hi');
  const signed = async (text: string): Promise<string> => {
    const r = buildManifest(text, { name: 'ops/restart', version: 1, scopes: [], patterns: {} });
    if ('errors' in r) throw new Error(r.errors.join('; '));
    const manifest = formatManifest(r.manifest);
    return withSignature(text, { signer: 'ana@example.net', signed: '2026-11-14', manifest, signature: await sshSign(manifest, key, { interactive: false }) });
  };

  it('asks nothing: sends only to an allowed address, and says so otherwise', async () => {
    const logs: string[] = [];
    const r = await prepareReport(runbook(''), { allowed: [] }, (l) => logs.push(l));
    assert.ok(r && typeof r === 'object' && !r.send);
    assert.match(logs.join('\n'), /not sent \(allow it with --report-to-allowed 127\.0\.0\.1:\d+\)/);
    assert.deepEqual(allowedAddresses(['a.net,b.net'], { MD_RUNBOOK_REPORT_ALLOWED: 'c.net' }), ['a.net', 'b.net', 'c.net']);
  });

  it('sends the summary (no outputs), signed with --key, the token from the environment; verify-run checks it', async () => {
    got.length = 0;
    const text = runbook('report-runs-token: ${secret:REPORT_TOKEN}\n');
    const o = { allowed: [url], key };
    const r = await prepareReport(text, o, () => undefined);
    assert.ok(r && typeof r === 'object' && r.send);
    const ok = await sendCliReport(r, { file: 'restart.md', text, started: 0, ended: 1000, steps: [step(1, 9, 'passed')], manual: [{ line: 6, step: 0, text: 'Tell the channel', ticked: true }], params: { ALERT: 'ApiDown', TARGET: 'secret-host' } }, o, { REPORT_TOKEN: 't0k' }, () => undefined);
    assert.equal(ok, true);
    assert.equal(got[0]!.auth, 'Bearer t0k');
    assert.ok(!got[0]!.body.includes('SECRET-OUTPUT') && !got[0]!.body.includes('secret-host') && !got[0]!.body.includes('t0k'));
    const envelope = JSON.parse(got[0]!.body) as { summary: { steps: { state: string }[]; alert: unknown } };
    assert.deepEqual(envelope.summary.steps.map((s) => s.state), ['by-hand', 'passed']);
    assert.deepEqual(envelope.summary.alert, { name: 'ApiDown' });
    const file = path.join(dir, 'envelope.json');
    fs.writeFileSync(file, got[0]!.body);
    const out: string[] = [];
    assert.equal(await verifyRunCommand([file, '--allowed-runners', path.join(dir, 'allowed_runners')], (l) => out.push(l)), 0);
    assert.match(out[0]!, /✓ signed by ana@example\.net/);
    fs.writeFileSync(file, got[0]!.body.replace('"passed"', '"failed"'));
    assert.equal(await verifyRunCommand([file, '--allowed-runners', path.join(dir, 'allowed_runners')], () => undefined), 1);
  });

  it('a runbook signed as a whole by a trusted signer can require the report and its signature (exit 2 before the run)', async () => {
    const text = await signed(runbook('report-runs-required: true\nreport-runs-signed: true\n'));
    // Not trusted (no --allowed-signers): ignored, and nothing stops the run.
    assert.equal(typeof (await prepareReport(text, { allowed: [] }, () => undefined)), 'object');
    assert.match(String(await prepareReport(text, { allowed: [], allowedSigners }, () => undefined)), /runs only if its run is reported to 127\.0\.0\.1/);
    assert.match(String(await prepareReport(text, { allowed: [url], allowedSigners }, () => undefined)), /add --key KEY/);
    const r = await prepareReport(text, { allowed: [url], allowedSigners, key }, () => undefined);
    assert.ok(r && typeof r === 'object' && r.plan.required && r.plan.signed && r.signer === 'ana@example.net');
    // A server that refuses it: false (main makes that exit 3 when required), no retries for a 4xx.
    answer = 403;
    got.length = 0;
    const warnings: string[] = [];
    assert.equal(await sendCliReport(r, { file: 'r.md', text, started: 0, ended: 1, steps: [], manual: [], params: {} }, { allowed: [url], key }, {}, (l) => warnings.push(l), [1, 1]), false);
    assert.equal(got.length, 1);
    assert.match(warnings.join('\n'), /not sent \(the server answered 403\)/);
    answer = 503;
    got.length = 0;
    assert.equal(await sendCliReport(r, { file: 'r.md', text, started: 0, ended: 1, steps: [], manual: [], params: {} }, { allowed: [url], key }, {}, () => undefined, [1, 1]), false);
    assert.equal(got.length, 3, 'tried 3 times');
    answer = 200;
  });

  it('steps in the runbook order: blocks and checklist items', () => {
    assert.deepEqual(
      summarySteps([step(1, 3, 'passed', 5), step(2, 10, 'not run')], [{ line: 6, step: 1, text: 'Check', ticked: false }]),
      [
        { label: 'Step 1', state: 'passed', ms: 5, ran: true },
        { label: 'Check', state: 'not-run' },
        { label: 'Step 2', state: 'not-run' },
      ],
    );
  });
});
