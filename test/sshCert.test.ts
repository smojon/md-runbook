/**
 * OpenSSH user certificates (packages/ssh/src/cert.ts): reading ssh-keygen's certificates
 * (test/fixtures/ssh-certs, signed by OpenSSH 9.7), the login algorithm names, and the wrapper
 * that attaches a certificate to a key the client has.
 */
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { Buffer } from 'buffer';
import { KeyPair, SshAlgorithms, SshSessionConfiguration } from '@microsoft/dev-tunnels-ssh';
import {
  CERT_TYPES,
  CertAlgorithm,
  CertKeyPair,
  certAlgorithms,
  certificateHint,
  certificateLine,
  certificateState,
  certificatesFirst,
  generateKey,
  keyFingerprint,
  parseCertificate,
} from '@md-runbook/ssh';
import { agentAlgorithms } from '@md-runbook/ssh/node';
import { FIXTURES } from './helpers';
import { testCertificate, testCertificateLine } from './sshCertFixture';

const fixture = (name: string): string => fs.readFileSync(path.join(FIXTURES, 'ssh-certs', name), 'utf8').trim();
const blobOf = (line: string): Buffer => Buffer.from(line.split(/\s+/)[1]!, 'base64');
/** ssh-keygen -lf test/fixtures/ssh-certs/ca.pub */
const CA = 'SHA256:/kQRJ26oVYVzCTwg+6GaOJosZfAgVHI2K0D0vJqQtO8';

