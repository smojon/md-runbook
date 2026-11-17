/**
 * Edit as Text's highlighting (editor/highlight.ts): every kind, nesting, line ends, unterminated
 * blocks, and huge or pathological texts in bounded time.
 */
import { HIGHLIGHT_KINDS, HighlightKind, Span, highlight, lineBounds, lineRuns } from '../editor/highlight';
import { MAX_RUNBOOK_BYTES } from '../runbooks/store';

/** The spans as [kind, text] pairs, in order. */
const marks = (text: string): [HighlightKind, string][] => highlight(text).map((s) => [s.kind, text.slice(s.start, s.end)]);
const of = (text: string, kind: HighlightKind): string[] =>
  marks(text)
    .filter(([k]) => k === kind)
    .map(([, t]) => t);

/** Spans are sorted, inside the text, never across a line end, and nested (no partial overlap). */
function wellFormed(text: string, spans: Span[]): void {
  const { starts, ends } = lineBounds(text);
  const lineOf = (pos: number): number => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const open: Span[] = [];
  let last = 0;
  for (const s of spans) {
    expect(s.start).toBeGreaterThanOrEqual(last);
    expect(s.end).toBeGreaterThan(s.start);
    expect(s.end).toBeLessThanOrEqual(text.length);
    const line = lineOf(s.start);
    expect(s.end).toBeLessThanOrEqual(ends[line]!);
    while (open.length && open[open.length - 1]!.end <= s.start) open.pop();
    if (open.length) expect(s.end).toBeLessThanOrEqual(open[open.length - 1]!.end);
    open.push(s);
    last = s.start;
  }
}

const RUNBOOK = [
  '---',
  'title: Restart',
  'params:',
  '  - service: api',
  '---',
  '# Restart the **API**',
  '',
  'When it *hangs*, see [the wiki](https://wiki.example.net/api) or <https://status.example.net>.',
  '',
  '- [ ] Tell the channel',
  '1. Check `uptime` first',
  '> Careful: _production_.',
  '',
  '```bash name="Restart" timeout=30 kube-context=prod os=linux capture=PID expect="active" skip',
  'systemctl restart api # **not bold**',
  '```',
  '<!-- md-runbook:output start exit=0 duration=1.2s -->',
  '```text',
  'ok',
  '```',
  '<!-- md-runbook:output end -->',
  '<!-- md-runbook:note by=ana at=2026-11-16 -->',
  '> **Note:** it came back',
  '> after 30 s',
  'Back to prose.',
  '<!-- a comment -->',
  '<details><summary>md-runbook: earlier runs</summary>',
  '</details>',
  '<!-- md-runbook:signature v1 signer=ana@example.net signed=2026-11-16',
  'manifest',
  'AAAA',
  '-->',
  '',
].join('\n');

