/**
 * What a runbook call runs, on its cell (core/call.ts callLabel), and its empty body: a lint note
 * with the comment that fixes it (callBodyComment), on the command line too. A team's report: a
 * call written all on its fence showed a bare `1` in VS Code and an empty box in a Markdown preview.
 */
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { CALL_LABEL_KEYS, callBodyComment, callLabel, isEmptyCallBody } from '@md-runbook/core/call';
import { CALL_EMPTY_BODY, CALL_EMPTY_BODY_MESSAGE, formatProblem, lintRunbook } from '@md-runbook/core/lint';
import { calledRunbookFile } from '@md-runbook/core/node';
import { markerLevel } from '../src/lintLevel';
import { lint } from '../src/cli/main';

const REPORTED = 'runbook name="2a. Restore the cluster" src="campaign/2a-restore-cluster.runbook.md" section=Restore';

describe('callLabel: what a call runs', () => {
  it('name → src · section, the src as written', () => {
    assert.deepEqual(callLabel(REPORTED), {
      text: '2a. Restore the cluster → campaign/2a-restore-cluster.runbook.md · section Restore',
      tooltip: 'Runs the runbook campaign/2a-restore-cluster.runbook.md\nName: 2a. Restore the cluster\nSection: "Restore"',
    });
    assert.equal(callLabel('runbook src=a.md')?.text, 'a.md');
    assert.equal(callLabel('runbook src=a.md section="Part A" section="Part B"')?.text, 'a.md · sections Part A, Part B');
    assert.equal(callLabel('runbook name="Only a name"')?.text, 'Only a name');
    assert.equal(callLabel('runbook'), undefined);
    assert.equal(callLabel('runbook confirm timeout=60'), undefined);
  });

  it('a dynamic src= as written, and the tooltip says when it is known', () => {
    const l = callLabel('runbook src="releases/${param:TO}.runbook.md"')!;
    assert.equal(l.text, 'releases/${param:TO}.runbook.md');
    assert.match(l.tooltip, /known when it runs/);
  });

  it('shortens a long name at its end and a long path at its start, keeping the full values in the tooltip', () => {
    const name = 'Restore the whole production cluster from last night backup';
    const src = 'campaigns/2026/november/cluster-maintenance/2a-restore-the-production-cluster.runbook.md';
    const l = callLabel(`runbook name="${name}" src="${src}" section="A very long section heading of the runbook called"`)!;
    const [shownName, rest] = l.text.split(' → ') as [string, string];
    assert.ok(shownName.endsWith('…') && name.startsWith(shownName.slice(0, -1)), shownName);
    assert.ok(Array.from(shownName).length <= 40);
    const shownSrc = rest.split(' · ')[0]!;
    assert.ok(shownSrc.startsWith('…/') && src.endsWith(shownSrc.slice(1)), shownSrc);
    assert.ok(Array.from(shownSrc).length <= 60);
    assert.match(rest, / · section A very long section heading…$/);
    assert.equal(shownName, 'Restore the whole production cluster…', 'cut after a whole word');
    assert.ok(l.tooltip.includes(name) && l.tooltip.includes(src) && l.tooltip.includes('A very long section heading of the runbook called'));
  });

  it('names the options it shows (the app leaves them out of the fence options it shows)', () => {
    assert.deepEqual([...CALL_LABEL_KEYS], ['name', 'src', 'section']);
  });
});