describe('ssh: certificates', () => {
  it("reads ssh-keygen's user certificates of each key type", () => {
    for (const [name, type] of [
      ['ed25519', 'ssh-ed25519'],
      ['ecdsab256', 'ecdsa-sha2-nistp256'],
      ['ecdsab384', 'ecdsa-sha2-nistp384'],
      ['ecdsab521', 'ecdsa-sha2-nistp521'],
      ['rsab2048', 'ssh-rsa'],
    ] as const) {
      const c = parseCertificate(fixture(`${name}-cert.pub`));
      assert.equal(c.type, `${type}-cert-v01@openssh.com`, name);
      assert.equal(c.keyType, type, name);
      // The certified key is the plain key of the .pub file next to it.
      assert.ok(c.publicKey.equals(blobOf(fixture(`${name}.pub`))), name);
      assert.equal(c.caFingerprint, CA, name);
      assert.equal(c.comment, `user-${name}`, name);
      assert.ok(c.blob.equals(blobOf(fixture(`${name}-cert.pub`))));
      assert.equal(certificateLine(c), fixture(`${name}-cert.pub`));
    }
  });

  it('reads the key ID, principals, serial, dates, options and extensions', () => {
    // -I alice@example -n alice,deploy -V 20250101000000Z:20350101000000Z -z 42
    const ed = parseCertificate(fixture('ed25519-cert.pub'));
    assert.equal(ed.keyId, 'alice@example');
    assert.deepEqual(ed.principals, ['alice', 'deploy']);
    assert.equal(ed.serial, '42');
    assert.equal(ed.validAfter, Date.UTC(2025, 0, 1) / 1000);
    assert.equal(ed.validBefore, Date.UTC(2035, 0, 1) / 1000);
    assert.deepEqual(ed.criticalOptions, {});
    assert.ok(ed.extensions.includes('permit-pty'));
    // No -V: valid forever; the largest serial stays exact.
    const p256 = parseCertificate(fixture('ecdsab256-cert.pub'));
    assert.equal(p256.validAfter, 0);
    assert.equal(p256.validBefore, Infinity);
    assert.equal(p256.serial, '18446744073709551615');
    // -O force-command=/usr/bin/true -O source-address=10.0.0.0/8 -O clear -O permit-pty
    const p521 = parseCertificate(fixture('ecdsab521-cert.pub'));
    assert.deepEqual(p521.criticalOptions, { 'force-command': '/usr/bin/true', 'source-address': '10.0.0.0/8' });
    assert.deepEqual(p521.extensions, ['permit-pty']);
    // The blob alone reads the same (an agent lists blobs).
    assert.deepEqual(parseCertificate(ed.blob).keyId, 'alice@example');
  });

  it('refuses what is not a user certificate, with a reason', () => {
    assert.throws(() => parseCertificate(fixture('ed25519.pub')), /plain key \(ssh-ed25519\): use the …-cert\.pub file/);
    assert.throws(() => parseCertificate(fixture('host-cert.pub')), /host certificate/);
    assert.throws(() => parseCertificate('hello'), /…-cert\.pub/);
    assert.throws(() => parseCertificate('ssh-ed25519-cert-v01@openssh.com %%%'), /not base64/);
    const line = fixture('ed25519-cert.pub');
    assert.throws(() => parseCertificate(line.replace(/^\S+/, 'ecdsa-sha2-nistp256-cert-v01@openssh.com')), /the line says/);
    const blob = blobOf(line);
    assert.throws(() => parseCertificate(blob.subarray(0, blob.length - 10)), /cut short/);
    assert.throws(() => parseCertificate(Buffer.concat([blob, Buffer.from([0])])), /after the signature/);
    // Security-key certificates are left out.
    const skType = Buffer.from('sk-ssh-ed25519-cert-v01@openssh.com');
    const sk = Buffer.concat([Buffer.from([0, 0, 0, skType.length]), skType, Buffer.alloc(64)]);
    assert.throws(() => parseCertificate(sk), /type is not supported: sk-ssh-ed25519-cert-v01@openssh\.com/);
  });

  it('is valid, expiring (last quarter, at most a day), expired or not yet valid', () => {
    const day = 86400;
    const week = { validAfter: 1_000_000, validBefore: 1_000_000 + 7 * day };
    const at = (s: number): number => s * 1000;
    assert.equal(certificateState(week, at(999_999)), 'not-yet');
    assert.equal(certificateState(week, at(1_000_000)), 'valid');
    assert.equal(certificateState(week, at(week.validBefore - day - 1)), 'valid');
    assert.equal(certificateState(week, at(week.validBefore - day)), 'expiring');
    assert.equal(certificateState(week, at(week.validBefore)), 'expired');
    const hours8 = { validAfter: 0, validBefore: 8 * 3600 };
    assert.equal(certificateState(hours8, at(5 * 3600)), 'valid');
    assert.equal(certificateState(hours8, at(6 * 3600)), 'expiring');
    assert.equal(certificateState({ validAfter: 0, validBefore: Infinity }), 'valid');
    assert.equal(certificateState(parseCertificate(fixture('ecdsab384-cert.pub'))), 'expired');
  });

  it('login algorithms: the certificate type, RSA as rsa-sha2-512; signatures named as the plain key', () => {
    const config = new SshSessionConfiguration();
    agentAlgorithms(config);
    certAlgorithms(config);
    certAlgorithms(config); // twice adds nothing
    const certs = config.publicKeyAlgorithms.filter((a): a is CertAlgorithm => a instanceof CertAlgorithm);
    assert.deepEqual(
      certs.map((a) => [a.keyAlgorithmName, a.name, a.plain.name]),
      Object.entries(CERT_TYPES).map(([type, s]) => [type, s.login, s.signature]),
    );
    assert.equal(CERT_TYPES['ssh-rsa-cert-v01@openssh.com']!.login, 'rsa-sha2-512-cert-v01@openssh.com');
    assert.ok(!certs.some((a) => /ssh-rsa$|ssh-rsa-cert/.test(a.name)), 'never SHA-1');
    for (const a of certs) {
      const data = a.createSignatureData(Buffer.from('sig'));
      assert.equal(data.subarray(4, 4 + data.readUInt32BE(0)).toString(), a.plain.name);
    }
    // After the plain ones: a server is never asked for a host certificate first.
    const firstCert = config.publicKeyAlgorithms.findIndex((a) => a instanceof CertAlgorithm);
    assert.ok(config.publicKeyAlgorithms.slice(firstCert).every((a) => a instanceof CertAlgorithm));
    // The app's algorithms have no Ed25519: no Ed25519 certificates either.
    const app = new SshSessionConfiguration();
    certAlgorithms(app);
    assert.ok(!app.publicKeyAlgorithms.some((a) => a?.keyAlgorithmName === 'ssh-ed25519-cert-v01@openssh.com'));
    assert.ok(app.publicKeyAlgorithms.some((a) => a?.keyAlgorithmName === 'ecdsa-sha2-nistp256-cert-v01@openssh.com'));
  });

  it("a certificate on the client's own key: the login sends the certificate, the key signs", async () => {
    const key = await generateKey();
    const own = (await key.getPublicKeyBytes())!;
    const pair = await CertKeyPair.create(key, testCertificateLine(own, { keyId: 'mine' }));
    assert.equal(pair.keyAlgorithmName, 'ecdsa-sha2-nistp256-cert-v01@openssh.com');
    assert.equal(pair.comment, 'mine');
    assert.equal(pair.hasPrivateKey, true);
    assert.ok((await pair.getPublicKeyBytes('ecdsa-sha2-nistp256-cert-v01@openssh.com'))!.equals(pair.certificate.blob));
    const config = new SshSessionConfiguration();
    certAlgorithms(config);
    const alg = config.publicKeyAlgorithms.find((a) => a?.keyAlgorithmName === pair.keyAlgorithmName)!;
    assert.equal(alg.name, 'ecdsa-sha2-nistp256-cert-v01@openssh.com');
    const data = Buffer.from('login data');
    const sig = await alg.createSigner(pair).sign(data);
    const lib = SshAlgorithms.publicKey.ecdsaSha2Nistp256!;
    assert.equal(await lib.createVerifier(key).verify(data, sig), true);
    assert.throws(() => alg.createKeyPair(), /host certificates/);
  });

  it('refuses a certificate for another key', async () => {
    const key = await generateKey();
    const other = (await (await generateKey()).getPublicKeyBytes())!;
    await assert.rejects(CertKeyPair.create(key, testCertificateLine(other)), new RegExp(`for another key \\(${keyFingerprint(other).replace(/[+/]/g, '\\$&')}\\)`));
    await assert.rejects(CertKeyPair.create(key, fixture('ecdsab256-cert.pub')), /for another key/);
    // A key with no public half yet.
    const empty = { getPublicKeyBytes: async () => null } as unknown as KeyPair;
    await assert.rejects(CertKeyPair.create(empty, fixture('ecdsab256-cert.pub')), /for another key/);
  });

  it('certificates first, otherwise in order', () => {
    const k = (keyAlgorithmName: string) => ({ keyAlgorithmName });
    const list = [k('ssh-ed25519'), k('ssh-rsa'), k('ssh-ed25519-cert-v01@openssh.com'), k('ecdsa-sha2-nistp256'), k('ssh-rsa-cert-v01@openssh.com')];
    assert.deepEqual(
      certificatesFirst(list).map((x) => x.keyAlgorithmName),
      ['ssh-ed25519-cert-v01@openssh.com', 'ssh-rsa-cert-v01@openssh.com', 'ssh-ed25519', 'ssh-rsa', 'ecdsa-sha2-nistp256'],
    );
  });

  it('a failed login says when a certificate expired or is for another user', async () => {
    const key = await generateKey();
    const own = (await key.getPublicKeyBytes())!;
    const expired = await CertKeyPair.create(key, testCertificateLine(own, { keyId: 'old', validAfter: 0, validBefore: Date.UTC(2020, 0, 1) / 1000 }));
    assert.match(await certificateHint([key, expired], 'alice'), /^; the certificate "old" expired 2020-01-01T00:00:00\.000Z$/);
    const other = await CertKeyPair.create(key, testCertificateLine(own, { keyId: 'ops', principals: ['ops', 'deploy'] }));
    assert.equal(await certificateHint([other], 'alice'), '; the certificate "ops" is not for user alice (principals: ops, deploy)');
    assert.equal(await certificateHint([other], 'ops'), '');
    assert.equal(await certificateHint([key], 'alice'), '');
    // The test builder makes what ssh-keygen makes.
    assert.equal(parseCertificate(testCertificate(own, { certType: 1 })).keyType, 'ecdsa-sha2-nistp256');
  });
});
