import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { cellRefs, parseCellOptions } from '@md-runbook/core/cellOptions';
import {
  KUBE_CONTEXT_COMMAND,
  checkKubeContext,
  isKubeContextName,
  isKubeContextValue,
  kubeContextParam,
  kubeContextRefusal,
  resolveKubeContext,
  wantedKubeContext,
} from '@md-runbook/core/kubeContext';
import { lintRunbook } from '@md-runbook/core/lint';
import { parseFrontMatter } from '@md-runbook/core/secrets';
import { buildManifest } from '@md-runbook/core/signing';

describe('kube-context guard', () => {
  it('reads kube-context: from the front matter and kube-context= from a cell, the cell winning', () => {
    const fm = parseFrontMatter('---\nkube-context: prod-eu # the EU cluster\n---\n');
    assert.equal(fm?.kubeContext, 'prod-eu');
    assert.equal(wantedKubeContext(parseCellOptions('bash'), fm), 'prod-eu');
    assert.equal(wantedKubeContext(parseCellOptions('bash kube-context=arn:aws:eks:eu-west-1:123:cluster/prod'), fm), 'arn:aws:eks:eu-west-1:123:cluster/prod');
    assert.equal(wantedKubeContext(parseCellOptions('bash'), undefined), undefined);
    assert.deepEqual(parseCellOptions('bash kube-context="two words"').errors, ['kube-context=two words: expected a Kubernetes context name or ${param:NAME}']);
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

  it('kube-context from a parameter (${param:NAME}): read as written, filled in when the cell runs (issue #22)', () => {
    const fm = parseFrontMatter('---\nparams:\n  - CTX: rancher-desktop\nkube-context: ${param:CTX}\nkube-context-mode: pin\n---\n');
    assert.equal(fm?.kubeContext, '${param:CTX}');
    assert.equal(fm?.kubeContextMode, 'pin');
    assert.deepEqual(parseCellOptions('bash kube-context=${param:PROD}').errors, []);
    assert.equal(kubeContextParam(wantedKubeContext(parseCellOptions('bash'), fm)), 'CTX');
    assert.equal(kubeContextParam('prod-eu'), undefined);
    assert.ok(!isKubeContextValue('${param:CTX}x') && !isKubeContextValue('${input:CTX}') && isKubeContextValue('${param:CTX}'));

    assert.equal(resolveKubeContext('prod-eu', () => 'ignored'), 'prod-eu');
    assert.equal(resolveKubeContext(undefined, () => 'x'), undefined);
    assert.equal(resolveKubeContext('${param:CTX}', (n) => (n === 'CTX' ? 'ocpasni-test' : undefined)), 'ocpasni-test');
    assert.throws(() => resolveKubeContext('${param:CTX}', () => undefined), /kube-context \$\{param:CTX\} has no value: nothing ran/);
    // The value goes into kubectl's command line and the pinned kubeconfig: only a context name.
    assert.throws(() => resolveKubeContext('${param:CTX}', () => 'lab; rm -rf ~'), /is "lab; rm -rf ~", which is not a Kubernetes context name/);

    // Every block asks for it: the front matter's, or the block's own.
    assert.deepEqual(cellRefs('echo hi', 'bash', fm).map((r) => `${r.kind}:${r.name}`), ['param:CTX']);
    assert.deepEqual(cellRefs('echo hi', 'bash kube-context=${param:PROD}', fm).map((r) => r.name), ['PROD']);
    assert.throws(() => cellRefs('echo ${input:CTX}', 'bash', fm), /both input and param/);
  });

  it('lint: a kube-context parameter is a parameter like the others', () => {
    const declared = lintRunbook('---\nparams:\n  - CTX: lab\nkube-context: ${param:CTX}\nkube-context-mode: pin\n---\n\n```bash\necho\n```\n');
    assert.deepEqual(declared, []);
    const undeclared = lintRunbook('```bash kube-context=${param:PROD}\necho\n```\n');
    assert.deepEqual(undeclared.map((p) => p.message), ['${param:PROD} is not declared in the front matter params: (it has no default, and the command line needs --param PROD=…)']);
  });

  it('a signed block with kube-context=${param:NAME} needs a pattern for it', () => {
    const md = '# T\n\n```bash kube-context=${param:CTX}\nkubectl get pods\n```\n';
    const meta = { name: 't', version: 1, scopes: [], patterns: {} };
    const without = buildManifest(md, meta);
    assert.ok('errors' in without);
    assert.match(without.errors.join('\n'), /kube-context=\$\{param:CTX\} needs a pattern \(--pattern CTX=REGEX\)/);
    const signed = buildManifest(md, { ...meta, patterns: { CTX: 'rancher-desktop|ocpasni-test' } });
    assert.ok('manifest' in signed, JSON.stringify(signed));
    // The gate doesn't need the value (the code doesn't use it); the client checks it against the pattern.
    assert.deepEqual(signed.manifest.cells[0]?.needs, []);
  });

  it('lint: an unusable kube-context is reported, a good one is not', () => {
    const bad = lintRunbook('---\nkube-context: two words\n---\n\n```bash kube-context=\necho\n```\n');
    assert.ok(bad.some((p) => /front matter kube-context: "two words" is ignored/.test(p.message)));
    assert.ok(bad.some((p) => /invalid cell option kube-context=/.test(p.message)));
    const good = lintRunbook('---\nkube-context: prod-eu\n---\n\n```bash kube-context=prod-us\necho\n```\n');
    assert.deepEqual(good.filter((p) => /kube-context/.test(p.message)), []);
  });
});
