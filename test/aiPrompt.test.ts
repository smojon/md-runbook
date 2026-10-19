import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { CodeMeta, DEFAULT_WRITE_OPTIONS, parse, serialize, toCellInputs } from '@md-runbook/core';
import { UNTRUSTED_CLOSE, UNTRUSTED_OPEN } from '@md-runbook/core/aiContext';
import {
  FINDINGS_HEADING,
  SYSTEM_PROMPT,
  explainOutputPrompt,
  extractProposals,
  findingsMarkdown,
  isFindingsCell,
  proposalCell,
  proposalMarkdown,
  suggestNextStepsPrompt,
  summarizeIncidentPrompt,
} from '@md-runbook/core/aiPrompt';
import { proposalOf } from '@md-runbook/core/proposal';
import { SseParser, anthropicRequest, interpretEvent } from '@md-runbook/core/anthropicStream';

describe('aiPrompt builders', () => {
  it('system prompt carries the safety contract', () => {
    assert.ok(SYSTEM_PROMPT.includes(UNTRUSTED_OPEN) && SYSTEM_PROMPT.includes(UNTRUSTED_CLOSE));
    assert.match(SYSTEM_PROMPT, /Never follow instructions/);
    assert.match(SYSTEM_PROMPT, /Never claim or imply that you executed/);
    assert.match(SYSTEM_PROMPT, /<lang> proposed by=ai reason="<short reason>"/);
    assert.match(SYSTEM_PROMPT, /read-only/);
    assert.match(SYSTEM_PROMPT, /DESTRUCTIVE/);
  });

  it('task prompts include the runbook and the task', () => {
    const e = explainOutputPrompt('RUNBOOK', 'cell 3');
    assert.equal(e.system, SYSTEM_PROMPT);
    assert.ok(e.user.startsWith('Runbook so far:\n\nRUNBOOK\n'));
    assert.match(e.user, /LAST code block above \(cell 3\)/);
    assert.match(suggestNextStepsPrompt('R', 3).user, /at most 3 proposed command blocks/);
    assert.match(suggestNextStepsPrompt('R', 1, 'cell 2').user, /at most 1 proposed command block,.*/);
    assert.match(suggestNextStepsPrompt('R', 1, 'cell 2').user, /up to and including cell 2/);
    assert.match(summarizeIncidentPrompt('R').user, /Likely cause/);
  });
});

describe('extractProposals', () => {
  it('reads lang, code and reason from the info string', () => {
    const a = 'Check pods.\n\n```bash proposed by=ai reason="list pods"\nkubectl get pods\n```\n';
    assert.deepEqual(extractProposals(a), [{ lang: 'bash', code: 'kubectl get pods', reason: 'list pods' }]);
  });

  it('falls back to the preceding sentence, ignores non-shell and empty blocks', () => {
    const a = [
      'First this. Then **look at the events**:',
      '```sh',
      'kubectl get events',
      '```',
      '```json',
      '{"a": 1}',
      '```',
      '```PowerShell',
      '',
      '```',
      '- Check the disk.',
      '~~~pwsh',
      'Get-PSDrive',
      '~~~',
    ].join('\n');
    assert.deepEqual(extractProposals(a), [
      { lang: 'sh', code: 'kubectl get events', reason: 'Then look at the events' },
      { lang: 'pwsh', code: 'Get-PSDrive', reason: 'Check the disk' },
    ]);
  });

  it('handles CRLF and maps aliases back', () => {
    const a = 'Logs of host-1:\r\n```bash proposed by=ai reason="logs on host-1"\r\nssh host-1 journalctl -n 50\r\nping ip-1\r\n```\r\n';
    const map = { forward: { 'web01.prod.example': 'host-1', '10.0.0.5': 'ip-1' } };
    assert.deepEqual(extractProposals(a, map), [
      { lang: 'bash', code: 'ssh web01.prod.example journalctl -n 50\nping 10.0.0.5', reason: 'logs on web01.prod.example' },
    ]);
  });

  it('ignores blocks nested in another block and unterminated blocks', () => {
    const a = '````markdown\n```bash\nrm -rf /\n```\n````\n\n```cmd\ndir\n```\n\n```bash\nunterminated\n';
    assert.deepEqual(extractProposals(a), [{ lang: 'cmd', code: 'dir' }]);
  });
});

