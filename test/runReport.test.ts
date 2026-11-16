/** Run reports (core/runReport.ts): the summary, its canonical form, the trust rules, signing and checking. */
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { lintRunbook } from '@md-runbook/core/lint';
import { parseFrontMatter, reportAddressProblem } from '@md-runbook/core/secrets';
import { ManifestMeta, armorSignature, buildManifest, formatManifest, readSignature, signedStatus, signedTextHash, wholeRunbookSigned, withSignature } from '@md-runbook/core/signing';
import {
  QueuedReport,
  RUN_SIGNATURE_NAMESPACE,
  addressAllowed,
  afterTry,
  alertFromParams,
  buildRunSummary,
  canonicalJson,
  consentKey,
  enqueueReport,
  gateModeOf,
  gateTrustText,
  parseRunEnvelope,
  postRunReport,
  reportBody,
  reportConsentText,
  reportPlan,
  reportRequiredText,
  runSummaryProblems,
} from '@md-runbook/core/runReport';
import { v1FrontMatterProblems } from '@md-runbook/core/frontMatterRun';
import { signRunSummary, sshSign, sshVerify, trustedRunbookSigner, verifyRunEnvelope } from '@md-runbook/core/node';

const fence = (info: string, body: string): string => '```' + info + '\n' + body + '\n```\n\n';
const meta = (m: Partial<ManifestMeta> = {}): ManifestMeta => ({ name: 'ops/restart', version: 2, scopes: [], patterns: {}, ...m });
const SIG = 'U1NIU0lHAAAAAQ' + 'A'.repeat(150);
/** The text with a signature block of its manifest (a placeholder signature: no key involved). */
const signedWith = (text: string, version: 1 | 2 = 2, m: Partial<ManifestMeta> = {}): string => {
  const r = buildManifest(text, meta(m), { version });
  if ('errors' in r) throw new Error(r.errors.join('; '));
  return withSignature(text, { signer: 'ops@example.net', signed: '2026-11-14', manifest: formatManifest(r.manifest), signature: SIG });
};

const REPORTING = '---\nreport-runs: https://reports.example.net/runs\nreport-runs-required: true\nreport-runs-signed: true\nreport-runs-token: ${secret:REPORT_TOKEN}\n---\n\n';
const BODY = '# Restart the API\n\n- [ ] Tell the channel\n\n## Stop\n\n' + fence('bash', 'systemctl stop api') + '## Start\n\n' + fence('bash', 'systemctl start api --target ${param:TARGET}');

