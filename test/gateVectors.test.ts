import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { parseCellOptions } from '@md-runbook/core/cellOptions';
import { parseManifest } from '@md-runbook/core/signing';

/**
 * The shared test vectors of md-runbook-gate and its clients (apps/gate/testdata/vectors.json):
 * core's reading of each input, which the gate's Go test (apps/gate/internal/vectors) must reach
 * too. Written by scripts/gate-vectors.js: a change to how core reads any of them fails here until
 * the file is written again on purpose (npm run gate-vectors), and the gate's test then says
 * whether the gate still agrees.
 */

// scripts/gate-vectors.js, from out/test/.
const gen = require(path.join(__dirname, '..', '..', 'scripts', 'gate-vectors.js')) as {
  generate: () => { counts: Record<string, number>; vectors: Vector[] };
  format: (data: unknown) => string;
  FILE: string;
};

interface Vector {
  kind: string;
  id: string;
  input: string | { parts: [string, number][] };
  core: Record<string, unknown>;
}

const text = (input: Vector['input']): string => (typeof input === 'string' ? input : input.parts.map(([t, n]) => t.repeat(n)).join(''));

describe('gate vectors (apps/gate/testdata/vectors.json)', () => {
  const data = gen.generate();

  it('are as core reads them now (else: npm run gate-vectors, and check the gate agrees)', () => {
    const now = fs.readFileSync(gen.FILE, 'utf8');
    const want = gen.format(data);
    if (now !== want) {
      // Name the first vector that changed, not a 1 MB diff.
      const a = now.split('\n');
      const b = want.split('\n');
      const i = a.findIndex((l, k) => l !== b[k]);
      assert.fail(`vectors.json line ${i + 1} is not as core reads it now:\n  file: ${a[i]?.slice(0, 300)}\n  core: ${b[i]?.slice(0, 300)}\nRun npm run gate-vectors, then go test ./... in apps/gate.`);
    }
  });

  it('cover what the gate and core both read', () => {
    for (const kind of ['manifest', 'info', 'name', 'runbook', 'request', 'length']) assert.ok((data.counts[kind] ?? 0) > 0, kind);
    const ids = data.vectors.map((v) => `${v.kind} ${v.id}`);
    assert.equal(new Set(ids).size, ids.length, 'every vector has its own id');
    // Every kind of edge case the file is for.
    const has = (re: RegExp): boolean => data.vectors.some((v) => re.test(text(v.input)));
    assert.ok(has(/\r\n/) && has(/\r[^\n]/) && has(/^\ufeff/) && has(/\0/), 'CRLF, lone CR, BOM and NUL');
    assert.ok(data.vectors.some((v) => v.kind === 'length' && v.core.read === false && (v.core.bytes as number) > 4_000_000), 'an over-long request');
    assert.ok(data.vectors.some((v) => text(v.input) === ''), 'empty input');
  });

  it('read a signed cell kube-context= as parseCellOptions does', () => {
    for (const v of data.vectors.filter((x) => x.kind === 'info')) {
      const opts = parseCellOptions(text(v.input));
      const kubeError = opts.errors.some((e) => e.startsWith('kube-context'));
      assert.equal(!v.core.ok, kubeError, v.id);
      if (v.core.ok) assert.equal(opts.kubeContext, v.core.want, v.id);
    }
  });

  it('sign only manifests that core and the gate read back', () => {
    for (const v of data.vectors.filter((x) => x.kind === 'runbook' && typeof x.core.manifest === 'string')) {
      assert.doesNotThrow(() => parseManifest(v.core.manifest as string), v.id);
      assert.equal((v.core.reading as { ok: boolean }).ok, true, v.id);
    }
  });

  it('read a runbook the same whatever its line endings and BOM', () => {
    // Except a signature block with lone CRs: it isn't read (the runbook reads as unsigned, everywhere).
    const groups = new Map<string, Vector[]>();
    for (const v of data.vectors.filter((x) => x.kind === 'runbook')) {
      const base = v.id.replace(/ \((LF|CRLF|CR|mixed)(, BOM)?\)$/, '');
      groups.set(base, [...(groups.get(base) ?? []), v]);
    }
    for (const [base, vs] of groups) {
      if (base.startsWith('signed')) continue;
      const strip = (c: Record<string, unknown>): string => JSON.stringify({ ...c, manifest: undefined, reading: { ...(c.reading as object), text: undefined } });
      for (const v of vs) assert.equal(strip(v.core), strip(vs[0]!.core), v.id);
    }
  });
});
