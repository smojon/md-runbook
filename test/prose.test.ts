/**
 * The prose checks (core/prose.ts): first the cases of the sister project's
 * tests/test_prose_ratchet.py, so both count the same, then the phrase rules, repeats, the heading
 * rule, levels, the ignore marker, the editor's marker levels and the command line's ratchet.
 */
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { lintRunbook } from '@md-runbook/core/lint';
import { parse } from '@md-runbook/core';
import { ProseOptions, checkProse, markupCellAt, measureProse, proseDuplicates, proseSentences, proseUnits, proseWords, roundAverage } from '@md-runbook/core/prose';
import { markerLevel, proseSetting } from '../src/lintLevel';
import { lint } from '../src/cli/main';
import { formatBaseline, globToRegExp, measureFile, proseConfig, proseWorse } from '../src/cli/prose';

// On GitHub Actions the ratchet writes to the job summary: not from these tests.
delete process.env.GITHUB_STEP_SUMMARY;

/** n words, the last one ending the sentence (prose_ratchet's test helper). */
const sentence = (n: number): string => Array(n - 1).fill('word').join(' ') + ' end.';
const rules = (md: string, rule: string, options: ProseOptions = {}): Array<[number, string]> =>
  checkProse(md, options).filter((f) => f.rule === rule).map((f) => [f.line, f.message]);
const units = (md: string, options: ProseOptions = {}): Array<[number, string]> => proseUnits(md, options).map((u) => [u.line, u.text.replace(/\n/g, ' ')]);
const lines = (md: string, rule: string): number[] => checkProse(md).filter((f) => f.rule === rule).map((f) => f.line);

describe('prose parity with prose_ratchet.py (its tests, the same counts)', () => {
  it('only prose is read', () => {
    const text =
      '---\ntitle: a long front matter line that is not prose at all, with many words in it\n---\n' +
      '# A heading with many words that would be far too long for a sentence anyway\n\n' +
      '```bash\necho a very long command line with a great many words in it that is code\n```\n\n' +
      '| a | table with many words in a cell that would be too long as a sentence |\n\n' +
      '<!-- md-runbook:signature v1 with a long comment line that is not prose either -->\n\n' +
      'One sentence.\n';
    assert.deepEqual(units(text).map(([, t]) => t), ['One sentence.']);
  });

  it('each list item is its own unit, nested ones too (lines 0-based here, 1-based there)', () => {
    assert.deepEqual(units('- First item.\n  It goes on here.\n  - A nested item.\n- [ ] A manual step.\n\n> A quote.\n'), [
      [0, 'First item. It goes on here.'],
      [2, 'A nested item.'],
      [3, 'A manual step.'],
      [5, 'A quote.'],
    ]);
  });

  it('a code span, a link and a URL count as one word', () => {
    assert.equal(proseWords('Run `uv run python runbooks/x.py --flag` now.'), 3);
    assert.equal(proseWords('Read [the long title of a page](https://example.org/a/b) first.'), 3);
    assert.equal(proseWords('Open https://runbook.127.0.0.1.nip.io/open?url=x now.'), 3);
  });

  it('sentences end before a lowercase name but not at versions or abbreviations', () => {
    assert.deepEqual(proseSentences('It runs in Docker. nevisAdmin 4 starts it, e.g. on 0.25.1. kubectl reads it · the end'), [
      'It runs in Docker.',
      'nevisAdmin 4 starts it, e.g. on 0.25.1.',
      'kubectl reads it',
      'the end',
    ]);
  });

  it('a sentence of 21 words is a finding and 20 is not', () => {
    assert.deepEqual(lines(sentence(20) + '\n\n' + sentence(21) + '\n', 'prose-sentence'), [2]);
  });

  it('a paragraph of four sentences or over 60 words is a finding', () => {
    const four = Array(4).fill(sentence(3)).join(' ');
    const long = [20, 20, 21].map(sentence).join(' '); // three sentences, 61 words
    const found = checkProse(four + '\n\n' + long + '\n\n' + sentence(5) + '\n').filter((f) => f.rule === 'prose-paragraph');
    assert.deepEqual(found.map((f) => [f.line, f.sentences]), [[0, 4], [2, 3]]);
  });

  it('a new file is held to the rules', () => {
    assert.deepEqual(proseWorse({ sentences: 0, units: 0, average: 12.0 }, undefined), []);
    assert.notDeepEqual(proseWorse({ sentences: 1, units: 0, average: 12.0 }, undefined), []);
    assert.notDeepEqual(proseWorse({ sentences: 0, units: 0, average: 15.5 }, undefined), []);
  });

  it('a recorded file may get better, not worse', () => {
    const before = { sentences: 10, units: 4, average: 17.0 };
    assert.deepEqual(proseWorse({ sentences: 9, units: 4, average: 16.0 }, before), []);
    assert.deepEqual(proseWorse({ sentences: 11, units: 4, average: 16.0 }, before), ['11 sentences over 20 words (was 10)']);
    assert.deepEqual(proseWorse({ sentences: 10, units: 5, average: 16.0 }, before), ['5 paragraphs over 3 sentences or 60 words (was 4)']);
    assert.deepEqual(proseWorse({ sentences: 10, units: 4, average: 17.5 }, before), ['17.5 words a sentence on average (was 17.0)']);
  });

  // The rules as the author of prose_ratchet.py states them.
  it('a sentence ends at . ! ? with closing marks, before a letter or digit; · ends one too', () => {
    // The closing marks go with the space that ends the sentence (as there: the words are the same).
    assert.deepEqual(proseSentences('Stop! Go? "Yes." (Fine.) **Bold.** 4 left. a b'), ['Stop!', 'Go?', '"Yes.', '(Fine.', 'Bold.', '4 left.', 'a b']);
    assert.deepEqual(proseSentences('One · two · three'), ['One', 'two', 'three']);
    assert.deepEqual(proseSentences('See e.g. this, i.e. that, etc. vs. them, cf. those and v0.25.1 here.'), [
      'See e.g. this, i.e. that, etc. vs. them, cf. those and v0.25.1 here.',
    ]);
    // "No." and "Fig." are no abbreviations any more: "the answer is no." ends a sentence.
    assert.deepEqual(proseSentences('The answer is no. Fig. 2 shows it.'), ['The answer is no.', 'Fig.', '2 shows it.']);
    assert.deepEqual(proseSentences('Ends with a stop.... next'), ['Ends with a stop....', 'next']);
  });

  it('a list item without a full stop is one unit; continuation lines join it; a blank line ends a unit', () => {
    assert.deepEqual(units('- no full stop here\n- [x] done item\n  continued\n\nNext\nsame paragraph\n'), [
      [0, 'no full stop here'],
      [1, 'done item continued'],
      [4, 'Next same paragraph'],
    ]);
    assert.equal(measureProse('- no full stop here\n').count, 1);
  });

  it('skipped: multi-line comments, lines starting with | # ![ <, horizontal rules; ~~~ fences', () => {
    assert.deepEqual(units('<!--\nhidden\n-->\n| a |\n# h\n![img](x.png)\n<br>\n---\n***\n~~~\ncode\n~~~\nKept.\n'), [[12, 'Kept.']]);
  });

  it('words: ** and __ dropped, tokens need a letter or digit (— · | not counted), an image link is one word', () => {
    assert.equal(proseWords('**Bold** and __under__ — then | a ![a long alt text](x.png) end'), 7);
    assert.deepEqual(proseSentences('A — b'), ['A — b']);
  });

  it('a unit is over its limit past 60 words or past 3 sentences; the average is words over sentences', () => {
    assert.deepEqual(lines([20, 20, 20].map(sentence).join(' ') + '\n', 'prose-paragraph'), []);
    assert.deepEqual(lines(Array(3).fill(sentence(3)).join(' ') + '\n', 'prose-paragraph'), []);
    const m = measureProse(sentence(10) + '\n\n' + sentence(13) + '\n\n' + sentence(13) + '\n');
    assert.equal(m.count, 3);
    assert.equal(m.average, 12);
  });

  it("averages round as Python's round(x, 1) (exact ties to even), and the baseline is written as json.dumps(indent=1, sort_keys=True)", () => {
    assert.equal(roundAverage(12.25), 12.2);
    assert.equal(roundAverage(16.75), 16.8);
    assert.equal(roundAverage(17.85), 17.9); // not a tie in binary: 17.850000000000001
    assert.equal(roundAverage(49 / 3), 16.3);
    assert.equal(
      formatBaseline({ 'b.md': { units: 1, sentences: 2, average: 26 }, 'a.md': { sentences: 0, units: 0, average: 17.8, phrases: 1 } }),
      '{\n "a.md": {\n  "average": 17.8,\n  "phrases": 1,\n  "sentences": 0,\n  "units": 0\n },\n "b.md": {\n  "average": 26.0,\n  "sentences": 2,\n  "units": 1\n }\n}\n',
    );
    assert.equal(formatBaseline({}), '{}\n');
  });

  it('globs as fnmatch: * and ** cross folders', () => {
    assert.ok(globToRegExp('tests/fixtures/*').test('tests/fixtures/a/b.md'));
    assert.ok(globToRegExp('tests/fixtures/**').test('tests/fixtures/b.md'));
    assert.ok(globToRegExp('CLAUDE.md').test('CLAUDE.md'));
    assert.ok(!globToRegExp('CLAUDE.md').test('apps/CLAUDE.md'));
    assert.ok(globToRegExp('runbooks/11?*.md').test('runbooks/11b-x.md'));
  });

  it('a callout label is dropped before counting: an emoji, a bold label, then · (the default labels)', () => {
    assert.deepEqual(units('> 🔑 **Key point** · Keep it short.\n\n- 💡 **Did you know?** · It counts.\n\n**Bold** · no emoji.\n'), [
      [0, 'Keep it short.'],
      [2, 'It counts.'],
      [4, 'no emoji.'],
    ]);
    assert.equal(measureProse('🔑 **Key point** · Keep it short.\n').count, 1);
    assert.deepEqual(units('**Bold** words, no dot.\n'), [[0, '**Bold** words, no dot.']]);
  });

  it('labels and skipLines, as a repository configures them: labels replace the default, [] turns it off', () => {
    assert.deepEqual(units('🔑 **Key point** · Kept.\n', { labels: [] }), [[0, '🔑 **Key point** · Kept.']]);
    assert.deepEqual(units('NOTE: Kept.\n\n🔑 **Key point** · Kept.\n', { labels: [/^NOTE: /] }), [
      [0, 'Kept.'],
      [2, '🔑 **Key point** · Kept.'],
    ]);
    assert.deepEqual(units('*⏱ The whole guide: about 48 min: commands 24 min (19 of 21 measured), 7 steps by hand.*\n\nKept.\n', { skipLines: [/^\*⏱/] }), [[2, 'Kept.']]);
    assert.equal(units('*⏱ a time line*\n').length, 1); // no default
  });

  it("a GitHub alert's marker line is not prose; the quote's text after it is", () => {
    assert.deepEqual(units('> [!NOTE]\n> Read this first.\n\n> [!warning]\n> Careful.\n'), [
      [1, 'Read this first.'],
      [4, 'Careful.'],
    ]);
  });

  // Where md-runbook deliberately differs: fences as CommonMark reads them (prose_ratchet.py toggles at
  // every ``` or ~~~ line, so a ```` fence holding ``` blocks, or a ```` code span at a line start, flips it).
  it('deviation: a longer fence holds shorter ones; an inline ```` code span opens no fence', () => {
    assert.deepEqual(units('````md\n```bash\necho\n```\nstill code\n````\nProse.\n'), [[6, 'Prose.']]);
    assert.deepEqual(units('  ```` `a` ```` is a code span.\nSo is this.\n').length, 1);
  });
});