describe('run reports: the summary', () => {
  it('canonical JSON: keys sorted at every level, no whitespace, undefined left out, arrays in order', () => {
    assert.equal(canonicalJson({ b: 1, a: [3, { d: true, c: 'x' }], e: undefined, A: null }), '{"A":null,"a":[3,{"c":"x","d":true}],"b":1}');
    // By UTF-16 code units: z (7A) before é (E9).
    assert.equal(canonicalJson({ 'é': 'ü\n"', z: -0.5 }), '{"z":-0.5,"é":"ü\\n\\""}');
    // Insertion order doesn't matter: the same value, the same text.
    assert.equal(canonicalJson({ x: 1, y: { q: 2, p: 1 } }), canonicalJson({ y: { p: 1, q: 2 }, x: 1 }));
    assert.throws(() => canonicalJson({ n: NaN }), /finite/);
  });

  it('holds names, states and times: never outputs, parameter or input values, or secrets', () => {
    const text =
      '---\nparams:\n  - TARGET: prod-eu-secret-host\n---\n\n# Deploy\n\n' +
      fence('bash', 'echo ${secret:API_TOKEN} ${input:WHO}') +
      '<!-- md-runbook:output start exit=0 ran=2026-11-14T10:00:00+01:00 -->\n```text\nhunter2-output-value\n```\n<!-- md-runbook:output end -->\n\n' +
      fence('bash', 'deploy --to ${param:TARGET}');
    const s = buildRunSummary({
      file: '/home/ops/runbooks/deploy.md',
      text,
      who: 'ana',
      client: 'cli',
      started: Date.UTC(2026, 10, 14, 9, 0, 0),
      ended: Date.UTC(2026, 10, 14, 9, 1, 30),
      steps: [
        { label: 'echo ${secret:API_TOKEN} ${input:WHO}', state: 'passed', ms: 1200.4, ran: true },
        { label: 'deploy --to ${param:TARGET}', state: 'failed', ms: 300, ran: true },
      ],
      alertParams: { ALERT: 'HighErrorRate', ALERT_FINGERPRINT: 'abc123', ALERT_STARTS_AT: '2026-11-14T08:58:00.123Z', TARGET: 'prod-eu-secret-host', ALERT_LABELS: 'severity=page,team=api' },
    });
    const json = canonicalJson(s);
    for (const value of ['prod-eu-secret-host', 'hunter2', '/home/ops']) assert.ok(!json.includes(value), `${value} is in the summary`);
    assert.deepEqual(runSummaryProblems(JSON.parse(json)), []);
    assert.equal(s.runbook.file, 'deploy.md');
    assert.equal(s.runbook.title, 'Deploy');
    assert.match(s.runbook.sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual([s.started, s.ended], ['2026-11-14T09:00:00.000Z', '2026-11-14T09:01:30.000Z']);
    assert.deepEqual(s.steps[0], { n: 1, label: 'echo ${secret:API_TOKEN} ${input:WHO}', state: 'passed', ms: 1200 });
    assert.deepEqual(s.totals, { steps: 2, passed: 1, failed: 1, skipped: 0, notRun: 0, byHand: 0 });
    assert.deepEqual([s.green, s.ran], [false, [1, 2]]);
    // Only ALERT, ALERT_FINGERPRINT and ALERT_LABELS, and only when passed.
    assert.deepEqual(s.alert, { name: 'HighErrorRate', fingerprint: 'abc123', startsAt: '2026-11-14T08:58:00.123Z', labels: { severity: 'page', team: 'api' } });
    assert.equal(alertFromParams({ TARGET: 'x' }), undefined);
    assert.equal(alertFromParams({ ALERT: '', ALERT_FINGERPRINT: 'abc' }), undefined, 'declared with an empty default: no alert');
    assert.deepEqual(alertFromParams({ ALERT: 'Disk full', ALERT_FINGERPRINT: 'not plain!', ALERT_STARTS_AT: 'yesterday' }), { name: 'Disk full' });
    assert.deepEqual(alertFromParams({ ALERT: 'Disk full', ALERT_FINGERPRINT: '', ALERT_STARTS_AT: '' }), { name: 'Disk full' });
    // The same runbook with other outputs: the same hash.
    const again = buildRunSummary({ file: 'deploy.md', text: text.replace('hunter2-output-value', 'other'), who: 'ana', client: 'cli', started: 0, ended: 0, steps: [] });
    assert.equal(again.runbook.sha256, s.runbook.sha256);
    assert.equal(again.green, false, 'no steps: not green');
  });

  it('a server refuses fields it does not know, and other versions', () => {
    const s = buildRunSummary({ file: 'a.md', text: '# A\n', who: 'ana', client: 'vscode', started: 0, ended: 1, steps: [{ label: 'A', state: 'by-hand' }] });
    assert.equal(s.green, true);
    assert.deepEqual(runSummaryProblems(s), []);
    assert.match(runSummaryProblems({ ...s, output: 'x' }).join('\n'), /unknown field "output"/);
    assert.match(runSummaryProblems({ ...s, steps: [{ ...s.steps[0], value: 'x' }] }).join('\n'), /unknown field "value"/);
    assert.match(runSummaryProblems({ ...s, v: 2 }).join('\n'), /not a summary version/);
    assert.match(runSummaryProblems({ ...s, client: 'curl' }).join('\n'), /client/);
    assert.match(runSummaryProblems({ ...s, alert: { name: 'A', labels: { 'bad name': 'x' } } }).join('\n'), /not a label name/);
  });

  it("a gate's summary: no file or hash of the text, always the signed runbook, and where it ran", () => {
    const signed = { name: 'ops/restart', version: 3, manifest: 'ab'.repeat(32), signer: 'ops@example.net', trusted: true };
    const g = {
      v: 1,
      runbook: { signed },
      who: 'SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
      client: 'gate',
      started: '2026-11-14T09:00:00Z',
      ended: '2026-11-14T09:00:05Z',
      steps: [{ n: 1, label: 'systemctl stop api', state: 'passed' }],
      ran: [1],
      totals: { steps: 1, passed: 1, failed: 0, skipped: 0, notRun: 0, byHand: 0 },
      green: true,
      gate: { host: 'web-1', account: 'support', from: '192.0.2.7' },
    };
    assert.deepEqual(runSummaryProblems(g), []);
    assert.match(runSummaryProblems({ ...g, runbook: {} }).join('\n'), /runbook.signed: a gate runs signed runbooks only/);
    assert.match(runSummaryProblems({ ...g, gate: { host: 'web-1', account: 'support', shell: 'x' } }).join('\n'), /unknown field "shell"/);
    // Only a gate's summary may leave the file and hash out, or say where it ran.
    const other = runSummaryProblems({ ...g, client: 'cli' }).join('\n');
    assert.match(other, /runbook.file/);
    assert.match(other, /runbook.sha256/);
    assert.match(other, /unknown field "gate"/);
  });

  it("a gate's mode: gate.gate_mode is shared or separated, counted only when sent by a gate", () => {
    const signed = { name: 'ops/restart', version: 3, manifest: 'ab'.repeat(32), signer: 'ops@example.net', trusted: true };
    const g = {
      v: 1,
      runbook: { signed },
      who: 'SHA256:abc',
      client: 'gate',
      started: '2026-11-14T09:00:00Z',
      ended: '2026-11-14T09:00:05Z',
      steps: [{ n: 1, label: 'systemctl stop api', state: 'passed' }],
      ran: [1],
      totals: { steps: 1, passed: 1, failed: 0, skipped: 0, notRun: 0, byHand: 0 },
      green: true,
      gate: { host: 'web-1', account: 'support', gate_mode: 'separated' },
    };
    const withMode = (gate_mode: unknown) => ({ ...g, gate: { host: 'web-1', account: 'support', gate_mode } });
    assert.deepEqual(runSummaryProblems(g), []);
    assert.deepEqual(runSummaryProblems(withMode('shared')), []);
    // Any other value is refused: the gate's log shows the 400.
    for (const bad of ['Separated', 'isolated', '', true, 1]) assert.match(runSummaryProblems(withMode(bad)).join('\n'), /gate\.gate_mode: expected shared or separated/, String(bad));
    // Not at the top level, and not in another client's summary.
    assert.match(runSummaryProblems({ ...g, gate_mode: 'separated' }).join('\n'), /unknown field "gate_mode"/);
    assert.match(runSummaryProblems({ ...g, client: 'cli' }).join('\n'), /unknown field "gate"/);
    // Counted only when verified as sent by a gate; without it, shared.
    assert.equal(gateModeOf(g, true), 'separated');
    assert.equal(gateModeOf(g, false), undefined);
    assert.equal(gateModeOf(withMode('shared'), true), 'shared');
    assert.equal(gateModeOf({ ...g, gate: { host: 'web-1', account: 'support' } }, true), 'shared');
    assert.equal(gateModeOf({ ...g, gate: undefined }, true), 'shared');
    assert.equal(gateModeOf(withMode('weird'), true), 'shared');
    assert.equal(gateModeOf({ ...g, client: 'cli' }, true), undefined);
    assert.equal(gateTrustText('separated'), 'verified: sent by a gate (separated)');
    assert.equal(gateTrustText('shared'), 'verified: sent by a gate (shared account)');
    assert.equal(gateTrustText(undefined), 'verified: sent by a gate (shared account)');
  });
});

describe('run reports: the front matter and what a client honours', () => {
  it('reads the address (https; http for localhost only), required, signed, and the token as a secret name', () => {
    const fm = parseFrontMatter(REPORTING + '# R\n');
    assert.deepEqual([fm?.reportRuns, fm?.reportRunsRequired, fm?.reportRunsSigned, fm?.reportRunsToken], ['https://reports.example.net/runs', true, true, 'REPORT_TOKEN']);
    for (const ok of ['https://x.example.net', 'https://x.example.net:8443/a?b=c', 'http://localhost:8080/r', 'http://127.0.0.1/r', 'http://[::1]:9/r']) assert.equal(reportAddressProblem(ok), undefined, ok);
    for (const bad of ['http://reports.example.net/r', 'ftp://x.net', 'https://user:pw@x.net/r', 'reports.example.net', 'https://']) assert.ok(reportAddressProblem(bad), bad);
    assert.equal(parseFrontMatter('---\nreport-runs: http://reports.example.net/r\n---\n')?.reportRuns, undefined);
    // A literal token is never used, and lint says so as an error.
    assert.equal(parseFrontMatter('---\nreport-runs: https://x.net/r\nreport-runs-token: abc123\n---\n')?.reportRunsToken, undefined);
    const lint = lintRunbook('---\nreport-runs: https://x.net/r\nreport-runs-token: abc123\n---\n\n' + fence('bash', 'echo'));
    assert.ok(lint.some((p) => p.severity === 'error' && /report-runs-token: never write a token/.test(p.message)), JSON.stringify(lint));
    assert.ok(lintRunbook('---\nreport-runs: http://x.net/r\n---\n').some((p) => /report-runs: "http:\/\/x.net\/r" is ignored: http is only for localhost/.test(p.message)));
  });

  it('required and signed count only in a runbook signed as a whole (v2), unchanged, by a signer the client trusts', () => {
    const text = REPORTING + BODY;
    const unsigned = reportPlan(text, undefined)!;
    assert.deepEqual([unsigned.required, unsigned.signed, unsigned.host, unsigned.token], [false, false, 'reports.example.net', 'REPORT_TOKEN']);
    assert.match(unsigned.ignored!, /not signed/);
    const signed = signedWith(text, 2, { patterns: { TARGET: '[a-z-]+' } });
    assert.match(reportPlan(signed, undefined)!.ignored!, /not checked against signers this client trusts/);
    const trusted = reportPlan(signed, 'ops@example.net')!;
    assert.deepEqual([trusted.required, trusted.signed, trusted.ignored], [true, true, undefined]);
    // Version 1 (blocks only): the front matter isn't signed.
    assert.match(reportPlan(signedWith(text, 1, { patterns: { TARGET: '[a-z-]+' } }), 'ops@example.net')!.ignored!, /covers only its blocks/);
    // Any change since signing, the front matter's or the prose's: asked like any other.
    const changed = signed.replace('report-runs-required: true', 'report-runs-required: true\nreport-runs-token: ${secret:OTHER}');
    assert.match(reportPlan(changed, 'ops@example.net')!.ignored!, /changed since signing/);
    assert.match(reportPlan(signed.replace('Tell the channel', 'Skip the channel'), 'ops@example.net')!.ignored!, /changed since signing/);
    // Expired.
    const expired = signedWith(text, 2, { patterns: { TARGET: '[a-z-]+' }, expires: '2026-01-01' });
    assert.match(reportPlan(expired, 'ops@example.net', new Date('2026-11-14'))!.ignored!, /expired/);
    // Lint says why it is ignored, and nothing once signed as a whole.
    assert.ok(lintRunbook(text).some((p) => /report-runs-required and report-runs-signed: ignored, the runbook is not signed/.test(p.message)));
    assert.ok(lintRunbook(signedWith(text, 1, { patterns: { TARGET: '[a-z-]+' } })).some((p) => /ignored, the signature covers only its blocks/.test(p.message)));
    assert.ok(!lintRunbook(signed).some((p) => /report-runs/.test(p.message)), JSON.stringify(lintRunbook(signed)));
    // No address: nothing to report; -required alone is a lint warning.
    assert.equal(reportPlan(BODY, 'ops@example.net'), undefined);
    assert.ok(lintRunbook('---\nreport-runs-required: true\n---\n').some((p) => /has no effect without report-runs/.test(p.message)));
  });

  it('report-runs-required: separated is required too, and asks for a gate in separated mode', () => {
    const fm = (v: string) => parseFrontMatter(`---\nreport-runs: https://x.net/r\nreport-runs-required: ${v}\n---\n`);
    assert.deepEqual([fm('separated')?.reportRunsRequired, fm('separated')?.reportRunsSeparated], [true, true]);
    assert.deepEqual([fm('"Separated"')?.reportRunsRequired, fm('"Separated"')?.reportRunsSeparated], [true, true]);
    assert.deepEqual([fm('true')?.reportRunsRequired, fm('true')?.reportRunsSeparated], [true, undefined]);
    assert.deepEqual([fm('false')?.reportRunsRequired, fm('false')?.reportRunsSeparated], [undefined, undefined]);
    // An unknown value requires nothing (lint and signing refuse it).
    assert.deepEqual([fm('seperated')?.reportRunsRequired, fm('seperated')?.reportRunsSeparated], [undefined, undefined]);
    // Written twice: the strictest counts, in the parser and in lint alike (before, the parser took
    // the last and lint said the first; gate vectors, 2026-11-16).
    for (const [a, b] of [['false', 'true'], ['true', 'false'], ['bogus', 'true']]) {
      assert.equal(fm(`${a}\nreport-runs-required: ${b}`)?.reportRunsRequired, true, `${a}, ${b}`);
    }
    assert.equal(fm('separated\nreport-runs-required: true')?.reportRunsSeparated, true);
    assert.equal(fm('true\nreport-runs-required: separated')?.reportRunsSeparated, true);
    assert.ok(lintRunbook('---\nreport-runs: https://x.net/r\nreport-runs-required: false\nreport-runs-required: true\n---\n').some((p) => /report-runs-required: written twice: the strictest counts/.test(p.message)));
    // A repeated line's value is checked too: a misspelt `separated` after `true` (review, 2026-11-16).
    const twice = lintRunbook('---\nreport-runs: https://x.net/r\nreport-runs-required: true\nreport-runs-required: separatd\nreport-runs-signed: true\nreport-runs-signed: maybe\nreport-runs-token: ${secret:T}\nreport-runs-token: abc123\n---\n')
      .filter((p) => /report-runs/.test(p.message))
      .map((p) => `${p.line} ${p.severity} ${p.message.slice(0, 80)}`);
    assert.ok(twice.some((p) => p.startsWith('3 warning front matter report-runs-required: written twice: the strictest counts')), twice.join('\n'));
    assert.ok(twice.some((p) => p.startsWith('3 error front matter report-runs-required: "separatd" is not understood')), twice.join('\n'));
    assert.ok(twice.some((p) => p.startsWith('5 warning front matter report-runs-signed: "maybe" is ignored')), twice.join('\n'));
    assert.ok(twice.some((p) => p.startsWith('7 error front matter report-runs-token: never write a token in the file')), twice.join('\n'));

    const text = REPORTING.replace('report-runs-required: true', 'report-runs-required: separated # a gate in separated mode') + BODY;
    const signed = signedWith(text, 2, { patterns: { TARGET: '[a-z-]+' } });
    const trusted = reportPlan(signed, 'ops@example.net')!;
    assert.deepEqual([trusted.required, trusted.separated, trusted.signed, trusted.ignored], [true, true, true, undefined]);
    assert.match(reportRequiredText(trusted), /The run counts only when a gate in separated mode reports it\./);
    assert.doesNotMatch(reportRequiredText(reportPlan(signedWith(REPORTING + BODY, 2, { patterns: { TARGET: '[a-z-]+' } }), 'ops@example.net')!), /separated/);
    // Honoured as required is: not in a runbook that isn't signed as a whole by a trusted signer.
    const untrusted = reportPlan(signed, undefined)!;
    assert.deepEqual([untrusted.required, untrusted.separated], [false, false]);
    assert.deepEqual([reportPlan(text, 'ops@example.net')!.separated, reportPlan(signedWith(text, 1, { patterns: { TARGET: '[a-z-]+' } }), 'ops@example.net')!.separated], [false, false]);
    // Changed from true to separated (or back) after signing: changed since signing.
    assert.match(reportPlan(signed.replace('required: separated', 'required: true'), 'ops@example.net')!.ignored!, /changed since signing/);
    // Next to a version 1 signature, the key is not covered (allow-list of v1FrontMatterProblems).
    assert.deepEqual(v1FrontMatterProblems('---\nreport-runs-required: separated\n---\n'), ['report-runs-required:']);

    // Lint: accepted as written and signed; an unknown value is an error.
    assert.ok(!lintRunbook(signed).some((p) => /report-runs/.test(p.message)), JSON.stringify(lintRunbook(signed)));
    assert.ok(lintRunbook(text).some((p) => /report-runs-required and report-runs-signed: ignored, the runbook is not signed/.test(p.message)));
    const typo = lintRunbook('---\nreport-runs: https://x.net/r\nreport-runs-required: seperated\n---\n\n' + fence('bash', 'echo'));
    assert.ok(typo.some((p) => p.severity === 'error' && /report-runs-required: "seperated" is not understood \(expected true, false or separated\)/.test(p.message)), JSON.stringify(typo));
    // -signed has no such value.
    const signedSeparated = lintRunbook('---\nreport-runs: https://x.net/r\nreport-runs-signed: separated\n---\n');
    assert.ok(signedSeparated.some((p) => /report-runs-signed: "separated" is ignored \(expected true or false\)/.test(p.message)), JSON.stringify(signedSeparated));
  });

  it('signing refuses report settings it could not hold as written', () => {
    const errs = (fm: string): string => {
      const r = buildManifest(`---\n${fm}\n---\n\n` + fence('bash', 'echo'), meta());
      return 'errors' in r ? r.errors.join('\n') : '';
    };
    assert.match(errs('report-runs: http://x.net/r'), /http is only for localhost/);
    assert.match(errs('report-runs: https://x.net/r\nreport-runs-token: abc'), /only \$\{secret:NAME\}/);
    assert.match(errs('report-runs-required: true'), /without report-runs/);
    assert.equal(errs('report-runs: https://x.net/r\nreport-runs-required: true'), '');
    assert.equal(errs('report-runs: https://x.net/r\nreport-runs-required: separated'), '');
    assert.match(errs('report-runs-required: separated'), /without report-runs/);
    assert.match(errs('report-runs: https://x.net/r\nreport-runs-required: seperated'), /report-runs-required: expected true, false or separated/);
    assert.match(errs('report-runs: https://x.net/r\nreport-runs-signed: separated'), /report-runs-signed: expected true or false/);
  });

  it('consent: the question names the host and what is sent; pre-approved addresses; remembered per address and secret', () => {
    const plan = reportPlan(REPORTING + BODY, undefined)!;
    const q = reportConsentText(plan);
    assert.match(q, /reports its runs to reports\.example\.net: .*Never outputs, parameter or input values, or secrets\. The secret REPORT_TOKEN is sent/);
    assert.equal(consentKey(plan), 'https://reports.example.net token=REPORT_TOKEN');
    for (const e of ['reports.example.net', 'https://reports.example.net', 'https://reports.example.net/runs', 'REPORTS.example.net']) assert.ok(addressAllowed(plan.url, [e]), e);
    for (const e of ['example.net', 'https://reports.example.net/other', 'http://reports.example.net', '']) assert.ok(!addressAllowed(plan.url, [e]), e);
  });
});

describe('run reports: sending and the queue', () => {
  it('POSTs the JSON with the bearer token; 4xx is dropped, 5xx and no answer are tried again later', async () => {
    const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
    const ok = await postRunReport({ url: 'https://r.net/x', body: '{}', token: 't0k', fetch: async (url, init) => (calls.push({ url, headers: init.headers, body: init.body }), { status: 201, ok: true }) });
    assert.deepEqual(ok, { ok: true });
    assert.deepEqual(calls[0], { url: 'https://r.net/x', headers: { 'content-type': 'application/json', authorization: 'Bearer t0k' }, body: '{}' });
    const refused = await postRunReport({ url: 'https://r.net/x', body: '{}', fetch: async () => ({ status: 400, ok: false }) });
    assert.deepEqual(refused, { ok: false, retry: false, why: 'the server answered 400' });
    const busy = await postRunReport({ url: 'https://r.net/x', body: '{}', fetch: async () => ({ status: 503, ok: false }) });
    assert.equal(busy.ok === false && busy.retry, true);
    const slow = await postRunReport({ url: 'https://r.net/x', body: '{}', timeoutMs: 20, fetch: (_u, init) => new Promise((_r, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))) });
    assert.deepEqual(slow, { ok: false, retry: true, why: 'no answer in time' });
  });

  it('queues without the token value, backs off, and drops what was sent, refused or too old', () => {
    const now = 1_000_000;
    let q: QueuedReport[] = enqueueReport([], { url: 'https://r.net/x', body: '{"a":1}', token: 'REPORT_TOKEN' }, now);
    assert.deepEqual(q, [{ url: 'https://r.net/x', body: '{"a":1}', token: 'REPORT_TOKEN', queued: now, next: now + 60_000, tries: 1 }]);
    q = afterTry(q, q[0]!, { ok: false, retry: true, why: 'x' }, now + 60_000);
    assert.deepEqual([q.length, q[0]!.tries, q[0]!.next], [1, 2, now + 60_000 + 120_000]);
    assert.deepEqual(afterTry(q, q[0]!, { ok: true }, now), []);
    assert.deepEqual(afterTry(q, q[0]!, { ok: false, retry: false, why: '400' }, now), []);
    assert.deepEqual(afterTry(q, q[0]!, { ok: false, retry: true, why: 'x' }, now + 8 * 24 * 3600_000), []);
  });
});

