import { baseName, reportHtml } from '../share/report';
import type { Runbook } from '../runbooks/store';

const rb = (text: string, fileName?: string): Runbook => ({
  id: 'x',
  title: 'Restart API',
  text,
  source: 'file',
  ...(fileName ? { fileName } : {}),
});

describe('the shared report', () => {
  it('is the core HTML report, redacted again, titled from the runbook', () => {
    const text =
      '# Restart API\n\n```bash\necho ok\n```\n<!-- md-runbook:output start exit=0 -->\n```text\ntoken=ghp_abcdefghijklmnopqrstuvwxyz0123456789\n```\n<!-- md-runbook:output end -->\n';
    const html = reportHtml(rb(text), new Date(2026, 9, 22, 10, 0));
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain('Restart API');
    expect(html).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
  });

  it('names files after the runbook, without characters files can’t have', () => {
    expect(baseName(rb('', 'deploy.runbook.md'))).toBe('deploy.runbook');
    expect(baseName(rb(''))).toBe('Restart API');
    expect(baseName({ ...rb(''), title: 'a/b: c?' })).toBe('a-b- c-');
  });
});
