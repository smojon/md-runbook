import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { DEFAULT_WRITE_OPTIONS, parse, serialize } from '../src/core';
import { roundTrip, show, untouched } from './helpers';

/** Small deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generate(r: () => number): string {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const eols = ['\n', '\n', '\r\n', '\r\n', '\r'];
  const fileEol = pick(['\n', '\r\n']);
  const eol = () => (r() < 0.1 ? pick(eols) : fileEol);
  const lines: string[] = [];
  const indent = () => pick(['', '', '', ' ', '  ', '   ', '    ', '\t']);
  const fence = () => pick(['```', '```', '~~~', '````', '~~~~~']);
  const lang = () => pick(['sh', 'bash', 'pwsh', 'powershell', 'cmd', 'PowerShell', 'json', 'text', '', 'sh title="a b"', ' bash {x}']);
  const text = () => pick(['Some text', '# Heading', '- item', '', '   ', '\t', 'echo `x`', '```', '~~~', '````', '<!-- comment -->', 'ünïcode ✓', 'a\u001bb']);

  const n = 1 + Math.floor(r() * 12);
  for (let k = 0; k < n; k++) {
    const kind = r();
    if (kind < 0.35) {
      lines.push(text());
    } else if (kind < 0.85) {
      const ind = indent();
      const f = fence();
      lines.push(ind + f + lang());
      const body = Math.floor(r() * 4);
      for (let b = 0; b < body; b++) lines.push(pick([ind, '', ' ']) + text());
      if (r() < 0.93) lines.push(pick([ind, '']) + f + pick(['', f[0]!, '  ']));
      if (r() < 0.4) {
        if (r() < 0.3) lines.push('');
        lines.push(ind + `<!-- md-runbook:output start exit=${pick(['0', '1', 'timeout'])} ran=2026-10-18T14:20:00+02:00 -->`);
        const of = pick(['```', '````']);
        lines.push(ind + of + 'text');
        const ol = Math.floor(r() * 3);
        for (let o = 0; o < ol; o++) lines.push(ind + text());
        if (r() < 0.95) lines.push(ind + of);
        if (r() < 0.95) lines.push(ind + '<!-- md-runbook:output end -->');
      }
    } else {
      lines.push('');
    }
  }
  let s = (r() < 0.1 ? '\uFEFF' : '') + lines.map((l) => l + eol()).join('');
  if (r() < 0.2) s = s.replace(/(?:\r\n|\n|\r)$/, '');
  return s;
}

describe('randomized documents', () => {
  it('round-trip byte for byte (3000 documents)', () => {
    const r = rng(Number(process.env.SEED ?? 12345));
    for (let k = 0; k < Number(process.env.N ?? 3000); k++) {
      const doc = generate(r);
      const out = roundTrip(doc);
      if (out !== doc) assert.fail(`document #${k} changed\n  in:  ${show(doc)}\n  out: ${show(out)}`);
    }
  });

  it('edited code values survive save + reload (1000 documents)', () => {
    const r = rng(777);
    for (let k = 0; k < 1000; k++) {
      const src = generate(r);
      const doc = parse(src);
      const cells = untouched(doc);
      const expected: string[] = [];
      for (const c of cells) {
        if (c.kind === 'code') {
          c.value = c.value + '\necho edited ```\n```';
          expected.push(c.value);
        }
      }
      const out = serialize(doc.meta, cells, DEFAULT_WRITE_OPTIONS);
      const re = parse(out);
      const got = re.cells.filter((c) => c.kind === 'code').map((c) => c.value);
      assert.deepEqual(got, expected, `document #${k}\n  in:  ${show(src)}\n  out: ${show(out)}`);
      assert.equal(roundTrip(out), out);
    }
  });

  it('new outputs survive save + reload (1000 documents)', () => {
    const r = rng(4242);
    const sample = ['plain', '```\nfenced\n```', '<!-- md-runbook:output end -->', '', '\n\nlead', 'a\r\nb', '~~~'];
    for (let k = 0; k < 1000; k++) {
      const src = generate(r);
      const doc = parse(src);
      const cells = untouched(doc);
      const expected: string[] = [];
      cells.forEach((c, idx) => {
        if (c.kind === 'code') {
          const t = sample[(k + idx) % sample.length]!;
          c.output = { kind: 'new', text: t, attrs: { exit: '0' } };
          expected.push(t.replace(/\r\n/g, '\n').replace(/\n+$/, ''));
        }
      });
      const out = serialize(doc.meta, cells, DEFAULT_WRITE_OPTIONS);
      const got = parse(out)
        .cells.filter((c) => c.kind === 'code')
        .map((c) => c.output?.text);
      assert.deepEqual(got, expected, `document #${k}\n  in:  ${show(src)}\n  out: ${show(out)}`);
    }
  });
});