describe("md-runbook's own blocks and markup", () => {
  it('output blocks, history, incident notes and comments are not prose; inline comments are dropped', () => {
    const text =
      '```bash\necho\n```\n\n<!-- md-runbook:output start exit=0 ran=2026-11-15T10:00:00+01:00 -->\n```text\nsome output words here\n```\n<!-- md-runbook:output end -->\n' +
      '<details><summary>md-runbook: 2 previous runs</summary>\n</details>\n\n' +
      '<!-- md-runbook:note at=2026-11-15T10:00:00+01:00 milestone=detected -->\n> **10:00 · detected:** a note written during an incident\n\n' +
      'The end <!-- a comment with words -->.\n';
    assert.deepEqual(units(text).map(([, t]) => t), ['The end  .']);
  });

  it('a link that wraps counts once, and a long sentence is reported on the line it starts', () => {
    assert.equal(proseWords('A [link that\nwraps](https://x.org) counts once.'), 4);
    assert.deepEqual(lines('Short one.\n' + sentence(10) + '\n' + sentence(21).replace(/ /g, '\n'), 'prose-sentence'), [2]);
  });
});

describe('prose: messages', () => {
  it('a long sentence: its words and the sentence', () => {
    assert.deepEqual(rules('Run `kubectl get pods -A` and ' + sentence(22) + '\n', 'prose-sentence'), [
      [0, `25 words, at most 20: "Run \`kubectl get pods -A\` and ${sentence(22)}"`],
    ]);
  });

  it('a paragraph or a list item with several ideas', () => {
    const four = Array(4).fill(sentence(3)).join(' ');
    assert.deepEqual(rules(four + '\n', 'prose-paragraph'), [[0, 'Several ideas (4 sentences, 12 words): make it a list']]);
    assert.deepEqual(rules('- ' + four + '\n', 'prose-paragraph'), [[0, 'Several ideas (4 sentences, 12 words): split this item']]);
  });

  it('a file average over 15 is no finding: only the ratchet records it', () => {
    const m = measureProse('# T\n\n' + sentence(16) + '\n\n' + sentence(17) + '\n');
    assert.equal(m.average, 16.5);
    assert.deepEqual(m.findings, []);
  });
});

