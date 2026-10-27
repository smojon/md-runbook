/**
 * kube-context-mode: pin and git-bash-path-conversion: off: the variables a runbook's front matter
 * adds to its cells, lint, and real runs through the command line (bash, kubectl and Windows
 * skipped where missing).
 */
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { ShellSettings } from '@md-runbook/core';
import { checkKubeContext, kubePinCommand, kubePinRefusal, pinnedKubeconfig, pinnedKubeconfigList } from '@md-runbook/core/kubeContext';
import { lintRunbook } from '@md-runbook/core/lint';
import { KubeconfigPins, NO_PATH_CONVERSION, nodeShellEnv, resolveShell, runbookEnv, userKubeconfig } from '@md-runbook/core/node';
import { parseFrontMatter } from '@md-runbook/core/secrets';
import { runRunbook } from '../src/cli/run';

const settings: ShellSettings = { bashPath: process.env.MD_RUNBOOK_BASH };
const hasBash = resolveShell('bash', settings, nodeShellEnv()).ok;
const kubectl = nodeShellEnv().which('kubectl');

describe('front matter: kube-context-mode and git-bash-path-conversion', () => {
  it('reads the two keys, case-insensitively, and ignores other values', () => {
    const fm = parseFrontMatter('---\nkube-context: lab\nkube-context-mode: Pin # the lab\ngit-bash-path-conversion: off\n---\n');
    assert.equal(fm?.kubeContextMode, 'pin');
    assert.equal(fm?.gitBashPathConversion, 'off');
    assert.equal(parseFrontMatter('---\nkube-context-mode: check\ngit-bash-path-conversion: "on"\n---\n')?.kubeContextMode, 'check');
    const bad = parseFrontMatter('---\nkube-context-mode: always\ngit-bash-path-conversion: false\n---\n');
    assert.equal(bad?.kubeContextMode, undefined);
    assert.equal(bad?.gitBashPathConversion, undefined);
    // kube-context: is not read from kube-context-mode:.
    assert.equal(parseFrontMatter('---\nkube-context-mode: pin\n---\n')?.kubeContext, undefined);
  });

  it('lint: bad values, pin without a context, pin on a host or a practice host', () => {
    const bad = lintRunbook('---\nkube-context: lab\nkube-context-mode: always\ngit-bash-path-conversion: false\n---\n\n```bash\necho\n```\n');
    assert.ok(bad.some((p) => p.line === 2 && /front matter kube-context-mode: "always" is ignored \(expected check or pin\)/.test(p.message)));
    assert.ok(bad.some((p) => p.line === 3 && /front matter git-bash-path-conversion: "false" is ignored \(expected on or off\)/.test(p.message)));

    const good = lintRunbook('---\nkube-context: lab\nkube-context-mode: pin\ngit-bash-path-conversion: off\n---\n\n```bash\necho\n```\n');
    assert.deepEqual(good, []);
    // A context on a cell is enough.
    assert.deepEqual(lintRunbook('---\nkube-context-mode: pin\n---\n\n```bash kube-context=lab\necho\n```\n'), []);

    const none = lintRunbook('---\ntitle: x\nkube-context-mode: pin\n---\n\n```bash\necho\n```\n');
    assert.ok(none.some((p) => p.line === 2 && /kube-context-mode: pin has no effect/.test(p.message)));

    const host = lintRunbook('---\nkube-context: lab\nkube-context-mode: pin\n---\n\n```bash host=ops-1\nkubectl get pods\n```\n\n```bash\necho local\n```\n');
    const onHost = host.filter((p) => /doesn't apply on the host ops-1/.test(p.message));
    assert.equal(onHost.length, 1);
    assert.equal(onHost[0]!.severity, 'warning');
    assert.equal(onHost[0]!.cell?.index, 1);
    assert.match(onHost[0]!.message, /current context must already be lab \(only checked\)/);
    // In check mode a host= cell is fine (the check runs there).
    assert.deepEqual(lintRunbook('---\nkube-context: lab\n---\n\n```bash host=ops-1\nkubectl get pods\n```\n'), []);

    const practice = lintRunbook('---\nkube-context: lab\nkube-context-mode: pin\npractice: training-1\n---\n\n```bash\necho\n```\n');
    assert.ok(practice.some((p) => /doesn't apply on the practice host training-1/.test(p.message)));
  });
});

describe('kube-context-mode: pin', () => {
  it('the pin file holds the current context and nothing else', () => {
    const text = pinnedKubeconfig('arn:aws:eks:eu-west-1:123:cluster/lab');
    assert.match(text, /^apiVersion: v1$/m);
    assert.match(text, /^kind: Config$/m);
    assert.match(text, /^current-context: "arn:aws:eks:eu-west-1:123:cluster\/lab"$/m);
    assert.match(text, /^clusters: \[\]$/m);
    assert.match(text, /^users: \[\]$/m);
    assert.doesNotMatch(text, /token|server|certificate/i);
  });

  it('KUBECONFIG is the pin file, then your list, with the platform separator', () => {
    assert.equal(pinnedKubeconfigList('/tmp/p/pin-1.kubeconfig', '/home/me/a:/home/me/b', 'linux'), '/tmp/p/pin-1.kubeconfig:/home/me/a:/home/me/b');
    assert.equal(pinnedKubeconfigList('C:\\t\\pin-1.kubeconfig', 'C:\\a;D:\\b', 'win32'), 'C:\\t\\pin-1.kubeconfig;C:\\a;D:\\b');
  });

  it('your list is $KUBECONFIG, else ~/.kube/config (on Windows the home client-go picks)', () => {
    assert.equal(userKubeconfig({ KUBECONFIG: '/a:/b', HOME: '/home/me' }, 'linux'), '/a:/b');
    assert.equal(userKubeconfig({ HOME: '/home/me' }, 'linux'), '/home/me/.kube/config');
    assert.equal(userKubeconfig({ HOME: '/home/me', KUBECONFIG: '' }, 'darwin'), '/home/me/.kube/config');
    // Windows: the variable's case doesn't matter.
    assert.equal(userKubeconfig({ KubeConfig: 'C:\\k\\a;C:\\k\\b' }, 'win32'), 'C:\\k\\a;C:\\k\\b');
    const env = { HOME: 'H:\\', HOMEDRIVE: 'C:', HOMEPATH: '\\Users\\me', USERPROFILE: 'C:\\Users\\profile' };
    assert.equal(userKubeconfig(env, 'win32', (f) => f === 'C:\\Users\\me\\.kube\\config'), 'C:\\Users\\me\\.kube\\config');
    assert.equal(userKubeconfig(env, 'win32', (f) => f === 'H:\\.kube\\config'), 'H:\\.kube\\config');
    assert.equal(userKubeconfig(env, 'win32', () => false), 'C:\\Users\\profile\\.kube\\config');
  });

  it('pin files: one per context, 0600 in a private folder, rewritten each time, removed by dispose', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mdrb-pins-'));
    try {
      const pins = new KubeconfigPins(tmp);
      const lab = pins.file('lab');
      const prod = pins.file('prod-eu');
      assert.notEqual(lab, prod);
      assert.equal(path.dirname(lab), path.dirname(prod));
      assert.equal(fs.readFileSync(lab, 'utf8'), pinnedKubeconfig('lab'));
      if (process.platform !== 'win32') {
        assert.equal(fs.statSync(lab).mode & 0o777, 0o600);
        assert.equal(fs.statSync(path.dirname(lab)).mode & 0o777, 0o700);
      }
      // A use-context in a cell changed the file: the next cell starts on its context again.
      fs.writeFileSync(lab, 'current-context: prod-eu\n');
      assert.equal(pins.file('lab'), lab);
      assert.equal(fs.readFileSync(lab, 'utf8'), pinnedKubeconfig('lab'));
      // A temp cleaner removed the folder: a new one.
      fs.rmSync(path.dirname(lab), { recursive: true, force: true });
      const again = pins.file('lab');
      assert.ok(fs.existsSync(again));
      pins.dispose();
      assert.ok(!fs.existsSync(path.dirname(again)));
      pins.dispose(); // twice is fine
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('runbookEnv: pins only in pin mode, with pins allowed; a cell for no context gets your own list', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mdrb-pins-'));
    const pins = new KubeconfigPins(tmp);
    try {
      const pin = parseFrontMatter('---\nkube-context: lab\nkube-context-mode: pin\n---\n');
      const env = { KUBECONFIG: '/home/me/.kube/config:/home/me/.kube/lab' };
      const r = runbookEnv({ language: 'bash', frontMatter: pin, kubeContext: 'lab', env, pins, platform: 'linux' });
      assert.equal(r.pinned, true);
      const pinFile = pins.file('lab');
      assert.equal(r.env.KUBECONFIG, `${pinFile}:/home/me/.kube/config:/home/me/.kube/lab`);
      assert.equal(fs.readFileSync(pinFile, 'utf8'), pinnedKubeconfig('lab'));
      const win = runbookEnv({ language: 'bash', frontMatter: pin, kubeContext: 'lab', env: { KUBECONFIG: 'C:\\k\\a;D:\\b' }, pins, platform: 'win32' });
      assert.equal(win.env.KUBECONFIG, `${pinFile};C:\\k\\a;D:\\b`);
      // Every shell gets it (cmd and PowerShell too); no MSYS variables without the option.
      for (const language of ['pwsh', 'cmd']) assert.equal(runbookEnv({ language, frontMatter: pin, kubeContext: 'lab', env, pins, platform: 'linux' }).pinned, true);
      assert.equal(r.env.MSYS_NO_PATHCONV, undefined);

      const noContext = runbookEnv({ language: 'bash', frontMatter: pin, kubeContext: undefined, env, pins, platform: 'linux' });
      assert.deepEqual(noContext, { env: { KUBECONFIG: env.KUBECONFIG }, pinned: false });
      // Pinning turned off (the setting), or check mode: nothing is added, the context is checked.
      assert.deepEqual(runbookEnv({ language: 'bash', frontMatter: pin, kubeContext: 'lab', env, pins: undefined, platform: 'linux' }), { env: {}, pinned: false });
      const check = parseFrontMatter('---\nkube-context: lab\n---\n');
      assert.deepEqual(runbookEnv({ language: 'bash', frontMatter: check, kubeContext: 'lab', env, pins, platform: 'linux' }), { env: {}, pinned: false });
      assert.deepEqual(runbookEnv({ language: 'bash', frontMatter: undefined, kubeContext: undefined, env, pins, platform: 'linux' }), { env: {}, pinned: false });
    } finally {
      pins.dispose();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('the pinned check: the context must exist and be current', async () => {
    const table = (current: boolean): string =>
      `CURRENT   NAME      CLUSTER   AUTHINFO   NAMESPACE\n${current ? '*' : ' '}         lab       c2        u\n`;
    assert.equal(kubePinCommand('lab'), 'kubectl config get-contexts lab');
    assert.equal(kubePinRefusal('lab', { exitCode: 0, stdout: table(true) }), undefined);
    assert.match(kubePinRefusal('lab', { exitCode: 0, stdout: table(false) }) ?? '', /pins the Kubernetes context lab, and kubectl's current context in the cell is another one/);
    assert.match(
      kubePinRefusal('lab', { exitCode: 1, stdout: '', stderr: 'error: context lab not found\n' }) ?? '',
      /^md-runbook: this runbook pins the Kubernetes context lab, and your kubeconfig has no context lab \(error: context lab not found\): nothing ran\./,
    );
    assert.match(kubePinRefusal('lab', { exitCode: null, stdout: '', stderr: 'kubectl: command not found' }) ?? '', /`kubectl config get-contexts lab` failed \(kubectl: command not found\)/);
    let ran: string | undefined;
    assert.equal(await checkKubeContext('lab', async (c) => ((ran = c), { exitCode: 0, stdout: table(true) }), true), undefined);
    assert.equal(ran, 'kubectl config get-contexts lab');
  });
});

describe('git-bash-path-conversion: off', () => {
  const off = parseFrontMatter('---\ngit-bash-path-conversion: off\n---\n');

  it('sets the MSYS variables for bash cells on Windows only', () => {
    const r = (language: string, platform: NodeJS.Platform, fm: typeof off = off) => runbookEnv({ language, frontMatter: fm, kubeContext: undefined, env: {}, pins: undefined, platform }).env;
    assert.deepEqual(r('bash', 'win32'), { MSYS_NO_PATHCONV: '1', MSYS2_ARG_CONV_EXCL: '*' });
    assert.deepEqual(r('sh', 'win32'), NO_PATH_CONVERSION);
    assert.deepEqual(r('pwsh', 'win32'), {});
    assert.deepEqual(r('cmd', 'win32'), {});
    assert.deepEqual(r('bash', 'linux'), {});
    assert.deepEqual(r('bash', 'darwin'), {});
    assert.deepEqual(r('bash', 'win32', parseFrontMatter('---\ngit-bash-path-conversion: on\n---\n')), {});
    assert.deepEqual(runbookEnv({ language: 'bash', frontMatter: undefined, kubeContext: undefined, env: {}, pins: undefined, platform: 'win32' }).env, {});
  });
});

/** Run a runbook through the command line with `env` added to this process's environment. */
async function runWith(md: string, env: Record<string, string>): Promise<Awaited<ReturnType<typeof runRunbook>> & { printed: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdrb-env-'));
  const file = path.join(dir, 'r.md');
  fs.writeFileSync(file, md);
  const lines: string[] = [];
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    const r = await runRunbook(
      { file, write: true, params: {}, inputs: {}, yes: true, keepGoing: true, shell: settings, env: process.env },
      { out: (t) => lines.push(t), log: (l) => lines.push(l + '\n') },
    );
    return { ...r, printed: lines.join('') };
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

describe('kube-context-mode: pin with kubectl', { skip: (!hasBash && 'bash not installed') || (!kubectl && 'kubectl not installed') }, () => {
  /** A kubeconfig with two contexts whose default is prod (the user's), and a lab. No server is contacted. */
  const fixture = (): { dir: string; file: string } => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdrb-kube-'));
    const file = path.join(dir, 'config');
    fs.writeFileSync(
      file,
      [
        'apiVersion: v1',
        'kind: Config',
        'clusters:',
        '- name: c-prod',
        '  cluster: {server: "https://127.0.0.1:1"}',
        '- name: c-lab',
        '  cluster: {server: "https://127.0.0.1:2"}',
        'users:',
        '- name: u',
        '  user: {token: not-a-real-token}',
        'contexts:',
        '- name: prod',
        '  context: {cluster: c-prod, user: u}',
        '- name: lab',
        '  context: {cluster: c-lab, user: u}',
        'current-context: prod',
        '',
      ].join('\n'),
    );
    return { dir, file };
  };

  for (const mode of ['isolated', 'session'] as const) {
    it(`${mode}: cells run on the pinned context, your default stays, use-context only changes the pin file`, async () => {
      const k = fixture();
      try {
        const md = [
          '---', `mode: ${mode}`, 'kube-context-mode: pin', '---', '',
          // The first line is the context; use-context then changes only the pin file.
          '```bash kube-context=lab expect=/^lab$/m', 'kubectl config current-context', 'echo "$KUBECONFIG"', 'kubectl config use-context prod', '```', '',
          // The next cell starts on its context again.
          '```bash kube-context=lab expect=/^lab$/m', 'kubectl config current-context', '```', '',
          // A cell for no context: your own default, also in a session that had a pin.
          '```bash expect=/^prod$/m', 'kubectl config current-context', '```', '',
          '```bash kube-context=nope', 'echo never-runs', '```', '',
        ].join('\n');
        const r = await runWith(md, { KUBECONFIG: k.file });
        assert.deepEqual(r.steps.map((s) => s.status), ['passed', 'passed', 'passed', 'failed'], r.printed);
        assert.match(r.text, /your kubeconfig has no context nope/);
        assert.doesNotMatch(r.printed, /never-runs\n/);
        // The user's kubeconfig still says prod: use-context wrote to the pin file.
        assert.match(fs.readFileSync(k.file, 'utf8'), /^current-context: prod$/m);
        // KUBECONFIG was the pin file, then the user's list; the pin folder is gone after the run.
        const pinned = r.steps[0]!.output.trim().split(/\r?\n/)[1]!;
        const [pinFile, ...rest] = pinned.split(path.delimiter);
        assert.deepEqual(rest, [k.file]);
        assert.match(path.basename(pinFile!), /^pin-\d+\.kubeconfig$/);
        assert.ok(!fs.existsSync(pinFile!), 'the pin file is removed after the run');
      } finally {
        fs.rmSync(k.dir, { recursive: true, force: true });
      }
    });
  }

  it('check mode is unchanged: the cell refuses while the current context is another one', async () => {
    const k = fixture();
    try {
      const r = await runWith(['---', 'kube-context: lab', '---', '', '```bash', 'echo never-runs', '```', ''].join('\n'), { KUBECONFIG: k.file });
      assert.equal(r.steps[0]!.status, 'failed', r.printed);
      assert.match(r.text, /Kubernetes context lab, and kubectl's current context is prod: nothing ran/);
    } finally {
      fs.rmSync(k.dir, { recursive: true, force: true });
    }
  });
});

describe('git-bash-path-conversion: off in Git Bash', { skip: (process.platform !== 'win32' && 'Windows only') || (!hasBash && 'bash not installed') }, () => {
  // node.exe is a Windows program: Git Bash rewrites /opt/x into its own folder when it starts it.
  const md = (fm: string, mode: string) =>
    ['---', `mode: ${mode}`, fm, '---', '', '```bash', '"$MDRB_NODE" -e "console.log(process.argv[1])" /opt/x', '```', ''].join('\n');

  for (const mode of ['isolated', 'session']) {
    it(`${mode}: /opt/x reaches a Windows program unchanged only with the option`, async () => {
      const node = { MDRB_NODE: process.execPath.replace(/\\/g, '/') };
      const off = await runWith(md('git-bash-path-conversion: off', mode), node);
      assert.equal(off.steps[0]!.output.trim(), '/opt/x', off.printed);
      const on = await runWith(md('title: default', mode), node);
      assert.notEqual(on.steps[0]!.output.trim(), '/opt/x', on.printed);
      assert.match(on.steps[0]!.output.trim(), /opt[\\/]x$/);
    });
  }
});
