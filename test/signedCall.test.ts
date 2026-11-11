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
import { nodeShellEnv, resolveShell } from '@md-runbook/core/node';
import { buildManifest, formatManifest, parseManifest, readSignature, signedStatus } from '@md-runbook/core/signing';
import { lintRunbook } from '@md-runbook/core/lint';
import { runRunbook } from '../src/cli/run';
import { signCommand, verifyCommand } from '../src/cli/sign';

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
});
