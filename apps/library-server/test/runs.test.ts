import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { RunSummaryReport, buildRunSummary, reportBody } from '../../../packages/core/src/runReport';
import { signRunSummary } from '../../../packages/core/src/node/runReport';
import { armorSignature } from '../../../packages/core/src/signing';
import type { RunsConfig } from '../src/config';
import { summaryMatches, summaryMismatches } from '../src/runs';
import { Keys, RUNBOOK, call, config, makeKeys, signRunbook, start, tok } from './helpers';

const READ = 'read-token-of-at-least-24-chars';
const SEND = 'send-token-of-at-least-24-chars';
const GATE = 'gate-token-of-at-least-24-chars';
const SEPARATED = 'separated-gate-token-of-24-chars';

const summary = (over: { who?: string; failed?: boolean; text?: string; file?: string; ended?: number } = {}): RunSummaryReport =>
  buildRunSummary({
    file: over.file ?? 'restart-api.md',
    text: over.text ?? RUNBOOK,
    who: over.who ?? 'ana',
    client: 'vscode',
    started: Date.UTC(2026, 10, 14, 9, 0, 0),
    ended: over.ended ?? Date.UTC(2026, 10, 14, 9, 1, 0),
    steps: [{ label: 'systemctl restart api', state: over.failed ? 'failed' : 'passed', ms: 1200, ran: true }],
    trustedSigner: 'ops@example.net',
  });

const gateSummary = (): Record<string, unknown> => ({
  v: 1,
  client: 'gate',
  runbook: { signed: { name: 'ops/restart-api', version: 1, manifest: 'ab'.repeat(32), signer: 'ops@example.net', trusted: true } },
  who: 'SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
  gate: { host: 'web-1', account: 'support', from: '192.0.2.7' },
  steps: [{ n: 1, label: 'systemctl restart api', state: 'passed' }],
  ran: [1],
  totals: { steps: 1, passed: 1, failed: 0, skipped: 0, notRun: 0, byHand: 0 },
  green: true,
  started: '2026-11-14T10:00:00Z',
  ended: '2026-11-14T10:00:00Z',
});

describe('run summaries: checking', () => {
  it('a summary must agree with its steps', () => {
    const s = summary();
    assert.deepEqual(summaryMismatches(s), []);
    assert.match(summaryMismatches({ ...s, green: false }).join('\n'), /green: false, but the steps say true/);
    assert.match(summaryMismatches({ ...s, totals: { ...s.totals, failed: 1 } }).join('\n'), /totals.failed/);
    assert.match(summaryMismatches({ ...s, ended: '2026-11-14T08:00:00.000Z' }).join('\n'), /before started/);
  });

  it('matches a runbook by its signed name, or by its path in the library', () => {
    const s = { ...summary(), runbook: { ...summary().runbook, signed: { name: 'ops/restart-api', version: 1, manifest: 'ab'.repeat(32), signer: 'x', trusted: true } } };
    assert.ok(summaryMatches(s, 'ops/restart-api'));
    assert.ok(summaryMatches(s, 'ops/restart-api.md'));
    assert.ok(summaryMatches(s, '/team/restart-api.md'));
    assert.ok(!summaryMatches(s, 'ops/stop-api.md'));
    assert.ok(!summaryMatches(s, 'restart-api'));
  });
});

