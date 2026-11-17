/** Trusted Signers… (src/allowedSigners.ts): reading, adding and removing allowed_signers lines. */
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { hasSigner, keyFingerprint, lineForKey, parsePublicKey, parseSignerLine, readSigners, signerLineToAdd, withLine, withoutSigner } from '../src/allowedSigners';

/** An ssh-ed25519 public key blob (its type, then 32 key bytes), base64. */
function edKey(seed: number): string {
  const type = Buffer.from('ssh-ed25519');
  const len = (n: number): Buffer => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n);
    return b;
  };
  return Buffer.concat([len(type.length), type, len(32), Buffer.alloc(32, seed)]).toString('base64');
}
const A = edKey(1);
const B = edKey(2);
const fp = (key: string): string => 'SHA256:' + createHash('sha256').update(Buffer.from(key, 'base64')).digest('base64').replace(/=+$/, '');

describe('allowed_signers lines', () => {
  it('reads a signer with its options and fingerprint (as ssh-keygen -l shows it)', () => {
    const s = parseSignerLine(`alice@example.net,bob@example.net namespaces="md-runbook,git",valid-before="20271231" ssh-ed25519 ${A} laptop`, 3);
    assert.ok(s && !('problem' in s));
    assert.deepEqual(s.principals, ['alice@example.net', 'bob@example.net']);
    assert.deepEqual(s.namespaces, ['md-runbook', 'git']);
    assert.equal(s.validBefore, '20271231');
    assert.equal(s.fingerprint, fp(A));
    assert.equal(keyFingerprint('ssh-rsa', A), undefined, 'the blob names its own type');
  });

  it('refuses lines md-runbook cannot use, with why', () => {
    const why = (l: string): string => {
      const r = parseSignerLine(l);
      return r && 'problem' in r ? r.problem : 'ok';
    };
    assert.match(why(`ops@example.net namespaces="git" ssh-ed25519 ${A}`), /other namespaces/);
    assert.match(why(`*@example.net cert-authority ssh-ed25519 ${A}`), /certificate authority/);
    assert.match(why(`ops@example.net no-touch-required ssh-ed25519 ${A}`), /doesn't know/);
    assert.match(why(`ops@example.net ssh-ed25519 AAAA`), /not a ssh-ed25519 key/);
    assert.match(why(`ssh-ed25519 ${A} alice@laptop`), /no signer name/);
    assert.equal(parseSignerLine('# a comment'), undefined);
    assert.equal(why(`ops@example.net namespaces="*,!git" ssh-ed25519 ${A}`), 'ok');
  });

  it('a line to add (pasted, from a file, a library) must name each signer: no principal patterns', () => {
    const adding = (l: string): string => {
      const r = parseSignerLine(l, 0, { adding: true });
      return r && 'problem' in r ? r.problem : 'ok';
    };
    for (const p of ['*', '*@example.net', 'ops@example.net,*', '!mallory,*', 'op?'])
      assert.match(adding(`${p} namespaces="md-runbook" ssh-ed25519 ${A}`), /not a signer's name/, p);
    assert.equal(adding(`alice@example.net,bob@example.net namespaces="md-runbook" ssh-ed25519 ${A}`), 'ok');
    assert.match(adding(`"ops team" namespaces="md-runbook" ssh-ed25519 ${A}`), /quote in the signer names/);
    // A library's allowed_signers: the pattern line is skipped, the named one kept.
    const lib = `* namespaces="md-runbook" ssh-ed25519 ${A}\nops@example.net namespaces="md-runbook" ssh-ed25519 ${B}\n`;
    const { signers, skipped } = readSigners(lib, { adding: true });
    assert.deepEqual([signers.map((s) => s.principals[0]), skipped.map((s) => s.line)], [['ops@example.net'], [0]]);
    // Your own file is still listed as written (ssh-keygen reads it as it is).
    assert.equal(readSigners(lib).signers.length, 2);
  });

  it('a line to add is written in canonical form: namespaces="md-runbook" when it has none', () => {
    const plain = parseSignerLine(`ops@example.net ssh-ed25519 ${A}`);
    assert.ok(plain && !('problem' in plain));
    assert.equal(signerLineToAdd(plain), `ops@example.net namespaces="md-runbook" ssh-ed25519 ${A}`);
    const dated = parseSignerLine(`ops@example.net valid-before="20271231" ssh-ed25519 ${A} laptop`);
    assert.ok(dated && !('problem' in dated));
    assert.equal(signerLineToAdd(dated), `ops@example.net namespaces="md-runbook",valid-before="20271231" ssh-ed25519 ${A}`);
    const own = parseSignerLine(`ops@example.net namespaces="md-runbook" ssh-ed25519 ${A}`);
    assert.ok(own && !('problem' in own));
    assert.equal(signerLineToAdd(own), own.raw);
  });

  it("read strictly, as OpenSSH reads it: escapes, stray quotes, unquoted values, odd blanks are refused (the review's line)", () => {
    const why = (l: string): string => {
      const r = parseSignerLine(l, 0, { adding: true });
      return r && 'problem' in r ? r.problem : 'ok';
    };
    // OpenSSH skips \" inside quotes: it reads the options up to the last quote and trusts B; a naive reader shows A.
    assert.match(why(`alice namespaces="md-runbook,\\" ssh-ed25519 ${A} x" ssh-ed25519 ${B}`), /backslash/);
    assert.match(why(`alice namespaces="md-runbook" ssh-ed25519 ${A} "x`), /quote outside/);
    assert.match(why(`al"ice namespaces="md-runbook" ssh-ed25519 ${A}`), /quote in the signer names/);
    assert.match(why(`alice namespaces="md-runbook"x ssh-ed25519 ${A}`), /quote outside|doesn't know/);
    assert.match(why(`alice namespaces="md-runbook ssh-ed25519 ${A}`), /quote outside|no public key/);
    assert.match(why(`alice namespaces=md-runbook ssh-ed25519 ${A}`), /needs quotes/);
    assert.match(why(`alice valid-before=20271231 ssh-ed25519 ${A}`), /needs quotes/);
    assert.match(why(`alice namespaces="md-runbook",namespaces="git" ssh-ed25519 ${A}`), /twice/);
    assert.match(why(`alice valid-before="tomorrow" ssh-ed25519 ${A}`), /YYYYMMDD/);
    assert.match(why(`alice namespaces="md-runbook" ssh-ed25519 ${A}`), /unusual blank/);
    assert.match(why(`alice‮ namespaces="md-runbook" ssh-ed25519 ${A}`), /control character/);
    assert.match(why(`alice namespaces="md-runbook" ssh-ed25519 ${A}\u0007`), /control character/);
    assert.equal(why(`alice\tnamespaces="md-runbook"\tssh-ed25519 ${A}`), 'ok', 'tabs are blanks to OpenSSH too');
    assert.equal(parsePublicKey(`ssh-ed25519 ${B} a\\b`), undefined);
    // The same rules for your own file's listing: such a line is listed as not used, to remove.
    const own = readSigners(`alice namespaces="md-runbook,\\" ssh-ed25519 ${A} x" ssh-ed25519 ${B}\n`);
    assert.deepEqual(own.signers, []);
    assert.match(own.skipped[0]!.raw, /^alice namespaces=/);
  });

  it('a public key (.pub) becomes a line for the name given', () => {
    const k = parsePublicKey(`ssh-ed25519 ${B} alice@laptop`);
    assert.ok(k);
    assert.equal(k.comment, 'alice@laptop');
    assert.equal(lineForKey('alice@example.net', k), `alice@example.net namespaces="md-runbook" ssh-ed25519 ${B}`, 'no comment');
    assert.equal(parsePublicKey(`alice ssh-ed25519 ${B}`), undefined);
  });

  it('adds at the end, notices a key already there, removes by the line as written', () => {
    let text = '# trusted\n';
    text = withLine(text, `ops@example.net namespaces="md-runbook" ssh-ed25519 ${A}`);
    text = withLine(text, `alice@example.net namespaces="md-runbook" ssh-ed25519 ${B}`);
    const { signers, skipped } = readSigners(text + `x cert-authority ssh-ed25519 ${A}\n`);
    assert.deepEqual(signers.map((s) => s.principals[0]), ['ops@example.net', 'alice@example.net']);
    assert.deepEqual(skipped.map((s) => s.line), [3]);
    assert.ok(hasSigner(text, { principals: ['ops@example.net'], keyType: 'ssh-ed25519', key: A }));
    assert.ok(!hasSigner(text, { principals: ['bob@example.net'], keyType: 'ssh-ed25519', key: A }));
    const removed = withoutSigner(text, signers[0]!);
    assert.equal(removed, `# trusted\nalice@example.net namespaces="md-runbook" ssh-ed25519 ${B}\n`);
    assert.equal(withoutSigner(removed!, signers[0]!), undefined, 'gone already');
    assert.equal(withLine('a', 'b'), 'a\nb\n');
    assert.equal(withLine('a\r\n', 'b'), 'a\r\nb\r\n');
  });
});
