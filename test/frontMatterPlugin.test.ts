import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { frontMatterLines, frontMatterPlugin } from '../renderer/frontMatterPlugin';
import { taskListPlugin } from '../renderer/taskListPlugin';

// No type declarations for markdown-it; only render() is used here.
type Md = Parameters<typeof frontMatterPlugin>[0] & Parameters<typeof taskListPlugin>[0] & { render(src: string): string };
const markdownIt = createRequire(__filename)('markdown-it') as new (o?: object) => Md;

function render(src: string): { html: string; sources: string[] } {
  const md = new markdownIt({ html: true });
  const sources: string[] = [];
  // As the notebook renderer (renderer/index.ts) adds them.
  frontMatterPlugin(md);
  taskListPlugin(md, (s) => sources.push(s), () => true);
  return { html: md.render(src), sources };
}

describe('front matter renderer plugin', () => {
  it('the front matter is not drawn (a rule, a list, a setext heading of its last line); the rest is', () => {
    const src = '---\nparams:\n  - NAMESPACE: shop-prod\nmode: session\n---\n\n# Restart the checkout service\n\nText.\n';
    const { html } = render(src);
    assert.doesNotMatch(html, /params|NAMESPACE|mode|<hr>|<h2>/);
    assert.match(html, /^<h1>Restart the checkout service<\/h1>\n<p>Text.<\/p>/);
    // Front matter only: nothing drawn.
    assert.equal(render('---\ntimeout: 300 # seconds\ncwd: ../infra\n---\n').html, '');
  });

  it('checkboxes after it keep their lines, and the click sends the source as it is', () => {
    const src = '---\nshell: zsh\n---\n- [ ] one\n- [x] two\n';
    const { html, sources } = render(src);
    assert.deepEqual([...html.matchAll(/data-line="(\d+)"/g)].map((m) => Number(m[1])), [3, 4]);
    assert.deepEqual(sources, [src]);
  });

  it('a cell that only starts with a rule, or front matter that never closes, is drawn as usual', () => {
    assert.match(render('---\nA paragraph between rules.\n---\n').html, /<hr>/);
    assert.match(render('---\nkey: value\n\nno end\n').html, /key: value/);
    assert.match(render('# Title\n\n---\nkey: v\n---\n').html, /key: v/);
    assert.equal(frontMatterLines('﻿---\r\nparams:\r\n  - A\r\n...\r\nrest'), 4);
    assert.equal(frontMatterLines('---\nWho reads this?\n---\n'), 0);
  });
});
