/**
 * Readers of user text that were quadratic on hostile input, rewritten to read it once, give what
 * the expressions they replace gave (random text from the characters each one looks at), and stay
 * fast on 100,000 characters: output attributes, call-copy digests, cloud views, the prose
 * checks' quotation ends, output levels, typo suggestions, a cell's commands, a parameter's
 * choices, trailing blanks (cell options, signed text, proposals).
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { TASK_BOX_RE, copyDigest, uncheckTaskBoxes } from '@md-runbook/core/callCopy';
import { cloudView, JSON_START_RE, startsJson } from '@md-runbook/core/cloudViews';
import { setInfoOption } from '@md-runbook/core/cellOptions';
import { isBlank, trimEndWith } from '@md-runbook/core/lineText';
import { KNOWN_OPTIONS, suggestOption } from '@md-runbook/core/lint';
import { LEVEL_MATCHER, LEVEL_WORDS, levelSpans } from '@md-runbook/core/outputColors';
import { ATTR_RE, parseAttrs } from '@md-runbook/core/outputBlock';
import { ENDS_IN_QUOTE_RE, endsInQuote, proseSentences } from '@md-runbook/core/prose';
import { CHOICE_SEPARATOR_RE, ONE_OF_RE, oneOf, paramComment, splitChoices } from '@md-runbook/core/secrets';
import { signedText } from '@md-runbook/core/signing';
import { splitSteps } from '@md-runbook/core/steps';
import { random } from './redactCorpus';

const COUNT = Number(process.env.HOSTILE_CORPUS ?? 30_000);
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const NBSP = String.fromCharCode(0xa0);

/** `count` random strings of up to `max` pieces from `pieces`. */
function* texts(seed: number, pieces: readonly string[], count = COUNT, max = 24): Generator<string> {
  const r = random(seed);
  for (let n = 0; n < count; n++) {
    let s = '';
    const k = Math.floor(r() * max);
    for (let i = 0; i < k; i++) s += pieces[Math.floor(r() * pieces.length)];
    yield s;
  }
}

const show = (s: string): string => JSON.stringify(s.length > 200 ? s.slice(0, 200) + '…' : s);

/** parseAttrs as it was. */
function oldParseAttrs(s: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of s.matchAll(ATTR_RE)) {
    const key = m[1];
    if (key) attrs[key] = decodeAttr(m[2] ?? m[3] ?? '');
  }
  return attrs;
}

/** outputBlock's decodeAttr. */
function decodeAttr(v: string): string {
  if (!v.includes('%')) return v;
  return v.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}

/** levelSpans as it was. */
function oldLevelSpans(line: string): Array<{ text: string; level?: string }> {
  if (/\u001b\[[0-9;]*m/.test(line)) return [{ text: line }];
  const spans: Array<{ text: string; level?: string }> = [];
  let at = 0;
  LEVEL_MATCHER.lastIndex = 0;
  for (let m = LEVEL_MATCHER.exec(line); m; m = LEVEL_MATCHER.exec(line)) {
    const k = m.findIndex((g, i) => i > 0 && g !== undefined);
    const level = k > 0 ? LEVEL_WORDS[k - 1]?.level : undefined;
    if (m[0] === '') {
      LEVEL_MATCHER.lastIndex++;
      continue;
    }
    if (!level) continue;
    if (m.index > at) spans.push({ text: line.slice(at, m.index) });
    spans.push({ text: m[0], level });
    at = m.index + m[0].length;
  }
  if (at < line.length || spans.length === 0) spans.push({ text: line.slice(at) });
  return spans;
}

/** suggestOption as it was: every option's distance. */
function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
    }
  }
  return d[a.length]![b.length]!;
}
function oldSuggestOption(key: string): string | undefined {
  const k = key.toLowerCase();
  const max = k.length <= 4 ? 1 : 2;
  let best: string | undefined;
  let bestDistance = Infinity;
  let tie = false;
  for (const option of KNOWN_OPTIONS) {
    const plural = option.endsWith('y') ? `${option.slice(0, -1)}ies` : `${option}s`;
    const distance = Math.min(editDistance(k, option), editDistance(k, plural));
    if (distance < bestDistance) {
      best = option;
      bestDistance = distance;
      tie = false;
    } else if (distance === bestDistance) tie = true;
  }
  return best !== undefined && bestDistance <= max && !tie ? best : undefined;
}

