import { openRunbookLink, rawRunbookUrl } from '../runbooks/openLink';
import { getRunbook, resetRunbooks } from '../runbooks/store';

beforeEach(() => resetRunbooks());

describe('opening a runbook from a link', () => {
  it('GitHub and GitLab pages give their raw file; only https', () => {
    expect(rawRunbookUrl('https://github.com/smojon/md-runbook/blob/main/examples/sample.runbook.md')).toBe(
      'https://raw.githubusercontent.com/smojon/md-runbook/main/examples/sample.runbook.md',
    );
    expect(rawRunbookUrl('https://gitlab.example.net/ops/runbooks/-/blob/main/deploy.md')).toBe(
      'https://gitlab.example.net/ops/runbooks/-/raw/main/deploy.md',
    );
    expect(rawRunbookUrl(' https://files.example.net/r/deploy.md ')).toBe('https://files.example.net/r/deploy.md');
    expect(rawRunbookUrl('http://files.example.net/deploy.md')).toBeUndefined();
    expect(rawRunbookUrl('file:///etc/passwd')).toBeUndefined();
    expect(rawRunbookUrl('not a link')).toBeUndefined();
  });

  it('downloads it and keeps a copy under its file name; errors say why', async () => {
    const ok = (async (url: string) => ({ ok: true, status: 200, text: async () => `# From ${url}\n` })) as unknown as typeof fetch;
    const r = await openRunbookLink('https://github.com/o/r/blob/main/ops/deploy.md', ok);
    expect(r.kind).toBe('opened');
    if (r.kind !== 'opened') return;
    expect(r.runbook.fileName).toBe('deploy.md');
    expect(getRunbook(r.runbook.id)?.text).toBe('# From https://raw.githubusercontent.com/o/r/main/ops/deploy.md\n');
    expect(r.runbook.origin).toBeUndefined();
    const missing = (async () => ({ ok: false, status: 404, text: async () => '' })) as unknown as typeof fetch;
    expect(await openRunbookLink('https://x.example.net/a.md', missing)).toEqual({
      kind: 'error',
      message: 'The runbook could not be downloaded: HTTP 404',
    });
    expect(await openRunbookLink('http://x.example.net/a.md', ok)).toMatchObject({
      kind: 'error',
      message: expect.stringMatching(/^Not a runbook link/),
    });
  });

  it('a huge file is refused before it is read; a stray % in the name does not stop the download', async () => {
    const read = jest.fn(async () => 'x');
    const huge = (async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-length': '999999999' }),
      text: read,
    })) as unknown as typeof fetch;
    expect(await openRunbookLink('https://x.example.net/big.md', huge)).toMatchObject({ kind: 'error' });
    expect(read).not.toHaveBeenCalled();
    const ok = (async () => ({ ok: true, status: 200, text: async () => '# T\n' })) as unknown as typeof fetch;
    expect(await openRunbookLink('https://x.example.net/100%.md', ok)).toMatchObject({ kind: 'opened', runbook: { fileName: '100%.md' } });
  });
});
