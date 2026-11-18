/**
 * The linear matchers (core/redactScan.ts) find exactly what the built-in patterns' regular
 * expressions find: same starts, same ends, on a large random corpus and on the repository's own
 * runbooks, docs and tests. And they stay fast where the regular expressions were quadratic.
 * REDACT_CORPUS_LINES sets the corpus size (default 50,000 lines, about 15 s; run it with 1,000,000
 * or more after changing a pattern) and REDACT_CORPUS_SEED its seed.
 */
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { REFERENCE_RE, scanForLeaks } from '@md-runbook/core/leaks';
import { DEFAULT_PATTERNS, REDACTED, RedactionPattern, createRedactor, mergeSpans, patternFinder, patternRegexes, redactSecretManifests } from '@md-runbook/core/redact';
import { LINEAR_FINDERS, LINEAR_PARTS, Spans, findReferences, isRegexSpace } from '@md-runbook/core/redactScan';
import { corpus } from './redactCorpus';

const LINES = Number(process.env.REDACT_CORPUS_LINES ?? 50_000);
const SEED = Number(process.env.REDACT_CORPUS_SEED ?? 20261117);
const ROOT = path.join(__dirname, '..', '..');

const LINEAR = DEFAULT_PATTERNS.filter((p) => LINEAR_FINDERS.has(p.name ?? ''));
const byRegex = (re: RegExp, text: string): Spans => [...text.matchAll(re)].map((m) => [m.index ?? 0, (m.index ?? 0) + m[0].length]);
/** What `p` finds by its regular expressions: its own matches, or for a pattern found in parts the union of its parts' (patternRegexes). */
function byPattern(p: RedactionPattern, text: string): Spans {
  const res = patternRegexes(p);
  return res.length === 1 ? byRegex(res[0]!, text) : mergeSpans(res.flatMap((re) => byRegex(re, text)));
}

/** The redactor by the regular expressions: the union of what they all match, each merged span replaced once. */
function regexRedact(text: string): string {
  const t = redactSecretManifests(text);
  let out = '';
  let at = 0;
  for (const [start, end] of mergeSpans(DEFAULT_PATTERNS.flatMap((p) => byPattern(p, t)))) {
    out += t.slice(at, start) + REDACTED;
    at = end;
  }
  return out + t.slice(at);
}

const show = (text: string): string => JSON.stringify(text.length > 400 ? text.slice(0, 400) + '…' : text);

/**
 * `text` with no continued line: a blank after each `\` before a line break. password-flag-tool's
 * matcher reads such a line as going on, its regular expression reads one line at a time (see
 * redact.ts, before toolRule), so the two are compared on this; redactWiden.test.ts tests
 * continued lines.
 */
const noContinuedLines = (text: string): string => text.replace(/\\(?=[\r\n])/g, '\\ ');

/** Compare every linear matcher with its regular expression on `text`; count the matches. */
function compare(text: string, counts: Map<string, number>, where: string): void {
  for (const p of LINEAR) {
    const t = p.name === 'password-flag-tool' ? noContinuedLines(text) : text;
    // A pattern found in parts: each part's matcher against that part's regular expression, then the union.
    const parts = LINEAR_PARTS.get(p.name!);
    if (parts) {
      patternRegexes(p).forEach((re, i) => {
        const want = byRegex(re, t);
        const got = parts[i]!(t);
        if (JSON.stringify(got) !== JSON.stringify(want)) {
          assert.fail(`${p.name} part ${i} (${where}) on ${show(t)}:\n  regex  ${JSON.stringify(want)}\n  linear ${JSON.stringify(got)}`);
        }
      });
    }
    const want = byPattern(p, t);
    const got = LINEAR_FINDERS.get(p.name!)!(t);
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      assert.fail(`${p.name} (${where}) on ${show(t)}:\n  regex  ${JSON.stringify(want)}\n  linear ${JSON.stringify(got)}`);
    }
    counts.set(p.name!, (counts.get(p.name!) ?? 0) + want.length);
  }
  const want = byRegex(REFERENCE_RE, text);
  const got = findReferences(text);
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    assert.fail(`references (${where}) on ${show(text)}:\n  regex  ${JSON.stringify(want)}\n  linear ${JSON.stringify(got)}`);
  }
  counts.set('references', (counts.get('references') ?? 0) + want.length);
}

function filesUnder(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'node_modules' && !e.name.startsWith('.')) filesUnder(f, out);
    } else if (/\.(?:md|ts|tsx|txt|json|ya?ml|sh|ps1)$/.test(e.name) && fs.statSync(f).size < 2_000_000) out.push(f);
  }
  return out;
}