describe('prose: phrases, repeats, the heading', () => {
  it('throat-clearing openers', () => {
    assert.deepEqual(rules('Please note that the job restarts.\n\nIt is important to note that it stops.\n\nAs mentioned above, it waits.\n\nNotes that count.\n', 'prose-opener'), [
      [0, 'Delete the opener "Please note that"'],
      [2, 'Delete the opener "It is important to note that"'],
      [4, 'Delete the opener "As mentioned above"'],
    ]);
  });

  it('announcing sentences', () => {
    assert.deepEqual(rules('This section describes the restart.\n\nThe following steps show how.\n\nThis restarts the API.\n', 'prose-announcing'), [
      [0, 'Delete this sentence, it only announces: "This section describes the restart."'],
      [2, 'Delete this sentence, it only announces: "The following steps show how."'],
    ]);
  });

  it('padding words and "in order to", on the line they are on; not in code or inside a word', () => {
    assert.deepEqual(rules('Basically run it.\nIt is obviously\nfast, in order\nto win. Run `simply` and adjust simply-typed. Of course it waits.\n', 'prose-padding'), [
      [0, 'Delete "Basically"'],
      [1, 'Delete "obviously"'],
      [2, 'Use "to", not "in order to"'],
      [3, 'Delete "Of course"'],
    ]);
    // Words that nearly always carry meaning are not padding.
    assert.deepEqual(rules('It needs just enough memory. The very login they watch. It really works. It actually ran.\n', 'prose-padding'), []);
  });

  it('the same sentence twice: already said, normalised; short ones may repeat; code spans tell them apart', () => {
    const md = 'Wait for all the pods to show Running.\n\n- Check the logs.\n- **Wait** for all the pods to show  Running\n- Check the logs.\n';
    assert.deepEqual(rules(md, 'prose-repeat'), [[3, 'Already said on line 1: "Wait for all the pods to show Running"']]);
    assert.deepEqual(rules('Run `a` on the first host now.\n\nRun `b` on the first host now.\n', 'prose-repeat'), []);
  });

  it('the first sentence under a heading that only says the heading again', () => {
    const says = "Says the heading again: cut it, or add what's new";
    assert.deepEqual(rules('## Restart the API\n\nThis restarts the API.\n', 'prose-heading'), [[2, says]]);
    assert.deepEqual(rules('## Restart the API\n\nRestart the API when it hangs for over 5 minutes.\n', 'prose-heading'), []);
    assert.deepEqual(rules('## Restart the API\n\nCheck the queue first.\n', 'prose-heading'), []);
    // Only the first sentence of the first unit; a code block in between doesn't matter.
    assert.deepEqual(rules('## Restart the API\n\n```bash\nx\n```\n\nThis restarts the API. It restarts the API.\n\nThe API restarts.\n', 'prose-heading'), [[6, says]]);
    // A heading's number is not one of its words: this sentence adds the exit code.
    assert.deepEqual(rules('## 3. Exit codes and failures\n\nFails with exit code 3.\n', 'prose-heading'), []);
    // A heading of one content word is never compared.
    assert.deepEqual(rules('## Rollback\n\nRoll back.\n', 'prose-heading'), []);
  });
});

describe('prose: levels and the ignore marker', () => {
  const long = sentence(27) + '\n';
  const levels = (md: string): string[] => lintRunbook(md).map((p) => `${p.line + 1} ${p.severity} ${p.code ?? ''}`);

  it('info by default, warnings with prose: strict, none with prose: off', () => {
    assert.deepEqual(levels(long), ['1 info prose-sentence']);
    assert.deepEqual(levels('---\nprose: strict\n---\n' + long), ['4 warning prose-sentence']);
    assert.deepEqual(levels('---\nprose: off\n---\n' + long), []);
    assert.deepEqual(levels('---\nprose: on\n---\nShort.\n'), []);
    assert.deepEqual(levels('---\nprose: strict\n---\nPlease note that it waits.\n'), ['4 warning prose-opener']);
  });

  it('prose: strict: a sentence of 23 words stays info (at most 20), one of 27 is a warning (at most 25)', () => {
    const at = (md: string): string[] => lintRunbook(md).map((p) => `${p.severity} ${p.message.slice(0, 22)}`);
    assert.deepEqual(at('---\nprose: strict\n---\n' + sentence(23) + '\n'), ['info 23 words, at most 20: ']);
    assert.deepEqual(at('---\nprose: strict\n---\n' + sentence(27) + '\n'), ['warning 27 words, at most 25: ']);
    assert.deepEqual(at(sentence(27) + '\n'), ['info 27 words, at most 20: ']);
    // The strict limit is a repository's limit too.
    const strict = lintRunbook('---\nprose: strict\n---\n' + sentence(27) + '\n', { prose: { limits: { strictSentenceWords: 30 } } });
    assert.deepEqual(strict.map((p) => p.severity), ['info']);
  });

  it('an unknown prose: value is ignored, with a warning', () => {
    assert.deepEqual(
      lintRunbook('---\nprose: loud\n---\nShort.\n').map((p) => p.message),
      ['front matter prose: "loud" is ignored (expected on, strict or off)'],
    );
  });

  it('<!-- md-runbook:prose-ignore --> at the end of a line or on the line before skips that paragraph or item', () => {
    assert.deepEqual(checkProse(sentence(25) + ' <!-- md-runbook:prose-ignore -->\n'), []);
    assert.deepEqual(checkProse('<!-- md-runbook:prose-ignore -->\n' + sentence(25) + '\n'), []);
    assert.deepEqual(checkProse('- ' + sentence(25) + ' <!-- md-runbook:prose-ignore -->\n- Short.\n'), []);
    // Only the line right after: a blank line in between ends it.
    assert.equal(checkProse('<!-- md-runbook:prose-ignore -->\n\n' + sentence(25) + '\n').length, 1);
  });

  it('a finding in a Markdown cell is placed on that cell, as the runbook view shows it', () => {
    const md = '# T\n\nShort.\n\n```bash\necho\n```\n\nIntro.\n' + long;
    const p = lintRunbook(md).find((x) => x.code === 'prose-sentence')!;
    assert.equal(p.line, 9);
    assert.deepEqual(p.cell, { index: 2, sourceLine: 1 });
    assert.deepEqual(markupCellAt(parse(md), 0), { index: 0, sourceLine: 0 });
  });
});

describe('prose in VS Code: marker levels (mdRunbook.lint.prose)', () => {
  const info = { severity: 'info' as const, code: 'prose-sentence' };
  const strict = { severity: 'warning' as const, code: 'prose-sentence' };
  it('information by default, hint or off as set; strict stays a warning unless off', () => {
    assert.equal(proseSetting(undefined), 'information');
    assert.equal(proseSetting('bogus'), 'information');
    assert.equal(markerLevel(info, 'information'), 'information');
    assert.equal(markerLevel(info, 'hint'), 'hint');
    assert.equal(markerLevel(info, 'off'), undefined);
    assert.equal(markerLevel(strict, 'hint'), 'warning');
    assert.equal(markerLevel(strict, 'off'), undefined);
    assert.equal(markerLevel({ severity: 'warning' }, 'off'), 'warning');
    assert.equal(markerLevel({ severity: 'error' }, 'off'), 'error');
  });
});

