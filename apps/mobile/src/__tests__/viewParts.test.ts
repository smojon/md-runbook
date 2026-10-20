import { renderMarkdown } from '@md-runbook/core';
import { highlightBash } from '../highlight/bash';
import { countTaskBoxes } from '../markdown/MarkdownView';
import { HtmlElement, parseHtml, textOf } from '../markdown/html';
import { planLines } from '../ssh/lineRuns';

describe('reading the core HTML', () => {
  it('builds the tree of a rendered runbook section', () => {
    const nodes = parseHtml(renderMarkdown('# Title &\n\n- [x] done `a<b`\n- [ ] [link](https://x.dev/?a=1&b=2)\n'));
    const els = nodes.filter((n): n is HtmlElement => typeof n !== 'string');
    expect(els.map((e) => e.tag)).toEqual(['h1', 'ul']);
    expect(textOf(els[0]!)).toBe('Title &');
    const items = els[1]!.children.filter((n): n is HtmlElement => typeof n !== 'string');
    expect(items.map((i) => i.attrs.class)).toEqual(['task', 'task']);
    const box = items[0]!.children[0] as HtmlElement;
    expect(box).toMatchObject({ tag: 'input', attrs: { type: 'checkbox', disabled: '', checked: '' } });
    expect(textOf(items[0]!)).toBe(' done a<b');
    const link = items[1]!.children.find((n): n is HtmlElement => typeof n !== 'string' && n.tag === 'a');
    expect(link?.attrs.href).toBe('https://x.dev/?a=1&b=2');
  });

  it('raw HTML in the runbook stays text', () => {
    const nodes = parseHtml(renderMarkdown('<script>alert(1)</script>'));
    expect(textOf(nodes[0]!)).toBe('<script>alert(1)</script>');
    expect(nodes.some((n) => typeof n !== 'string' && n.tag === 'script')).toBe(false);
  });

  it('counts the task boxes the renderer draws', () => {
    expect(countTaskBoxes('- [ ] a\n- [x] b\n\n1. [ ] c\n- [] no\n')).toBe(3);
  });
});

describe('bash highlighting', () => {
  const samples = [
    'uptime\ndf -h /',
    'if [ -f "$HOME/.x" ]; then\n  echo "hi ${USER}" # greet\nfi',
    "export A=1 B='two'\nFOO=bar make -j 4 | tee out.log 2>&1",
    'cat <<EOF > /tmp/x\nline $one\nEOF\necho done',
    "echo $'a\\'b' \\\n  next",
    'x=$(date +%s)\n',
    '',
  ];

  it('keeps the text of every line exactly', () => {
    for (const s of samples) {
      const lines = highlightBash(s).map((l) => l.map((t) => t.text).join(''));
      expect(lines).toEqual(s.split('\n'));
    }
  });

  it('colours the parts the way VS Code does', () => {
    const kinds = (s: string) =>
      highlightBash(s)
        .flat()
        .filter((t) => t.text.trim() !== '')
        .map((t) => `${t.kind}:${t.text.trim()}`);
    expect(kinds('if [ -f "$HOME/x" ]; then echo hi # note\nfi')).toEqual([
      'control:if',
      'command:[',
      'plain:-f',
      'string:"',
      'variable:$HOME',
      'string:/x"',
      'plain:]',
      'operator:;',
      'control:then',
      'command:echo',
      'plain:hi',
      'comment:# note',
      'control:fi',
    ]);
    expect(kinds('export A=1')).toEqual(['keyword:export', 'variable:A', 'operator:=', 'number:1']);
    expect(kinds('cat <<EOF\n$x\nEOF')).toEqual(['command:cat', 'operator:<<EOF', 'string:$x', 'operator:EOF']);
    expect(kinds('ls | grep 3')).toEqual(['command:ls', 'operator:|', 'command:grep', 'number:3']);
  });
});

describe('line runs', () => {
  const src = '# setup\ncd /srv\nmake \\\n  build\n\necho done';
  it('picks the commands for each action', () => {
    const lines = (p: ReturnType<typeof planLines>) => p?.steps.map((s) => [s.start, s.end]);
    expect(lines(planLines(src, 'at', 3))).toEqual([[2, 3]]);
    expect(planLines(src, 'at', 0)).toBeUndefined();
    expect(lines(planLines(src, 'to', 2))).toEqual([
      [1, 1],
      [2, 3],
    ]);
    expect(planLines(src, 'to', 5)?.coversCell).toBe(true);
    expect(lines(planLines(src, 'from', 4))).toEqual([[5, 5]]);
    expect(planLines(src, 'from', 1)?.coversCell).toBe(true);
    expect(lines(planLines(src, 'checked', 0, new Set(['echo done', 'cd /srv'])))).toEqual([
      [1, 1],
      [5, 5],
    ]);
    expect(planLines(src, 'checked', 0, new Set())).toBeUndefined();
  });
});
