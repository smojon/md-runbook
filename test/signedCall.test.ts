/**
 * Signed runbook calls: `md-runbook sign` signs a call as written, and `md-runbook run
 * --allowed-signers` runs a signed pair only as signed: the runbook called must be signed itself,
 * unchanged, in the repository, with each parameter matching its pattern. Needs ssh-keygen and
 * bash (skipped without them).
 */
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { ShellSettings } from '@md-runbook/core';
import { manifestHash, nodeShellEnv, resolveShell } from '@md-runbook/core/node';
import { buildManifest, formatManifest, parseManifest, readSignature, signedStatus } from '@md-runbook/core/signing';
import { lintRunbook } from '@md-runbook/core/lint';
import { runRunbook } from '../src/cli/run';
import { SignedPolicy, floorOf, isRevoked, scopeAccepted, signedValueProblem } from '../src/cli/signedRun';
import { signCommand, verifyCommand } from '../src/cli/sign';

// The command line's record of the call copies it wrote: in a folder of these tests, not yours.
process.env.MD_RUNBOOK_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mdrb-state-'));

const settings: ShellSettings = { bashPath: process.env.MD_RUNBOOK_BASH };
const hasBash = resolveShell('bash', settings, nodeShellEnv()).ok;
const hasKeygen = (() => {
  try {
    execFileSync('ssh-keygen', ['-?'], { stdio: 'ignore' });
    return true;
  } catch (e) {
    return (e as { status?: number }).status !== undefined; // it ran (and printed its usage)
  }
})();

const CHILD = '---\nparams:\n  - STAGE\n---\n# Release\n\n```bash\necho "go ${param:STAGE}"\n```\n';
const PARENT = '---\nparams:\n  - TO\n  - STAGE\n---\n# Upgrade\n\n```bash\necho before\n```\n\n```runbook src="releases/${param:TO}.md"\nSTAGE=${param:STAGE}\n```\n';

describe('signed runbook calls: the manifest', () => {
  it('signs a call as written; its placeholders need patterns; a changed call is unsigned', () => {
    const meta = { name: 'upgrade', version: 1, scopes: [], patterns: { TO: '[0-9]+', STAGE: '[a-z]+' } };
    const built = buildManifest(PARENT, meta);
    assert.ok('manifest' in built, JSON.stringify(built));
    assert.deepEqual(built.manifest.calls, [{ n: 1, info: 'runbook src="releases/${param:TO}.md"', body: 'STAGE=${param:STAGE}', needs: ['TO', 'STAGE'] }]);
    const text = formatManifest(built.manifest);
    assert.match(text, /\ncall 1\ncallinfo [A-Za-z0-9+/=]+\ncallbody [A-Za-z0-9+/=]+\ncallneeds TO\ncallneeds STAGE\nend\n$/);
    assert.deepEqual(parseManifest(text).calls, built.manifest.calls);
    const missing = buildManifest(PARENT, { ...meta, patterns: { STAGE: '[a-z]+' } });
    assert.ok('errors' in missing && missing.errors.some((e) => /\$\{param:TO\} needs a pattern/.test(e)), JSON.stringify(missing));
    const absolute = buildManifest(PARENT.replace('releases/${param:TO}.md', '/etc/${param:TO}.md'), meta);
    assert.ok('errors' in absolute && absolute.errors.some((e) => /src= must be relative/.test(e)));
  });
});