describe('md-runbook lint: prose', () => {
  const dir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'mdrb-prose-'));
  const write = (d: string, name: string, content: string): string => {
    fs.mkdirSync(path.dirname(path.join(d, name)), { recursive: true });
    fs.writeFileSync(path.join(d, name), content);
    return path.join(d, name);
  };
  const run = (argv: string[]): { code: number; out: string } => {
    const out: string[] = [];
    const code = lint(argv, (l) => out.push(l));
    return { code, out: out.join('\n') };
  };
  const inDir = <T>(d: string, fn: () => T): T => {
    const before = process.cwd();
    process.chdir(d);
    try {
      return fn();
    } finally {
      process.chdir(before);
    }
  };
  const git = (d: string, ...args: string[]): void => void execFileSync('git', args, { cwd: d, stdio: 'ignore' });

  it('lists prose findings as info; they never fail, not even with --strict', () => {
    const f = write(dir(), 'r.md', sentence(25) + '\n');
    const r = run([f, '--strict']);
    assert.equal(r.code, 0);
    assert.match(r.out, /r\.md:1: info: 25 words, at most 20: "word/);
    assert.match(r.out, /✓ 1 file checked, 0 problems, 1 prose note$/);
    assert.equal(run([write(dir(), 'r.md', '---\nprose: strict\n---\n' + sentence(25) + '\n'), '--strict']).code, 0);
    assert.equal(run([write(dir(), 'r.md', '---\nprose: strict\n---\n' + sentence(27) + '\n'), '--strict']).code, 1);
  });

  it('--prose-only: a plain document, its code examples not checked', () => {
    const f = write(dir(), 'README.md', 'Use it.\n\n```bash timeout=x\necho ${out:X}\n```\n');
    assert.equal(run([f]).code, 1);
    const r = run([f, '--prose-only']);
    assert.equal(r.code, 0);
    assert.match(r.out, /0 problems$/);
  });

  it('--prose-baseline: per rule; worse or new fails, listing the findings; --update-baseline never raises', () => {
    const d = dir();
    write(d, 'docs/a.md', sentence(25) + '\n');
    write(d, 'b.md', 'Short.\n');
    inDir(d, () => {
      assert.equal(run(['--prose-baseline', 'base.json', 'docs/a.md']).code, 2); // no baseline yet
      assert.match(run(['--prose-baseline', 'base.json', '--update-baseline', 'docs/a.md', 'b.md']).out, /recorded 1 file in base\.json/);
      assert.equal(fs.readFileSync('base.json', 'utf8'), '{\n "docs/a.md": {\n  "average": 25.0,\n  "sentences": 1,\n  "units": 0\n }\n}\n');
      assert.match(run(['--prose-baseline', 'base.json', 'docs/a.md', 'b.md']).out, /✅ prose: no file harder to read; 1 long sentences left in 1 file/);
      // A phrase in a file not recorded: listed, and it fails.
      write(d, 'b.md', 'Please note that it is short.\n');
      const worse = run(['--prose-baseline', 'base.json', 'docs/a.md', 'b.md']);
      assert.equal(worse.code, 1);
      assert.match(worse.out, /^b\.md:1: Delete the opener "Please note that"$/m);
      assert.match(worse.out, /❌ prose: 1 file harder to read than before\n- b\.md: 1 phrases to cut \(was 0\)/);
      // Updating doesn't record it: it still fails.
      assert.equal(run(['--prose-baseline', 'base.json', '--update-baseline', 'docs/a.md', 'b.md']).code, 1);
      assert.doesNotMatch(fs.readFileSync('base.json', 'utf8'), /b\.md/);
      // Better: passes, says so, and the update lowers the numbers.
      write(d, 'b.md', 'Short.\n');
      write(d, 'docs/a.md', sentence(25) + ' <!-- md-runbook:prose-ignore -->\n');
      assert.match(run(['--prose-baseline', 'base.json', 'docs/a.md', 'b.md']).out, /1 file got better: record them with --update-baseline/);
      run(['--prose-baseline', 'base.json', '--update-baseline', 'docs/a.md', 'b.md']);
      assert.equal(fs.readFileSync('base.json', 'utf8'), '{}\n');
    });
  });

  it('without files: the Markdown files git tracks, less the excludes (flag and .md-runbook-prose.json); --prose-show lists findings', () => {
    const d = dir();
    git(d, 'init', '-q');
    // A generated line (skipLines: "^\\*⏱") is not prose either.
    write(d, 'a.md', 'Short.\n\n*⏱ ' + sentence(30) + '*\n');
    write(d, 'tests/fixtures/x.md', sentence(25) + '\n');
    write(d, 'notes/CLAUDE.md', sentence(30) + '\n');
    write(d, 'untracked.md', sentence(30) + '\n');
    git(d, 'add', 'a.md', 'tests', 'notes');
    // The docs' example label pattern works (\p{…}: the u flag).
    const labels = ['^(?:\\p{Extended_Pictographic}\\uFE0F?\\s*)?\\*\\*[^*]+\\*\\*\\s+·\\s+'];
    write(d, '.md-runbook-prose.json', JSON.stringify({ exclude: ['tests/fixtures/**'], skipLines: ['^\\*⏱'], labels }));
    // Three sentences after the label; the label read as one more would make a long paragraph.
    write(d, 'b.md', '🔑 **Key point** · ' + [8, 9, 10].map(sentence).join(' ') + '\n');
    git(d, 'add', 'b.md');
    inDir(d, () => {
      write(d, 'base.json', '{}\n');
      const r = run(['--prose-baseline', 'base.json']);
      assert.equal(r.code, 1);
      assert.match(r.out, /- notes\/CLAUDE\.md: 1 sentences over 20 words \(was 0\)/);
      assert.doesNotMatch(r.out, /fixtures|untracked/);
      assert.equal(run(['--prose-baseline', 'base.json', '--exclude', 'notes/*']).code, 0);
      const show = run(['--prose-show', 'notes/*']);
      assert.match(show.out, /^notes\/CLAUDE\.md: 1 sentence, 30\.0 words on average$/m);
      assert.match(show.out, /^ {2}notes\/CLAUDE\.md:1: 30 words: word word/m);
      assert.equal(run(['--prose-show', 'nothing/*']).code, 1);
    });
  });

  it('appends the summary to $GITHUB_STEP_SUMMARY', () => {
    const d = dir();
    write(d, 'a.md', 'Short.\n');
    const summary = path.join(d, 'summary.md');
    inDir(d, () => {
      write(d, 'base.json', '{}\n');
      process.env.GITHUB_STEP_SUMMARY = summary;
      try {
        run(['--prose-baseline', 'base.json', 'a.md']);
      } finally {
        delete process.env.GITHUB_STEP_SUMMARY;
      }
    });
    assert.match(fs.readFileSync(summary, 'utf8'), /^## ✅ prose: no file harder to read/);
  });

  it('measureFile counts phrases and repeats apart from sentences and units', () => {
    const m = measureFile('Basically do it now.\n\nRun all the checks on each host.\n\nRun all the checks on each host.\n');
    assert.deepEqual(m.numbers, { sentences: 0, units: 0, average: 6, phrases: 1, repeats: 1 });
  });
});

