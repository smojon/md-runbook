import { isCodeMeta, parse } from '@md-runbook/core';
import { lineDiff } from '../cells/lineDiff';
import type { Host } from '../hosts/store';
import { runCell } from '../ssh/runCell';
import { fakeConnection } from '../testing/fakeConnection';

const host: Host = { id: 'h1', name: 'web-1', hostname: 'web1', port: 22, username: 'deploy' };

describe('lineDiff', () => {
  it('lines removed, added or kept, in order', () => {
    expect(lineDiff('a\nb\nc', 'a\nx\nc\nd')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'removed', text: 'b' },
      { kind: 'added', text: 'x' },
      { kind: 'same', text: 'c' },
      { kind: 'added', text: 'd' },
    ]);
    expect(lineDiff('', 'new')).toEqual([{ kind: 'added', text: 'new' }]);
    expect(lineDiff('same', 'same')).toEqual([{ kind: 'same', text: 'same' }]);
  });
});

describe('output history, as the extension writes it', () => {
  const ran =
    '# H\n\n```bash\necho hi\n```\n<!-- md-runbook:output start exit=0 ran=2026-10-22T09:00:00+02:00 -->\n```text\nold\n```\n<!-- md-runbook:output end -->\n';

  it('a re-run writes changed=yes|no; with history on, the earlier run is kept under the new one', async () => {
    const off = await runCell({ host, text: ran, cellIndex: 1, connection: fakeConnection([{ stdout: 'new\n' }]), historySize: 0 });
    expect(off.kind === 'done' && parse(off.text).cells[1]?.output?.attrs.changed).toBe('yes');
    expect(off.kind === 'done' && off.text).not.toContain('<details>');

    const on = await runCell({ host, text: ran, cellIndex: 1, connection: fakeConnection([{ stdout: 'old\n' }]), historySize: 3 });
    if (on.kind !== 'done') throw new Error(on.kind);
    const cell = parse(on.text).cells[1]!;
    expect(cell.output?.attrs.changed).toBe('no');
    const entries = isCodeMeta(cell.meta) ? (cell.meta.history?.entries ?? []) : [];
    expect(entries.map((e) => e.text)).toEqual(['old']);
    expect(on.text).toContain('<details><summary>md-runbook: 1 previous run</summary>');
  });
});