describe('linear redaction matchers', () => {
  it('cover the patterns whose regular expressions backtrack', () => {
    assert.deepEqual(
      LINEAR.map((p) => p.name),
      [
        'authorization-header',
        'cookie-header',
        'bearer-token',
        'jwt',
        'secret-key-value-quoted',
        'secret-key-value',
        'pass-key-value',
        'secret-flag-value',
        'keycloak-client-secret',
        'authorization-header-quoted',
        'cookie-header-quoted',
        'secret-after-unicode-space',
        'password-flag-tool',
        'secret-key-value-spaced',
      ],
    );
    for (const p of LINEAR) assert.equal(patternFinder(p), LINEAR_FINDERS.get(p.name!));
    // The patterns found in parts: a matcher for the whole and for each alternative.
    assert.deepEqual([...LINEAR_PARTS.keys()], ['secret-key-value-quoted', 'pass-key-value', 'secret-key-value-spaced']);
    for (const p of LINEAR.filter((x) => LINEAR_PARTS.has(x.name!))) assert.equal(patternRegexes(p).length, LINEAR_PARTS.get(p.name!)!.length, p.name);
    // A pattern of yours that only shares a name is a regular expression.
    assert.notEqual(patternFinder({ name: 'jwt', pattern: 'eyJ' }), LINEAR_FINDERS.get('jwt'));
  });

  it('read \\s as JavaScript does', () => {
    for (let c = 0; c <= 0xffff; c++) assert.equal(isRegexSpace(c), /\s/.test(String.fromCharCode(c)), `U+${c.toString(16)}`);
    assert.equal(isRegexSpace(NaN), false);
  });

  it(`find what the regular expressions find on ${LINES.toLocaleString('en')} random lines`, (t) => {
    const counts = new Map<string, number>();
    let seen = 0;
    for (const text of corpus(SEED, LINES)) {
      compare(text, counts, `corpus text ${seen++}`);
    }
    t.diagnostic(`matches: ${[...counts].map(([k, n]) => `${k} ${n}`).join(', ')}`);
    // Each pattern matched often: the corpus reaches what it guards.
    for (const k of [...LINEAR.map((p) => p.name!), 'references']) assert.ok((counts.get(k) ?? 0) > LINES / 200, `${k}: ${counts.get(k)} matches`);
  });

  it('find what the regular expressions find in the repository’s runbooks, docs and tests', () => {
    const counts = new Map<string, number>();
    const files = ['docs', 'examples', 'test', 'walkthrough', 'apps/mobile/src/__tests__', 'README.md', 'CHANGELOG.md'].flatMap((d) => {
      const f = path.join(ROOT, d);
      return fs.existsSync(f) && fs.statSync(f).isFile() ? [f] : filesUnder(f);
    });
    assert.ok(files.length > 50, `${files.length} files`);
    for (const f of files) {
      const text = fs.readFileSync(f, 'utf8');
      compare(text, counts, path.relative(ROOT, f));
      // Line by line too: a test's inputs are one line each.
      for (const line of text.split('\n')) compare(line, counts, path.relative(ROOT, f));
    }
  });

  it('redact as the regular expressions did', () => {
    const r = createRedactor(DEFAULT_PATTERNS);
    for (const raw of corpus(7, Math.ceil(LINES / 4))) {
      const text = noContinuedLines(raw);
      assert.equal(r.redact(text), regexRedact(text), show(text));
    }
  });
});

/** Each call well under what a quadratic reading takes (tens of seconds for 200,000 characters). */
const BUDGET_MS = Number(process.env.REDACT_BUDGET_MS ?? 2_000);
const N = 200_000;