describe('signing: manifest version 2 (the whole runbook)', () => {
  const TEXT = '---\nmanual-steps: pause\n---\n\n' + BODY + fence('powershell', 'Get-Date');
  const signed = signedWith(TEXT, 2, { patterns: { TARGET: '[a-z-]+' } });

  it('a v2 signature covers the whole text; outputs, notes and ticks are not part of it', () => {
    const s = signedStatus(signed)!;
    assert.deepEqual([s.version, s.textChanged, s.unsigned, wholeRunbookSigned(s)], [2, false, [], true]);
    const ran =
      signed.replace('- [ ] Tell the channel', '- [x] Tell the channel').replace(
        'systemctl stop api\n```\n',
        'systemctl stop api\n```\n\n<!-- md-runbook:output start exit=0 ran=2026-11-14T10:00:00+01:00 -->\n```text\nstopped\n```\n<!-- md-runbook:output end -->\n',
      ) + '\n<!-- md-runbook:note at=2026-11-14T10:01:00+01:00 by=ana -->\n> **10:01 · ana:** all quiet\n';
    assert.equal(signedTextHash(ran), signedTextHash(signed));
    assert.equal(signedTextHash(signed.replace(/\n/g, '\r\n')), signedTextHash(signed), 'line endings');
    assert.equal(wholeRunbookSigned(signedStatus(ran)!), true);
  });

  it('a PowerShell block added, or a front matter change, makes the text changed', () => {
    const added = signed.replace('## Start', fence('pwsh', 'Remove-Item -Recurse C:\\') + '## Start');
    const a = signedStatus(added)!;
    assert.equal(a.textChanged, true);
    assert.equal(a.unsigned.length, 2, 'both PowerShell blocks: the text no longer vouches for them');
    assert.equal(wholeRunbookSigned(a), false);
    assert.ok(lintRunbook(added).some((p) => /the runbook changed since signing/.test(p.message)));
    const fm = signedStatus(signed.replace('manual-steps: pause', 'manual-steps: continue'))!;
    assert.deepEqual([fm.textChanged, fm.changed, wholeRunbookSigned(fm)], [true, [], false]);
  });

  it('a v1 file (signed before) is partly signed: its bash blocks, never its PowerShell block', () => {
    const v1 = signedWith(TEXT, 1, { patterns: { TARGET: '[a-z-]+' } });
    const s = signedStatus(v1)!;
    assert.deepEqual([s.version, s.textChanged, s.changed, s.unsigned.length, s.cells.size, wholeRunbookSigned(s)], [1, false, [], 1, 2, false]);
    assert.ok(lintRunbook(v1).some((p) => /block not covered by the signature: it was signed before manifest version 2/.test(p.message)));
  });

  it('the same code with other placeholders is not the cell signed (${X} made ${input:X})', () => {
    const text = '# R\n\n' + fence('bash', 'rm -rf "${BUILD_DIR}/cache"');
    const s = signedWith(text, 1);
    assert.deepEqual(signedStatus(s)!.changed, []);
    assert.deepEqual(signedStatus(s.replace('${BUILD_DIR}', '${input:BUILD_DIR}'))!.changed.length, 1);
    assert.deepEqual(signedStatus(s.replace('${BUILD_DIR}', '${secret:BUILD_DIR}'))!.changed.length, 1);
  });

  it('a signer name allowed_signers would read differently is no signature', () => {
    const text = signedWith('# R\n\n' + fence('bash', 'echo'));
    assert.ok(readSignature(text));
    assert.equal(readSignature(text.replace('signer=ops@example.net', 'signer=*@example.net')), undefined);
    assert.equal(readSignature(text.replace('signer=ops@example.net', 'signer=a,b')), undefined);
  });

  it('co-signing a v1 manifest keeps it v1 (co-signing never changes what was signed)', async () => {
    const { cosignable } = await import('@md-runbook/core/signing');
    const v1 = signedWith(TEXT, 1, { patterns: { TARGET: '[a-z-]+' } });
    assert.equal(cosignable(v1, readSignature(v1)!), true);
    assert.equal(cosignable(signed, readSignature(signed)!), true);
    assert.equal(cosignable(signed.replace('Tell the channel', 'Tell nobody'), readSignature(signed)!), false);
  });
});

