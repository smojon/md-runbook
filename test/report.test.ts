import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { renderInline, renderMarkdown, renderReport, safeUrl } from '@md-runbook/core';

const AT = new Date(2026, 9, 18, 14, 30, 0);
const report = (text: string): string => renderReport(text, { generatedAt: AT });

describe('renderMarkdown', () => {
  it('renders headings, paragraphs, emphasis, code and links', () => {
    assert.equal(
      renderMarkdown('# Title\n\nSome **bold**, *it*, `a<b>` and [link](https://x.test/?a=1&b=2).\nNext line'),
      '<h1>Title</h1>\n<p>Some <strong>bold</strong>, <em>it</em>, <code>a&lt;b&gt;</code> and ' +
        '<a href="https://x.test/?a=1&amp;b=2">link</a>.\nNext line</p>\n',
    );
  });

  it('renders lists, task lists and ordered starts', () => {
    assert.equal(
      renderMarkdown('- [ ] todo\n- [x] done\n- plain\n\n3. three\n4. four'),
      '<ul>\n<li class="task"><input type="checkbox" disabled> todo</li>\n' +
        '<li class="task"><input type="checkbox" disabled checked> done</li>\n<li>plain</li>\n</ul>\n' +
        '<ol start="3">\n<li>three</li>\n<li>four</li>\n</ol>\n',
    );
    assert.match(renderMarkdown('- a\n  - nested\n- b'), /<li>a\n<ul>\n<li>nested<\/li>\n<\/ul>\n<\/li>/);
  });

  it('renders fenced code with a language label and tables', () => {
    assert.equal(
      renderMarkdown('```json\n{"a": "<x>"}\n```'),
      '<div class="code"><span class="lang">json</span><pre><code>{&quot;a&quot;: &quot;&lt;x&gt;&quot;}</code></pre></div>\n',
    );
    assert.match(renderMarkdown('| a | b |\n|---|---|\n| 1 | `2` |'), /<th>a<\/th><th>b<\/th>[\s\S]*<td>1<\/td><td><code>2<\/code><\/td>/);
  });

  it('never passes raw HTML through', () => {
    const html = renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n**<b>x</b>**');
    assert.doesNotMatch(html, /<script|<img|<b>/);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(html, /<strong>&lt;b&gt;x&lt;\/b&gt;<\/strong>/);
  });

  it('drops HTML comments, including multi-line ones and md-runbook markers', () => {
    assert.equal(renderMarkdown('a\n\n<!-- hidden\n<script>\n-->\n\n<!-- md-runbook:output end -->\nb'), '<p>a</p>\n<p>b</p>\n');
  });

  it('neutralizes dangerous links and attribute breakouts', () => {
    for (const md of ['[x](javascript:alert(1))', '[x](JavaScript:alert(1))', '[x](data:text/html,hi)', '![x](vbscript:x)']) {
      assert.doesNotMatch(renderInline(md), /href/, md);
    }
    assert.doesNotMatch(renderInline('[x](https://a/"onmouseover="alert(1))'), /"onmouseover/);
    assert.equal(renderInline('<javascript:alert(1)>'), '&lt;javascript:alert(1)&gt;');
    assert.equal(renderInline('[`a*b*`](#x)'), '<a href="#x"><code>a*b*</code></a>');
    assert.equal(safeUrl('docs/a.md#b'), 'docs/a.md#b');
    assert.equal(safeUrl('java\tscript:x'), undefined);
  });
});

describe('renderReport', () => {
  const src =
    '# Deploy <app>\r\n\r\nIntro with <b>html</b>.\r\n\r\n```bash\r\necho hi\r\n```\r\n' +
    '<!-- md-runbook:output start exit=0 ran=2026-10-18T14:20:00+02:00 duration=1.234s -->\r\n```text\r\nhi <script>alert(1)</script>\r\n```\r\n<!-- md-runbook:output end -->\r\n\r\n' +
    '- [x] checked\r\n\r\n```pwsh\r\nexit 3\r\n```\r\n\r\n<!-- md-runbook:output start exit=3 ran=2026-10-18T14:21:00+02:00 -->\r\n```text\r\n```\r\n<!-- md-runbook:output end -->\r\n\r\n```sh\r\n\r\nls\r\n```\r\n';
  const html = report(src);

  it('is a complete page with a title, generated time and CSP', () => {
    assert.match(html, /^<!DOCTYPE html>/);
    assert.match(html, /<title>Deploy &lt;app&gt;<\/title>/);
    assert.match(html, /Generated 2026-10-18T14:30:00[+-]\d\d:\d\d · 3 steps · 1 passed · 1 failed · 1 not run/);
    assert.match(html, /Content-Security-Policy" content="default-src 'none'/);
    assert.match(html, /prefers-color-scheme:dark/);
    assert.doesNotMatch(html, /\r/);
  });

  it('has a summary row per step with badges', () => {
    const rows = html.match(/<tr class="(ok|fail|none)">.*<\/tr>/g)!;
    assert.equal(rows.length, 3);
    assert.match(rows[0]!, /<code>echo hi<\/code><\/td><td>bash<\/td><td><span class="badge ok">✓ exit 0<\/span><\/td><td>2026-10-18T14:20:00\+02:00<\/td><td>1.234s<\/td>/);
    assert.match(rows[1]!, /<span class="badge fail">✗ exit 3<\/span>/);
    assert.match(rows[2]!, /<code>ls<\/code>.*not run/);
  });

  it('renders the document with outputs escaped and no raw HTML or markers', () => {
    assert.match(html, /<h1>Deploy &lt;app&gt;<\/h1>/);
    assert.match(html, /Intro with &lt;b&gt;html&lt;\/b&gt;/);
    assert.match(html, /<pre>hi &lt;script&gt;alert\(1\)&lt;\/script&gt;<\/pre>/);
    assert.match(html, /<input type="checkbox" disabled checked> checked/);
    assert.doesNotMatch(html, /<script|md-runbook:output|<b>/);
  });

  it('applies the extra redactor and falls back to a given title', () => {
    const r = renderReport('```sh\necho\n```\n<!-- md-runbook:output start exit=0 -->\n```text\ntoken abc\n```\n<!-- md-runbook:output end -->\n', {
      generatedAt: AT,
      fallbackTitle: 'notes.md',
      redact: (s) => s.replace('abc', '[REDACTED]'),
    });
    assert.match(r, /<title>notes\.md<\/title>/);
    assert.match(r, /token \[REDACTED\]/);
  });
});

describe('report hardening', () => {
  it('drops protocol-relative and UNC links', () => {
    for (const u of ['//evil.example/x', '\\\\evil\\share', '/\\evil/x', '\\/evil/x']) assert.equal(safeUrl(u), undefined, u);
    assert.equal(safeUrl('/abs/path'), '/abs/path');
    assert.equal(safeUrl('docs/x.md'), 'docs/x.md');
    assert.doesNotMatch(renderMarkdown('[a](//evil.example/x) [b](\\\\evil\\share)'), /href/);
  });

  it('redacts code in the summary table, steps and fenced blocks', () => {
    const r = renderReport('# R\n\n```bash\ncurl https://admin:Hunter2@sso.example\n```\n\n```text\nHunter2 here\n```\n', {
      generatedAt: AT,
      redact: (s) => s.replace(/Hunter2/g, '[REDACTED]'),
    });
    assert.doesNotMatch(r, /Hunter2/);
    assert.equal(r.match(/\[REDACTED\]/g)?.length, 3);
  });

  it('renders front matter as a metadata block, not as a rule and text', () => {
    const r = report('---\nparams:\n  - NAMESPACE: prod\n---\n# Title\n\n```sh\necho\n```\n');
    assert.match(r, /<div class="front-matter"><div class="code"><span class="lang">front matter<\/span><pre><code>params:\n  - NAMESPACE: prod<\/code><\/pre><\/div>/);
    assert.doesNotMatch(r, /<hr/);
    assert.match(r, /<title>Title<\/title>/);
  });
});

describe('renderReport step states', () => {
  it('shows declined/proposed as not run and done as passed', () => {
    const out = (exit: string): string =>
      `\`\`\`bash\necho x\n\`\`\`\n<!-- md-runbook:output start exit=${exit} ran=2026-10-18T14:20:00+02:00 -->\n\`\`\`text\nx\n\`\`\`\n<!-- md-runbook:output end -->\n`;
    const html = report(`# T\n\n${out('declined')}\n${out('proposed')}\n${out('done')}`);
    assert.match(html, /3 steps · 1 passed · 0 failed · 2 not run/);
    assert.match(html, /– declined/);
    assert.match(html, /– proposed/);
    assert.match(html, /✓ done/);
  });
});
