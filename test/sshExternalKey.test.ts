import { strict as assert } from 'node:assert';
import { KeyObject, generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { describe, it } from 'node:test';
import { Buffer } from 'buffer';
import { ExternalAwareEcdsaP256, ExternalKeyPair, ExternalP256Key, derToRs, publicKeyLine } from '@md-runbook/ssh';
import '@md-runbook/ssh/node';

/** A P-256 key held by Node's crypto, used the way the app uses the Secure Enclave or Keystore. */
function nodeExternalKey(): { external: ExternalP256Key; privateKey: KeyObject; signed: number } {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url')]);
  const holder = {
    privateKey,
    signed: 0,
    external: {
      publicKey: new Uint8Array(point),
      sign: async (data: Uint8Array) => {
        holder.signed++;
        return new Uint8Array(nodeSign('sha256', data, privateKey));
      },
    },
  };
  return holder;
}

describe('ssh: keys held outside JavaScript', () => {
  it('reads DER signatures', () => {
    const der = Uint8Array.from([0x30, 0x08, 0x02, 0x02, 0x00, 0x81, 0x02, 0x02, 0x01, 0x02]);
    const [r, s] = derToRs(der);
    assert.deepEqual([...r], [0x00, 0x81]);
    assert.deepEqual([...s], [0x01, 0x02]);
    assert.throws(() => derToRs(Uint8Array.from([0x30, 0x03, 0x02, 0x01])), /DER/);
    assert.throws(() => derToRs(Uint8Array.from([0x31, 0x00])), /DER/);
    assert.throws(() => derToRs(Uint8Array.from([...der, 0])), /DER/);
  });

  it('signs through the keystore; the library verifies the signature', async () => {
    const holder = nodeExternalKey();
    const key = await ExternalKeyPair.create(holder.external);
    assert.equal(key.keyAlgorithmName, 'ecdsa-sha2-nistp256');
    assert.equal(key.hasPrivateKey, true);
    assert.match(await publicKeyLine(key), /^ecdsa-sha2-nistp256 AAAA\S+ md-runbook$/);
    const alg = new ExternalAwareEcdsaP256();
    const data = Buffer.from('session data to sign');
    for (let i = 0; i < 20; i++) {
      // Different signatures: some r or s have a high bit (a leading zero in DER) and some don't.
      const sig = await alg.createSigner(key).sign(data);
      assert.equal(await alg.createVerifier(key).verify(data, sig), true);
      assert.equal(await alg.createVerifier(key).verify(Buffer.from('other data'), sig), false);
    }
    assert.equal(holder.signed, 20);
  });

  it('refuses a public key that is not an uncompressed P-256 point', async () => {
    await assert.rejects(ExternalKeyPair.create({ publicKey: new Uint8Array(33), sign: async () => new Uint8Array() }), /uncompressed/);
  });
});
