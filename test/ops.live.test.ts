/**
 * The md-runbook ops host (apps/ops) as the app reaches it: the image's sshd and gate, kubectl
 * with the Pod's service account (or a mounted kubeconfig), the kube-context check. The Ops
 * workflow starts it in a kind cluster and sets:
 *
 *   MD_RUNBOOK_OPS_TEST=host:port:user     the forwarded SSH port
 *   MD_RUNBOOK_OPS_KEY                     the client's private key (PKCS#8 PEM, in authorized_keys)
 *   MD_RUNBOOK_OPS_HOST_PUB                the host key's .pub
 *   MD_RUNBOOK_OPS_SIGNER                  a signer's private key (in allowed_signers)
 *   MD_RUNBOOK_OPS_CONTEXT                 the context kubectl reports there
 *   MD_RUNBOOK_OPS_IN_CLUSTER=1            kubectl runs as the Pod's service account (RBAC checks)
 *
 * Skipped without them.
 */
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import { after, before, describe, it } from 'node:test';
import { RemoteSession, RemoteShell, hostKeyId, importPrivateKey } from '@md-runbook/ssh';
import { connectTcp } from '@md-runbook/ssh/node';
import { checkKubeContext } from '@md-runbook/core/kubeContext';
import { buildManifest, formatManifest } from '@md-runbook/core/signing';
import { sshSign } from '@md-runbook/core/node';
import type { KeyPair } from '@microsoft/dev-tunnels-ssh';

const spec = process.env.MD_RUNBOOK_OPS_TEST;
const [host = '', port = '0', user = ''] = (spec ?? '').split(':');
const context = process.env.MD_RUNBOOK_OPS_CONTEXT ?? '';
const inCluster = process.env.MD_RUNBOOK_OPS_IN_CLUSTER === '1';

