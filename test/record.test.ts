import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { recordJson, renderReport } from '@md-runbook/core';
import {
  readRecordSignature,
  recordDigest,
  recordStatement,
  recordStatus,
  withRecordCosigner,
  withRecordSignature,
  withoutRecordSignature,
} from '@md-runbook/core/record';
import { readSignature, withSignature } from '@md-runbook/core/signing';
import { signCommand, verifyCommand } from '../src/cli/sign';

const RECORD =
  '---\nincident: INC-7\n---\n\n# Failover\n\n```bash\nsystemctl restart api\n```\n<!-- md-runbook:output start exit=0 ran=2026-10-26T22:05:00+01:00 duration=4.000s by=ana on=ana@ops-1 -->\n```text\nok\n```\n<!-- md-runbook:output end -->\n';
const SIG = 'U1NIU0lHAAAAAQ' + 'A'.repeat(150);

describe('run record signatures (core)', () => {
  it('cover every byte but their own block; a later change shows', () => {
    const block = { signer: 'ana@example.net', signed: '2026-10-26T22:40:00+01:00', sha256: recordDigest(RECORD), signature: SIG };
    const signed = withRecordSignature(RECORD, block);
    assert.deepEqual(readRecordSignature(signed), block);
    assert.equal(withoutRecordSignature(signed), RECORD);
    assert.deepEqual(recordStatus(signed), { block, unchanged: true });
    assert.equal(recordStatus(signed.replace('ok', 'OK'))!.unchanged, false, 'an edited output');
    assert.equal(recordStatus(RECORD), undefined);
  });

  it('a co-signer is added (once per name); the statement is no runbook manifest', () => {
    const block = { signer: 'ana', signed: '2026-10-26T22:40:00+01:00', sha256: recordDigest(RECORD), signature: SIG };
    const two = withRecordCosigner(withRecordCosigner(block, { signer: 'lead', signed: 'x', signature: SIG }), { signer: 'lead', signed: 'y', signature: SIG });
    assert.deepEqual(two.cosigners!.map((c) => [c.signer, c.signed]), [['lead', 'y']]);
    const text = withRecordSignature(RECORD, two);
    assert.deepEqual(readRecordSignature(text), two);
    assert.equal(recordStatement('ab'.repeat(32)), `md-runbook run record v1\nsha256 ${'ab'.repeat(32)}\n`);
  });

  it('lives beside a runbook signature: each finds its own block', () => {
    const runbookSig = { signer: 'ops', signed: '2026-10-20', manifest: 'name ops/failover\n', signature: SIG };
    const withBoth = withRecordSignature(withSignature(RECORD, runbookSig), { signer: 'ana', signed: 't', sha256: 'x'.repeat(64).replace(/x/g, 'a'), signature: SIG });
    assert.equal(readSignature(withBoth)!.signer, 'ops');
    assert.equal(readRecordSignature(withBoth)!.signer, 'ana');
  });

  it('the report says who signed the record and whether it changed', () => {
    const block = { signer: 'ana', signed: '2026-10-26T22:40:00+01:00', sha256: recordDigest(RECORD), signature: SIG };
    const signed = withRecordSignature(RECORD, block);
    const opts = { generatedAt: new Date('2026-10-26T22:50:00Z') };
    assert.match(renderReport(signed, opts), /<dt>Record signed<\/dt><dd>by ana · unchanged since<\/dd>/);
    assert.match(renderReport(signed.replace('ok', 'OK'), opts), /<div class="changed"><dt>Record signed<\/dt><dd>by ana · CHANGED since signing<\/dd>/);
  });
});

describe('cli: sign --record and verify', () => {
  let dir: string;
  const keys: Record<string, string> = {};
  let allowed: string;
  const lines: string[] = [];
  const out = (l: string): void => void lines.push(l);

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdrb-record-'));
    let signers = '';
    for (const who of ['ana', 'lead']) {
      keys[who] = path.join(dir, who);
      execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', `${who}@example.net`, '-f', keys[who]!]);
      signers += `${who}@example.net namespaces="md-runbook" ${fs.readFileSync(keys[who] + '.pub', 'utf8').trim().split(' ').slice(0, 2).join(' ')}\n`;
    }
    allowed = path.join(dir, 'allowed_signers');
    fs.writeFileSync(allowed, signers);
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('signs, co-signs, verifies both signatures, and fails once the record changed', async () => {
    const f = path.join(dir, 'failover.2026-10-26.md');
    fs.writeFileSync(f, RECORD);
    lines.length = 0;
    assert.equal(await signCommand([f, '--record', '--cosign', '--key', keys.ana!], out), 1, 'nothing to co-sign yet');
    assert.equal(await signCommand([f, '--record', '--key', keys.ana!], out), 0, lines.join('\n'));
    assert.equal(await signCommand([f, '--record', '--cosign', '--key', keys.lead!], out), 0, lines.join('\n'));
    lines.length = 0;
    assert.equal(await verifyCommand([f, '--allowed-signers', allowed], out), 0, lines.join('\n'));
    assert.ok(lines.some((l) => /record signature 1 \(ana@example.net\): good, by ana@example.net/.test(l)), lines.join('\n'));
    assert.ok(lines.some((l) => /record signature 2 \(lead@example.net\): good, by lead@example.net/.test(l)), lines.join('\n'));
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('ok', 'OK'));
    lines.length = 0;
    assert.equal(await verifyCommand([f, '--allowed-signers', allowed], out), 1);
    assert.ok(lines.some((l) => /CHANGED since signing/.test(l)), lines.join('\n'));
    assert.equal(await signCommand([f, '--record', '--cosign', '--key', keys.lead!], out), 1, 'no co-signing a changed record');
  });
});

describe('Export Run Record (JSON)', () => {
  it('carries the timeline, the summary and the signature, redacted', () => {
    const block = { signer: 'ana', signed: '2026-10-26T22:40:00+01:00', sha256: recordDigest(RECORD), signature: SIG };
    const json = JSON.parse(
      recordJson(withRecordSignature(RECORD, block), { file: 'failover.md', generatedAt: new Date('2026-10-26T22:50:00Z'), redact: (s) => s.replace('ops-1', '[redacted]') }),
    );
    assert.equal(json.format, 'md-runbook run record v1');
    assert.equal(json.summary.incident, 'INC-7');
    assert.deepEqual(json.summary.places, ['ana@[redacted]']);
    assert.deepEqual(json.events.map((e: { kind: string; on: string }) => [e.kind, e.on]), [['run', 'ana@[redacted]']]);
    assert.equal(json.signature.unchanged, true);
    assert.deepEqual(json.signature.signers.map((s: { signer: string }) => s.signer), ['ana']);
    assert.equal(JSON.parse(recordJson(RECORD, { file: 'f.md', generatedAt: new Date() })).signature, null);
  });
});