describe('run summaries: the endpoint', () => {
  let keys: Keys;
  let dir: string;
  const runsConfig = (over: Partial<RunsConfig> = {}): RunsConfig => ({
    dir: path.join(dir, 'runs'),
    tokens: [],
    gateTokens: [],
    separatedGateTokens: [],
    readTokens: [tok(READ, 'team')],
    allowedRunners: keys.allowedRunners,
    requireSigned: false,
    maxBytes: 16 * 1024,
    ...over,
  });
  const fresh = (): void => {
    dir = fs.mkdtempSync(path.join(keys.dir, 'runs-'));
  };
  const lines = (): any[] =>
    fs
      .readdirSync(path.join(dir, 'runs'))
      .flatMap((f) => fs.readFileSync(path.join(dir, 'runs', f), 'utf8').split('\n'))
      .filter(Boolean)
      .map((l) => JSON.parse(l));

  before(() => {
    keys = makeKeys();
  });
  after(() => fs.rmSync(keys.dir, { recursive: true, force: true }));

  it('keeps a valid summary as one JSON line, with when it came and what the check found', async () => {
    fresh();
    const { s, url, logs } = await start(config(dir, { runs: runsConfig() }));
    try {
      const r = await call(`${url}/v1/runs`, 'POST', reportBody(summary()), undefined, { 'content-type': 'application/json' });
      assert.equal(r.status, 202, JSON.stringify(r.json));
      assert.deepEqual([r.json.trust, r.json.verified, r.json.why], ['unverified', false, 'not signed']);
      const [line] = lines();
      assert.equal(line.trust, 'unverified');
      assert.equal(line.summary.who, 'ana');
      assert.match(line.received, /^\d{4}-\d{2}-\d{2}T/);
      assert.equal(line.from, '127.0.0.1');
      assert.ok(logs.some((e) => e.event === 'run' && e.who === 'ana' && e.trust === 'unverified'));
    } finally {
      await s.close();
    }
  });

  it('is strict: unknown fields (an output), other versions and contradictions are refused, and nothing is kept', async () => {
    fresh();
    const { s, url } = await start(config(dir, { runs: runsConfig() }));
    try {
      const output = await call(`${url}/v1/runs`, 'POST', JSON.stringify({ ...summary(), output: 'hunter2' }));
      assert.equal(output.status, 400);
      assert.match(output.json.problems.join('\n'), /unknown field "output"/);
      assert.equal((await call(`${url}/v1/runs`, 'POST', JSON.stringify({ ...summary(), v: 2 }))).status, 400);
      assert.equal((await call(`${url}/v1/runs`, 'POST', JSON.stringify({ ...summary(), green: false }))).status, 400);
      assert.equal((await call(`${url}/v1/runs`, 'POST', 'not json')).status, 400);
      assert.equal((await call(`${url}/v1/runs`, 'POST', JSON.stringify(summary()).padEnd(17 * 1024, ' '))).status, 413);
      assert.ok(!fs.existsSync(path.join(dir, 'runs')));
    } finally {
      await s.close();
    }
  });

  it('checks runner signatures against the allowed runners (namespace md-runbook-run)', async () => {
    fresh();
    const { s, url } = await start(config(dir, { runs: runsConfig() }));
    try {
      const sum = summary();
      const signed = reportBody(sum, { signature: await signRunSummary(sum, keys.runner, { interactive: false }), signer: 'ana@example.net' });
      const good = await call(`${url}/v1/runs`, 'POST', signed);
      assert.deepEqual([good.status, good.json.trust, good.json.runner], [202, 'runner-signed', 'ana@example.net']);
      // A key that isn't in the allowed runners: kept, as unverified.
      const stranger = reportBody(sum, { signature: await signRunSummary(sum, keys.stranger, { interactive: false }) });
      const unknown = await call(`${url}/v1/runs`, 'POST', stranger);
      assert.deepEqual([unknown.status, unknown.json.trust], [202, 'unverified']);
      assert.ok(!unknown.json.why.includes(keys.dir), 'no server file names in the answer');
      // The summary changed after signing.
      const tampered = JSON.parse(signed);
      tampered.summary.who = 'mallory';
      assert.equal((await call(`${url}/v1/runs`, 'POST', JSON.stringify(tampered))).json.trust, 'unverified');
      // A runbook signature (namespace md-runbook) is no run summary signature.
      const runbookSig = (await signRunbook(RUNBOOK, {}, keys.runner)).match(/\nsignature\n([\s\S]*?)\n-->/)![1]!.replace(/\n/g, '');
      const asRunbook = await call(`${url}/v1/runs`, 'POST', reportBody(sum, { signature: armorSignature(runbookSig) }));
      assert.deepEqual([asRunbook.status, asRunbook.json.trust], [202, 'unverified']);
      const kept = lines();
      assert.deepEqual(
        kept.map((l) => l.trust),
        ['runner-signed', 'unverified', 'unverified', 'unverified'],
      );
      assert.match(kept[0].signature, /BEGIN SSH SIGNATURE/);
    } finally {
      await s.close();
    }
  });

  it('RUNS_REQUIRE_SIGNED refuses what no runner signed and no gate sent; RUNS_TOKENS asks for a token', async () => {
    fresh();
    const { s, url } = await start(config(dir, { runs: runsConfig({ requireSigned: true, tokens: [tok(SEND, 'clients')] }) }));
    try {
      const sum = summary();
      assert.equal((await call(`${url}/v1/runs`, 'POST', reportBody(sum))).status, 401);
      const unsigned = await call(`${url}/v1/runs`, 'POST', reportBody(sum), SEND);
      assert.deepEqual([unsigned.status, /signed by a known runner/.test(unsigned.json.error)], [403, true]);
      const signed = reportBody(sum, { signature: await signRunSummary(sum, keys.runner, { interactive: false }) });
      assert.equal((await call(`${url}/v1/runs`, 'POST', signed, SEND)).status, 202);
      assert.equal(lines()[0].token, 'clients');
    } finally {
      await s.close();
    }
  });

  it("a gate's summary (client gate) needs a gate token when there are gate tokens, and then counts as verified", async () => {
    fresh();
    const { s, url } = await start(config(dir, { runs: runsConfig({ requireSigned: true, gateTokens: [tok(GATE, 'web-1')] }) }));
    try {
      const body = JSON.stringify(gateSummary());
      const noToken = await call(`${url}/v1/runs`, 'POST', body);
      assert.deepEqual([noToken.status, /needs a gate token/.test(noToken.json.error)], [403, true]);
      const ok = await call(`${url}/v1/runs`, 'POST', body, GATE);
      assert.deepEqual([ok.status, ok.json.trust, ok.json.verified], [202, 'gate', true]);
      assert.equal(lines()[0].token, 'web-1');
      // No gate_mode: the gate's own account (shared), the strictest reading.
      assert.deepEqual([ok.json.gateMode, lines()[0].gateMode], ['shared', 'shared']);
    } finally {
      await s.close();
    }
  });

  it("a gate's mode (gate.gate_mode) is kept only when sent by a gate; any other value is refused", async () => {
    fresh();
    const { s, url, logs } = await start(config(dir, { runs: runsConfig({ gateTokens: [tok(GATE, 'web-1')], separatedGateTokens: [tok(SEPARATED, 'web-2')] }) }));
    const withMode = (mode: unknown): string =>
      JSON.stringify({ ...gateSummary(), gate: { host: 'web-1', account: 'support', ...(mode === undefined ? {} : { gate_mode: mode }) } });
    try {
      // A separated gate's token (RUNS_SEPARATED_GATE_TOKENS): its summaries say the mode they ran in.
      const separated = await call(`${url}/v1/runs`, 'POST', withMode('separated'), SEPARATED);
      assert.deepEqual([separated.status, separated.json.trust, separated.json.gateMode], [202, 'gate', 'separated']);
      const shared = await call(`${url}/v1/runs`, 'POST', withMode('shared'), SEPARATED);
      assert.deepEqual([shared.status, shared.json.gateMode], [202, 'shared']);
      const none = await call(`${url}/v1/runs`, 'POST', withMode(undefined), SEPARATED);
      assert.deepEqual([none.status, none.json.gateMode], [202, 'shared']);
      // A shared gate's token (RUNS_GATE_TOKENS), which that gate's blocks can read: separated is
      // refused, so a block can't pass its run off as a separated gate's (review, 2026-11-16).
      const forged = await call(`${url}/v1/runs`, 'POST', withMode('separated'), GATE);
      assert.equal(forged.status, 400);
      assert.match(forged.json.error, /says gate_mode separated, but its token is not a separated gate's: .*RUNS_SEPARATED_GATE_TOKENS/);
      assert.ok(logs.some((e) => e.event === 'run-refused' && e.token === 'web-1' && e.status === 400));
      assert.deepEqual([(await call(`${url}/v1/runs`, 'POST', withMode('shared'), GATE)).json.gateMode], ['shared']);
      for (const bad of ['Separated', 'isolated', '', 1]) {
        const r = await call(`${url}/v1/runs`, 'POST', withMode(bad), SEPARATED);
        assert.equal(r.status, 400, String(bad));
        assert.match(r.json.problems.join('\n'), /gate\.gate_mode: expected shared or separated/);
      }
      assert.deepEqual(lines().map((l) => [l.token, l.gateMode]), [['web-2', 'separated'], ['web-2', 'shared'], ['web-2', 'shared'], ['web-1', 'shared']]);
    } finally {
      await s.close();
    }
    // Without gate tokens a gate's summary is unverified: its gate_mode is kept in the summary, but counts for nothing.
    fresh();
    const open = await start(config(dir, { runs: runsConfig() }));
    try {
      const r = await call(`${open.url}/v1/runs`, 'POST', withMode('separated'));
      assert.deepEqual([r.status, r.json.trust, r.json.gateMode], [202, 'unverified', undefined]);
      assert.equal(lines()[0].gateMode, undefined);
      const green = await call(`${open.url}/v1/runs/last-green?runbook=ops/restart-api`, 'GET', undefined, READ);
      assert.match(green.json.text, /, unverified$/);
    } finally {
      await open.s.close();
    }
  });

  it('report-runs-required: separated in the library: only a run a gate sent in separated mode counts', async () => {
    fresh();
    const libDir = path.join(dir, 'library');
    fs.mkdirSync(path.join(libDir, 'ops'), { recursive: true });
    const front = (required: string): string => `---\nreport-runs: https://runbooks.example.net/v1/runs\nreport-runs-required: ${required}\n---\n\n`;
    fs.writeFileSync(path.join(libDir, 'ops', 'restart-api.md'), await signRunbook(front('separated') + RUNBOOK, {}, keys.signer));
    fs.writeFileSync(path.join(libDir, 'ops', 'stop-api.md'), await signRunbook(front('true') + RUNBOOK, { name: 'ops/stop-api' }, keys.signer));
    const library = { dir: libDir, uploadTokens: [tok('upload-token-of-at-least-24-chars')], allowedSigners: keys.allowedSigners, acceptV1: false, allowDelete: false, signedOnly: true, maxBytes: 256 * 1024 };
    const { s, url } = await start(config(dir, { library, runs: runsConfig({ gateTokens: [tok(GATE, 'web-1')], separatedGateTokens: [tok(SEPARATED, 'web-2')] }) }));
    const gateRun = (name: string, mode: string | undefined, ended: string): string =>
      JSON.stringify({
        ...gateSummary(),
        runbook: { signed: { name, version: 1, manifest: 'ab'.repeat(32), signer: 'ops@example.net', trusted: true } },
        gate: { host: 'web-1', account: 'support', ...(mode ? { gate_mode: mode } : {}) },
        ended,
      });
    const lastGreen = async (q: string): Promise<any> => (await call(`${url}/v1/runs/last-green?runbook=${q}`, 'GET', undefined, READ)).json;
    try {
      // A runner-signed run and a shared gate's run: verified, but neither counts for separated.
      const sum = summary({ text: front('separated') + RUNBOOK, ended: Date.UTC(2026, 10, 14, 9, 1, 0) });
      await call(`${url}/v1/runs`, 'POST', reportBody(sum, { signature: await signRunSummary(sum, keys.runner, { interactive: false }) }));
      assert.equal((await call(`${url}/v1/runs`, 'POST', gateRun('ops/restart-api', 'shared', '2026-11-14T10:00:00Z'), GATE)).status, 202);
      let g = await lastGreen('ops/restart-api.md');
      assert.equal(g.required, 'separated');
      assert.equal(g.last.gateMode, 'shared');
      assert.equal(g.lastVerified, undefined);
      assert.equal(
        g.text,
        'ops/restart-api.md: last ran green by SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG at 2026-11-14T10:00:00Z (version 1), verified: sent by a gate (shared account); none sent by a gate in separated mode, as report-runs-required: separated asks',
      );
      // By its signed name too.
      assert.equal((await lastGreen('ops/restart-api')).required, 'separated');
      // A separated gate's run counts; a later shared one doesn't replace it.
      assert.equal((await call(`${url}/v1/runs`, 'POST', gateRun('ops/restart-api', 'separated', '2026-11-14T11:00:00Z'), SEPARATED)).status, 202);
      g = await lastGreen('ops/restart-api.md');
      assert.match(g.text, /at 2026-11-14T11:00:00Z \(version 1\), verified: sent by a gate \(separated\)$/);
      assert.equal(g.lastVerified.gateMode, 'separated');
      await call(`${url}/v1/runs`, 'POST', gateRun('ops/restart-api', undefined, '2026-11-14T12:00:00Z'), GATE);
      g = await lastGreen('ops/restart-api.md');
      assert.match(
        g.text,
        /at 2026-11-14T12:00:00Z \(version 1\), verified: sent by a gate \(shared account\); last green run sent by a gate in separated mode by SHA256:\S+ at 2026-11-14T11:00:00Z \(version 1\), verified: sent by a gate \(separated\)$/,
      );
      assert.deepEqual([g.last.gateMode, g.lastVerified.gateMode], ['shared', 'separated']);

      // report-runs-required: true: any verified run counts, as before.
      await call(`${url}/v1/runs`, 'POST', gateRun('ops/stop-api', 'shared', '2026-11-14T10:00:00Z'), GATE);
      const stop = await lastGreen('ops/stop-api.md');
      assert.equal(stop.required, undefined);
      assert.match(stop.text, /verified: sent by a gate \(shared account\)$/);
      assert.equal(stop.lastVerified.gateMode, 'shared');
      // The list shows each gate's mode.
      const list = await call(`${url}/v1/runs?runbook=ops/restart-api.md`, 'GET', undefined, READ);
      assert.deepEqual(list.json.runs.map((r: any) => r.gateMode), ['shared', 'separated', 'shared', undefined]);
    } finally {
      await s.close();
    }
  });

  it('lists recent runs and the last green one, with verified and unverified marked (read token)', async () => {
    fresh();
    const { s, url } = await start(config(dir, { runs: runsConfig({ gateTokens: [tok(GATE, 'web-1')] }) }));
    try {
      const text = await signRunbook(RUNBOOK, {}, keys.signer);
      const signedSum = summary({ text, who: 'ana', ended: Date.UTC(2026, 10, 14, 9, 1, 0) });
      await call(`${url}/v1/runs`, 'POST', reportBody(signedSum, { signature: await signRunSummary(signedSum, keys.runner, { interactive: false }) }));
      await call(`${url}/v1/runs`, 'POST', reportBody(summary({ text, who: 'bob', ended: Date.UTC(2026, 10, 14, 9, 2, 0) })));
      await call(`${url}/v1/runs`, 'POST', reportBody(summary({ text, who: 'carl', failed: true })));
      await call(`${url}/v1/runs`, 'POST', reportBody(summary({ file: 'other.md', text: '# Other\n' })));

      assert.equal((await call(`${url}/v1/runs?runbook=ops/restart-api`, 'GET')).status, 401);
      const list = await call(`${url}/v1/runs?runbook=ops/restart-api`, 'GET', undefined, READ);
      assert.equal(list.status, 200);
      assert.deepEqual(
        list.json.runs.map((r: any) => r.summary.who),
        ['carl', 'bob', 'ana'],
      );
      assert.equal((await call(`${url}/v1/runs?limit=2`, 'GET', undefined, READ)).json.runs.length, 2);
      assert.equal((await call(`${url}/v1/runs?runbook=other.md`, 'GET', undefined, READ)).json.runs.length, 1);

      const green = await call(`${url}/v1/runs/last-green?runbook=ops/restart-api.md`, 'GET', undefined, READ);
      assert.equal(green.json.last.summary.who, 'bob');
      assert.equal(green.json.last.verified, false);
      assert.equal(green.json.lastVerified.runner, 'ana@example.net');
      assert.equal(
        green.json.text,
        'ops/restart-api.md: last ran green by "bob" at 2026-11-14T09:02:00.000Z (version 1), unverified; last verified green run by ana@example.net at 2026-11-14T09:01:00.000Z (version 1), verified: signed by the runner',
      );
      // A gate's run is verified (sent with a gate token) and the newest.
      await call(`${url}/v1/runs`, 'POST', JSON.stringify(gateSummary()), GATE);
      const after = await call(`${url}/v1/runs/last-green?runbook=ops/restart-api`, 'GET', undefined, READ);
      assert.match(after.json.text, /last ran green by SHA256:\S+ at 2026-11-14T10:00:00Z \(version 1\), verified: sent by a gate \(shared account\)$/);
      assert.equal(after.json.last.gateMode, 'shared');
      // Records kept before gate_mode (trust gate, no gateMode) read as shared.
      const file = fs.readdirSync(path.join(dir, 'runs'))[0]!;
      const kept = fs.readFileSync(path.join(dir, 'runs', file), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      fs.writeFileSync(path.join(dir, 'runs', file), kept.map((r) => JSON.stringify({ ...r, gateMode: undefined })).join('\n') + '\n');
      const old = await call(`${url}/v1/runs/last-green?runbook=ops/restart-api`, 'GET', undefined, READ);
      assert.match(old.json.text, /verified: sent by a gate \(shared account\)$/);
      assert.equal(old.json.last.gateMode, 'shared');
      assert.equal((await call(`${url}/v1/runs/last-green?runbook=nothing.md`, 'GET', undefined, READ)).json.text, 'nothing.md: no green run reported');
    } finally {
      await s.close();
    }
  });

  it('reading is off without RUNS_READ_TOKENS; clients are rate-limited', async () => {
    fresh();
    const { s, url } = await start(config(dir, { runs: runsConfig({ readTokens: [] }), ratePerMinute: 3 }));
    try {
      assert.equal((await call(`${url}/v1/runs`, 'GET', undefined, READ)).status, 403);
      for (let i = 0; i < 2; i++) assert.equal((await call(`${url}/v1/runs`, 'POST', reportBody(summary()))).status, 202);
      assert.equal((await call(`${url}/v1/runs`, 'POST', reportBody(summary()))).status, 429);
    } finally {
      await s.close();
    }
  });
});
