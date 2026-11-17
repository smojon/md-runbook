/**
 * The pseudonymizer's linear matchers (core/pseudonymScan.ts) find exactly what NS_FLAG_RE, NS_RE
 * and URL_RE (aiContext.ts) find, on random kubectl/helm/URL-heavy text and the repository's
 * files; and they, and the pseudonymizer, stay fast where the regular expressions were quadratic.
 * KUBE_CORPUS_LINES sets the corpus size (default 50,000 lines).
 */
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { NS_FLAG_RE, NS_RE, URL_RE, buildAiContext } from '@md-runbook/core/aiContext';
import { findNamespaceFlags, findNamespaces, findUrls } from '@md-runbook/core/pseudonymScan';
import { corpus, kubeCorpus } from './redactCorpus';

const LINES = Number(process.env.KUBE_CORPUS_LINES ?? 50_000);
const ROOT = path.join(__dirname, '..', '..');

const spans = (re: RegExp, text: string): Array<[number, number]> => [...text.matchAll(re)].map((m) => [m.index ?? 0, (m.index ?? 0) + m[0].length]);
const urls = (text: string): Array<[number, number, number]> =>
  [...text.matchAll(URL_RE)].map((m) => [m.index ?? 0, (m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length - (m[1] ?? '').length]);
const show = (text: string): string => JSON.stringify(text.length > 300 ? text.slice(0, 300) + '…' : text);

function compare(text: string, counts: Record<string, number>, where: string): void {
  const cases: Array<[string, unknown[], unknown[]]> = [
    ['NS_FLAG_RE', spans(NS_FLAG_RE, text), findNamespaceFlags(text)],
    ['NS_RE', spans(NS_RE, text), findNamespaces(text)],
    ['URL_RE', urls(text), findUrls(text)],
  ];
  for (const [name, want, got] of cases) {
    if (JSON.stringify(got) !== JSON.stringify(want)) assert.fail(`${name} (${where}) on ${show(text)}:\n  regex  ${JSON.stringify(want)}\n  linear ${JSON.stringify(got)}`);
    counts[name] = (counts[name] ?? 0) + want.length;
  }
}

describe('linear pseudonymizer matchers', () => {
  it(`find what the regular expressions find on ${LINES.toLocaleString('en')} random lines`, (t) => {
    const counts: Record<string, number> = {};
    let n = 0;
    for (const text of kubeCorpus(20261117, LINES)) compare(text, counts, `text ${n++}`);
    t.diagnostic(`matches: ${JSON.stringify(counts)}`);
    for (const k of ['NS_FLAG_RE', 'NS_RE', 'URL_RE']) assert.ok((counts[k] ?? 0) > LINES / 20, `${k}: ${counts[k]}`);
  });

  it('find what the regular expressions find in the redaction corpus and the repository’s files', () => {
    const counts: Record<string, number> = {};
    const texts = [...corpus(4, 5000)];
    const walk = (dir: string): void => {
      if (!fs.existsSync(dir)) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const f = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name !== 'node_modules') walk(f);
        } else if (/\.(?:md|ts|tsx|json|ya?ml|sh)$/.test(e.name) && fs.statSync(f).size < 1_000_000) texts.push(fs.readFileSync(f, 'utf8'));
      }
    };
    for (const d of ['docs', 'examples', 'test', 'apps/ops', 'walkthrough']) walk(path.join(ROOT, d));
    for (const [i, text] of texts.entries()) {
      compare(text, counts, `text ${i}`);
      for (const line of text.split('\n')) compare(line, counts, `a line of text ${i}`);
    }
    assert.ok((counts.URL_RE ?? 0) > 100, JSON.stringify(counts));
  });
});

const BUDGET_MS = Number(process.env.REDACT_BUDGET_MS ?? 2_000);
const N = 100_000;
const rep = (s: string, n = N): string => s.repeat(Math.ceil(n / s.length)).slice(0, n);
const HOSTILE = [
  ' '.repeat(N),
  '\t'.repeat(N),
  rep('a.'),
  rep('a.a.a.a ') + '://',
  rep('a-'),
  rep('-n '),
  'kubectl' + rep(' -n a'),
  rep('kubectl -n a\n'),
  rep('ns='),
  rep('ns = '),
  rep('namespace: '),
  rep('oc project '),
  rep('"namespace": "'),
  'http://' + rep('a.'),
  rep('http://a'),
  rep('a://'),
  rep('x@'),
];

describe('the pseudonymizer stays linear on 100,000-character lines', () => {
  for (const [name, find] of [
    ['NS_FLAG_RE', findNamespaceFlags],
    ['NS_RE', findNamespaces],
    ['URL_RE', findUrls],
  ] as const) {
    it(name, () => {
      const t0 = performance.now();
      for (const line of HOSTILE) find(line);
      const ms = performance.now() - t0;
      assert.ok(ms < BUDGET_MS, `${Math.round(ms)} ms`);
    });
  }
  it('buildAiContext with pseudonymize', () => {
    // Not a 100,000-character host name: the expression of known names it builds is too large (a
    // separate limit, as in 0.29.0).
    for (const line of HOSTILE.filter((l) => !l.startsWith('http://a.a.'))) {
      const t0 = performance.now();
      buildAiContext('```bash\n' + line + '\n```\n', { pseudonymize: true, maxOutputLines: 1000, maxChars: 1_000_000 });
      const ms = performance.now() - t0;
      assert.ok(ms < BUDGET_MS, `${show(line.slice(0, 30))}: ${Math.round(ms)} ms`);
    }
  });
});