describe('highlight: the kinds', () => {
  it('front matter, headings, bold, italic, links, inline code, lists, quotes', () => {
    expect(of(RUNBOOK, 'frontMatter')).toEqual(['---', 'title: Restart', 'params:', '  - service: api', '---']);
    expect(of(RUNBOOK, 'heading')).toEqual(['# Restart the **API**']);
    expect(of(RUNBOOK, 'bold')).toEqual(['**API**']);
    expect(of(RUNBOOK, 'italic')).toEqual(['*hangs*', '_production_']);
    expect(of(RUNBOOK, 'linkText')).toEqual(['[the wiki]']);
    expect(of(RUNBOOK, 'linkUrl')).toEqual(['(https://wiki.example.net/api)', '<https://status.example.net>']);
    expect(of(RUNBOOK, 'inlineCode')).toEqual(['`uptime`']);
    expect(of(RUNBOOK, 'listMarker')).toEqual(['- [ ]', '1.']);
    expect(of(RUNBOOK, 'quote')).toEqual(['> Careful: _production_.']);
  });

  it('fences: the fence, the language, the cell options and their values, the code', () => {
    expect(of(RUNBOOK, 'fence')).toEqual(['```', '```']);
    expect(of(RUNBOOK, 'fenceLang')).toEqual(['bash']);
    expect(of(RUNBOOK, 'option')).toEqual(['name', 'timeout', 'kube-context', 'os', 'capture', 'expect', 'skip']);
    expect(of(RUNBOOK, 'optionValue')).toEqual(['"Restart"', '30', 'prod', 'linux', 'PID', '"active"']);
    // A code body is one kind: no Markdown inside.
    expect(of(RUNBOOK, 'code')).toEqual(['systemctl restart api # **not bold**']);
    expect(marks('```\n# not a heading\n```\n')).toEqual([
      ['fence', '```'],
      ['code', '# not a heading'],
      ['fence', '```'],
    ]);
    // Tildes, longer fences, indented (in a list), Pandoc braces.
    expect(marks('~~~~ sh {.x}\n~~~\nx\n~~~~\n')).toEqual([
      ['fence', '~~~~'],
      ['fenceLang', 'sh'],
      ['code', '~~~'],
      ['code', 'x'],
      ['fence', '~~~~'],
    ]);
    expect(of('- a\n  ```pwsh\n  Get-Date\n  ```\n', 'fenceLang')).toEqual(['pwsh']);
    // Options start after the first word as core ends it (ASCII blanks): after a no-break space
    // there are none, as core reads it; the language is the word before it, as langOf finds it.
    const nbsp = '```bash kube-context=prod\nx\n```\n';
    expect(of(nbsp, 'fenceLang')).toEqual(['bash']);
    expect(of(nbsp, 'option')).toEqual([]);
    expect(of('```bash  kube-context=prod\nx\n```\n', 'option')).toEqual(['kube-context']);
  });

  it("md-runbook's markers: output, notes, run history, signatures; other comments", () => {
    expect(of(RUNBOOK, 'marker')).toEqual([
      '<!-- md-runbook:output start exit=0 duration=1.2s -->',
      '<!-- md-runbook:output end -->',
      '<!-- md-runbook:note by=ana at=2026-11-16 -->',
      '<details><summary>md-runbook: earlier runs</summary>',
      '</details>',
    ]);
    // An output block's lines are output, its fences too.
    expect(of(RUNBOOK, 'output')).toEqual(['```text', 'ok', '```']);
    expect(of(RUNBOOK, 'note')).toEqual(['> **Note:** it came back', '> after 30 s']);
    expect(of(RUNBOOK, 'signature')).toEqual([
      '<!-- md-runbook:signature v1 signer=ana@example.net signed=2026-11-16',
      'manifest',
      'AAAA',
      '-->',
    ]);
    expect(of(RUNBOOK, 'comment')).toEqual(['<!-- a comment -->']);
    expect(of('a <!-- inline --> b', 'comment')).toEqual(['<!-- inline -->']);
    // The prose after a note is prose again.
    expect(marks(RUNBOOK).filter(([, t]) => t.includes('Back to prose'))).toEqual([]);
  });

  it('every kind has a test above, and a colour in both themes', () => {
    const seen = new Set(highlight(RUNBOOK + 'x <!-- y -->\n').map((s) => s.kind));
    expect([...HIGHLIGHT_KINDS].filter((k) => !seen.has(k))).toEqual([]);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { light, dark } = require('../theme') as typeof import('../theme');
    for (const k of HIGHLIGHT_KINDS) {
      expect(light.highlight[k]).toMatch(/^#[0-9a-f]{6}$/);
      expect(dark.highlight[k]).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

describe('highlight: nesting and edge cases', () => {
  it('nests inline spans, and lineRuns gives each piece its kinds, outermost first', () => {
    const text = '# A **b `c`** [d *e*](f)';
    wellFormed(text, highlight(text));
    const [line] = lineRuns(text, highlight(text));
    expect(line!.runs.map((r) => [text.slice(r.start, r.end), r.kinds.join('>')])).toEqual([
      ['# A ', 'heading'],
      ['**b ', 'heading>bold'],
      ['`c`', 'heading>bold>inlineCode'],
      ['**', 'heading>bold'],
      [' ', 'heading'],
      ['[d ', 'heading>linkText'],
      ['*e*', 'heading>linkText>italic'],
      [']', 'heading>linkText'],
      ['(f)', 'heading>linkUrl'],
    ]);
    // The runs cover each line exactly; an empty line has none.
    const lines = lineRuns(RUNBOOK, highlight(RUNBOOK));
    for (const l of lines) expect(l.runs.map((r) => RUNBOOK.slice(r.start, r.end)).join('')).toBe(RUNBOOK.slice(l.start, l.end));
    expect(lines[6]!.runs).toEqual([]);
  });

  it('not emphasis: snake_case, a lone star, a star before a blank, code first', () => {
    expect(of('run my_long_name now', 'italic')).toEqual([]);
    expect(of('2 * 3 * 4', 'italic')).toEqual([]);
    expect(of('a ** b', 'bold')).toEqual([]);
    expect(of('`**x**` and **y**', 'bold')).toEqual(['**y**']);
    expect(of('``a ` b`` c', 'inlineCode')).toEqual(['``a ` b``']);
    expect(of('`unclosed and `` other', 'inlineCode')).toEqual([]);
  });

  it('CRLF and lone CR end lines, and spans stop before them', () => {
    const crlf = RUNBOOK.replace(/\n/g, '\r\n');
    const spans = highlight(crlf);
    wellFormed(crlf, spans);
    expect(spans.map((s) => [s.kind, crlf.slice(s.start, s.end)])).toEqual(marks(RUNBOOK));
    expect(marks('# a\rb **c**')).toEqual([
      ['heading', '# a'],
      ['bold', '**c**'],
    ]);
  });

  it('unterminated: a fence runs to the end; an output start without an end is a marker only', () => {
    expect(marks('```sh\nls\n\n# x\n')).toEqual([
      ['fence', '```'],
      ['fenceLang', 'sh'],
      ['code', 'ls'],
      ['code', '# x'],
    ]);
    expect(marks('<!-- md-runbook:output start exit=0 -->\n# x\n')).toEqual([
      ['marker', '<!-- md-runbook:output start exit=0 -->'],
      ['heading', '# x'],
    ]);
    expect(of('<!-- open\n# x\n', 'comment')).toEqual(['<!-- open', '# x']);
    // Front matter that never closes is prose (as core reads it).
    expect(of('---\ntitle: x\n# y\n', 'frontMatter')).toEqual([]);
    expect(of('**open *open [open](open', 'bold')).toEqual([]);
    expect(highlight('')).toEqual([]);
    expect(lineRuns('', [])).toEqual([{ start: 0, end: 0, runs: [] }]);
  });
});

describe('highlight: size and time', () => {
  const timed = (text: string): number => {
    const t0 = performance.now();
    const spans = highlight(text);
    lineRuns(text, spans);
    return performance.now() - t0;
  };

  it('the largest runbook the app takes (2 MB), in a few seconds at most', () => {
    let text = '';
    while (text.length < MAX_RUNBOOK_BYTES) text += RUNBOOK;
    text = text.slice(0, MAX_RUNBOOK_BYTES);
    expect(timed(text)).toBeLessThan(5_000);
    wellFormed(text.slice(0, 50_000), highlight(text.slice(0, 50_000)));
  });

  it('pathological lines: linear, not quadratic', () => {
    const n = 400_000;
    const cases = [
      '['.repeat(n),
      '[a]'.repeat(n / 3),
      '*'.repeat(n),
      '* a'.repeat(n / 3),
      '_a'.repeat(n / 2),
      '`'.repeat(n),
      '` ``'.repeat(n / 4),
      '`a``b```c'.repeat(n / 9),
      '<http'.repeat(n / 5),
      '<!--'.repeat(n / 4),
      '**a *b [c](d'.repeat(n / 12),
      '<!-- md-runbook:output start' + '--> '.repeat(n / 4) + 'x',
      '<details><summary>md-runbook:' + ' '.repeat(n) + 'x',
      '```' + ' a=1'.repeat(n / 4),
      '```' + ' a="'.repeat(n / 4),
      '- '.repeat(n / 2),
      '#'.repeat(n),
      ' '.repeat(n) + 'x',
      // U+2028 and U+2029 end no line, and core's fence pattern once backtracked on them.
      '`'.repeat(n) + ' ',
      '~'.repeat(n) + ' ',
      '#' + ' '.repeat(n) + ' ',
      '<!-- md-runbook:output start ' + ' '.repeat(n) + ' ',
    ];
    for (const line of cases) {
      // A line, and the same line many times over.
      expect(timed(line)).toBeLessThan(3_000);
      expect(timed((line.slice(0, 2_000) + '\n').repeat(200))).toBeLessThan(3_000);
    }
  });

  it('many lines: fences, comments and output blocks opened and never closed', () => {
    const n = 100_000;
    for (const line of ['```', '<!-- md-runbook:output start -->', '<!-- md-runbook:x', '<!--', '> a', '---']) {
      expect(timed((line + '\n').repeat(n))).toBeLessThan(3_000);
    }
  });
});