describe('an empty call body', () => {
  const fence = (info: string, body: string): string => '# Guide\n\n```' + info + '\n' + body + (body ? '\n' : '') + '```\n';
  const notes = (md: string) => lintRunbook(md).filter((p) => p.code === CALL_EMPTY_BODY);

  it('is a note on the body, with the comment that names the runbook', () => {
    for (const body of ['', '   ', '\n\n']) {
      const ps = notes(fence(REPORTED, body));
      assert.equal(ps.length, 1, JSON.stringify(body));
      assert.deepEqual(ps[0], {
        severity: 'info',
        code: CALL_EMPTY_BODY,
        message: CALL_EMPTY_BODY_MESSAGE,
        line: 3,
        cell: { index: 1, sourceLine: 0 },
        addComment: '# Runs the runbook campaign/2a-restore-cluster.runbook.md (section Restore)',
      });
    }
    assert.equal(CALL_EMPTY_BODY_MESSAGE, "This call's body is empty: a plain Markdown viewer shows an empty box. Add a comment saying what it runs.");
  });

  it('not with a comment or a parameter in the body, nor on other blocks, nor without src=', () => {
    assert.deepEqual(notes(fence(REPORTED, '# Runs the runbook campaign/2a-restore-cluster.runbook.md')), []);
    assert.deepEqual(notes(fence('runbook src=a.md', 'ENV=prod')), []);
    assert.deepEqual(notes(fence('bash', '')), []);
    assert.deepEqual(notes(fence('runbook name=x', '')), [], 'no src=: lint already says so (an error)');
  });

  it('the comment: src= as written, the sections, nothing without src=', () => {
    assert.equal(callBodyComment('runbook src=a.md'), '# Runs the runbook a.md');
    assert.equal(callBodyComment('runbook src="r/${param:TO}.md" section=A section="B c"'), '# Runs the runbook r/${param:TO}.md (sections A, B c)');
    assert.equal(callBodyComment('runbook name=x'), undefined);
    assert.ok(isEmptyCallBody(' \n\t\n') && !isEmptyCallBody('# x'));
  });

  it('the comment, added, ends the note, and the call still passes its parameters', () => {
    const md = fence('runbook src=a.md', '# Runs the runbook a.md\nENV=prod');
    assert.deepEqual(notes(md), []);
  });

  it('shows as information in VS Code, whatever the prose setting', () => {
    const p = { severity: 'info' as const, code: CALL_EMPTY_BODY };
    assert.equal(markerLevel(p, 'information'), 'information');
    assert.equal(markerLevel(p, 'hint'), 'information');
    assert.equal(markerLevel(p, 'off'), 'information');
  });

  it('on the command line: a note with the line to add, never failing, counted apart from prose notes', () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mdrb-call-label-')), 'guide.md');
    fs.writeFileSync(f, fence('runbook src=a.md section=Restore', ''));
    fs.writeFileSync(path.join(path.dirname(f), 'a.md'), '# A\n\n## Restore\n\n```bash\necho\n```\n');
    const lines: string[] = [];
    assert.equal(lint([f, '--strict'], (l) => lines.push(l)), 0);
    // (On GitHub Actions also an annotation line, `::notice …`.)
    assert.deepEqual(lines.filter((l) => !l.startsWith('::')), [
      `${f}:4: info: ${CALL_EMPTY_BODY_MESSAGE} First line: # Runs the runbook a.md (section Restore)`,
      '✓ 1 file checked, 0 problems, 1 note',
    ]);
    assert.equal(
      formatProblem('g.md', { severity: 'info', message: 'm', line: 0, addComment: '# Runs the runbook a.md' }),
      'g.md:1: info: m First line: # Runs the runbook a.md',
    );
  });
});

describe('calledRunbookFile: the runbook a call opens', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdrb-called-'));
  fs.mkdirSync(path.join(dir, 'campaign'));
  fs.writeFileSync(path.join(dir, 'campaign', '2a-restore-cluster.runbook.md'), '# Restore\n');
  const guide = path.join(dir, 'guide.md');

  it('resolves src= as a run does: relative to the calling file', () => {
    assert.deepEqual(calledRunbookFile(guide, REPORTED), { file: path.join(dir, 'campaign', '2a-restore-cluster.runbook.md') });
  });

  it('says why when it cannot: no src=, placeholders, no such file', () => {
    assert.match((calledRunbookFile(guide, 'runbook name=x') as { problem: string }).problem, /names no runbook/);
    assert.match((calledRunbookFile(guide, 'runbook src="r/${param:TO}.md"') as { problem: string }).problem, /has placeholders: the runbook it runs is known only when it runs/);
    assert.equal((calledRunbookFile(guide, 'runbook src=campaign/nope.md') as { problem: string }).problem, 'src="campaign/nope.md": no such runbook: campaign/nope.md');
    assert.match((calledRunbookFile(guide, 'runbook src=campaign') as { problem: string }).problem, /no such runbook/, 'a folder is not a runbook');
  });
});