describe('one-pass readers give what the expressions gave', () => {
  it('output attributes (parseAttrs)', () => {
    for (const s of texts(1, ['a', 'k', '-', '_', '=', '"', ' ', '\t', '\n', 'x', '%41', '%e2%82', 'ab=', 'k="v"', '="', '==', '\u00a0', LS])) {
      assert.deepEqual(parseAttrs(s), oldParseAttrs(s), show(s));
    }
  });

  it('task boxes in a call copy (uncheckTaskBoxes)', () => {
    for (const s of texts(2, ['-', '*', '+', ' ', '\t', '\n', '\r', LS, PS, '\u00a0', '[', ']', 'x', 'X', '[ ]', '[x]', '- [x]', 'a', '  - ', '\n\n'])) {
      assert.equal(uncheckTaskBoxes(s), s.replace(TASK_BOX_RE, '$1[ ]'), show(s));
    }
  });

  it('a JSON start in cloud output (startsJson)', () => {
    for (const s of texts(3, ['[', '{', ' ', '\t', '\n', '\r', LS, PS, '\u00a0', 'a', '\ufeff', '"', '\u{1F600}'])) {
      assert.equal(startsJson(s), JSON_START_RE.test(s), show(s));
    }
  });

  it('a sentence that ends in a quotation (endsInQuote)', () => {
    for (const s of texts(4, ['S', 'Q', '\ue000', '\ue001', '0', '1', '9', 'a', ' ', 'S\ue0001\ue001', '\ue0002'])) {
      assert.equal(endsInQuote(s), ENDS_IN_QUOTE_RE.test(s), show(s));
    }
  });

  it('output levels (levelSpans)', () => {
    const words = LEVEL_WORDS.flatMap((l) => [...l.words, ...(l.colon ?? []).map((w) => `${w}:`), ...(l.brackets ?? []).map((w) => `[${w}]`)]);
    const pieces = [...words, 'Exception', 'exception', 'a', 'A', '.', ' ', '_', '1', ':', '[', ']', '✓', '✗', 'E1022 12:00:00.000000', 'x.Exception', 'Exception.', 'IOException', '\u001b[31m'];
    for (const s of texts(5, pieces, COUNT / 2, 16)) assert.deepEqual(levelSpans(s), oldLevelSpans(s), show(s));
  });

  it('typo suggestions (suggestOption)', () => {
    const options = [...KNOWN_OPTIONS];
    const r = random(6);
    for (let n = 0; n < COUNT / 20; n++) {
      let k = options[Math.floor(r() * options.length)]!;
      const edits = Math.floor(r() * 5);
      for (let e = 0; e < edits; e++) {
        const at = Math.floor(r() * (k.length + 1));
        const c = 'abcdefghijklmnopqrstuvwxyz-_'[Math.floor(r() * 28)]!;
        const kind = r();
        k = kind < 0.33 ? k.slice(0, at) + c + k.slice(at) : kind < 0.66 ? k.slice(0, at) + k.slice(at + 1) : k.slice(0, at) + c + k.slice(at + 1);
      }
      if (r() < 0.1) k = k.toUpperCase();
      assert.equal(suggestOption(k), oldSuggestOption(k), k);
    }
  });

  it('a parameter\'s choices (oneOf, splitChoices)', () => {
    const pieces = ['one of:', 'One Of:', 'ONE OF:', 'one of', ' ', ' ', '(', ')', '.', ',', 'a', '1.2', 'or', ' or ', '"x"', "'y'", '\t', ':', 'x.', '. ', NBSP];
    for (const s of texts(8, pieces, COUNT, 14)) {
      const t = s.trim();
      const m = ONE_OF_RE.exec(t);
      assert.deepEqual(oneOf(t), m ? { index: m.index, list: m[1] } : undefined, show(t));
    }
    for (const s of texts(9, [' ', ',', 'or', 'OR', 'a', '\t', ' or ', ', or ', 'b', 'or\t', NBSP], COUNT, 14)) {
      assert.deepEqual(splitChoices(s), s.split(CHOICE_SEPARATOR_RE), show(s));
    }
  });

  it('trailing blanks and whitespace (trimEndWith, trimEnd)', () => {
    for (let c = 0; c <= 0xffff; c++) {
      const s = `a${String.fromCharCode(c)}`;
      assert.equal(s.trimEnd(), s.replace(/\s+$/, ''), `U+${c.toString(16)}`);
    }
    for (const s of texts(7, [' ', '\t', 'a', '\n', '\u00a0', LS])) {
      assert.equal(s.trimEnd(), s.replace(/\s+$/, ''), show(s));
      assert.equal(trimEndWith(s, isBlank), s.replace(/[ \t]+$/, ''), show(s));
    }
  });
});

const BUDGET_MS = Number(process.env.REDACT_BUDGET_MS ?? 2_000);
const N = 100_000;
const rep = (s: string, n = N): string => s.repeat(Math.ceil(n / s.length)).slice(0, n);

function fast(name: string, run: () => unknown): void {
  const t0 = performance.now();
  run();
  const ms = performance.now() - t0;
  assert.ok(ms < BUDGET_MS, `${name}: ${Math.round(ms)} ms`);
}

describe('they stay fast on 100,000 characters', () => {
  it('each of them', () => {
    for (const s of ['a'.repeat(N), rep('-'), rep('_'), rep('eyJ'), rep('a="'), rep('a=')]) fast('parseAttrs', () => parseAttrs(s));
    for (const s of [rep('\n'), rep('\n '), rep(' -\n'), rep('\n- ') + 'x']) fast('copyDigest', () => copyDigest(s));
    for (const s of [rep('\n'), rep(' \n')]) fast('cloudView', () => cloudView(s));
    for (const s of [rep('a.'), rep('i.'), rep('a.Exception.'), rep('Exception.a'), rep('ERROR.')]) fast('levelSpans', () => levelSpans(s));
    for (const s of [' '.repeat(N), 'a'.repeat(N)]) fast('suggestOption', () => suggestOption(s));
    for (const s of [rep('a\r\n'), rep('a:\n'), rep('a\n\n')]) fast('splitSteps', () => splitSteps(s, 'pwsh'));
    for (const s of [' '.repeat(N) + 'x', 'x' + ' '.repeat(N) + 'y', rep('one of: '), rep('a or ')]) fast('paramComment', () => paramComment('one of: a' + s));
    fast('proseSentences', () => proseSentences(rep('```\n')));
    for (const s of [' '.repeat(N) + 'x', ' '.repeat(N) + LS + 'x']) {
      fast('setInfoOption', () => setInfoOption(`bash ${s}`, 'timeout', '5'));
      fast('signedText', () => signedText(s));
    }
  });
});
