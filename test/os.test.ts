import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { computeProgress, renderReport } from '@md-runbook/core';
import { parseCellOptions } from '@md-runbook/core/cellOptions';
import { currentOs, osGroups, osLabel, parseOsList } from '@md-runbook/core/os';

describe('os= alternatives', () => {
  it('parses names and aliases', () => {
    assert.deepEqual(parseOsList('linux, macOS,darwin'), ['linux', 'macos']);
    assert.deepEqual(parseOsList('win'), ['windows']);
    assert.match(parseOsList('beos') as string, /unknown OS "beos"/);
    assert.deepEqual(parseCellOptions('bash os=linux,macos').os, ['linux', 'macos']);
    assert.equal(parseCellOptions('bash os=dos').errors.length, 1);
    assert.equal(osLabel(['linux', 'macos']), 'Linux, macOS');
  });

  it('knows the current OS', () => {
    assert.equal(currentOs('win32'), 'windows');
    assert.equal(currentOs('darwin'), 'macos');
    assert.equal(currentOs('linux'), 'linux');
    assert.equal(currentOs('freebsd'), 'linux');
  });

  it('groups adjacent alternatives; Markdown between them is fine, a repeated OS starts a new group', () => {
    const slots = osGroups(
      [
        { kind: 'code', os: ['windows'] },
        { kind: 'markup' },
        { kind: 'code', os: ['linux', 'macos'] },
        { kind: 'code', os: ['windows'] }, // repeats windows: a new step
        { kind: 'code', os: ['linux'] },
        { kind: 'code' }, // no os=: ends the group
        { kind: 'code', os: ['macos'] },
      ],
      'linux',
    );
    assert.deepEqual(slots, [
      { group: 0, active: false },
      undefined,
      { group: 0, active: true },
      { group: 3, active: false },
      { group: 3, active: true },
      undefined,
      { group: 6, active: false },
    ]);
  });

  it('progress counts one step per group, judged by the alternative for this OS', () => {
    const p = computeProgress([
      { kind: 'code', exit: undefined, os: { group: 0, active: false } },
      { kind: 'code', exit: '0', os: { group: 0, active: true } },
      { kind: 'code', exit: undefined, os: { group: 2, active: false } }, // no alternative here: skipped
      { kind: 'code', exit: undefined, os: { group: 2, active: false } },
      { kind: 'code', exit: undefined },
    ]);
    assert.deepEqual([p.total, p.done, p.skipped, p.pending], [3, 1, 1, 1]);
    assert.deepEqual(p.resume, [4]);
  });

  it('the report shows the alternative that ran as the step, the others as alternatives', () => {
    const md =
      '```pwsh os=windows\nGet-Date\n```\n\n```bash os=linux,macos\ndate\n```\n<!-- md-runbook:output start exit=0 -->\n```text\nMon\n```\n<!-- md-runbook:output end -->\n\n```bash\necho next\n```\n';
    const html = renderReport(md, { generatedAt: new Date('2026-10-18T12:00:00Z') });
    assert.match(html, /– for Windows/);
    assert.match(html, /2 steps/);
    assert.match(html, /1 passed/);
    assert.match(html, /Step 1 \(alternative\)/);
    assert.match(html, /Step 2</);
  });
});
