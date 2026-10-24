/**
 * OpenSSH signatures (`ssh-keygen -Y sign`, PROTOCOL.sshsig) made with the app's own key, so the
 * app can sign and co-sign runbooks: md-runbook-gate checks them with `ssh-keygen -Y verify`
 * against its `allowed_signers`, as it checks signatures made in VS Code or on the command line.
 * The key signs through the SSH library, so a key in the Secure Enclave or Android Keystore
 * (ExternalKeyPair) signs inside the hardware.
 */
import { SIGNATURE_NAMESPACE, SIGNER_NAME_RE } from '@md-runbook/core/signing';
import { sha256Bytes } from '@md-runbook/core/sha256';
import type { KeyPair } from '@microsoft/dev-tunnels-ssh';
import { SshDataWriter } from '@microsoft/dev-tunnels-ssh';
import { Buffer } from 'buffer';
import { ECDSA_P256, ExternalAwareEcdsaP256 } from './externalKey';

const MAGIC = Buffer.from('SSHSIG', 'ascii');
/** SHA-256 of the message: PROTOCOL.sshsig allows sha256 and sha512, and ssh-keygen verifies both. */
const HASH = 'sha256';

const encode = (fill: (w: SshDataWriter) => void): Buffer => {
  const w = new SshDataWriter(Buffer.alloc(256));
  fill(w);
  return w.toBuffer();
};

/**
 * The SSHSIG blob, base64 (what the runbook's signature block keeps), of `message` signed with
 * `pair` (ECDSA P-256) in md-runbook's namespace.
 */
export async function signSshsig(pair: KeyPair, message: string, namespace: string = SIGNATURE_NAMESPACE): Promise<string> {
  if (pair.keyAlgorithmName !== ECDSA_P256) throw new Error(`signing needs an ECDSA P-256 key, not ${pair.keyAlgorithmName}`);
  const publicKey = await pair.getPublicKeyBytes();
  if (!publicKey) throw new Error('the key has no public half');
  const digest = Buffer.from(sha256Bytes(new TextEncoder().encode(message)));
  // What is signed: the preamble, the namespace, an empty reserved field, the hash and its name.
  const signed = Buffer.concat([
    MAGIC,
    encode((w) => {
      w.writeString(namespace, 'utf8');
      w.writeBinary(Buffer.alloc(0));
      w.writeString(HASH, 'ascii');
      w.writeBinary(digest);
    }),
  ]);
  const signer = new ExternalAwareEcdsaP256().createSigner(pair);
  let raw: Buffer;
  try {
    raw = await signer.sign(signed);
  } finally {
    signer.dispose();
  }
  const signature = encode((w) => {
    w.writeString(ECDSA_P256, 'ascii');
    w.writeBinary(raw);
  });
  const blob = Buffer.concat([
    MAGIC,
    encode((w) => {
      w.writeUInt32(1);
      w.writeBinary(publicKey);
      w.writeString(namespace, 'utf8');
      w.writeBinary(Buffer.alloc(0));
      w.writeString(HASH, 'ascii');
      w.writeBinary(signature);
    }),
  ]);
  return blob.toString('base64');
}

/**
 * The key's line for a server's `allowed_signers` (OpenSSH's format), for signatures in
 * md-runbook's namespace only: `principal namespaces="md-runbook" ecdsa-sha2-nistp256 AAAA…`.
 */
export async function allowedSignersLine(pair: KeyPair, principal: string): Promise<string> {
  if (!SIGNER_NAME_RE.test(principal)) throw new Error(`not a signer name: ${principal}`);
  const publicKey = await pair.getPublicKeyBytes();
  if (!publicKey) throw new Error('the key has no public half');
  return `${principal} namespaces="${SIGNATURE_NAMESPACE}" ${pair.keyAlgorithmName} ${publicKey.toString('base64')}`;
}