const rep = (s: string, n = N): string => s.repeat(Math.ceil(n / s.length)).slice(0, n);
/** Lines that made a regular expression backtrack quadratically (and a few more of the same kind). */
const HOSTILE = [
  ' '.repeat(N),
  '\t'.repeat(N),
  rep(' \t'),
  'Authorization:' + ' '.repeat(N) + '\u2028',
  'Authorization=' + '\t'.repeat(N),
  'Cookie:' + ' '.repeat(N),
  'Bearer' + ' '.repeat(N) + '!',
  'password:' + ' '.repeat(N),
  'password="' + ' '.repeat(N),
  'DB_PASS =' + ' '.repeat(N),
  '--password' + ' '.repeat(N),
  rep(' -p'),
  rep(' -p '),
  'login' + rep(' -p'),
  'mysql' + rep(' -p'),
  rep(' -pa'),
  ' -u' + ' '.repeat(N) + 'a:',
  rep('eyJ-'),
  rep('eyJa'),
  rep('password="${a'),
  rep('password=$(a'),
  rep("token: '${"),
  rep('password: '),
  rep('password='),
  rep('a.password:'),
  rep('password'),
  rep('Authorization: '),
  rep('Bearer '),
  rep('--password '),
  rep(' --user a:'),
  rep('a://a:'),
  rep('-----END '),
  rep('"type":"secret","value":"'),
  rep('secret 0'),
  rep('0000000-'),
  rep('${'),
  rep('$('),
  rep('%a'),
  rep('a:'),
  rep('a='),
  rep('"'),
  rep("'"),
  rep('$a password=x '),
  rep('AKIAABCDEFGHIJKLMNOP '),
  rep('-----BEGIN A PRIVATE KEY-----'),
  rep('secret '),
  'secret' + ' '.repeat(N),
  rep('a'),
  rep('-'),
  // second review of 0.30: escaped JSON values, quoted pass values, a tool's name in a segment
  'password:\\"' + '\\'.repeat(N),
  rep('password:\\"\\\\\\"'),
  rep('DB_PASS="a '),
  rep('DB_PASS=\\"a '),
  rep('-/mongo '),
  rep('A=/zip '),
  rep('mongo \\\n'),
  // third review of 0.30: quoted user:pass, escaped Secret JSON, Redis flags (prefixes and paths: redactWiden.test.ts)
  rep(' -u "a:\\"'),
  ' -u "a:' + '\\"'.repeat(N / 2),
  '"kind":"Secret",' + rep('\\"data\\":{\\"a\\":\\"'),
  '"kind":"Secret","data":{' + rep('\\"a\\":\\"b\\\\'),
  rep(' requirepass'),
  // fourth review of 0.30: requirepass after a line's start or config set, a reference after user: in quotes
  rep('\n # requirepass '),
  rep('config set requirepass '),
  rep(' config set'),
  rep(' -u "a:$'),
  // final review of 0.30: quotes that a `\"` closes, a `${…}` user part
  rep('password="a\\" '),
  rep('password="\\"\\"'),
  rep('"a\\";'),
  rep(' -u "${a:'),
  rep(' -u "${a}:'),
  ' -u "${' + 'a'.repeat(N),
  rep('sshpass='),
  // 0.30.0 review: each quote's alternative read on its own
  rep(`password="a\\", token='`),
  rep(`DB_PASS=\\"a; api key: '`),
  // text glued to a closing quote
  rep(`password='a'`),
  rep(`password='a'"`),
  rep(`password='a''`),
  `password='a''` + 'b'.repeat(N),
  rep(`password="a"'b`),
  rep(`--password 'a'b"`),
  rep(`password=\\"a\\"b`),
  rep(`sshpass -p 'a'\\'`),
  `password='a'"` + 'b'.repeat(N),
];

describe('redaction and the leak scan stay linear on 200,000-character lines', () => {
  const redactor = createRedactor(DEFAULT_PATTERNS);
  for (const p of DEFAULT_PATTERNS) {
    it(p.name ?? p.pattern, () => {
      const find = patternFinder(p);
      const t0 = performance.now();
      for (const line of HOSTILE) find(line);
      const ms = performance.now() - t0;
      // secret-after-unicode-space is eight patterns in one (each of them read with Unicode spaces).
      const budget = p.name === 'secret-after-unicode-space' ? 4 * BUDGET_MS : BUDGET_MS;
      assert.ok(ms < budget, `${p.name}: ${Math.round(ms)} ms for ${HOSTILE.length} lines`);
    });
  }
  it('variable references (leak scan)', () => {
    const t0 = performance.now();
    for (const line of HOSTILE) findReferences(line);
    const ms = performance.now() - t0;
    assert.ok(ms < BUDGET_MS, `${Math.round(ms)} ms`);
  });
  it('the redactor, all patterns', () => {
    const t0 = performance.now();
    for (const line of HOSTILE) redactor.redact(line);
    const ms = performance.now() - t0;
    assert.ok(ms < 4 * BUDGET_MS, `${Math.round(ms)} ms`);
  });
  it('scanForLeaks', () => {
    const t0 = performance.now();
    for (const line of HOSTILE) scanForLeaks(line);
    const ms = performance.now() - t0;
    // Every detector, the widened ones included (about 180 ms a line here; quadratic would be minutes).
    assert.ok(ms < 8 * BUDGET_MS, `${Math.round(ms)} ms`);
  });
});
