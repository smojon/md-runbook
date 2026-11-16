/**
 * A whole-runbook signature (manifest version 2) and the front matter: every reader must see the
 * front matter that was signed, or the runbook isn't signed as a whole (security review, round 4).
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { LINE_RE } from '@md-runbook/core/lines';
import { parseFrontMatter } from '@md-runbook/core/secrets';
import { buildManifest, formatManifest, signedStatus, signedText, wholeRunbookSigned, withSignature } from '@md-runbook/core/signing';

const FM = '---\nkube-context: staging\nreport-runs: https://audit.example.com/runs\nreport-runs-required: true\nmode: isolated\nenv:\n  SAFE: 1\nparams:\n  - SVC: api # One of: api, web\n---\n';
const BODY = '# Restart\n\n```bash\nkubectl rollout restart deploy/${param:SVC}\n```\n';

function signed(): string {
  const orig = FM + BODY;
  const built = buildManifest(orig, { name: 'r', version: 1, scopes: [], patterns: { SVC: '^(api|web)$' } });
  if ('errors' in built) throw new Error(built.errors.join('\n'));
  return withSignature(orig, { signer: 'alice', signed: '2026-11-16', manifest: formatManifest(built.manifest), signature: 'AAAA' });
}

const whole = (t: string): boolean => wholeRunbookSigned(signedStatus(t)!);

describe('a whole-runbook signature and its front matter', () => {
  const s = signed();

  it('the runbook as signed: whole, with its front matter', () => {
    assert.equal(whole(s), true);
    const fm = parseFrontMatter(s)!;
    assert.deepEqual([fm.kubeContext, fm.reportRuns, fm.reportRunsRequired, fm.mode, { ...fm.env }], ['staging', 'https://audit.example.com/runs', true, 'isolated', { SAFE: '1' }]);
  });

  it('a lone CR ends a line, as in CommonMark: the front matter is read, and signedText is the same', () => {
    assert.deepEqual('a\r\nb\rc\nd'.split(LINE_RE), ['a', 'b', 'c', 'd']);
    for (const t of [s.replace(FM, FM.replace(/\n/g, '\r')), s.replace('---\nkube', '---\rkube')]) {
      assert.equal(parseFrontMatter(t)?.kubeContext, 'staging');
      assert.equal(parseFrontMatter(t)?.reportRunsRequired, true);
      assert.equal(whole(t), true);
    }
  });

  it('a note or a record block above the front matter: not signed as a whole', () => {
    for (const top of ['<!-- md-runbook:note -->\n', '<!-- md-runbook:record-signature v1 x\n-->\n', '<!-- md-runbook:note at=2026-11-16T10:00:00+01:00 -->\n> **10:00:** hi\n']) {
      const t = top + s;
      assert.equal(parseFrontMatter(t), undefined);
      assert.notEqual(signedText(t), signedText(s), JSON.stringify(top));
      assert.equal(whole(t), false, JSON.stringify(top));
    }
  });

  it('a note line inside env: or params: is not set aside (it ends the list)', () => {
    for (const t of [s.replace('env:\n', 'env:\n<!-- md-runbook:note -->\n'), s.replace('params:\n', 'params:\n<!-- md-runbook:note -->\n')]) {
      assert.notEqual(signedText(t), signedText(s));
      assert.equal(whole(t), false);
    }
  });

  it('the signature block above the front matter: not signed as a whole', () => {
    const block = /<!-- md-runbook:signature[\s\S]*?-->\n/.exec(s)![0];
    const t = block + s.replace(block, '');
    assert.equal(parseFrontMatter(t), undefined);
    assert.equal(whole(t), false);
  });

  it('notes and outputs after the front matter are still set aside', () => {
    const t = s.replace('```\n\n<!-- md-runbook:signature', '```\n\n<!-- md-runbook:note at=2026-11-16T10:00:00+01:00 -->\n> **10:00:** paged\n\n<!-- md-runbook:signature');
    assert.notEqual(t, s);
    assert.equal(whole(t), true);
  });
});
