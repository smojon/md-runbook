/** The app's signatures (OpenSSH SSHSIG made in TypeScript) checked by ssh-keygen, as md-runbook-gate checks them. */
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import { sshVerify } from '@md-runbook/core/node';
import { buildManifest, formatManifest } from '@md-runbook/core/signing';
import { ExternalKeyPair, allowedSignersLine, generateKey, signSshsig } from '@md-runbook/ssh';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';

const fence = (info: string, body: string): string => '```' + info + '\n' + body + '\n```\n\n';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdrb-sshsig-'));

describe('app signatures (SSHSIG) verify with ssh-keygen', () => {
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const built = buildManifest('# R\n\n' + fence('bash', 'systemctl restart api'), { name: 'ops/restart-api', version: 1, scopes: [], patterns: {} });
  if ('errors' in built) throw new Error(built.errors.join('; '));
  const manifest = formatManifest(built.manifest);

  it("a key made by the SSH library (the web, or a phone without secure hardware)", async () => {
    const key = await generateKey();
    const allowed = path.join(dir, 'allowed_signers');
    fs.writeFileSync(allowed, (await allowedSignersLine(key, 'phone@example.net')) + '\n');
    assert.match(fs.readFileSync(allowed, 'utf8'), /^phone@example\.net namespaces="md-runbook" ecdsa-sha2-nistp256 AAAA/);
    const signature = await signSshsig(key, manifest);
    assert.equal(await sshVerify(manifest, signature, allowed), 'phone@example.net');
    // Another text, or another namespace, doesn't verify.
    await assert.rejects(sshVerify(manifest + ' ', signature, allowed));
    await assert.rejects(sshVerify(manifest, await signSshsig(key, manifest, 'file'), allowed));
    // Names allowed_signers would read differently (a space, a quote, a list, a pattern) are refused.
    for (const bad of ['Stephane Mojon', 'x"y', 'a,b', 'ops*', '#me', '']) await assert.rejects(allowedSignersLine(key, bad), /not a signer name/);
  });

  it('a key whose private half signs elsewhere (Secure Enclave, Keystore: DER signatures)', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const point = publicKey.export({ format: 'jwk' });
    const xy = (v: string | undefined): Buffer => Buffer.from(v!, 'base64url');
    const key = await ExternalKeyPair.create({
      publicKey: new Uint8Array(Buffer.concat([Buffer.from([4]), xy(point.x), xy(point.y)])),
      sign: async (data) => new Uint8Array(nodeSign('sha256', data, privateKey)),
    });
    const allowed = path.join(dir, 'allowed_signers_hw');
    fs.writeFileSync(allowed, (await allowedSignersLine(key, 'reviewer@example.net')) + '\n');
    assert.equal(await sshVerify(manifest, await signSshsig(key, manifest), allowed), 'reviewer@example.net');
  });
});