describe('prose: the guard, lead-ins, durations, choppy sentences, citations, labels', () => {
  it('the sentence rules skip a sentence with a digit, a code span, a link or a guard word; the word rules never do', () => {
    // Heading restated, but it holds a condition: kept.
    assert.deepEqual(rules('## Restart the API\n\nThis restarts the API only.\n', 'prose-heading'), []);
    assert.deepEqual(rules('## Restart the API\n\nThis restarts the API.\n', 'prose-heading').length, 1);
    for (const s of ['This section describes the 3 restarts.', 'This section describes `restart`.', 'This section describes [it](x.md).', 'This section describes why it must restart.']) {
      assert.deepEqual(rules(s + '\n', 'prose-announcing'), [], s);
    }
    for (const w of ['because', 'so that', 'never', 'must', 'only', 'not', 'unless', 'until', 'except']) {
      assert.deepEqual(rules(`This section describes the restart ${w} it hangs.\n`, 'prose-announcing'), [], w);
    }
    // Openers and padding cut words, not the sentence.
    assert.deepEqual(rules('Please note that it never retries.\n', 'prose-opener'), [[0, 'Delete the opener "Please note that"']]);
    assert.deepEqual(rules('It basically runs 3 times.\n', 'prose-padding'), [[0, 'Delete "basically"']]);
  });

  it('an empty lead-in right before a code block', () => {
    const msg = 'Empty lead-in: start with what the block does, or cut it';
    const block = '\n\n```bash\necho\n```\n';
    assert.deepEqual(rules('Now run:' + block, 'prose-lead-in'), [[0, msg]]);
    assert.deepEqual(rules('Intro.\n\nOn the lab:\n```bash\necho\n```\n', 'prose-lead-in'), [[2, msg]]);
    assert.deepEqual(rules('**Back to the terminal:**' + block, 'prose-lead-in'), [[0, msg]]);
    for (const md of [
      'Now run `kubectl`:' + block, // a code span: it says something
      'Now run it 3 times:' + block, // a digit
      'Now check the pods in the namespace again:' + block, // 8 words
      'Run this:' + block, // no lead-in word
      'Now run it.' + block, // no colon
      '- Now run:' + block, // a list item
      'Now run:\n\nThe pods restart.' + block, // not right before the block
      'Now run only this:' + block, // guarded
    ]) {
      assert.deepEqual(rules(md, 'prose-lead-in'), [], md);
    }
  });

  it('a duration of the whole guide or step, in a runbook with estimates; never a wait tied to one block', () => {
    const msg = 'Duration in prose: it goes stale; the estimates show it';
    const block = '```bash estimate=2m\necho\n```\n';
    const md = (prose: string): string => '# Restart\n\nIntro.\n\n' + block + '\n' + prose + '\n';
    assert.deepEqual(rules(md('This guide takes about 40 minutes.'), 'prose-duration'), [[8, msg]]);
    assert.deepEqual(rules(md('The steps take about 40 minutes in all.'), 'prose-duration'), [[8, msg]]);
    assert.deepEqual(rules(md('About 40 minutes.'), 'prose-duration'), [[8, msg]]);
    // In an opening paragraph (the runbook's or a section's): the whole thing's.
    assert.deepEqual(rules('# Restart\n\nAllow about five minutes for it.\n\n' + block, 'prose-duration'), []); // right before the block: its own wait
    assert.deepEqual(rules('# Restart\n\nAllow about five minutes for it.\n\nCheck first.\n\n' + block, 'prose-duration'), [[2, msg]]);
    // One block's wait, not the first paragraph: kept.
    assert.deepEqual(rules(md("Keycloak's first start takes about five minutes."), 'prose-duration'), []);
    // A reference to another guide, a certificate's life, a window: no total, even in an opening paragraph.
    assert.deepEqual(rules(md('It passes when its check (guide 12) stayed up the last 15 minutes.'), 'prose-duration'), []);
    assert.deepEqual(rules('# Renew\n\nThe Secret holds the certificate for 24 hours.\n\nCheck.\n\n' + block, 'prose-duration'), []);
    assert.deepEqual(rules('# Sign\n\nIt passes when the login stayed up the last 15 minutes.\n\nCheck.\n\n' + block, 'prose-duration'), []);
    assert.deepEqual(rules('# Load\n\nA new pod needs four to five minutes to start.\n\nCheck.\n\n' + block, 'prose-duration'), []);
    // No estimates: nothing shows the time, so the prose may.
    assert.deepEqual(rules('# Restart\n\nThis guide takes about 40 minutes.\n\n```bash\necho\n```\n', 'prose-duration'), []);
    // The guard (but its digit): a condition or a link keeps it.
    assert.deepEqual(rules(md('This guide takes about 40 minutes unless the cluster is cold.'), 'prose-duration'), []);
    assert.deepEqual(rules(md('This guide takes about 40 minutes ([measured](x.md)).'), 'prose-duration'), []);
  });

  it('choppy: three short sentences in a row in one paragraph', () => {
    const msg = 'Choppy: join these sentences with their link word';
    assert.deepEqual(rules('It starts. It waits. It ends.\n', 'prose-choppy'), [[0, msg]]);
    assert.deepEqual(rules('It starts. It waits for the queue to drain first. It ends.\n', 'prose-choppy'), []);
    assert.deepEqual(rules('It starts. It waits.\n\nIt ends.\n', 'prose-choppy'), []); // two paragraphs
    assert.deepEqual(rules('- It starts. It waits. It ends.\n', 'prose-choppy'), []); // a list item
    assert.deepEqual(rules('It starts. It waits only once. It ends.\n', 'prose-choppy'), []); // guarded: breaks the run
    assert.deepEqual(rules('> 💡 **Did you know?** · It starts. It waits. It ends.\n', 'prose-choppy'), [[0, msg]]); // a box
  });

  it('a citation of links in parentheses is no sentence', () => {
    assert.equal(measureProse('A fact here. ([Wikipedia](https://en.wikipedia.org/wiki/X))\n').count, 1);
    assert.equal(measureProse('([source](https://a.org), [paper](https://b.org))\n').count, 0);
    assert.equal(measureProse('A fact here. (See [the paper](https://b.org).)\n').count, 2);
  });

  it('a known label\'s "?" in running text ends no sentence', () => {
    assert.deepEqual(proseSentences('A Did you know? is one quoted paragraph. Next.'), ['A Did you know? is one quoted paragraph.', 'Next.']);
    // The file's own labels count too.
    assert.equal(measureProse('> 💡 **Ready yet?** · Box.\n\nA Ready yet? box is short.\n').count, 2);
    assert.equal(measureProse('Ready yet? Go.\n').count, 2);
  });
});

