/** The command-line runner: argument parsing, reports, and a real run with bash (skipped without it). */
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { ShellSettings, nodeShellEnv, resolveShell } from '../src/core';
import { parseArgs } from '../src/cli/main';
import { browserCandidates, findBrowser } from '../src/cli/pdf';
import { StepResult, junitReport, markdownSummary, runRunbook } from '../src/cli/run';

const settings: ShellSettings = { bashPath: process.env.MD_RUNBOOK_BASH };
const hasBash = resolveShell('bash', settings, nodeShellEnv()).ok;

describe('cli: arguments', () => {
  it('parses run options', () => {
    const p = parseArgs(['run', 'x.md', '--check', '--param', 'HOST=a=b', '--input', 'N=1', '--yes', '--keep-going', '--session', '--timeout', '30', '--pdf', 'r.pdf', '--junit', 'j.xml']);
    assert.ok(typeof p === 'object');
    assert.equal(p.options.file, 'x.md');
    assert.equal(p.options.write, false);
    assert.deepEqual(p.options.params, { HOST: 'a=b' });
    assert.deepEqual(p.options.inputs, { N: '1' });
    assert.equal(p.options.yes, true);
    assert.equal(p.options.keepGoing, true);
    assert.equal(p.options.session, true);
    assert.equal(p.options.timeoutSeconds, 30);
    assert.equal(p.pdf, 'r.pdf');
    assert.equal(p.options.junit, 'j.xml');
    const j = parseArgs(['run', 'x.md', '--json', 'r.json']);
    assert.ok(typeof j === 'object' && j.options.json === 'r.json');
  });

  it('help, version and usage errors', () => {
    assert.equal(parseArgs([]), 'help');
    assert.equal(parseArgs(['--help']), 'help');
    assert.equal(parseArgs(['--version']), 'version');
    assert.throws(() => parseArgs(['go', 'x.md']), /unknown command/);
    assert.throws(() => parseArgs(['run']), /missing the runbook/);
    assert.throws(() => parseArgs(['run', 'x.md', '--param', 'NOEQUALS']), /NAME=VALUE/);
    assert.throws(() => parseArgs(['run', 'x.md', '--nope']), /unknown option/);
  });
});

describe('cli: argument safety', () => {
  it('-h, --help and --version only count as the first argument', () => {
    assert.throws(() => parseArgs(['run', 'x.md', '--param', '-h']), /NAME=VALUE/);
    assert.throws(() => parseArgs(['run', '--help']), /unknown option/);
    assert.throws(() => parseArgs(['run', 'x.md', '-h']), /unknown option/);
  });
});

