import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { parseCellOptions } from '@md-runbook/core/cellOptions';
import { KUBE_CONTEXT_COMMAND, checkKubeContext, isKubeContextName, kubeContextRefusal, wantedKubeContext } from '@md-runbook/core/kubeContext';
import { lintRunbook } from '@md-runbook/core/lint';
import { parseFrontMatter } from '@md-runbook/core/secrets';

describe('kube-context guard', () => {
  it('reads kube-context: from the front matter and kube-context= from a cell, the cell winning', () => {
    const fm = parseFrontMatter('---\nkube-context: prod-eu # the EU cluster\n---\n');
    assert.equal(fm?.kubeContext, 'prod-eu');
    assert.equal(wantedKubeContext(parseCellOptions('bash'), fm), 'prod-eu');
    assert.equal(wantedKubeContext(parseCellOptions('bash kube-context=arn:aws:eks:eu-west-1:123:cluster/prod'), fm), 'arn:aws:eks:eu-west-1:123:cluster/prod');
    assert.equal(wantedKubeContext(parseCellOptions('bash'), undefined), undefined);
    assert.deepEqual(parseCellOptions('bash kube-context="two words"').errors, ['kube-context=two words: expected a Kubernetes context name']);
    assert.equal(parseFrontMatter('---\nkube-context: "two words"\n---\n')?.kubeContext, undefined);
    assert.ok(isKubeContextName('gke_my-project_europe-west1_prod'));
    assert.ok(!isKubeContextName(''));
  });

  it('lets a cell run only on the named context, and says why not otherwise', () => {
    assert.equal(kubeContextRefusal('prod-eu', { exitCode: 0, stdout: 'prod-eu\n' }), undefined);
    assert.match(
      kubeContextRefusal('prod-eu', { exitCode: 0, stdout: 'staging\n' }) ?? '',
      /context prod-eu, and kubectl's current context is staging: nothing ran\. Switch with `kubectl config use-context prod-eu`/,
    );
    assert.match(
      kubeContextRefusal('prod-eu', { exitCode: 1, stdout: '', stderr: 'error: current-context is not set\n' }) ?? '',
      /`kubectl config current-context` failed \(error: current-context is not set\): nothing ran/,
    );
    assert.match(kubeContextRefusal('prod-eu', { exitCode: 127, stdout: '', stderr: '' }) ?? '', /named no context/);
  });

  it('runs the check only when a context is wanted, and turns a thrown error into a refusal', async () => {
    let ran: string | undefined;
    assert.equal(await checkKubeContext(undefined, async (c) => ((ran = c), { exitCode: 0, stdout: '' })), undefined);
    assert.equal(ran, undefined);
    assert.equal(await checkKubeContext('prod-eu', async (c) => ((ran = c), { exitCode: 0, stdout: 'prod-eu' })), undefined);
    assert.equal(ran, KUBE_CONTEXT_COMMAND);
    assert.match(
      (await checkKubeContext('prod-eu', () => Promise.reject(new Error('the remote shell has ended')))) ?? '',
      /failed \(the remote shell has ended\)/,
    );
  });

  it('lint: an unusable kube-context is reported, a good one is not', () => {
    const bad = lintRunbook('---\nkube-context: two words\n---\n\n```bash kube-context=\necho\n```\n');
    assert.ok(bad.some((p) => /front matter kube-context: "two words" is ignored/.test(p.message)));
    assert.ok(bad.some((p) => /invalid cell option kube-context=/.test(p.message)));
    const good = lintRunbook('---\nkube-context: prod-eu\n---\n\n```bash kube-context=prod-us\necho\n```\n');
    assert.deepEqual(good.filter((p) => /kube-context/.test(p.message)), []);
  });
});
