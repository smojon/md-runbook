/** Passkeys as the app's SSH key: the key line, the signature blob, and SSHSIG checked by ssh-keygen. */
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import { sshVerify } from '@md-runbook/core/node';
import { buildManifest, formatManifest } from '@md-runbook/core/signing';
import { PasskeyKeyPair, allowedSignersLine, publicKeyLine, signSshsig, webauthnSignature } from '@md-runbook/ssh';
import { softPasskey } from './softPasskey';

const RP = 'runbook.example.net';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdrb-passkey-'));
const fence = (info: string, body: string): string => '```' + info + '\n' + body + '\n```\n\n';

describe('passkeys as SSH keys', () => {
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("the key line is an sk-ecdsa key ssh-keygen reads, with the site as its application", async () => {
    const line = await publicKeyLine(new PasskeyKeyPair(softPasskey(RP)), 'md-runbook-app');
    assert.match(line, /^sk-ecdsa-sha2-nistp256@openssh\.com AAAA\S+ md-runbook-app$/);
    const file = path.join(dir, 'key.pub');
    fs.writeFileSync(file, line + '\n');
    assert.match(execFileSync('ssh-keygen', ['-lf', file], { encoding: 'utf8' }), /\(ECDSA-SK\)/);
    const blob = Buffer.from(line.split(' ')[1]!, 'base64');
    assert.ok(blob.subarray(blob.length - RP.length).equals(Buffer.from(RP)), 'the application ends the blob');
  });

  it('a runbook signed with a passkey verifies with ssh-keygen -Y verify (as the gate checks it)', async () => {
    const built = buildManifest('# R\n\n' + fence('bash', 'systemctl restart api'), { name: 'ops/restart-api', version: 1, scopes: [], patterns: {} });
    if ('errors' in built) throw new Error(built.errors.join('; '));
    const manifest = formatManifest(built.manifest);
    const passkey = softPasskey(RP);
    const key = new PasskeyKeyPair(passkey);
    const allowed = path.join(dir, 'allowed_signers');
    fs.writeFileSync(allowed, (await allowedSignersLine(key, 'web@example.net')) + '\n');
    assert.match(fs.readFileSync(allowed, 'utf8'), /^web@example\.net namespaces="md-runbook" sk-ecdsa-sha2-nistp256@openssh\.com AAAA/);
    const signature = await signSshsig(key, manifest);
    assert.equal(passkey.signed, 1);
    assert.equal(await sshVerify(manifest, signature, allowed), 'web@example.net');
    await assert.rejects(sshVerify(manifest + ' ', signature, allowed));
  });

  it('refuses what sshd would refuse without saying why', async () => {
    const challenge = new Uint8Array([1, 2, 3]);
    const sign = (o: Parameters<typeof softPasskey>[1]) => softPasskey(RP, o).sign(challenge);
    await assert.rejects(async () => webauthnSignature(RP, challenge, await sign({ signedRpId: 'evil.example' })), /another site than runbook\.example\.net/);
    await assert.rejects(async () => webauthnSignature(RP, challenge, await sign({ reordered: true })), /order OpenSSH does not accept/);
    await assert.rejects(async () => webauthnSignature(RP, challenge, await sign({ flags: 0x45 })), /OpenSSH does not accept/);
    await assert.rejects(async () => webauthnSignature(RP, challenge, await sign({ origin: 'https://a"b' })), /no usable origin|not JSON/);
    // Another challenge than the one signed: the client data does not match.
    await assert.rejects(async () => webauthnSignature(RP, new Uint8Array([9]), await sign({})), /order OpenSSH does not accept/);
    assert.ok(webauthnSignature(RP, challenge, await sign({})).length > 100);
  });

  it('a malformed passkey is refused when the key pair is made', () => {
    assert.throws(() => new PasskeyKeyPair({ ...softPasskey(RP), publicKey: new Uint8Array(33) }), /uncompressed P-256/);
    assert.throws(() => new PasskeyKeyPair({ ...softPasskey(RP), rpId: 'a b' }), /not a relying party/);
  });
});
