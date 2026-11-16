/** Links in VS Code (src/signerCheck.ts): no ssh-keygen says so, instead of "not signed by a trusted signer". */
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import { buildManifest, formatManifest, withSignature } from '@md-runbook/core/signing';
import { SSH_KEYGEN_MISSING, checkSigner, sshKeygenMissing } from '../src/signerCheck';

const TEXT = '# Restart\n\n```bash\nsystemctl restart api\n```\n';
/** A signature block with a placeholder signature (no key involved). */
function signed(): string {
  const r = buildManifest(TEXT, { name: 'ops/restart', version: 2, scopes: [], patterns: {} }, { version: 2 });
  if ('errors' in r) throw new Error(r.errors.join('; '));
  return withSignature(TEXT, { signer: 'ops@example.net', signed: '2026-11-16', manifest: formatManifest(r.manifest), signature: 'U1NIU0lHAAAAAQ' + 'A'.repeat(150) });
}

describe('links: checking a signature', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdrb-signercheck-'));
  const signers = path.join(dir, 'allowed_signers');
  fs.writeFileSync(signers, '');
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const NONE = 'md-runbook-no-such-ssh-keygen';

  it('without ssh-keygen: "can\'t check signatures", not "not signed"', async () => {
    assert.equal(await sshKeygenMissing(NONE), true);
    assert.deepEqual(await checkSigner(signed(), signers, NONE), { cantCheck: SSH_KEYGEN_MISSING });
    assert.match(SSH_KEYGEN_MISSING, /ssh-keygen not found \(install OpenSSH\)/);
  });

  it('nothing to say for a runbook without a signature', async () => {
    assert.deepEqual(await checkSigner(TEXT, signers, NONE), {});
  });

  it('with ssh-keygen, a signature no trusted key made is just not trusted', async (t) => {
    if (await sshKeygenMissing()) return void t.diagnostic('no ssh-keygen here');
    assert.deepEqual(await checkSigner(signed(), signers), {});
  });
});
