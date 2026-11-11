/**
 * Runbook calls (core/call.ts): a ```runbook block runs another runbook as one step. Parsing,
 * the checks before a run, lint, estimates, and `md-runbook run` following a call (real bash;
 * the runs are skipped without it).
 */
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { ShellSettings, parse, renderReport } from '@md-runbook/core';
import { callEstimateSeconds, matchRunbooks, nodeShellEnv, resolveShell, runbookReader, writeCallCopy } from '@md-runbook/core/node';
import { callChainProblem, checkCall, isDynamicSrc, parseCall, srcGlob, staysBelow } from '@md-runbook/core/call';
import { lintRunbook } from '@md-runbook/core/lint';
import { CliOptions, RunSummary, firstStepNotDone, flattenSteps, junitReport, runRunbook } from '../src/cli/run';

const settings: ShellSettings = { bashPath: process.env.MD_RUNBOOK_BASH };
const hasBash = resolveShell('bash', settings, nodeShellEnv()).ok;

const CHILD = [
  '---',
  'params:',
  '  - ENV',
  '  - TENANT: t1',
  '---',
  '',
  '# Child',
  '',
  '## Part A',
  '',
  '```bash estimate=10s',
  'echo "A ${param:ENV} ${param:TENANT}"',
  '```',
  '',
  '## Part B',
  '',
  '```bash estimate=20s',
  'echo "B ${param:ENV}"',
  '```',
  '',
].join('\n');

/** CHILD with an output (exit 0) on its first block. */
function withOutput(text: string, out: string): string {
  return text.replace('\n\n## Part B', `\n<!-- md-runbook:output start exit=0 -->\n\`\`\`text\n${out}\n\`\`\`\n<!-- md-runbook:output end -->\n\n## Part B`);
}

function tmp(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdrb-call-'));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text, 'utf8');
  }
  return dir;
}

function parent(call: string, front = 'params:\n  - TO: child'): string {
  return ['---', front, '---', '', '# Parent', '', '```bash', 'echo before', '```', '', call, '', '```bash', 'echo after', '```', ''].join('\n');
}

async function run(file: string, more: Partial<CliOptions> = {}): Promise<{ summary: RunSummary; log: string[] }> {
  const log: string[] = [];
  const summary = await runRunbook(
    { file, write: true, params: {}, inputs: {}, yes: false, keepGoing: false, shell: settings, env: process.env, ...more },
    { out: () => undefined, log: (l) => log.push(l) },
  );
  fs.writeFileSync(file, summary.text, 'utf8');
  return { summary, log };
}