describe('run reports: signatures with real keys (ssh-keygen)', () => {
  let dir: string;
  let runner: string;
  let ecdsa: string;
  let allowedRunners: string;
  let allowedSigners: string;
  const summary = buildRunSummary({ file: 'a.md', text: '# A\n', who: 'ana', client: 'cli', started: 0, ended: 1000, steps: [{ label: 'Step', state: 'passed', ms: 5, ran: true }] });

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdrb-runreport-'));
    runner = path.join(dir, 'runner');
    ecdsa = path.join(dir, 'ecdsa');
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'ana@example.net', '-f', runner]);
    execFileSync('ssh-keygen', ['-q', '-t', 'ecdsa', '-b', '256', '-N', '', '-C', 'ops@example.net', '-f', ecdsa]);
    const pub = (k: string): string => fs.readFileSync(k + '.pub', 'utf8').trim().split(' ').slice(0, 2).join(' ');
    allowedRunners = path.join(dir, 'allowed_runners');
    fs.writeFileSync(allowedRunners, `ana@example.net namespaces="${RUN_SIGNATURE_NAMESPACE}" ${pub(runner)}\n`);
    allowedSigners = path.join(dir, 'allowed_signers');
    fs.writeFileSync(allowedSigners, `ops@example.net namespaces="md-runbook" ${pub(ecdsa)}\nana@example.net namespaces="md-runbook" ${pub(runner)}\n`);
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('sign and verify: the envelope checks against the allowed runners, prints who', async () => {
    const signature = await signRunSummary(summary, runner, { interactive: false });
    const body = reportBody(summary, { signature, signer: 'ana@example.net' });
    const parsed = parseRunEnvelope(body);
    assert.ok('envelope' in parsed);
    const r = await verifyRunEnvelope(body, allowedRunners);
    assert.equal(r.signer, 'ana@example.net');
    assert.deepEqual(r.envelope.summary, summary);
  });

  it('tampering: any change to the summary, or a key not allowed, fails', async () => {
    const signature = await signRunSummary(summary, runner, { interactive: false });
    const tampered = reportBody({ ...summary, green: !summary.green }, { signature });
    await assert.rejects(verifyRunEnvelope(tampered, allowedRunners), /does not verify/);
    const stranger = await signRunSummary(summary, ecdsa, { interactive: false });
    await assert.rejects(verifyRunEnvelope(reportBody(summary, { signature: stranger }), allowedRunners));
    assert.match(JSON.stringify(parseRunEnvelope('{"summary":{},"signature":"x"}')), /signature: expected an SSH signature/);
  });

  it('namespaces: a runbook signature is no run signature, nor the reverse', async () => {
    const message = canonicalJson(summary);
    // Signed as a runbook (namespace md-runbook) by a key allowed for both: not a run summary.
    const asRunbook = armorSignature(await sshSign(message, runner, { interactive: false }));
    await assert.rejects(verifyRunEnvelope(reportBody(summary, { signature: asRunbook }), allowedRunners));
    // Signed as a run summary: not a runbook signature, even with allowed_signers allowing the key.
    const asRun = await signRunSummary(summary, runner, { interactive: false });
    const blob = asRun.replace(/-----(BEGIN|END) SSH SIGNATURE-----/g, '').replace(/\s+/g, '');
    await assert.rejects(sshVerify(message, blob, allowedSigners));
  });

  it("a runbook's signer is trusted when allowed_signers has its key (ssh-keygen; Ed25519 and P-256)", async () => {
    const text = REPORTING + BODY;
    const r = buildManifest(text, meta({ patterns: { TARGET: '[a-z-]+' } }));
    if ('errors' in r) throw new Error(r.errors.join('; '));
    const manifest = formatManifest(r.manifest);
    for (const [key, who] of [
      [ecdsa, 'ops@example.net'],
      [runner, 'ana@example.net'],
    ] as const) {
      const file = withSignature(text, { signer: who, signed: '2026-11-14', manifest, signature: await sshSign(manifest, key, { interactive: false }) });
      assert.equal(await trustedRunbookSigner(file, allowedSigners), who);
      assert.equal(reportPlan(file, await trustedRunbookSigner(file, allowedSigners))!.required, true);
      // Changed after signing: the signature still verifies, but the runbook isn't as signed.
      assert.equal(reportPlan(file.replace('Tell the channel', 'Tell nobody'), who)!.required, false);
    }
    // The app's own checks (valid-before, namespaces, key types) are in apps/mobile runReports.test.tsx and librarySecurity.test.ts.
  });
});
