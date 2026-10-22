/**
 * apps/gate/md-runbook-gate, the forced command of restricted keys, driven the way sshd starts
 * it: its line protocol on stdin, SSH_ORIGINAL_COMMAND for the stop request. Real ssh-keygen
 * signatures. Runs with /bin/sh (dash on Linux, bash's sh on macOS); on Windows only when
 * MD_RUNBOOK_GATE_SH names a POSIX sh (e.g. Git for Windows' dash.exe).
 */
import { strict as assert } from 'node:assert';
import { ChildProcess, execFileSync, spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Manifest, ManifestMeta, buildManifest, formatManifest, toBase64 } from '@md-runbook/core/signing';
import { manifestHash, sshSign } from '@md-runbook/core/node';

const GATE = path.resolve(__dirname, '..', '..', 'apps', 'gate', 'md-runbook-gate');
const SH = process.env.MD_RUNBOOK_GATE_SH ?? (process.platform === 'win32' ? '' : '/bin/sh');

const fence = (info: string, body: string): string => '```' + info + '\n' + body + '\n```\n\n';

/** pkill is on every Linux and macOS server, not in Git for Windows. */
const hasPkill = (): boolean => !!SH && /^\//.test(spawnSync(SH, ['-c', 'command -v pkill'], { encoding: 'utf8' }).stdout ?? '');

interface Reply {
  code: number;
  out: string;
  err: string;
}

/** One gate process: a session, or a stop request (`command`). */
class Gate {
  readonly child: ChildProcess;
  private out = '';
  private err = '';
  private waiters: (() => void)[] = [];
  readonly exited: Promise<number | null>;
  private n = 0;

  constructor(args: string[], env: Record<string, string>, command = 'bash -l') {
    this.child = spawn(SH, [GATE, ...args], { env: { ...process.env, ...env, SSH_ORIGINAL_COMMAND: command }, stdio: 'pipe' });
    this.child.stdout!.on('data', (d: Buffer) => this.got('out', d.toString('utf8')));
    this.child.stderr!.on('data', (d: Buffer) => this.got('err', d.toString('utf8')));
    this.exited = new Promise((r) => this.child.on('close', (code) => r(code)));
  }

  private got(stream: 'out' | 'err', text: string): void {
    this[stream] += text;
    for (const w of this.waiters.splice(0)) w();
  }

  /** Text and exit code of request `id`, once its marker arrived on both streams. */
  async reply(id: string): Promise<Reply> {
    const re = new RegExp(`\\x1e__MDRB_${id}__ (\\S+)\\n`);
    const deadline = Date.now() + 20_000;
    for (;;) {
      const o = re.exec(this.out);
      const e = re.exec(this.err);
      if (o && e) {
        const r = { code: Number(o[1]), out: this.out.slice(0, o.index), err: this.err.slice(0, e.index) };
        this.out = this.out.slice(o.index + o[0].length);
        this.err = this.err.slice(e.index + e[0].length);
        return r;
      }
      if (Date.now() > deadline) throw new Error(`no reply to ${id}; stdout ${JSON.stringify(this.out)} stderr ${JSON.stringify(this.err)}`);
      await new Promise<void>((r) => {
        const t = setTimeout(r, 200);
        this.waiters.push(() => {
          clearTimeout(t);
          r();
        });
      });
    }
  }

  /** Send `verb … ` with a fresh id; resolves with the reply. */
  request(verb: string, ...args: string[]): Promise<Reply> {
    const id = (++this.n).toString(16).padStart(8, '0');
    this.child.stdin!.write([verb, id, ...args].join(' ') + '\n');
    return this.reply(id);
  }

  hello(): Promise<Reply> {
    const id = 'feed' + (++this.n).toString(16).padStart(4, '0');
    this.child.stdin!.write(`: mdrb-gate-hello ${id}; printf '\\036%s %s\\n' __MDRB_${id}__ "$$" >&2; printf '\\036%s %s\\n' __MDRB_${id}__ "$$"\n`);
    return this.reply(id);
  }

  async close(): Promise<number | null> {
    this.child.stdin!.end();
    return this.exited;
  }
}