describe('runbook call: parsing and checks', () => {
  it('reads src=, section= and the parameters', () => {
    const c = parseCall('runbook name="x" src="releases/${param:TO}.md" section="Part B"', 'ENV=${param:ENV}\n# a comment\n\nTENANT="t 2"\n');
    assert.equal(c.src, 'releases/${param:TO}.md');
    assert.deepEqual(c.sections, ['Part B']);
    assert.deepEqual(
      c.args.map((a) => [a.name, a.value, a.line]),
      [
        ['ENV', '${param:ENV}', 0],
        ['TENANT', 't 2', 3],
      ],
    );
    assert.deepEqual(c.problems, []);
    assert.ok(isDynamicSrc(c.src!));
    assert.equal(srcGlob(c.src!), 'releases/*.md');
  });

  it('reports a missing src=, a bad line, a name twice and an input in src=', () => {
    assert.match(parseCall('runbook', '').problems[0]!.message, /needs src=/);
    const c = parseCall('runbook src=${input:X}.md', 'not a pair\nA=1\nA=2');
    const messages = c.problems.map((p) => p.message).join('\n');
    assert.match(messages, /src= can't use \$\{input:X\}/);
    assert.match(messages, /"not a pair": expected NAME=value/);
    assert.match(messages, /A is passed twice/);
  });

  it('checks what a call passes against the runbook called', () => {
    const c = parseCall('runbook src=child.md section="Part C"', 'NOPE=1');
    const check = checkCall(c, CHILD);
    assert.deepEqual(
      check.unknown.map((a) => a.name),
      ['NOPE'],
    );
    assert.deepEqual(check.notPassed, ['ENV']);
    assert.match(check.sections[0]!, /section="Part C": no heading/);
    assert.match(checkCall(parseCall('runbook src=child.md section=Child', 'ENV=x'), CHILD).sections[0]!, /matches the title/);
  });

  it('finds cycles and too deep a chain; paths that leave their folder', () => {
    assert.match(callChainProblem(['a.md', 'b.md'], 'a.md')!, /cycle: a\.md → b\.md → a\.md/);
    assert.match(callChainProblem(['a', 'b', 'c', 'd'], 'e')!, /more than 3 deep/);
    assert.equal(callChainProblem(['a', 'b', 'c'], 'd'), undefined);
    assert.ok(staysBelow('releases/x.md'));
    assert.ok(staysBelow('a/../b.md'));
    assert.ok(!staysBelow('../x.md'));
    assert.ok(!staysBelow('/etc/x.md'));
    assert.ok(!staysBelow('C:\\x.md'));
  });
});

describe('runbook call: lint, estimates and copies', () => {
  it('lints a call against the file it calls', () => {
    const dir = tmp({ 'child.md': CHILD });
    const file = path.join(dir, 'parent.md');
    const text = parent('```runbook src=child.md section="Part X" cwd=..\nENV=${param:ENV}\nWHO=me\n```', 'params:\n  - ENV');
    const problems = lintRunbook(text, { readRunbook: runbookReader(file) }).map((p) => `${p.severity}: ${p.message}`);
    assert.ok(problems.some((p) => /^warning: cwd= has no effect on a runbook call/.test(p)), problems.join('\n'));
    assert.ok(problems.some((p) => /^error: WHO: the runbook called \(child\.md\) has no parameter WHO/.test(p)), problems.join('\n'));
    assert.ok(problems.some((p) => /^error: section="Part X": no heading/.test(p)), problems.join('\n'));
    const missing = lintRunbook(parent('```runbook src=nope.md\n```'), { readRunbook: runbookReader(file) });
    assert.ok(missing.some((p) => p.severity === 'error' && /no such runbook/.test(p.message)));
    const notPassed = lintRunbook(parent('```runbook src=child.md\n```'), { readRunbook: runbookReader(file) });
    assert.ok(notPassed.some((p) => p.severity === 'warning' && /needs \$\{param:ENV\}/.test(p.message)));
    const glob = lintRunbook(parent('```runbook src="releases/${param:TO}.md"\n```'), { matchRunbooks: (g) => matchRunbooks(file, g) });
    assert.ok(glob.some((p) => p.severity === 'warning' && /no runbook matches releases\/\*\.md yet/.test(p.message)));
  });

  it('matches a parameterised src= against the files there, not run copies', () => {
    const dir = tmp({ 'releases/1.md': CHILD, 'releases/2.md': CHILD, 'releases/2.20261111-101010.md': CHILD, 'other/3.md': CHILD });
    assert.deepEqual(matchRunbooks(path.join(dir, 'p.md'), 'releases/*.md'), ['releases/1.md', 'releases/2.md']);
  });

  it("estimates a call by what it runs, its sections only", () => {
    const dir = tmp({ 'child.md': CHILD });
    const file = path.join(dir, 'parent.md');
    assert.equal(callEstimateSeconds(file, 'runbook src=child.md', ''), 30);
    assert.equal(callEstimateSeconds(file, 'runbook src=child.md section="Part B"', ''), 20);
    assert.equal(callEstimateSeconds(file, 'runbook src=child.md estimate=1m', ''), 60);
    assert.equal(callEstimateSeconds(file, 'runbook src=${param:TO}.md', ''), undefined);
  });

  it('writes the copy without outputs, with the caller record settings', () => {
    const dir = tmp({ 'child.md': withOutput(CHILD, 'old') });
    const copy = writeCallCopy(path.join(dir, 'child.md'), '---\ndrill: true\nrto: 30m\n---\n# P\n', undefined, new Date(2026, 10, 11, 10, 0, 0));
    assert.equal(path.basename(copy), 'child.20261111-100000.md');
    const text = fs.readFileSync(copy, 'utf8');
    assert.match(text, /^---\nparams:[\s\S]*drill: true\nrto: 1800s\n---/);
    assert.doesNotMatch(text, /md-runbook:output/);
    const second = writeCallCopy(path.join(dir, 'child.md'), '', 'runs', new Date(2026, 10, 11, 10, 0, 0));
    assert.equal(path.relative(dir, second).split(path.sep).join('/'), 'runs/child.20261111-100000.md');
  });

  it('finds the first step not done in a copy', () => {
    const done = withOutput(CHILD, 'A');
    assert.equal(firstStepNotDone(done), 2);
    assert.equal(firstStepNotDone(CHILD), 1);
    assert.equal(firstStepNotDone(done, ['Part A']), undefined);
  });
});

describe('runbook call: md-runbook run', { skip: !hasBash && 'no bash' }, () => {
  it('runs the runbook called as one step, as a copy, with what the call passes', async () => {
    const dir = tmp({ 'child.md': CHILD });
    const file = path.join(dir, 'parent.md');
    fs.writeFileSync(file, parent('```runbook name="Apply" src="${param:TO}.md"\nENV=dev\n```'), 'utf8');
    const { summary, log } = await run(file);
    assert.ok(summary.ok, log.join('\n'));
    assert.deepEqual(
      summary.steps.map((s) => [s.step, s.status]),
      [
        [1, 'passed'],
        [2, 'passed'],
        [3, 'passed'],
      ],
    );
    const call = summary.steps[1]!.call!;
    assert.equal(call.runbook, 'child.md');
    assert.match(call.copy, /^child\.\d{8}-\d{6}\.md$/);
    assert.deepEqual(
      call.steps.map((s) => s.status),
      ['passed', 'passed'],
    );
    assert.ok(log.some((l) => /^ {2}▶ Step 2\.1 · /.test(l)), log.join('\n'));
    // The child file stays a template; the copy holds the outputs; the parent the call's record.
    assert.equal(fs.readFileSync(path.join(dir, 'child.md'), 'utf8'), CHILD);
    const copy = fs.readFileSync(path.join(dir, call.copy), 'utf8');
    assert.match(copy, /A dev t1/);
    assert.match(copy, /B dev/);
    const out = parse(fs.readFileSync(file, 'utf8')).cells.find((c) => c.languageId === 'runbook')!.output!;
    assert.equal(out.attrs.exit, '0');
    assert.equal(out.attrs.runbook, 'child.md');
    assert.equal(out.attrs.copy, call.copy);
    assert.equal(out.attrs.steps, '2 done');
    assert.match(out.attrs.sha256!, /^[0-9a-f]{64}$/);
    // Nested in the reports.
    assert.deepEqual(
      flattenSteps(summary.steps).map((s) => s.number),
      ['1', '2', '2.1', '2.2', '3'],
    );
    assert.match(junitReport('parent.md', summary.steps), new RegExp(`classname="${call.copy.replace(/\./g, '\\.')}" name="Step 2\\.1: echo`));
    // Export Report: the copy's steps under the call, with its link; a copy changed after the run is flagged.
    const read = (rel: string): string | undefined => (fs.existsSync(path.join(dir, rel)) ? fs.readFileSync(path.join(dir, rel), 'utf8') : undefined);
    const html = renderReport(fs.readFileSync(file, 'utf8'), { generatedAt: new Date(), readCall: read });
    assert.match(html, /<a href="#step-2-1">2\.1<\/a>/);
    assert.match(html, /<div class="step-head">Step 2\.2<\/div>/);
    assert.ok(html.includes(`<a href="${call.copy}"><code>${call.copy}</code></a>`));
    assert.doesNotMatch(html, /the copy changed after the run/);
    fs.appendFileSync(path.join(dir, call.copy), '\nedited\n');
    assert.match(renderReport(fs.readFileSync(file, 'utf8'), { generatedAt: new Date(), readCall: read }), /the copy changed after the run/);
    assert.doesNotMatch(renderReport(fs.readFileSync(file, 'utf8'), { generatedAt: new Date() }), /step-2-1/);
  });

  it('runs only the sections named; a failure stops the caller; a second run continues the copy', async () => {
    const failing = CHILD.replace('echo "B ${param:ENV}"', 'test -f "${param:ENV}" && echo "B ok"');
    const dir = tmp({ 'child.md': failing });
    const file = path.join(dir, 'parent.md');
    fs.writeFileSync(file, parent('```runbook src=child.md\nENV=flag\n```'), 'utf8');
    const first = await run(file);
    assert.ok(!first.summary.ok);
    assert.deepEqual(
      first.summary.steps.map((s) => s.status),
      ['passed', 'failed', 'not run'],
    );
    assert.match(first.summary.steps[1]!.message!, /step 2\.2 failed/);
    const copy = first.summary.steps[1]!.call!.copy;
    // Fixed: the next run goes on in the same copy from step 2.
    fs.writeFileSync(path.join(dir, 'flag'), '', 'utf8');
    const second = await run(file);
    assert.ok(second.summary.ok, second.log.join('\n'));
    assert.equal(second.summary.steps[1]!.call!.copy, copy);
    assert.ok(second.log.some((l) => l.includes(`continuing ${copy} (steps done there are kept)`)), second.log.join('\n'));
    assert.deepEqual(
      second.summary.steps[1]!.call!.steps.map((s) => s.status),
      ['skipped', 'passed'],
    );

    // section=: only Part B.
    fs.writeFileSync(file, parent('```runbook src=child.md section="Part B" \nENV=flag\n```'), 'utf8');
    const part = await run(file, { freshCopy: true });
    assert.ok(part.summary.ok, part.log.join('\n'));
    assert.notEqual(part.summary.steps[1]!.call!.copy, copy);
    assert.deepEqual(
      part.summary.steps[1]!.call!.steps.map((s) => s.status),
      ['skipped', 'passed'],
    );
  });

  it('refuses a cycle, a parameter not passed, and another cluster, before anything runs in it', async () => {
    const dir = tmp({
      'a.md': '# A\n\n```runbook src=b.md\n```\n',
      'b.md': '# B\n\n```runbook src=a.md\n```\n',
      'child.md': CHILD,
      'k8s.md': '---\nkube-context: prod\n---\n# K\n\n```bash\necho k\n```\n',
    });
    const cycle = await run(path.join(dir, 'a.md'));
    assert.ok(!cycle.summary.ok);
    assert.match(cycle.summary.steps[0]!.message!, /cycle: a\.md → b\.md → a\.md|cycle/);
    const file = path.join(dir, 'p.md');
    fs.writeFileSync(file, '# P\n\n```runbook src=child.md\n```\n', 'utf8');
    const notPassed = await run(file);
    assert.equal(notPassed.summary.steps[0]!.status, 'not run');
    assert.match(notPassed.summary.steps[0]!.message!, /needs \$\{param:ENV\}: pass it in the call/);
    fs.writeFileSync(file, '---\nkube-context: dev\n---\n# P\n\n```runbook src=k8s.md\n```\n', 'utf8');
    const cluster = await run(file);
    assert.match(cluster.summary.steps[0]!.message!, /runs against the Kubernetes context prod, this runbook against dev/);
  });
});

const MANUAL = ['# M', '', '## Do', '', '```bash', 'echo did', '```', '', '- [ ] Check the canary', '- [x] Told the team', '', '## Verify', '', '- [ ] Look at the dashboard', ''].join('\n');

describe('manual steps on the command line', { skip: !hasBash && 'no bash' }, () => {
  it('lists the unticked ones; a section of manual steps only runs; evidence fails on one', async () => {
    const dir = tmp({ 'm.md': MANUAL });
    const file = path.join(dir, 'm.md');
    const all = await run(file);
    assert.ok(all.summary.ok, all.log.join('\n'));
    assert.ok(all.log.includes('☐ manual, not ticked · m.md:9 · Check the canary'), all.log.join('\n'));
    assert.ok(all.log.includes('☐ 2 manual steps not ticked'), all.log.join('\n'));
    assert.deepEqual(
      all.summary.manual.map((m) => [m.line + 1, m.ticked, m.step]),
      [
        [9, false, 1],
        [10, true, 1],
        [14, false, 1],
      ],
    );
    assert.match(junitReport('m.md', all.summary.steps, all.summary.manual), /name="Manual \(line 14\): Look at the dashboard" time="0\.000"><skipped message="manual step, not ticked"\/>/);

    const verify = await run(file, { sections: ['Verify'] });
    assert.deepEqual(verify.summary.steps.map((s) => s.status), ['skipped']);
    assert.deepEqual(verify.summary.manual.map((m) => m.text), ['Look at the dashboard']);

    fs.writeFileSync(file, '---\nevidence: true\n---\n' + MANUAL, 'utf8');
    const evidence = await run(file);
    assert.ok(!evidence.summary.ok);
    assert.ok(evidence.log.some((l) => /^✗ 2 manual steps not ticked, and this runbook keeps evidence/.test(l)), evidence.log.join('\n'));
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/- \[ \]/g, '- [x]'), 'utf8');
    assert.ok((await run(file)).summary.ok);
  });

  it('a call in a runbook that keeps evidence waits for the manual steps of the copy', async () => {
    const dir = tmp({ 'm.md': MANUAL });
    const file = path.join(dir, 'p.md');
    fs.writeFileSync(file, '---\nevidence: true\n---\n# P\n\n```runbook src=m.md section=Verify\n```\n', 'utf8');
    const first = await run(file);
    assert.ok(!first.summary.ok);
    const call = first.summary.steps[0]!.call!;
    assert.match(first.summary.steps[0]!.message!, /1 manual step not ticked in m\.\d{8}-\d{6}\.md, which keeps evidence/);
    const out = parse(fs.readFileSync(file, 'utf8')).cells.find((c) => c.languageId === 'runbook')!.output!;
    assert.equal(out.attrs.steps, '0 done, 1 skipped, 1 manual not ticked');
    // Ticked in the copy: the call goes on in it and passes.
    const copy = path.join(dir, call.copy);
    fs.writeFileSync(copy, fs.readFileSync(copy, 'utf8').replace('- [ ] Look', '- [x] Look'), 'utf8');
    const second = await run(file);
    assert.ok(second.summary.ok, second.log.join('\n'));
    assert.equal(second.summary.steps[0]!.call!.copy, call.copy);
  });

  it('lint warns about a section= of manual steps only', () => {
    const dir = tmp({ 'm.md': MANUAL });
    const problems = lintRunbook('# P\n\n```runbook src=m.md section=Verify\n```\n', { readRunbook: runbookReader(path.join(dir, 'p.md')) });
    assert.ok(problems.some((p) => p.severity === 'warning' && /section="Verify" holds manual steps only/.test(p.message)), JSON.stringify(problems));
  });
});
