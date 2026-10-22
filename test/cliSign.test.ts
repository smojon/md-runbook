import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { parseManifest, readSignature } from '@md-runbook/core/signing';
import { checkSignedSteps, nodeShellEnv, resolveShell } from '@md-runbook/core/node';
import { parseSignArgs, signCommand, verifyCommand } from '../src/cli/sign';

const fence = (info: string, body: string): string => '```' + info + '\n' + body + '\n```\n\n';

describe('cli: sign and verify', () => {
  let dir: string;
  let key: string;
  let allowed: string;
  const lines: string[] = [];
  const out = (l: string): void => void lines.push(l);
  const file = (name: string, text: string): string => {
    const f = path.join(dir, name);
    fs.writeFileSync(f, text);
    return f;
  };

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdrb-sign-'));
    key = path.join(dir, 'release');
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'release@example.net', '-f', key]);
    allowed = path.join(dir, 'allowed_signers');
    const pub = fs.readFileSync(key + '.pub', 'utf8').trim().split(' ').slice(0, 2).join(' ');
    fs.writeFileSync(allowed, `release@example.net namespaces="md-runbook" ${pub}\n`);
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('signs, verifies with the allowed signers, and signs again with the next version', async () => {
    const f = file('restart-api.runbook.md', '# Restart\n\n' + fence('bash', 'systemctl restart ${param:SERVICE}') + fence('pwsh', 'Get-Date'));
    lines.length = 0;
    assert.equal(await signCommand([f, '--key', key, '--scope', 'web', '--pattern', 'SERVICE=[a-z-]+', '--expires-in', '30'], out), 0, lines.join('\n'));
    assert.match(lines.find((l) => l.startsWith('✓'))!, /^✓ restart-api version 1 signed by release@example.net: 1 block, scopes web, until \d{4}-\d{2}-\d{2}/);
    const block = readSignature(fs.readFileSync(f, 'utf8'))!;
    assert.equal(block.signer, 'release@example.net');
    lines.length = 0;
    assert.equal(await verifyCommand([f, '--allowed-signers', allowed], out), 0, lines.join('\n'));
    assert.match(lines.join('\n'), /signature: good, by release@example.net/);
    assert.match(lines.join('\n'), /parameter SERVICE: \[a-z-\]\+/);

    // Signing again keeps name, scopes and patterns; the version counts up.
    lines.length = 0;
    assert.equal(await signCommand([f, '--key', key], out), 0, lines.join('\n'));
    const m = parseManifest(readSignature(fs.readFileSync(f, 'utf8'))!.manifest);
    assert.deepEqual([m.name, m.version, m.scopes, m.patterns, m.expires], ['restart-api', 2, ['web'], { SERVICE: '[a-z-]+' }, undefined]);
    assert.equal(fs.readFileSync(f, 'utf8').match(/md-runbook:signature/g)?.length, 1);
  });

  it('verify reports blocks changed since signing (with their line) and a foreign signature', async () => {
    const f = file('check.md', fence('bash', 'echo one') + fence('bash', 'echo two'));
    assert.equal(await signCommand([f, '--key', key, '--name', 'ops/check'], out), 0);
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('echo two', 'echo three'));
    lines.length = 0;
    assert.equal(await verifyCommand([f], out), 1);
    assert.match(lines.join('\n'), /check\.md:5: changed since signing/);
    assert.match(lines.at(-1)!, /✗ 1 signed block, 1 changed/);

    const other = path.join(dir, 'other');
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', other]);
    const g = file('foreign.md', fence('bash', 'echo hi'));
    assert.equal(await signCommand([g, '--key', other, '--signer', 'mallory'], out), 0);
    lines.length = 0;
    assert.equal(await verifyCommand([g, '--allowed-signers', allowed], out), 1);
    assert.match(lines.join('\n'), /signature: no key in .* made this signature/);

    // Without the allowed signers, the signer's name is only what the file says.
    lines.length = 0;
    assert.equal(await verifyCommand([g], out), 0);
    assert.match(lines[0]!, /signed by mallory \(as the file says\)/);
    assert.match(lines.join('\n'), /signature: NOT checked/);
    assert.match(lines.at(-1)!, /✓ 1 signed block, 0 changed, signature not checked/);
  });

  it('refuses to sign commands a gate would run one by one but bash would read differently', async () => {
    // Before the fix the here-doc ended at "E" and its data ran as the next command.
    const ok = file('heredoc.md', fence('bash', 'cat > notes.txt <<E"O"F\nE\nrm -rf /srv/data\nEOF\necho done'));
    lines.length = 0;
    assert.equal(await signCommand([ok, '--key', key], out), 0, lines.join('\n'));
    const steps = parseManifest(readSignature(fs.readFileSync(ok, 'utf8'))!.manifest).cells[0]!.steps;
    assert.deepEqual(steps, ['cat > notes.txt <<E"O"F\nE\nrm -rf /srv/data\nEOF', 'echo done']);
    // Should the scanner still split a command wrongly, bash -n catches it before signing.
    const bash = resolveShell('bash', {}, nodeShellEnv());
    if (!bash.ok) return;
    const split = parseManifest(readSignature(fs.readFileSync(ok, 'utf8'))!.manifest);
    split.cells[0]!.steps = ['cat > notes.txt <<EOF', 'rm -rf /srv/data', 'EOF', 'echo $((1 +'];
    const problems = await checkSignedSteps(split, bash.shell.command);
    // A syntax error is caught everywhere. An unterminated here-doc only where bash -n warns about
    // it (Git Bash does; Linux and macOS bash don't), so the scanner itself must get here-docs right.
    assert.ok(problems?.some((p) => /^cell 1, command 4 \(echo \$\(\(1 \+\): /.test(p)), problems?.join('\n'));
    assert.ok(problems!.every((p) => /^cell 1, command (1|4) /.test(p)), problems!.join('\n'));
  });

  it('refuses what it can not sign, and bad arguments', async () => {
    const f = file('bad.md', fence('bash', 'echo ${param:X} ${secret:TOKEN}'));
    lines.length = 0;
    assert.equal(await signCommand([f, '--key', key], out), 1);
    assert.match(lines.join('\n'), /\$\{param:X\} needs a pattern/);
    assert.match(lines.join('\n'), /\$\{secret:TOKEN\} can't be signed/);
    assert.equal(readSignature(fs.readFileSync(f, 'utf8')), undefined, 'the file is unchanged');
    lines.length = 0;
    assert.equal(await verifyCommand([f], out), 1);
    assert.match(lines[0]!, /not signed/);
    assert.throws(() => parseSignArgs(['x.md']), /missing --key/);
    assert.throws(() => parseSignArgs(['x.md', '--key', 'k', '--pattern', 'nope']), /NAME=REGEX/);
    assert.throws(() => parseSignArgs(['x.md', '--key', 'k', '--version', '0']), /positive whole number/);
    assert.deepEqual(parseSignArgs(['x.md', '--key', 'k', '--scope', 'a', '--scope', 'b']).scopes, ['a', 'b']);
  });
});
