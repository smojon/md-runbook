import { parse } from '@md-runbook/core';
import { proposalOf } from '@md-runbook/core/proposal';
import { askClaude, setApiKey } from '../assistant/claude';
import { insertNote, insertPasted, insertSuggestions, withFindings } from '../assistant/edits';

const map = { forward: { 'db1.corp.example.com': 'host-1' } };
const base = '# Incident\n\n```bash\necho one\n```\n';
const infos = (text: string) =>
  parse(text)
    .cells.filter((c) => c.kind === 'code')
    .map((c) => (c.meta as { info: string }).info);

describe('assistant edits', () => {
  it('suggestions become proposed cells after the cell, names mapped back, at most `max`', () => {
    const answer = 'Try:\n\n```bash proposed by=ai reason="check db"\nping -c 1 host-1\n```\n\n```bash\nuptime\n```\n\n```bash\nls\n```\n';
    const r = insertSuggestions(base, answer, map, 2, 1);
    expect(r.count).toBe(2);
    const code = parse(r.text).cells.filter((c) => c.kind === 'code');
    expect(code.map((c) => c.value)).toEqual(['echo one', 'ping -c 1 db1.corp.example.com', 'uptime']);
    expect(
      infos(r.text)
        .slice(1)
        .map((i) => proposalOf(i).state),
    ).toEqual(['proposed', 'proposed']);
  });

  it('pasted blocks: runnable ones as proposals (reason kept), others as a quote', () => {
    const clip = '```bash proposed by=claude reason="restart it"\nsystemctl restart api\n```\n\n```python\nprint(1)\n```\n';
    const r = insertPasted(base, clip, map);
    expect(r.count).toBe(2);
    const p = proposalOf(infos(r.text)[1]!);
    expect([p.state, p.by, p.reason]).toEqual(['proposed', 'claude', 'restart it']);
    expect(r.text).toContain('> **Proposed by AI** (python)');
    expect(insertPasted(base, 'no code here', map).count).toBe(0);
  });

  it('a note goes after its cell; findings replace an earlier draft', () => {
    const noted = insertNote(base, 1, 'cell 2', 'Claude', 'It printed one.');
    expect(noted).toMatch(/echo one\n```\n\n> \*\*AI note on cell 2\*\*/);
    const once = withFindings(base, 'First draft', 'Claude');
    const twice = withFindings(once, 'Second draft', 'Claude');
    expect(twice.match(/## Findings \(AI draft\)/g)).toHaveLength(1);
    expect(twice).toContain('Second draft');
    expect(twice).not.toContain('First draft');
  });
});

describe('askClaude', () => {
  it('one non-streaming Messages API request with the stored key; errors explained', async () => {
    await setApiKey('sk-ant-test-123');
    const calls: { url: string; init: RequestInit }[] = [];
    const ok = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: 'Hi' }, { type: 'thinking' }] }) };
    }) as unknown as typeof fetch;
    expect(await askClaude('sys', 'user', undefined, ok)).toBe('Hi');
    expect(calls[0]!.url).toBe('https://api.anthropic.com/v1/messages');
    const body = JSON.parse(String(calls[0]!.init.body)) as { stream: boolean; system: string; model: string };
    expect([body.stream, body.system, body.model]).toEqual([false, 'sys', 'claude-sonnet-5-5']);
    expect((calls[0]!.init.headers as Record<string, string>)['x-api-key']).toBe('sk-ant-test-123');
    const denied = (async () => ({
      ok: false,
      status: 401,
      json: async () => ({ error: { type: 'authentication_error', message: 'bad key' } }),
    })) as unknown as typeof fetch;
    await expect(askClaude('s', 'u', undefined, denied)).rejects.toThrow(/API key was rejected/);
  });
});