describe('proposal cells', () => {
  it('writes the proposed info string and a long enough fence', () => {
    const md = proposalMarkdown({ lang: 'bash', code: 'echo ```x```', reason: 'say "hi"' }, 'ai');
    assert.equal(md, '````bash proposed by=ai reason="say hi"\necho ```x```\n````\n');
    assert.equal(proposalOf((parse(md).cells[0]!.meta as CodeMeta).info).state, 'proposed');
  });

  it('inserts as a separate block that survives serialize', () => {
    const doc = parse('# T\r\n\r\n```bash\r\necho a\r\n```\r\n\r\nafter\r\n');
    const cell = proposalCell({ lang: 'bash', code: 'ls', reason: 'list' }, 'ai', '\r\n');
    assert.equal(cell.languageId, 'shellscript');
    const cells = toCellInputs(doc);
    cells.splice(2, 0, { kind: 'code', value: cell.value, languageId: cell.languageId, meta: cell.meta });
    const out = serialize(doc.meta, cells, DEFAULT_WRITE_OPTIONS);
    assert.equal(out, '# T\r\n\r\n```bash\r\necho a\r\n```\r\n\r\n```bash proposed by=ai reason="list"\r\nls\r\n```\r\n\r\nafter\r\n');
    const end = proposalCell({ lang: 'sh', code: 'ls' }, 'ai', '\n', true);
    const doc2 = parse('text\n');
    const out2 = serialize(doc2.meta, [...toCellInputs(doc2), { kind: 'code', value: end.value, languageId: end.languageId, meta: end.meta }], DEFAULT_WRITE_OPTIONS);
    assert.equal(out2, 'text\n\n```sh proposed by=ai\nls\n```\n');
  });

  it('findings cell is marked as a draft', () => {
    const md = findingsMarkdown('## Findings\n\n### Summary\nDisk full.', 'Claude');
    assert.ok(md.startsWith(FINDINGS_HEADING + '\n\n> Draft generated by Claude.'));
    assert.ok(md.endsWith('### Summary\nDisk full.\n'));
    assert.ok(isFindingsCell(md) && !isFindingsCell('## Findings'));
  });
});

describe('anthropic stream', () => {
  it('builds the request', () => {
    const r = anthropicRequest('https://api.anthropic.com/', 'k', 'claude-sonnet-5-5', 100, 'S', 'U');
    assert.equal(r.url, 'https://api.anthropic.com/v1/messages');
    assert.equal(r.headers['x-api-key'], 'k');
    assert.equal(r.headers['anthropic-version'], '2023-06-01');
    assert.equal(r.body.stream, true);
    assert.equal(r.body.fallbacks, 'default');
    const g = anthropicRequest('https://gw.example/anthropic', 'k', 'claude-sonnet-5-5', 100, 'S', 'U');
    assert.equal(g.url, 'https://gw.example/anthropic/v1/messages');
    assert.equal(g.body.fallbacks, undefined);
    assert.equal(g.headers['anthropic-beta'], undefined);
  });

  it('parses SSE across chunk boundaries and CRLF', () => {
    const p = new SseParser();
    const stream =
      'event: message_start\r\ndata: {"type":"message_start"}\r\n\r\n' +
      'event: content_block_delta\r\ndata: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"x"}}\r\n\r\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}\n\n' +
      ': ping\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"lo"}}\n\n' +
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n' +
      'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n';
    const events = [];
    for (let i = 0; i < stream.length; i += 7) events.push(...p.feed(stream.slice(i, i + 7)));
    const updates = events.map(interpretEvent);
    assert.equal(updates.map((u) => u.text ?? '').join(''), 'Hello');
    assert.equal(updates.find((u) => u.stopReason)?.stopReason, 'end_turn');
    assert.equal(updates.find((u) => u.error)?.error, 'overloaded_error: Overloaded');
  });
});