describe('prose: boxes', () => {
  const four = [8, 8, 8, 8].map(sentence).join(' ');
  const paragraphs = (md: string, options: ProseOptions = {}): number[] => checkProse(md, options).filter((f) => f.rule === 'prose-paragraph').map((f) => f.line);

  it("a box's labelled paragraph has 5 sentences and 100 words; elsewhere 3 and 60", () => {
    assert.deepEqual(paragraphs('> 💡 **Did you know?** · ' + four + '\n'), []);
    assert.deepEqual(paragraphs('> 🔑 **Key point** · ' + [8, 8, 8, 8, 8, 8].map(sentence).join(' ') + '\n'), [0]); // 6 sentences
    assert.deepEqual(paragraphs(four + '\n'), [0]);
    assert.deepEqual(paragraphs('> ' + four + '\n'), [0]); // a quote without a label is no box
    assert.deepEqual(paragraphs('- 💡 **Did you know?** · ' + four + '\n'), [0]); // nor a list item
    // A second paragraph in the same box: 3 and 60.
    assert.deepEqual(paragraphs('> 💡 **Did you know?** · ' + four + '\n>\n> ' + four + '\n'), [2]);
    // A configured label marks a box too.
    assert.deepEqual(paragraphs('> NOTE: ' + four + '\n', { labels: [/^NOTE: /] }), []);
  });

  it('a GitHub alert is a box: its first paragraph after the marker line', () => {
    assert.deepEqual(paragraphs('> [!TIP]\n> ' + four + '\n'), []);
    assert.deepEqual(paragraphs('> [!TIP]\n> ' + four + '\n>\n> ' + four + '\n'), [3]);
  });

  it('"boxes" sets the limits, or false turns boxes off', () => {
    assert.deepEqual(paragraphs('> 💡 **Did you know?** · ' + four + '\n', { boxes: { sentences: 3 } }), [0]);
    assert.deepEqual(paragraphs('> 💡 **Did you know?** · ' + four + '\n', { boxes: false }), [0]);
    assert.deepEqual(paragraphs('> 💡 **Did you know?** · ' + [8, 8, 8, 8, 8, 8].map(sentence).join(' ') + '\n', { boxes: { sentences: 6, words: 100 } }), []);
  });

  it('a box in several paragraphs: make it one; not around a list, not without boxes', () => {
    const box = '> 💡 **Did you know?** · ' + sentence(8) + '\n>\n> ' + sentence(9) + '\n';
    assert.deepEqual(rules(box, 'prose-box'), [[0, 'Box in 2 paragraphs: make it one']]);
    assert.deepEqual(rules('> [!NOTE]\n> ' + sentence(8) + '\n>\n> ' + sentence(9) + '\n>\n> ' + sentence(10) + '\n', 'prose-box'), [[1, 'Box in 3 paragraphs: make it one']]);
    assert.deepEqual(rules('> 💡 **Did you know?** · ' + sentence(8) + '\n>\n> - one item\n> - two items\n', 'prose-box'), []);
    assert.deepEqual(rules('> 💡 **Did you know?** · ' + sentence(8) + '\n>\n> - one item\n>\n> ' + sentence(9) + '\n', 'prose-box'), []);
    assert.deepEqual(rules(box, 'prose-box', { boxes: false }), []);
    assert.deepEqual(rules('> ' + sentence(8) + '\n>\n> ' + sentence(9) + '\n', 'prose-box'), []); // no label: no box
  });

  it('a box that repeats a sentence of the paragraph above: flagged there', () => {
    const msg = 'Box repeats this sentence: cut it here, keep the box';
    const above = 'Run the check first. The gateway checks every token against the issuer.\n\n';
    assert.deepEqual(rules(above + '> 🔑 **Key point** · The gateway checks every token against its issuer before forwarding.\n', 'prose-box-repeat'), [[0, msg]]);
    // A run of 4 content words is enough.
    assert.deepEqual(
      rules('Logs go to Loki and the gateway checks every token against the issuer here.\n\n> 🔑 **Key point** · Gateway checks every token, then a separate audit trail records rejections later on.\n', 'prose-box-repeat'),
      [[0, msg]],
    );
    // The sentence above carries a condition the box lacks: kept.
    assert.deepEqual(rules('The gateway checks every token only against the issuer.\n\n> 🔑 **Key point** · The gateway checks every token against the issuer.\n', 'prose-box-repeat'), []);
    // The box adds a new fact.
    assert.deepEqual(rules('The gateway checks every token.\n\n> 🔑 **Key point** · Rotated signing keys reach the proxy within a minute.\n', 'prose-box-repeat'), []);
  });
});

describe('prose: limits in .md-runbook-prose.json', () => {
  const config = (json: unknown): ReturnType<typeof proseConfig> => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mdrb-prose-config-'));
    fs.writeFileSync(path.join(d, '.md-runbook-prose.json'), JSON.stringify(json));
    return proseConfig([], d);
  };

  it('any limit may be set; the others keep their defaults', () => {
    const c = config({ limits: { sentenceWords: 25, unitSentences: 4 }, boxes: { sentences: 6, words: 120 } });
    assert.deepEqual(c.options.limits, { sentenceWords: 25, unitSentences: 4 });
    assert.deepEqual(c.options.boxes, { sentences: 6, words: 120 });
    assert.deepEqual(rules(sentence(23) + '\n', 'prose-sentence', c.options), []);
    assert.equal(rules(sentence(26) + '\n', 'prose-sentence', c.options)[0]![1].slice(0, 22), '26 words, at most 25: ');
    assert.deepEqual(rules(Array(4).fill(sentence(8)).join(' ') + '\n', 'prose-paragraph', c.options), []);
    assert.equal(config({ boxes: false }).options.boxes, false);
  });

  it('a bad value is an error that says what is expected', () => {
    assert.throws(() => config({ limits: { sentenceWords: 0 } }), /"limits\.sentenceWords" must be a positive whole number \(got 0\)/);
    assert.throws(() => config({ limits: { unitWords: 2.5 } }), /"limits\.unitWords" must be a positive whole number \(got 2\.5\)/);
    assert.throws(() => config({ limits: { averageWords: '15' } }), /"limits\.averageWords" must be a positive whole number \(got "15"\)/);
    assert.throws(() => config({ limits: { sentences: 20 } }), /unknown limit "sentences" \(expected sentenceWords, strictSentenceWords, averageWords, unitSentences, unitWords\)/);
    assert.throws(() => config({ limits: [20] }), /"limits" must be an object/);
    assert.throws(() => config({ boxes: { lines: 3 } }), /unknown "boxes" key "lines"/);
    assert.throws(() => config({ boxes: true }), /"boxes" must be false or an object/);
  });

  it('the ratchet holds a new file to the configured limits', () => {
    const l = { sentenceWords: 25, strictSentenceWords: 25, averageWords: 18, unitSentences: 3, unitWords: 60 };
    assert.deepEqual(proseWorse({ sentences: 0, units: 0, average: 17.5 }, undefined, l), []);
    assert.deepEqual(proseWorse({ sentences: 1, units: 0, average: 12 }, undefined, l), ['1 sentences over 25 words (was 0)']);
  });
});

