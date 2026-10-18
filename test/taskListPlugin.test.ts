import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { MarkdownIt, taskListPlugin } from '../renderer/taskListPlugin';
import { taskItemAtLine } from '../src/core';

// No type declarations for markdown-it; only render() is used here.
const markdownIt = createRequire(__filename)('markdown-it') as new (o?: object) => MarkdownIt & { render(src: string): string };

function render(src: string, interactive = true): { html: string; sources: string[] } {
  const md = new markdownIt({ html: true });
  const sources: string[] = [];
  taskListPlugin(md, (s) => sources.push(s), () => interactive);
  return { html: md.render(src), sources };
}

/** Checkboxes in the HTML: their line and whether they're checked. */
const boxes = (html: string): { line: number; checked: boolean }[] =>
  [...html.matchAll(/<input type="checkbox"[^>]*data-line="(\d+)"([^>]*)>/g)].map((m) => ({ line: Number(m[1]), checked: / checked/.test(m[2]!) }));

describe('task-list renderer plugin', () => {
  it('turns task items into checkboxes on the right lines', () => {
    const src = '# Steps\n\n- [ ] one\n- [x] two\n  * [X] nested\n1. [ ] three\n';
    const { html, sources } = render(src);
    assert.deepEqual(boxes(html), [
      { line: 2, checked: false },
      { line: 3, checked: true },
      { line: 4, checked: true },
      { line: 5, checked: false },
    ]);
    assert.match(html, /> one<\/li>|>one<\/li>/);
    assert.doesNotMatch(html, /\[ \]|\[x\]/i);
    assert.deepEqual(sources, [src], 'the source is registered once per render');
  });

  it('finds the same items as the extension, so a click flips the right box', () => {
    const src = 'Intro\r\n\r\n- [ ] a\r\n  continued\r\n- [x] b\r\n\r\n```\r\n- [ ] code\r\n```\r\n';
    for (const b of boxes(render(src).html)) assert.equal(taskItemAtLine(src, b.line)?.checked, b.checked);
    assert.equal(boxes(render(src).html).length, 2);
  });

  it('leaves non-tasks alone', () => {
    const src = '- [] empty\n- [ ]no space\n- text [ ] later\n> - [ ] quoted\n\n    - [ ] indented code\n\n[ ] not a list\n';
    const { html, sources } = render(src);
    assert.deepEqual(boxes(html), []);
    assert.deepEqual(sources, []);
    assert.deepEqual(boxes(render('- [ ] a\n\n> - [ ] quoted\n\n- [ ] b\n').html).map((b) => b.line), [0, 4]);
  });

  it('makes checkboxes read-only without messaging', () => {
    assert.match(render('- [ ] a', false).html, /<input type="checkbox"[^>]* disabled/);
    assert.doesNotMatch(render('- [ ] a', true).html, /disabled/);
  });
});
