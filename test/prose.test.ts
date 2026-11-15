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
import { ProseOptions, checkProse, markupCellAt, measureProse, proseSentences, proseUnits, proseWords, roundAverage } from '@md-runbook/core/prose';
import { markerLevel, proseSetting } from '../src/lintLevel';
import { lint } from '../src/cli/main';
import { formatBaseline, globToRegExp, measureFile, proseWorse } from '../src/cli/prose';

// On GitHub Actions the ratchet writes to the job summary: not from these tests.
delete process.env.GITHUB_STEP_SUMMARY;

/** n words, the last one ending the sentence (prose_ratchet's test helper). */
const sentence = (n: number): string => Array(n - 1).fill('word').join(' ') + ' end.';
const rules = (md: string, rule: string): Array<[number, string]> => checkProse(md).filter((f) => f.rule === rule).map((f) => [f.line, f.message]);
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

  it('a file average over 15: one finding, at the first prose line', () => {
    assert.deepEqual(rules('# T\n\n' + sentence(16) + '\n\n' + sentence(17) + '\n', 'prose-average'), [[2, '16.5 words a sentence on average, at most 15']]);
    assert.deepEqual(rules(sentence(15) + '\n\n' + sentence(15) + ' ' + sentence(14) + '\n', 'prose-average'), []);
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
    assert.deepEqual(rules('Just run it.\nIt is very\nfast, in order\nto win. Run `simply` and adjust just-in-time.\n', 'prose-padding'), [
      [0, 'Delete "Just"'],
      [1, 'Delete "very"'],
      [2, 'Use "to", not "in order to"'],
    ]);
  });

  it('the same sentence twice: already said, normalised; short ones may repeat; code spans tell them apart', () => {
    const md = 'Wait until all the pods show Running.\n\n- Check the logs.\n- **Wait** until all the pods show  Running\n- Check the logs.\n';
    assert.deepEqual(rules(md, 'prose-repeat'), [[3, 'Already said on line 1: "Wait until all the pods show Running"']]);
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
  const long = sentence(25) + '\n';
  const levels = (md: string): string[] => lintRunbook(md).map((p) => `${p.line + 1} ${p.severity} ${p.code ?? ''}`);

  it('info by default, warnings with prose: strict, none with prose: off', () => {
    assert.deepEqual(levels(long), ['1 info prose-sentence', '1 info prose-average']);
    assert.deepEqual(levels('---\nprose: strict\n---\n' + long), ['4 warning prose-sentence', '4 warning prose-average']);
    assert.deepEqual(levels('---\nprose: off\n---\n' + long), []);
    assert.deepEqual(levels('---\nprose: on\n---\nShort.\n'), []);
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
    assert.equal(checkProse('<!-- md-runbook:prose-ignore -->\n\n' + sentence(25) + '\n').length, 2);
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
    assert.match(r.out, /✓ 1 file checked, 0 problems, 2 prose notes/);
    assert.equal(run([write(dir(), 'r.md', '---\nprose: strict\n---\n' + sentence(25) + '\n'), '--strict']).code, 1);
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
    write(d, 'b.md', '🔑 **Key point** · ' + [3, 3, 3].map(sentence).join(' ') + '\n');
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
    const m = measureFile('Just do it now.\n\nRun all the checks on each host.\n\nRun all the checks on each host.\n');
    assert.deepEqual(m.numbers, { sentences: 0, units: 0, average: 6, phrases: 1, repeats: 1 });
  });
});