describe('prose: the same text in several files (repository-wide)', () => {
  const said = 'Open the lab terminal and check that every pod of the gateway shows Running.';
  const files = (n: number, text: (i: number) => string): Array<{ name: string; text: string }> =>
    Array.from({ length: n }, (_, i) => ({ name: `r${i}.md`, text: text(i) }));

  it('a sentence of 8 words or more in 3 files: at each place; not in 2', () => {
    const found = proseDuplicates(files(3, (i) => `# Guide ${i}\n\nIntro ${i}.\n\n${said}\n`));
    assert.deepEqual([...found.keys()], ['r0.md', 'r1.md', 'r2.md']);
    assert.deepEqual(found.get('r1.md')!.map((f) => [f.line, f.message]), [[4, 'Said in 3 files: say it once and link it']]);
    assert.equal(proseDuplicates(files(2, () => said + '\n')).size, 0);
    // Normalised: case and digits don't tell them apart (links: see pointers below).
    const variants = [said, said.toUpperCase(), said.replace('lab terminal', 'lab terminal 2')];
    assert.equal(proseDuplicates(files(3, (i) => variants[i]! + '\n')).size, 3);
    // Short sentences may come back anywhere.
    assert.equal(proseDuplicates(files(3, () => 'Check the logs of the pod.\n')).size, 0);
  });

  it('near copies: paragraphs of 3 files sharing most of their 5-word runs', () => {
    const para = 'Going straight on to the next guide? Keep the lab running, the next guide starts from the same cluster and the same keys, so nothing needs to be set up again before you start';
    const ends = ['before you start', 'before you begin', 'before it starts'];
    const found = proseDuplicates(files(3, (i) => para.replace('before you start', ends[i]!) + '.\n'));
    assert.equal(found.size, 3);
    assert.match(found.get('r0.md')![0]!.message, /^Said in 3 files/);
    assert.equal(proseDuplicates(files(3, (i) => (i === 2 ? 'Something else entirely, said in words of its own, with no run of five shared at all here.' : para) + '\n')).size, 0);
  });

  it('the ratchet counts them as "duplicates"', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mdrb-prose-dup-'));
    for (const n of ['a', 'b', 'c']) fs.writeFileSync(path.join(d, `${n}.md`), said + '\n');
    const before = process.cwd();
    process.chdir(d);
    try {
      const out: string[] = [];
      fs.writeFileSync('base.json', '{}\n');
      assert.equal(lint(['--prose-baseline', 'base.json', 'a.md', 'b.md', 'c.md'], (l) => out.push(l)), 1);
      assert.match(out.join('\n'), /^a\.md:1: Said in 3 files: say it once and link it$/m);
      assert.match(out.join('\n'), /- a\.md: 1 passages said in 3 files or more \(was 0\)/);
      fs.writeFileSync('base.json', '{\n "a.md": {"sentences": 0, "units": 0, "average": 14.0, "duplicates": 1},\n "b.md": {"sentences": 0, "units": 0, "average": 14.0, "duplicates": 1},\n "c.md": {"sentences": 0, "units": 0, "average": 14.0, "duplicates": 1}\n}\n');
      assert.equal(lint(['--prose-baseline', 'base.json', 'a.md', 'b.md', 'c.md'], () => undefined), 0);
      // Two files left: no duplicate, and the update lowers them.
      lint(['--prose-baseline', 'base.json', '--update-baseline', 'a.md', 'b.md'], () => undefined);
      assert.doesNotMatch(fs.readFileSync('base.json', 'utf8'), /"a\.md"/);
    } finally {
      process.chdir(before);
    }
  });
});

describe('prose: counting traps, labels, quotations, a box that says the box above', () => {
  it('initials and "no." before a number end no sentence', () => {
    assert.deepEqual(proseSentences('Ghostscript is by L. Peter Deutsch. J. R. R. Tolkien wrote it.'), ['Ghostscript is by L. Peter Deutsch.', 'J. R. R. Tolkien wrote it.']);
    assert.deepEqual(proseSentences('See section no. 6 of it. The answer is no. Then go.'), ['See section no. 6 of it.', 'The answer is no.', 'Then go.']);
    // A capital at a sentence's end before a lowercase name still ends it.
    assert.deepEqual(proseSentences('Pick plan B. kubectl reads it.'), ['Pick plan B.', 'kubectl reads it.']);
    // A key, not an initial.
    assert.deepEqual(proseSentences('Cancel sends Ctrl+C. If it hangs, wait.'), ['Cancel sends Ctrl+C.', 'If it hangs, wait.']);
    // A capital after a lowercase word, then a sentence: a name (design A), not an initial.
    assert.deepEqual(proseSentences('It reads the files of classic corpus A. In 15, the classic file is gone.'), [
      'It reads the files of classic corpus A.',
      'In 15, the classic file is gone.',
    ]);
    assert.deepEqual(proseSentences('Guide 23 uses design B. The renewal happens later.'), ['Guide 23 uses design B.', 'The renewal happens later.']);
    assert.deepEqual(proseSentences('It falls back to design A. That takes about 4 days.'), ['It falls back to design A.', 'That takes about 4 days.']);
    // Initials at the start, or before a name of two capitalised words.
    assert.deepEqual(proseSentences('L. Peter Deutsch wrote Ghostscript.'), ['L. Peter Deutsch wrote Ghostscript.']);
  });

  it('a " · " inside emphasis joins one label; outside, it ends a sentence', () => {
    assert.deepEqual(proseSentences('The Steps view shows **Before you run: 1 confirmation · 1 secret to set · 1 step by hand**.'), [
      'The Steps view shows Before you run: 1 confirmation · 1 secret to set · 1 step by hand.',
    ]);
    assert.deepEqual(proseSentences('Guide one · Guide two · Guide three'), ['Guide one', 'Guide two', 'Guide three']);
  });

  it('a citation wrapped over quoted lines, with one or more links, is no part of the sentence before it', () => {
    const twoLinks = [
      '> 💡 **Did you know?** · The alerts fired and nobody acted on them. An alert is only as good as a reader who',
      '> knows what to do next. ([NBC News on the Senate report,',
      '> 2014](https://www.nbcnews.com/business/x),',
      "> [Target's own statement,",
      '> 2013](https://corporate.target.com/press/y))',
      '',
    ].join('\n');
    assert.deepEqual(
      measureProse(twoLinks).findings.filter((f) => /words, at most/.test(f.message)),
      [],
    );
    const wrapped = [
      "> 💡 **Did you know?** · The ops team signs the SOP's *source* after reading it, with the team's key, not the server's. ([Wikipedia: 2020",
      '> United States federal government data',
      '> breach](https://en.wikipedia.org/wiki/2020_breach))',
      '',
    ].join('\n');
    assert.deepEqual(
      measureProse(wrapped).findings.filter((f) => /words, at most/.test(f.message)),
      [],
    );
  });

  it('a citation after a sentence, on the same line, is no part of it', () => {
    assert.deepEqual(proseSentences('Read what to do next. ([NBC News on the Senate report, 2014](https://example.net/a))'), ['Read what to do next.']);
    assert.deepEqual(proseSentences("The key is the client's, not the server's. ([Wikipedia: TLS](https://example.net/b)) Then go."), [
      "The key is the client's, not the server's.",
      'Then go.',
    ]);
  });

  it('the default label: an optional emoji, a bold label, then " · ", " — ", " – " or ":"', () => {
    assert.deepEqual(units('> 💡 **Did you know?** — It counts.\n\n> 🔑 **Key point:** Kept.\n\n> **Note**: Short.\n\n> 💡 **Tip** – Fine.\n'), [
      [0, 'It counts.'],
      [2, 'Kept.'],
      [4, 'Short.'],
      [6, 'Fine.'],
    ]);
    assert.deepEqual(units('**Bold** words, no dot.\n\n**Bold**—no space.\n'), [[0, '**Bold** words, no dot.'], [2, '**Bold**—no space.']]);
    const four = [8, 9, 10, 11].map(sentence).join(' ');
    assert.equal(checkProse('> 💡 **Did you know?** — ' + four + '\n').filter((f) => f.rule === 'prose-paragraph').length, 0); // a box
  });

  it('a sentence that is mostly a direct quotation is not too long; other rules still apply', () => {
    const quote = 'the processing of personal data shall be lawful only if and to the extent that at least one of the following applies';
    assert.deepEqual(rules(`Article 6 says: “${quote}”.\n`, 'prose-sentence'), []);
    assert.deepEqual(rules(`Article 6 says: "${quote}".\n`, 'prose-sentence'), []);
    assert.deepEqual(rules(`Article 6 says «${quote}».\n`, 'prose-sentence'), []);
    // The quote is under 60 % of the sentence: too long.
    assert.equal(rules(`The team wrote this down in its notes for the review next week, with the checks we planned: "lawful only if one applies here".\n`, 'prose-sentence').length, 1);
    // A quote that runs on into the next sentence counts to the end.
    assert.deepEqual(rules(`It says: “${quote}. The controller shall be responsible for and be able to demonstrate compliance with paragraph one of this article in every single case”.\n`, 'prose-sentence'), []);
    // Still a paragraph of its words, still padding.
    assert.equal(rules(`Basically it says: “${quote}”.\n`, 'prose-padding').length, 1);
  });

  it('a box that says what the box above it in the same section says: flagged on the later box', () => {
    const msg = 'Says what the box above says: cut one';
    const first = '> 🔑 **Key point** · The gateway checks every token against the issuer.\n\n';
    assert.deepEqual(rules(first + 'Other text.\n\n> 💡 **Did you know?** · The gateway checks every token against its issuer before forwarding.\n', 'prose-box-repeat'), [[4, msg]]);
    // Another section: kept.
    assert.deepEqual(rules(first + '## Next\n\n> 💡 **Did you know?** · The gateway checks every token against its issuer.\n', 'prose-box-repeat'), []);
    // A condition in the later box: kept.
    assert.deepEqual(rules(first + '> 💡 **Did you know?** · The gateway checks every token only against the issuer.\n', 'prose-box-repeat'), []);
    // A new lesson: kept.
    assert.deepEqual(rules(first + '> 💡 **Did you know?** · Rotated signing keys reach the proxy within a minute.\n', 'prose-box-repeat'), []);
  });
});