describe('md-runbook-gate', { skip: !SH && 'no POSIX sh (set MD_RUNBOOK_GATE_SH)' }, () => {
  let dir: string;
  let conf: string;
  let key: string;
  let otherKey: string;
  const gates: Gate[] = [];
  const env = (): Record<string, string> => ({ HOME: dir, TMPDIR: dir });
  const start = (...args: string[]): Gate => {
    const g = new Gate([`--config=${conf}`, ...args], env());
    gates.push(g);
    return g;
  };
  const writeConf = (lines: string[]): void =>
    fs.writeFileSync(conf, [`allowed_signers = ${path.join(dir, 'allowed_signers')}`, `log = ${path.join(dir, 'gate.log')}`, ...lines].join('\n') + '\n');
  const meta = (m: Partial<ManifestMeta> = {}): ManifestMeta => ({ name: 'ops/test', version: 1, scopes: [], patterns: {}, ...m });
  const manifestOf = (text: string, m: Partial<ManifestMeta> = {}): Manifest => {
    const r = buildManifest(text, meta(m));
    if ('errors' in r) throw new Error(r.errors.join('; '));
    return r.manifest;
  };
  const signed = async (text: string, m: Partial<ManifestMeta> = {}, withKey = key): Promise<[string, string, string]> => {
    const manifest = formatManifest(manifestOf(text, m));
    return [toBase64(manifest), await sshSign(manifest, withKey), manifestHash(manifest)];
  };

  const RUNBOOK =
    fence('bash', 'X=kept; cd /; echo "one $X"') +
    fence('bash env.GREETING=hello cwd=/tmp', 'echo "$GREETING from $(basename "$PWD") $X"') +
    fence('bash', 'echo a\necho b\necho c') +
    fence('bash lines=any', 'echo first\necho second') +
    fence('bash', 'echo "target=${param:TARGET}"');
  const PATTERNS = { TARGET: '[a-z][a-z0-9-]{0,30}' };

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdrb-gate-'));
    conf = path.join(dir, 'gate.conf');
    key = path.join(dir, 'signer');
    otherKey = path.join(dir, 'stranger');
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'ops@example.net', '-f', key]);
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'stranger', '-f', otherKey]);
    const pub = fs.readFileSync(key + '.pub', 'utf8').trim().split(' ').slice(0, 2).join(' ');
    fs.writeFileSync(path.join(dir, 'allowed_signers'), `ops@example.net,release@example.net namespaces="md-runbook" ${pub}\n`);
    writeConf([]);
  });
  after(() => {
    for (const g of gates) g.child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('answers the hello with its banner and the pid of the shell the cells run in', async () => {
    const g = start();
    const r = await g.hello();
    assert.match(r.out, /\x1e__MDRB_GATE__ 1 unsigned=refuse\n/);
    assert.ok(r.code > 1, `pid ${r.code}`);
    assert.equal(await g.close(), 0);
  });

  it('runs signed cells in one shell: state, env.* and cwd= carry over as in a session', async () => {
    const g = start();
    await g.hello();
    const [m, s, hash] = await signed(RUNBOOK, { patterns: PATTERNS });
    const load = await g.request('load', m, s);
    assert.equal(load.code, 0, load.err);
    assert.match(load.out, new RegExp(`\\x1e__MDRB_SIGNED__ ops@example.net ${hash}\\n`));
    const one = await g.request('run', '1');
    assert.deepEqual([one.code, one.out], [0, 'one kept\n']);
    const two = await g.request('run', '2');
    assert.deepEqual([two.code, two.out], [0, 'hello from tmp kept\n']);
    const back = await g.request('step', '3', '0');
    assert.deepEqual([back.code, back.out], [0, 'a\n']);
    await g.close();
    const log = fs.readFileSync(path.join(dir, 'gate.log'), 'utf8');
    assert.match(log, /"event":"load".*"runbook":"ops\/test".*"signer":"ops@example.net"/);
    assert.match(log, /"event":"run".*"cell":"2"/);
    assert.match(log, /"event":"end".*"exit":0/);
  });

  it('refuses a changed manifest, a stranger\'s signature and unsigned text (by default)', async () => {
    const g = start();
    await g.hello();
    const manifest = formatManifest(manifestOf(RUNBOOK, { patterns: PATTERNS }));
    const sig = await sshSign(manifest, key);
    const changed = await g.request('load', toBase64(manifest.replace('version 1', 'version 2')), sig);
    assert.equal(changed.code, 126);
    assert.match(changed.err, /not from a trusted signer \(or the runbook was changed after signing\)/);
    const stranger = await g.request('load', toBase64(manifest), await sshSign(manifest, otherKey));
    assert.equal(stranger.code, 126);
    const run = await g.request('run', '1');
    assert.match(run.err, /no signed runbook loaded/);
    const raw = await g.request('raw', toBase64('echo nope\n'));
    assert.equal(raw.code, 126);
    assert.match(raw.err, /runs signed runbooks only/);
    assert.equal(raw.out, '');
    await g.close();
  });

  it('runs unsigned text where the key allows it', async () => {
    const g = start('--unsigned=allow');
    const hello = await g.hello();
    assert.match(hello.out, /unsigned=allow/);
    const id = 'abcdef01';
    g.child.stdin!.write(`raw 00000099 ${toBase64(`echo unsigned-ok; printf '\\036%s %s\\n' __MDRB_${id}__ 0 >&2; printf '\\036%s %s\\n' __MDRB_${id}__ 0\n`)}\n`);
    const r = await g.reply(id);
    assert.deepEqual([r.code, r.out], [0, 'unsigned-ok\n']);
    await g.close();
    assert.match(fs.readFileSync(path.join(dir, 'gate.log'), 'utf8'), /"event":"unsigned"/);
  });

  it('parameters: every one needs a value, and the value must match its signed pattern', async () => {
    const g = start();
    await g.hello();
    const [m, s] = await signed(RUNBOOK, { patterns: PATTERNS });
    assert.equal((await g.request('load', m, s)).code, 0);
    assert.match((await g.request('run', '5')).err, /needs a value for the parameter TARGET/);
    for (const bad of ['web; rm -rf /', '$(id)', 'Web', 'a\nb', '']) {
      const r = await g.request('param', 'TARGET', toBase64(bad));
      assert.equal(r.code, 126, JSON.stringify(bad));
      assert.match(r.err, /doesn't match its pattern/);
    }
    assert.match((await g.request('param', 'OTHER', toBase64('x'))).err, /has no parameter OTHER/);
    assert.equal((await g.request('param', 'TARGET', toBase64('web-1'))).code, 0);
    const r = await g.request('run', '5');
    assert.deepEqual([r.code, r.out], [0, 'target=web-1\n']);
    await g.close();
  });

  it('commands run in order, or singly where the cell is signed with lines=any', async () => {
    const g = start();
    await g.hello();
    const [m, s] = await signed(RUNBOOK, { patterns: PATTERNS });
    await g.request('load', m, s);
    assert.match((await g.request('step', '3', '1')).err, /lines in order; single lines need lines=any/);
    assert.equal((await g.request('step', '3', '0')).out, 'a\n');
    assert.equal((await g.request('step', '3', '1')).out, 'b\n');
    assert.equal((await g.request('step', '3', '2')).out, 'c\n');
    assert.match((await g.request('step', '3', '3')).err, /order|no command 3/);
    assert.equal((await g.request('step', '4', '1')).out, 'second\n');
    assert.match((await g.request('run', '9')).err, /no signed cell 9/);
    await g.close();
  });

  it('refuses revoked and expired runbooks, and runbooks for other scopes', async () => {
    const [m, s, hash] = await signed(RUNBOOK, { patterns: PATTERNS });
    // Written by hand on Windows, copied from md-runbook verify: CRLF, upper case, a sha256: prefix.
    fs.writeFileSync(path.join(dir, 'revoked'), `${'0'.repeat(64)}\r\n sha256:${hash.toUpperCase()} \r\n`);
    writeConf([`revoked = ${path.join(dir, 'revoked')}`, 'scopes = web staging']);
    try {
      const g = start();
      await g.hello();
      assert.match((await g.request('load', m, s)).err, /ops\/test version 1 was withdrawn/);
      const expired = await signed(RUNBOOK, { patterns: PATTERNS, expires: '2020-01-01' });
      assert.match((await g.request('load', expired[0], expired[1])).err, /expired on 2020-01-01/);
      // The server takes web and staging: a runbook without scopes, or for prod, doesn't run.
      const none = await signed(RUNBOOK, { patterns: PATTERNS, version: 2 });
      assert.match((await g.request('load', none[0], none[1])).err, /is for no scope/);
      const prod = await signed(RUNBOOK, { patterns: PATTERNS, scopes: ['prod'] });
      assert.match((await g.request('load', prod[0], prod[1])).err, /is for prod/);
      const staging = await signed(RUNBOOK, { patterns: PATTERNS, scopes: ['prod', 'staging'] });
      assert.equal((await g.request('load', staging[0], staging[1])).code, 0);
      await g.close();
      // A key's --scopes narrows the server's.
      const narrow = start('--scopes=web');
      await narrow.hello();
      assert.match((await narrow.request('load', staging[0], staging[1])).err, /accepts web/);
      await narrow.close();
    } finally {
      writeConf([]);
    }
  });

  it('signers = 2 needs two distinct trusted signers; floors withdraw older versions', async () => {
    const reviewer = path.join(dir, 'reviewer');
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'review@example.net', '-f', reviewer]);
    const signers = path.join(dir, 'allowed_signers');
    const original = fs.readFileSync(signers, 'utf8');
    const pub = fs.readFileSync(reviewer + '.pub', 'utf8').trim().split(' ').slice(0, 2).join(' ');
    fs.writeFileSync(signers, original + `review@example.net namespaces="md-runbook" ${pub}\n`);
    fs.writeFileSync(path.join(dir, 'floors'), '# lowest versions\r\nops/test 3\r\nother/name 99\r\n');
    writeConf(['signers = 2', `floors = ${path.join(dir, 'floors')}`]);
    try {
      const manifest = formatManifest(manifestOf(RUNBOOK, { patterns: PATTERNS, version: 3 }));
      const [a, b, stranger] = [await sshSign(manifest, key), await sshSign(manifest, reviewer), await sshSign(manifest, otherKey)];
      const g = start();
      await g.hello();
      assert.match((await g.request('load', toBase64(manifest), a)).err, /needs 2 signers here; signed by ops@example\.net/);
      // The same signer twice, or a stranger, doesn't make a second signer.
      assert.match((await g.request('load', toBase64(manifest), a, a, stranger)).err, /needs 2 signers/);
      const both = await g.request('load', toBase64(manifest), a, b);
      assert.equal(both.code, 0, both.err);
      assert.match(both.out, /\x1e__MDRB_SIGNED__ ops@example\.net,review@example\.net [0-9a-f]{64}\n/);
      assert.equal((await g.request('run', '1')).out, 'one kept\n');
      // Version 2 is below the floor (3) for ops/test.
      const old = formatManifest(manifestOf(RUNBOOK, { patterns: PATTERNS, version: 2 }));
      const r = await g.request('load', toBase64(old), await sshSign(old, key), await sshSign(old, reviewer));
      assert.match(r.err, /ops\/test version 2 is older than the lowest version this server runs \(3\)/);
      await g.close();
      // A key's --signers=1 lowers it for that key.
      const one = start('--signers=1');
      await one.hello();
      assert.equal((await one.request('load', toBase64(manifest), a)).code, 0);
      await one.close();
      assert.match(fs.readFileSync(path.join(dir, 'gate.log'), 'utf8'), /"signer":"ops@example.net,review@example.net"/);
    } finally {
      fs.writeFileSync(signers, original);
      writeConf([]);
    }
  });

  it('a stop request stops the running cell of its own session only', { skip: !hasPkill() && 'no pkill (Git for Windows)' }, async () => {
    const g = start();
    const pid = (await g.hello()).code;
    const [m, s] = await signed(fence('bash', 'sleep 30') + fence('bash', 'echo still-here'), {});
    await g.request('load', m, s);
    const running = g.request('run', '1');
    await new Promise((r) => setTimeout(r, 500));
    const stranger = new Gate([`--config=${conf}`], env(), 'pkill -TERM -P 1 2>/dev/null; true');
    assert.equal(await stranger.exited, 2);
    const stop = new Gate([`--config=${conf}`], env(), `pkill -TERM -P ${pid} 2>/dev/null; true`);
    assert.equal(await stop.exited, 0);
    const r = await running;
    assert.notEqual(r.code, 0);
    // The shell survived: the session goes on.
    assert.equal((await g.request('run', '2')).out, 'still-here\n');
    await g.close();
  });

  it('a signed cell that rewrites the stored manifest does not get its change run', async () => {
    const g = start();
    await g.hello();
    // Signed code is trusted, but even so: the gate runs only the bytes it verified.
    const tamper = 'for d in "${TMPDIR:-/tmp}"/md-runbook-gate.*; do echo "cell 2 all" >> "$d/manifest"; done; echo tampered';
    const [m, s] = await signed(fence('bash', tamper) + fence('bash', 'echo second'), {});
    await g.request('load', m, s);
    assert.equal((await g.request('run', '1')).out, 'tampered\n');
    assert.match((await g.request('run', '2')).err, /changed on disk since it was checked/);
    assert.match((await g.request('run', '2')).err, /no signed runbook loaded/);
    await g.close();
  });

  it('a reused request id does not let a later step replace an earlier one still queued', async () => {
    const g = start();
    await g.hello();
    const [m, s] = await signed(fence('bash', 'sleep 1') + fence('bash', 'echo a\necho b\necho c'), {});
    await g.request('load', m, s);
    // While cell 1 runs, steps 0 and 1 of cell 2 wait in the shell's queue under one id.
    const busy = g.request('run', '1');
    g.child.stdin!.write('step 0000beef 2 0\nstep 0000beef 2 1\n');
    await busy;
    assert.deepEqual([(await g.reply('0000beef')).out, (await g.reply('0000beef')).out], ['a\n', 'b\n']);
    assert.match((await g.request('step', '2', '01')).err, /bad step request/);
    await g.close();
  });

  it("a runbook can't set PATH and the like, and doesn't see the previous runbook's values", async () => {
    const g = start();
    await g.hello();
    const manifest = formatManifest(manifestOf(RUNBOOK, { patterns: PATTERNS })).replace(/^env GREETING /m, 'env PATH ');
    assert.match(manifest, /^env PATH /m);
    const bad = await g.request('load', toBase64(manifest), await sshSign(manifest, key));
    assert.match(bad.err, /sets PATH, a name the gate doesn't let a runbook set/);
    const [m, s] = await signed(RUNBOOK, { patterns: PATTERNS });
    await g.request('load', m, s);
    await g.request('param', 'TARGET', toBase64('web-1'));
    assert.equal((await g.request('run', '5')).out, 'target=web-1\n');
    assert.equal((await g.request('run', '2')).out, 'hello from tmp \n');
    const [m2, s2] = await signed(fence('bash', 'echo "[${TARGET-unset}] [${GREETING-unset}]"'), { name: 'ops/other' });
    await g.request('load', m2, s2);
    assert.equal((await g.request('run', '1')).out, '[unset] [unset]\n');
    await g.close();
  });

  it('`exit` in a cell ends the session', async () => {
    const g = start();
    await g.hello();
    const [m, s] = await signed(fence('bash', 'exit 3'), {});
    await g.request('load', m, s);
    g.child.stdin!.write('run 0000abcd 1\n');
    assert.equal(await g.exited, 0);
  });

  it('ignores lines that are not requests, refuses unknown ones, and fails closed on a bad config', async () => {
    const g = start();
    await g.hello();
    g.child.stdin!.write('rm -rf /\n');
    assert.match((await g.request('frobnicate')).err, /unknown request frobnicate/);
    await g.close();
    const bad = new Gate([`--config=${conf}`, '--unsigned=maybe'], env());
    assert.equal(await bad.exited, 2);
    fs.writeFileSync(path.join(dir, 'bad.conf'), 'unsigned = sometimes\n');
    const badConf = new Gate([`--config=${path.join(dir, 'bad.conf')}`], env());
    assert.equal(await badConf.exited, 2);
  });
});
