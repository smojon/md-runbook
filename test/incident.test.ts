import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { buildTimeline, formatNote, formatSeconds, parseNotes } from '@md-runbook/core/incident';
import { parseDurationSeconds, parseFrontMatter } from '@md-runbook/core/secrets';
import { renderReport } from '@md-runbook/core';

const out = (attrs: string, body = 'x') => `<!-- md-runbook:output start ${attrs} -->\n\`\`\`text\n${body}\n\`\`\`\n<!-- md-runbook:output end -->\n`;
const history = (...blocks: string[]) => `<details><summary>md-runbook: ${blocks.length} previous runs</summary>\n\n${blocks.join('\n')}\n</details>\n`;

const RECORD =
  '---\nincident: INC-1234\nseverity: SEV2\nrto: 30m\n---\n\n# Failover\n\n' +
  formatNote({ at: new Date('2026-10-26T21:00:00Z'), by: 'most', milestone: 'detected', text: 'Pager: API 5xx above 5 %' }) +
  '\n```bash name=status\nsystemctl status api\n```\n' +
  out('exit=0 ran=2026-10-26T22:06:00+01:00 duration=0.400s by=most on=deploy@web-1') +
  history(out('exit=3 ran=2026-10-26T22:02:00+01:00 duration=0.300s by=most on=deploy@web-1')) +
  '\n```bash\nsystemctl restart api\n```\n' +
  out('exit=0 ran=2026-10-26T22:05:00+01:00 duration=4.000s by=most on=deploy@web-1') +
  '\n- [x] called the DBA\n\n```bash\ncurl -fsS https://api/health\n```\n' +
  out('exit=done ran=2026-10-26T22:20:00+01:00 by=ana', '[md-runbook] marked done by ana') +
  '\n' +
  formatNote({ at: new Date('2026-10-26T21:08:00Z'), by: 'most', milestone: 'mitigated', text: 'Failover done;\nerrors back to 0' }) +
  '\n' +
  formatNote({ at: new Date('2026-10-26T21:25:00Z'), by: 'ana', milestone: 'resolved', text: 'Root cause: certificate expired' });

describe('run timeline (audit evidence, postmortems)', () => {
  it('every run, earlier attempts, marks and notes in time order, with who and where', () => {
    const { events } = buildTimeline(RECORD);
    assert.deepEqual(
      events.map((e) => [e.kind, e.step, e.exit ?? e.milestone, e.ok, e.earlier ?? false]),
      [
        ['note', undefined, 'detected', undefined, false],
        ['run', 1, '3', false, true],
        ['run', 2, '0', true, false],
        ['run', 1, '0', true, false],
        ['note', undefined, 'mitigated', undefined, false],
        ['mark', 3, 'done', true, false],
        ['note', undefined, 'resolved', undefined, false],
      ],
    );
    const restart = events[2]!;
    assert.deepEqual([restart.label, restart.by, restart.on, restart.duration], ['systemctl restart api', 'most', 'deploy@web-1', '4.000s']);
    assert.equal(events[1]!.label, 'status', 'a name= labels the step');
    assert.equal(events[4]!.text, 'Failover done;\nerrors back to 0');
  });

  it('the summary: incident, severity, span, failed attempts, time to mitigate and resolve, RTO', () => {
    const { summary } = buildTimeline(RECORD);
    assert.equal(summary.incident, 'INC-1234');
    assert.equal(summary.severity, 'SEV2');
    assert.equal(summary.runs, 3);
    assert.equal(summary.failedAttempts, 1);
    assert.equal(summary.durationSeconds, 25 * 60);
    assert.equal(summary.timeToMitigateSeconds, 8 * 60);
    assert.equal(summary.timeToResolveSeconds, 25 * 60);
    assert.equal(summary.rtoSeconds, 30 * 60);
    assert.equal(summary.rtoMet, true);
    assert.deepEqual(summary.people, ['most', 'ana']);
    assert.deepEqual(summary.places, ['deploy@web-1']);
  });

  it('a record without times has an empty timeline; a missed RTO is reported', () => {
    assert.deepEqual(buildTimeline('# T\n\n```bash\necho\n```\n').events, []);
    const slow = RECORD.replace('rto: 30m', 'rto: 10m');
    assert.equal(buildTimeline(slow).summary.rtoMet, false);
  });

  it('notes round-trip; the front matter reads incident, severity, evidence and rto', () => {
    const note = formatNote({ at: new Date('2026-10-26T21:00:00Z'), by: 'ana', text: 'one\ntwo' });
    assert.match(note, /^<!-- md-runbook:note at=\S+ by=ana -->\n> \*\*\d\d:\d\d · ana:\*\* one\n> two\n$/);
    assert.deepEqual(parseNotes(note).map((n) => [n.by, n.text, n.milestone]), [['ana', 'one\ntwo', undefined]]);
    const fm = parseFrontMatter('---\nincident: "INC-9"\nrto: 1h30m\n---\n')!;
    assert.deepEqual([fm.incident, fm.evidence, fm.rtoSeconds], ['INC-9', true, 5400]);
    assert.equal(parseFrontMatter('---\nevidence: yes\n---\n')!.evidence, true);
    assert.equal(parseFrontMatter('---\nmode: session\n---\n')!.evidence, undefined);
    assert.deepEqual(['90s', '45', '2h', 'soon'].map(parseDurationSeconds), [90, 45, 7200, undefined]);
    assert.deepEqual([95, 7200, 0, 3725].map(formatSeconds), ['1 min 35 s', '2 h', '0 s', '1 h 2 min 5 s']);
  });
});

describe('drills', () => {
  it('drill: true and practice: are read; the report calls it a drill record', () => {
    const fm = parseFrontMatter('---\nincident: DRILL-1\ndrill: true\npractice: train\nrto: 30m\n---\n')!;
    assert.deepEqual([fm.drill, fm.practice, fm.evidence], [true, 'train', true]);
    const text = '---\nincident: DRILL-1\ndrill: true\n---\n\n# Failover drill\n\n```bash\nuptime\n```\n<!-- md-runbook:output start exit=0 ran=2026-10-27T10:00:00+01:00 duration=1.000s -->\n```text\nup\n```\n<!-- md-runbook:output end -->\n';
    const html = renderReport(text, { generatedAt: new Date('2026-10-27T10:30:00Z') });
    assert.match(html, /<h2>Drill record<\/h2>/);
    assert.match(html, /<dt>Drill<\/dt><dd>DRILL-1<\/dd>/);
    assert.equal(buildTimeline(text).summary.drill, true);
  });
});