describe('prose: a bullet that leans on the one before', () => {
  const msg = 'Leans on the item before: join them into a sentence, or make it stand alone';
  it('flags a bullet after a sibling that starts with It, This, They, Then, But, …', () => {
    assert.deepEqual(rules('- The gate checks it.\n- It refuses an unsigned block.\n', 'prose-list-lean'), [[1, msg]]);
    assert.deepEqual(rules('- [ ] The gate checks it.\n- [x] **They** refuse it.\n', 'prose-list-lean'), [[1, msg]]);
    assert.deepEqual(rules('- The gate checks it.\n  - It is nested.\n- But the sibling is flagged.\n', 'prose-list-lean'), [[2, msg]]);
    assert.deepEqual(rules('- The gate checks it.\n- 🔑 **Key point** · Then it refuses.\n', 'prose-list-lean'), [[1, msg]]);
  });

  it('not in a numbered list, not a first item, not under another parent, a whole word only', () => {
    assert.deepEqual(rules('1. Open the lab.\n2. Then run the check.\n', 'prose-list-lean'), []);
    assert.deepEqual(rules('- It starts the list.\n', 'prose-list-lean'), []);
    assert.deepEqual(rules('Intro.\n\n- It starts the list.\n', 'prose-list-lean'), []);
    assert.deepEqual(rules('- The gate checks it.\n  - It is a first nested item.\n', 'prose-list-lean'), []);
    assert.deepEqual(rules('- The gate checks it.\n\n## Next\n\n- It starts another list.\n', 'prose-list-lean'), []);
    assert.deepEqual(rules('- The gate checks it.\n- Itself a check.\n- Thereafter it runs.\n- them lowercase.\n', 'prose-list-lean'), []);
  });
});

describe('prose: a paragraph said in several files is one finding', () => {
  it('one at the paragraph, not one a sentence', () => {
    const para = 'Leave the lab running for the next guide, its ready check finds it up.\nStopping for today: take it down, everything in the lab is kept as it is.\n';
    const found = proseDuplicates(['a', 'b', 'c'].map((n) => ({ name: `${n}.md`, text: para })));
    assert.deepEqual(found.get('b.md')!.map((f) => f.line), [0]);
    // One sentence copied, the other not: that sentence alone.
    const one = proseDuplicates(['a', 'b', 'c'].map((n) => ({ name: `${n}.md`, text: `Intro ${n} here.\n` + para.split('\n')[1] + ` More of ${n}, written for this file alone.\n` })));
    assert.deepEqual(one.get('a.md')!.map((f) => f.line), [1]);
  });
});

describe('prose: pointers, emphasis, lead-ins that say something', () => {
  it('a short sentence with a link in 3 files is a pointer, not a duplicate; without the link it is one', () => {
    const files = (text: string): Array<{ name: string; text: string }> => ['a', 'b', 'c'].map((n) => ({ name: `${n}.md`, text: `Intro of ${n}.\n\n${text}\n` }));
    const pointer = 'If the lab is down, the steps marked setup start it ([the lab between guides](README.md#lab)).';
    assert.equal(proseDuplicates(files(pointer)).size, 0);
    assert.equal(proseDuplicates(files('Going on to the next guide? Leave the lab running ([the lab](README.md#lab)).')).size, 0);
    assert.equal(proseDuplicates(files('If the lab is down, the steps marked setup start it, between the guides too.')).size, 3);
    // Over 20 words, a link doesn't make it a pointer.
    assert.equal(proseDuplicates(files(sentence(22).replace('word', '[word](x.md)'))).size, 3);
  });

  it('in emphasis, a ? or ! before lowercase text, or a . inside, ends no sentence; nor any mark in a code span', () => {
    // A bold lead still ends its sentence: **Estimates.** With … and **VS Code models.** md-runbook …
    assert.deepEqual(proseSentences('**Estimates.** With it. **Models.** md-runbook picks one.'), ['Estimates.', 'With it.', 'Models.', 'md-runbook picks one.']);
    assert.deepEqual(proseSentences('*Can the autoscalers read their metrics?* turns red for minutes. Then it heals.'), [
      '*Can the autoscalers read their metrics?* turns red for minutes.',
      'Then it heals.',
    ]);
    assert.deepEqual(proseSentences('**Stop!** It waits. *Is it up? yes* is a panel. See *fig. one* here. Run `a. B` now.'), ['Stop!', 'It waits.', '*Is it up? yes* is a panel.', 'See *fig. one* here.', 'Run `a. B` now.']);
    assert.deepEqual(rules('*What each autoscaler sees* has gaps. *Can the autoscalers read their metrics?* turns red for minutes at a time. It heals.\n', 'prose-choppy'), []);
  });

  it('a lead-in that says something of the block is not empty', () => {
    const block = '\n\n```bash\necho\n```\n';
    for (const w of ['shortened', 'abridged', 'excerpt', 'the last lines', 'the first lines', 'trimmed']) {
      assert.deepEqual(rules(`On the lab, the output (${w}):` + block, 'prose-lead-in'), [], w);
    }
    assert.equal(rules('On the lab, the output:' + block, 'prose-lead-in').length, 1);
  });
});
