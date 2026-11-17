/**
 * The leak scan's Kubernetes Secret reading (core/leaks.ts) in linear time, finding what the
 * scans it replaces found: `secretMappings` as `yamlObjectIsSecret` on every line, and the brace
 * search around each `"data": {…}` as reading back and ahead with a depth count did, on random
 * YAML and JSON documents (nested, many, malformed) and the repository's files.
 * K8S_CORPUS_LINES sets the corpus size (default 50,000 lines and JSON parts).
 */
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { KIND_SECRET_JSON, enclosingBraces, inSecretObjects, lineIndent, scanForLeaks, secretMappings, yamlObjectIsSecret } from '@md-runbook/core/leaks';
import { corpus, k8sCorpus, random } from './redactCorpus';

const COUNT = Number(process.env.K8S_CORPUS_LINES ?? 50_000);
const ROOT = path.join(__dirname, '..', '..');
const DATA_RE = /\\?"(?:data|stringData)\\?"\s*:\s*\{([^{}]*)\}/g;

/** The brace search as it was (0.29.0): from each span, back to the `{` and ahead to the `}` around it. */
function oldBraces(text: string, [at, matchEnd]: readonly [number, number]): [number, number] {
  let start = 0;
  for (let d = 0, j = at - 1; j >= 0; j--) {
    const ch = text[j];
    if (ch === '}') d++;
    else if (ch === '{' && d-- === 0) {
      start = j;
      break;
    }
  }
  let end = text.length;
  for (let d = 0, j = matchEnd; j < text.length; j++) {
    const ch = text[j];
    if (ch === '{') d++;
    else if (ch === '}' && d-- === 0) {
      end = j + 1;
      break;
    }
  }
  return [start, end];
}

const show = (text: string): string => JSON.stringify(text.length > 300 ? text.slice(0, 300) + '…' : text);

function compareYaml(text: string, counts: { lines: number; secret: number }): void {
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  const isSecret = secretMappings(lines);
  lines.forEach((line, i) => {
    if (/^\s*(?:#.*)?$/.test(line) || /^(?:---|\.\.\.)\s*$/.test(line)) return;
    const want = yamlObjectIsSecret(lines, i, lineIndent(line));
    if (isSecret(i) !== want) assert.fail(`line ${i} of ${show(text)}: scan ${want}, secretMappings ${isSecret(i)}`);
    counts.lines++;
    if (want) counts.secret++;
  });
}

function compareJson(text: string, spans: Array<[number, number]>, counts: { spans: number; secret: number }): void {
  const got = enclosingBraces(text, spans);
  const secret = inSecretObjects(text, spans);
  spans.forEach((span, n) => {
    const want = oldBraces(text, span);
    if (JSON.stringify(got[n]) !== JSON.stringify(want)) assert.fail(`span ${span} of ${show(text)}: search ${want}, enclosingBraces ${got[n]}`);
    const wantSecret = KIND_SECRET_JSON.test(text.slice(want[0], want[1]));
    if (secret[n] !== wantSecret) assert.fail(`span ${span} of ${show(text)}: test ${wantSecret}, inSecretObjects ${secret[n]}`);
    counts.spans++;
    if (wantSecret) counts.secret++;
  });
}

const dataSpans = (text: string): Array<[number, number]> => [...text.matchAll(DATA_RE)].map((m) => [m.index ?? 0, (m.index ?? 0) + m[0].length]);

/** Random spans in order, not overlapping (empty ones too). */
function randomSpans(text: string, r: () => number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let at = Math.floor(r() * 5); at <= text.length; at += 1 + Math.floor(r() * 12)) {
    const end = Math.min(text.length, at + Math.floor(r() * 8));
    out.push([at, end]);
    at = end;
  }
  return out;
}

describe('Kubernetes Secret reading in the leak scan', () => {
  it(`reads YAML and JSON as the scans did, on ${COUNT.toLocaleString('en')} random lines and parts`, (t) => {
    const yaml = { lines: 0, secret: 0 };
    const json = { spans: 0, secret: 0 };
    const r = random(5);
    for (const text of k8sCorpus(20261117, COUNT)) {
      compareYaml(text, yaml);
      compareJson(text, dataSpans(text), json);
      compareJson(text, randomSpans(text, r), json);
    }
    t.diagnostic(`YAML lines ${yaml.lines} (${yaml.secret} in a Secret), JSON spans ${json.spans} (${json.secret} in a Secret)`);
    assert.ok(yaml.secret > COUNT / 50 && yaml.lines - yaml.secret > COUNT / 50, JSON.stringify(yaml));
    assert.ok(json.secret > COUNT / 50 && json.spans - json.secret > COUNT / 50, JSON.stringify(json));
  });

  it('reads the redaction corpus and the repository’s files as the scans did', () => {
    const yaml = { lines: 0, secret: 0 };
    const json = { spans: 0, secret: 0 };
    const texts = [...corpus(3, 5000)];
    for (const d of ['docs', 'examples', 'test', 'apps/ops', 'apps/mobile/src/__tests__']) {
      const walk = (dir: string): void => {
        if (!fs.existsSync(dir)) return;
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const f = path.join(dir, e.name);
          if (e.isDirectory()) {
            if (e.name !== 'node_modules') walk(f);
          } else if (/\.(?:md|ts|tsx|json|ya?ml)$/.test(e.name) && fs.statSync(f).size < 1_000_000) texts.push(fs.readFileSync(f, 'utf8'));
        }
      };
      walk(path.join(ROOT, d));
    }
    for (const text of texts) {
      compareYaml(text, yaml);
      compareJson(text, dataSpans(text), json);
    }
    assert.ok(yaml.lines > 10_000, JSON.stringify(yaml));
  });
});

const BUDGET_MS = Number(process.env.REDACT_BUDGET_MS ?? 2_000);
const N = 100_000;
const rep = (s: string, n = N): string => s.repeat(Math.ceil(n / s.length)).slice(0, n);

/** Documents that made the scans quadratic, and more of their kind. */
const HOSTILE = [
  rep('data:\n'),
  'kind: Secret\n' + rep('data:\n'),
  rep('kind: Secret\ndata:\n'),
  rep('  data:\n'),
  rep('- data:\n'),
  'kind: Secret\ndata:\n' + rep('  a: b\n'),
  'kind: Secret\ndata:\n' + rep('  data:\n'),
  rep('"data":{}'),
  '{"kind":"Secret",' + rep('"data":{"a":"b"},'),
  rep('{"data":{},'),
  rep('{') + '"data":{}',
  '"data":{}' + rep('}'),
  rep('\\"data\\":{\\"a\\":\\"b\\"},'),
  rep('"kind":"Secret",'),
];

describe('the leak scan stays linear on 100,000-character Kubernetes documents', () => {
  for (const [n, text] of HOSTILE.entries()) {
    it(show(text.slice(0, 40)) + ` (${n})`, () => {
      const t0 = performance.now();
      scanForLeaks(text);
      const ms = performance.now() - t0;
      assert.ok(ms < BUDGET_MS, `${Math.round(ms)} ms`);
    });
  }
});