describe('signed runbook calls: sign, verify, run --allowed-signers', { skip: (!hasBash || !hasKeygen) && 'needs bash and ssh-keygen' }, () => {
  let dir: string;
  let key: string;
  let allowed: string;
  const lines: string[] = [];
  const out = (l: string): void => void lines.push(l);
  const put = (rel: string, text: string): string => {
    const f = path.join(dir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
    return f;
  };
  const run = (file: string, params: Record<string, string>) =>
    runRunbook({ file, write: true, params, inputs: {}, yes: false, keepGoing: false, shell: settings, env: process.env, allowedSigners: allowed }, { out: () => undefined, log: (l) => void lines.push(l) });

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdrb-signed-call-'));
    fs.mkdirSync(path.join(dir, 'repo', '.git'), { recursive: true });
    key = path.join(dir, 'release');
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'release@example.net', '-f', key]);
    allowed = path.join(dir, 'allowed_signers');
    const pub = fs.readFileSync(key + '.pub', 'utf8').trim().split(' ').slice(0, 2).join(' ');
    fs.writeFileSync(allowed, `release@example.net namespaces="md-runbook" ${pub}\n`);
    const child = put('repo/releases/1.md', CHILD);
    assert.equal(await signCommand([child, '--key', key, '--pattern', 'STAGE=[a-z]+'], out), 0, lines.join('\n'));
    const parent = put('repo/upgrade.md', PARENT);
    assert.equal(await signCommand([parent, '--key', key, '--pattern', 'TO=[0-9]+', '--pattern', 'STAGE=[a-z]+'], out), 0, lines.join('\n'));
    assert.equal(parseManifest(readSignature(fs.readFileSync(parent, 'utf8'))!.manifest).calls.length, 1);
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('runs a signed pair; verify checks the pair', async () => {
    lines.length = 0;
    const r = await run(path.join(dir, 'repo/upgrade.md'), { TO: '1', STAGE: 'dev' });
    assert.ok(r.ok, lines.join('\n'));
    assert.ok(lines.some((l) => /^✓ signed by release@example\.net/.test(l)), lines.join('\n'));
    lines.length = 0;
    assert.equal(await verifyCommand([path.join(dir, 'repo/upgrade.md'), '--allowed-signers', allowed], out), 0, lines.join('\n'));
    assert.match(lines.join('\n'), /runbook call: releases\/\$\{param:TO\}\.md: has placeholders, checked when it runs/);
  });

  it('refuses before anything runs: a parameter off its pattern, an unsigned or changed runbook called, a call outside the repository', async () => {
    const parent = path.join(dir, 'repo/upgrade.md');
    await assert.rejects(run(parent, { TO: '1x', STAGE: 'dev' }), /TO="1x" doesn't match its signed pattern \[0-9\]\+/);
    put('repo/releases/2.md', CHILD);
    await assert.rejects(run(parent, { TO: '2', STAGE: 'dev' }), /releases\/2\.md: not signed/);
    put('repo/releases/3.md', fs.readFileSync(path.join(dir, 'repo/releases/1.md'), 'utf8').replace('echo "go', 'echo "changed'));
    await assert.rejects(run(parent, { TO: '3', STAGE: 'dev' }), /releases\/3\.md: line \d+: changed since signing/);
    // Nothing ran: the parent has no output.
    assert.doesNotMatch(fs.readFileSync(parent, 'utf8').replace(/<!-- md-runbook:signature[\s\S]*$/, ''), /output start exit=0[^\n]*\n```text\nbefore/);
    // A changed call in the caller is no longer signed: lint and the run say so.
    const edited = put('repo/edited.md', fs.readFileSync(parent, 'utf8').replace('STAGE=${param:STAGE}', 'STAGE=prod'));
    assert.ok(signedStatus(fs.readFileSync(edited, 'utf8'))!.changed.length === 1);
    assert.ok(lintRunbook(fs.readFileSync(edited, 'utf8')).some((p) => /changed since the runbook was signed/.test(p.message)));
    await assert.rejects(run(edited, { TO: '1', STAGE: 'dev' }), /edited\.md: line \d+: changed since signing/);
  });

  it('--signers, --name, --revoked, --floors and --scope refuse as gate.conf would (review, 2026-11-28)', async () => {
    const parent = path.join(dir, 'repo/upgrade.md');
    const runAs = (signedPolicy: SignedPolicy) =>
      runRunbook(
        { file: parent, write: false, params: { TO: '1', STAGE: 'dev' }, inputs: {}, yes: false, keepGoing: false, shell: settings, env: process.env, allowedSigners: allowed, signedPolicy },
        { out: () => undefined, log: (l) => void lines.push(l) },
      );
    const hash = manifestHash(readSignature(fs.readFileSync(parent, 'utf8'))!.manifest);
    await assert.rejects(runAs({ name: 'ops/other' }), /upgrade\.md: it is signed as upgrade, not ops\/other \(--name\)/);
    await assert.rejects(runAs({ signers: 2 }), /upgrade version 1 needs 2 signers \(--signers\); signed by 1 trusted/);
    const revoked = put('revoked', `# withdrawn\r\nSHA256:${hash.toUpperCase()}\r\n`);
    await assert.rejects(runAs({ revoked }), /upgrade version 1 was withdrawn \(revoked in/);
    await assert.rejects(runAs({ revoked: path.join(dir, 'missing') }), /can't read the revoked list/);
    const floors = put('floors', 'other 9\nupgrade 2 # since the fix\n');
    await assert.rejects(runAs({ floors }), /upgrade version 1 is older than the lowest version allowed \(2, in/);
    await assert.rejects(runAs({ scopes: ['prod'] }), /upgrade is for no scope; this run accepts prod \(--scope\)/);
    // The runbook called (signed as "1") is checked too, but not against --name.
    await assert.rejects(runAs({ floors: put('floors1', '1 3\n') }), /releases\/1\.md: 1 version 1 is older than the lowest version allowed/);
    lines.length = 0;
    assert.ok((await runAs({ name: 'upgrade', signers: 1, scopes: ['*'], revoked: put('revoked2', 'ab\n'), floors: put('floors2', 'upgrade 1\n') })).ok, lines.join('\n'));
    // The list formats, as md-runbook-gate reads them.
    assert.equal(isRevoked(` sha256:${hash}\t\r\n`, hash), true);
    assert.equal(isRevoked(hash.slice(1), hash), false);
    assert.equal(floorOf('# x 9\nops/a 1x\nops/a 4\nops/a 5\n', 'ops/a'), '4');
    assert.equal(floorOf('ops/ab 4\n', 'ops/a'), undefined);
    assert.equal(scopeAccepted(['web', 'db'], ['db']), true);
    assert.equal(scopeAccepted(['web'], []), false);
    assert.equal(scopeAccepted(['*'], []), true);
  });

  it('checks inputs and captured values against their signed patterns, as the gate does (review, 2026-11-28)', async () => {
    const runWith = (file: string, inputs: Record<string, string>) =>
      runRunbook(
        { file, write: false, params: {}, inputs, yes: false, keepGoing: false, shell: settings, env: {}, allowedSigners: allowed },
        { out: () => undefined, log: (l) => void lines.push(l) },
      );
    const input = put('repo/input.md', '# Input\n\n```bash\necho "pod [${input:POD}]"\n```\n');
    assert.equal(await signCommand([input, '--key', key, '--pattern', 'POD=[a-z]+'], out), 0, lines.join('\n'));
    // Known before the run: refused before anything runs.
    await assert.rejects(runWith(input, { POD: 'x; rm -rf /' }), /nothing ran:\n {2}Step 1 · input\.md:3: POD="x; rm -rf \/" doesn't match its signed pattern \[a-z\]\+/);
    lines.length = 0;
    assert.ok((await runWith(input, { POD: 'web' })).ok, lines.join('\n'));

    // Captured by an earlier step: refused when the step that uses it would run.
    const captured = put('repo/captured.md', '# Out\n\n```bash capture=POD\necho "not a pod!"\n```\n\n```bash\necho "pod [${out:POD}]"\n```\n');
    assert.equal(await signCommand([captured, '--key', key, '--pattern', 'POD=[a-z]+'], out), 0, lines.join('\n'));
    lines.length = 0;
    const r = await runWith(captured, {});
    assert.equal(r.ok, false);
    assert.deepEqual(r.steps.map((s) => s.status), ['passed', 'not run']);
    assert.match(r.steps[1]!.message ?? '', /POD="not a pod!" doesn't match its signed pattern \[a-z\]\+/);

    // A name with no signed pattern: the gate refuses it, so does the run.
    assert.equal(signedValueProblem({}, { kind: 'input', name: 'POD' }, 'web'), '${input:POD} has no signed pattern, so a signed run takes no value for it');
    assert.equal(signedValueProblem({ POD: '[a-z]+' }, { kind: 'out', name: 'POD' }, 'web'), undefined);
    assert.match(signedValueProblem({ POD: '[a-z]+' }, { kind: 'out', name: 'POD' }, 'web\nx') ?? '', /doesn't match/);
  });

  it('refuses a front matter changed after signing: env:, cwd: and shell: change how every cell runs (security review, 2026-11-16)', async () => {
    const signed = fs.readFileSync(path.join(dir, 'repo/upgrade.md'), 'utf8');
    assert.ok(signed.startsWith('---\nparams:'));
    const env = put('repo/env.md', signed.replace('---\nparams:', '---\nenv:\n  BASH_ENV: /tmp/payload\nparams:'));
    await assert.rejects(run(env, { TO: '1', STAGE: 'dev' }), /env\.md: changed since signing outside its blocks/);
    const cwd = put('repo/cwd.md', signed.replace('---\nparams:', '---\ncwd: /tmp\nparams:'));
    await assert.rejects(run(cwd, { TO: '1', STAGE: 'dev' }), /cwd\.md: changed since signing outside its blocks/);
  });
});