describe('cli: reports', () => {
  const steps: StepResult[] = [
    { step: 1, line: 3, language: 'bash', title: 'echo <a>', status: 'passed', exit: '0', durationMs: 1200, output: 'a\n' },
    { step: 2, line: 7, language: 'bash', title: 'false | x', status: 'failed', exit: '1', durationMs: 10, message: 'exit 1', output: 'bad & worse\n' },
    { step: 3, line: 9, language: 'pwsh', title: 'Get-Date', status: 'skipped', exit: 'skipped', durationMs: 0, output: '' },
  ];

  it('JUnit XML escapes text and marks failures and skips', () => {
    const x = junitReport('r.md', steps);
    assert.match(x, /<testsuite name="r.md" tests="3" failures="1" skipped="1"/);
    assert.match(x, /name="Step 1: echo &lt;a&gt;" time="1.200"><\/testcase>/);
    assert.match(x, /<failure message="exit 1">bad &amp; worse\n<\/failure>/);
    assert.match(x, /<skipped message="skipped"\/>/);
  });

  it('Markdown summary escapes pipes', () => {
    const md = markdownSummary('r.md', steps);
    assert.match(md, /^### r.md: 1\/3 steps passed/);
    assert.match(md, /`false \\| x`/);
  });
});

describe('cli: PDF browser lookup', () => {
  it('lists the usual locations per platform and prefers an explicit path', () => {
    const win = browserCandidates({ platform: 'win32', env: { ProgramFiles: 'C:\\PF' }, exists: () => false, which: () => undefined });
    assert.ok(win.includes('C:\\PF\\Microsoft\\Edge\\Application\\msedge.exe'));
    const linux = browserCandidates({ platform: 'linux', env: {}, exists: () => true, which: (c) => (c === 'chromium' ? '/usr/bin/chromium' : undefined) });
    assert.deepEqual(linux, ['/usr/bin/chromium']);
    assert.equal(findBrowser('/my/chrome', { platform: 'linux', env: {}, exists: () => false, which: () => undefined }), '/my/chrome');
    assert.equal(findBrowser(undefined, { platform: 'darwin', env: {}, exists: () => false, which: () => undefined }), undefined);
  });
});

describe('cli: running a runbook', { skip: !hasBash && 'bash not installed' }, () => {
  const run = async (md: string, extra: Partial<Parameters<typeof runRunbook>[0]> = {}) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdrb-cli-'));
    const file = path.join(dir, 'r.md');
    fs.writeFileSync(file, md);
    const lines: string[] = [];
    const r = await runRunbook(
      { file, write: true, params: {}, inputs: {}, yes: false, keepGoing: false, shell: settings, env: { ...process.env, CLI_TOKEN: 'tok-cli-12345' }, ...extra },
      { out: (t) => lines.push(t), log: (l) => lines.push(l + '\n') },
    );
    fs.rmSync(dir, { recursive: true, force: true });
    return { ...r, printed: lines.join('') };
  };

  it('runs blocks, writes output blocks, resolves placeholders and redacts secrets', async () => {
    const r = await run(
      '---\nparams:\n- WHO: world\n---\n\n```bash capture=GREETING\necho "hello ${param:WHO}"\n```\n\n```bash expect="hello world"\necho "${out:GREETING} ${secret:CLI_TOKEN}"\n```\n',
    );
    assert.equal(r.ok, true, r.printed);
    assert.deepEqual(r.steps.map((s) => s.status), ['passed', 'passed']);
    assert.match(r.text, /<!-- md-runbook:output start exit=0 /);
    assert.match(r.text, /hello world \[REDACTED\]/);
    assert.doesNotMatch(r.text + r.printed, /tok-cli-12345/);
  });

  it('redacts environment secrets from every step, holds back secret captures, survives bad placeholders', async () => {
    const md = [
      '```bash', 'echo "early $CLI_TOKEN"', '```', '',
      '```bash', 'echo ${secret:CLI_TOKEN}', '```', '',
      '```bash capture-secret=TOK', 'echo tok-held-98765', '```', '',
      '```bash', 'echo ${input:X} ${param:X}', '```', '',
    ].join('\n');
    const r = await run(
      md,
      { keepGoing: true, extraSecrets: ['https://hooks.example/SECRET-URL'] },
    );
    assert.doesNotMatch(r.text + r.printed, /tok-cli-12345/, 'the env secret is redacted in the step before its reference');
    assert.doesNotMatch(r.printed, /tok-held-98765/, 'a secret capture is not printed before it is known');
    assert.equal(r.steps[3]!.status, 'not run');
    assert.match(r.steps[3]!.message ?? '', /both input and param/);
    assert.equal(r.redact('x https://hooks.example/SECRET-URL'), 'x [REDACTED]');
  });

  it('stops at a failure; risky commands need --yes; missing inputs fail clearly', async () => {
    const failed = await run('```bash\nexit 4\n```\n\n```bash\necho never\n```\n');
    assert.equal(failed.ok, false);
    assert.deepEqual(failed.steps.map((s) => s.status), ['failed', 'not run']);
    const risky = await run('```bash\nrm -rf ./nothing-here-x\n```\n');
    assert.equal(risky.steps[0]!.status, 'not run');
    assert.match(risky.text, /exit=declined/);
    assert.equal((await run('```bash\nrm -rf ./nothing-here-x\n```\n', { yes: true })).ok, true);
    const input = await run('```bash\necho ${input:NOPE_INPUT}\n```\n');
    assert.match(input.steps[0]!.message ?? '', /--input NOPE_INPUT=/);
    const proposed = await run('```bash proposed by=claude\necho hi\n```\n');
    assert.equal(proposed.steps[0]!.status, 'not run');
  });
});