describe('ops host', { skip: !spec && 'set MD_RUNBOOK_OPS_TEST to run' }, () => {
  let key: KeyPair;
  let pinned: string;
  let shell: RemoteShell;
  const open = () => connectTcp(host, Number(port));
  const opts = () => ({ username: user, key, verifyHostKey: (k: string) => hostKeyId(k) === pinned });
  /** Run unsigned text (the test's gate.conf allows it); stdout and the exit code. */
  const sh = async (text: string): Promise<{ code: number | null; out: string; err: string }> => {
    let out = '';
    let err = '';
    const r = await shell.run(text, { onStdout: (t) => (out += t), onStderr: (t) => (err += t), timeoutMs: 60_000 });
    return { code: r.exitCode, out, err };
  };

  before(async () => {
    key = await importPrivateKey(fs.readFileSync(process.env.MD_RUNBOOK_OPS_KEY!, 'utf8'));
    pinned = hostKeyId(fs.readFileSync(process.env.MD_RUNBOOK_OPS_HOST_PUB!, 'utf8'));
    shell = await RemoteShell.connect(await open(), opts());
  });
  after(() => shell?.close());

  it('every login goes to md-runbook-gate, whatever the client asks for', () => {
    assert.deepEqual(shell.gate, { protocol: 1, unsigned: 'allow' });
  });

  it('kube-context: the gate names the context, and the guard lets only that one through', async () => {
    let out = '';
    const r = await shell.kubeContext({ onStdout: (t) => (out += t) });
    assert.deepEqual([r.exitCode, out.trim()], [0, context]);
    const probe = async () => {
      let stdout = '';
      const p = await shell.kubeContext({ onStdout: (t) => (stdout += t) });
      return { exitCode: p.exitCode, stdout };
    };
    assert.equal(await checkKubeContext(context, probe), undefined);
    assert.match((await checkKubeContext('prod-eu', probe)) ?? '', new RegExp(`current context is ${context}: nothing ran`));
  });

  it('kubectl reaches the cluster', async () => {
    const r = await sh('kubectl get namespace kube-system -o name');
    assert.deepEqual([r.code, r.out], [0, 'namespace/kube-system\n'], r.err);
  });

  it('as the Pod\'s service account: restart and scale, but no deleting and no Secrets', { skip: !inCluster && 'not in a cluster' }, async () => {
    const can = await sh(
      'for v in "delete pods" "get secrets" "patch deployments" "update deployments --subresource=scale" "create pods --subresource=exec"; do kubectl auth can-i $v -n default; done',
    );
    assert.equal(can.out, 'no\nno\nyes\nyes\nno\n', can.err);
    const restart = await sh('kubectl -n default rollout restart deployment/web');
    assert.equal(restart.code, 0, restart.err);
    const del = await sh('kubectl -n default delete deployment web');
    assert.notEqual(del.code, 0);
    assert.match(del.err, /forbidden/i);
  });

  it('md-runbook-probe: DNS, TCP and the certificate, seen from inside the cluster', { skip: !inCluster && 'not in a cluster' }, async () => {
    const api = 'kubernetes.default.svc:443';
    const ca = '--ca /var/run/secrets/kubernetes.io/serviceaccount/ca.crt';
    const ok = await sh(`md-runbook-probe ${ca} ${api}`);
    assert.equal(ok.code, 0, ok.out + ok.err);
    assert.match(ok.out, /^OK +kubernetes\.default\.svc:443 +\S+, tcp \d+ms, certificate trusted, \d+ days left \(\d{4}-\d\d-\d\d\), CN=kube-apiserver/m);
    const untrusted = await sh(`md-runbook-probe ${api}`);
    assert.equal(untrusted.code, 1);
    assert.match(untrusted.out, /^FAIL .*certificate not trusted: /m);
    const soon = await sh(`md-runbook-probe ${ca} --days 100000 https://kubernetes.default.svc/healthz`);
    assert.match(soon.out, /^FAIL .*certificate expires in \d+ days .*under 100000/m);
    const down = await sh('md-runbook-probe --timeout 2 no-such-host.invalid kubernetes.default.svc:1; echo "exit $?"');
    assert.match(down.out, /^FAIL +no-such-host\.invalid:443 +no address/m);
    assert.match(down.out, /^FAIL +kubernetes\.default\.svc:1 +\S+, no TCP connection within 2s/m);
    assert.match(down.out, /exit 1\n$/);
    const piped = await sh(`echo "${api} ${api}" | md-runbook-probe --no-verify --ping -`);
    assert.equal(piped.code, 0, piped.out + piped.err);
    assert.equal((piped.out.match(/^OK /gm) ?? []).length, 2);
    assert.match(piped.out, /, (ping [\d.]+ms|ping not allowed here|no ping reply)\n/);
    // Nothing that openssl or ping could read as an option, no spaces or control characters.
    const bad = await sh(`printf '%s\\n' '-oProxyCommand=x:443' 'a;b' 'evil$(id).example' 'x:99999' | md-runbook-probe -`);
    assert.equal(bad.code, 1);
    assert.equal((bad.out.match(/ not a host name, address or URL$/gm) ?? []).length, 4, bad.out);
    assert.doesNotMatch(bad.out, /uid=/);
  });

  it('a signed run of the probe: its checks are in the gate\'s log, with the run\'s id', { skip: !inCluster && 'not in a cluster' }, async () => {
    const body = 'md-runbook-probe --ca /var/run/secrets/kubernetes.io/serviceaccount/ca.crt kubernetes.default.svc';
    const built = buildManifest('```bash\n' + body + '\n```\n', { name: 'ops/probe', version: 1, scopes: [], patterns: {} });
    if ('errors' in built) throw new Error(built.errors.join('; '));
    const manifest = formatManifest(built.manifest);
    const signature = await sshSign(manifest, process.env.MD_RUNBOOK_OPS_SIGNER!);
    const session = new RemoteSession(open, opts());
    try {
      let out = '';
      const r = await session.run('', { onStdout: (t) => (out += t) }, { manifest, signature, cell: 1 });
      assert.equal(r.exitCode, 0, out);
      assert.match(out, /^OK +kubernetes\.default\.svc:443 /m);
    } finally {
      await session.close();
    }
    // The workflow then finds the probe event with the run's id in the Pod's log.
  });

  it('a signed runbook runs through the image\'s gate (ssh-keygen -Y checks the signature)', async () => {
    const fence = (body: string): string => '```bash\n' + body + '\n```\n\n';
    const built = buildManifest(fence('kubectl get namespace default -o name'), { name: 'ops/ci', version: 1, scopes: [], patterns: {} });
    if ('errors' in built) throw new Error(built.errors.join('; '));
    const manifest = formatManifest(built.manifest);
    const signature = await sshSign(manifest, process.env.MD_RUNBOOK_OPS_SIGNER!);
    const session = new RemoteSession(open, opts());
    try {
      let out = '';
      const r = await session.run('', { onStdout: (t) => (out += t) }, { manifest, signature, cell: 1 });
      assert.deepEqual([r.exitCode, r.signedBy, out], [0, 'ci@example.net', 'namespace/default\n']);
    } finally {
      await session.close();
    }
  });
});
