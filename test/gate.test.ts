/**
 * md-runbook-gate (the Go program in apps/gate), the forced command of restricted keys, driven the
 * way sshd starts it: its line protocol on stdin, SSH_ORIGINAL_COMMAND for the stop request. Real
 * ssh-keygen signatures. MD_RUNBOOK_GATE_BIN names the binary (default: apps/gate/dist/
 * md-runbook-gate, built by `go build` as in apps/gate/README.md). Linux and macOS; on Windows only
 * when MD_RUNBOOK_GATE_BIN is set.
 */
import { strict as assert } from 'node:assert';
import { ChildProcess, execFileSync, spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Manifest, ManifestMeta, RESERVED_VARS, RESERVED_VAR_PREFIXES, buildManifest, formatManifest, toBase64 } from '@md-runbook/core/signing';
import { manifestHash, sshSign } from '@md-runbook/core/node';
import { runSummaryProblems } from '@md-runbook/core/runReport';
import { gateAlertNote, gateNoteCommand } from '@md-runbook/ssh';

const GATE = process.env.MD_RUNBOOK_GATE_BIN ?? path.resolve(__dirname, '..', '..', 'apps', 'gate', 'dist', 'md-runbook-gate');
/** The gate is a Linux and macOS program: elsewhere, only a binary named on purpose runs. */
const RUNS = process.platform !== 'win32' || !!process.env.MD_RUNBOOK_GATE_BIN;
/** A POSIX sh for the tests' own commands (not the gate's). */
const SH = '/bin/sh';

const fence = (info: string, body: string): string => '```' + info + '\n' + body + '\n```\n\n';
/** A path with forward slashes, as a key line or gate.conf names it. */
const shPath = (p: string): string => p.replace(/\\/g, '/');
/** An authorized_keys line whose forced command is this gate. */
const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGdhdGUtdGVzdC1rZXktbm90LXVzZWQtdG8tbG9nLWlu test@gate';
const keyLine = (options = '', prefix = 'restrict,'): string => `${prefix}command="${shPath(GATE)}${options}" ${KEY}`;

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

  /** `as`: run it as that account, through the test's own sudo, with only `env` (separated mode). */
  constructor(args: string[], env: Record<string, string>, command = 'bash -l', as = '') {
    // As sshd starts it: argv[0] is the path the key line names. Not under sshd unless a test says
    // so (the gate checks the login shell then).
    const base: Record<string, string | undefined> = { ...process.env };
    delete base.SSH_CLIENT;
    delete base.SSH_CONNECTION;
    if (as) {
      const pairs = Object.entries({ ...env, SSH_ORIGINAL_COMMAND: command }).map(([k, v]) => `${k}=${v}`);
      this.child = spawn('sudo', ['-n', '-u', as, '--', '/usr/bin/env', ...pairs, GATE, ...args], { stdio: 'pipe' });
    } else {
      this.child = spawn(GATE, args, { env: { ...base, ...env, SSH_ORIGINAL_COMMAND: command }, stdio: 'pipe' });
    }
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
    // A gate run from Windows through a wrapper (MD_RUNBOOK_GATE_BIN) starts slowly.
    const deadline = Date.now() + (process.platform === 'win32' ? 60_000 : 20_000);
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

  /** Send the line a client's own command makes, with a fresh id. */
  send(text: (id: string) => string): Promise<Reply> {
    const id = (++this.n).toString(16).padStart(8, '0');
    this.child.stdin!.write(text(id));
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

describe('md-runbook-gate: reserved names', () => {
  it("the gate's reserved names are exactly core's isReservedVar list (security review, 2026-11-16)", () => {
    const source = fs.readFileSync(path.resolve(__dirname, '..', '..', 'apps', 'gate', 'internal', 'names', 'names.go'), 'utf8');
    const list = (name: string): string[] => {
      const block = new RegExp(`\\nvar ${name} = \\[\\]string\\{([\\s\\S]*?)\\n\\}`).exec(source)?.[1];
      assert.ok(block, `${name} in the gate`);
      return [...block.matchAll(/"([^"]*)"/g)].map((m) => m[1]!).sort();
    };
    assert.deepEqual(list('ReservedExact'), [...RESERVED_VARS].sort());
    assert.deepEqual(list('ReservedPrefixes'), [...RESERVED_VAR_PREFIXES].sort());
  });
});

describe('md-runbook-gate', { skip: !RUNS && 'the gate runs on Linux and macOS (set MD_RUNBOOK_GATE_BIN)' }, () => {
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
  // The account's key lines (all signed or none): every test config names a file of its own.
  const keysAt = (name: string, lines: string[]): string => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, lines.join('\n') + '\n');
    return shPath(file);
  };
  const confText = (lines: string[]): string =>
    [
      `allowed_signers = ${path.join(dir, 'allowed_signers')}`,
      `log = ${path.join(dir, 'gate.log')}`,
      ...(lines.some((l) => /^(authorized_keys|sshd_force_command)\b/.test(l)) ? [] : [`authorized_keys = ${shPath(path.join(dir, 'authorized_keys'))}`]),
      ...lines,
    ].join('\n') + '\n';
  const writeConf = (lines: string[]): void => fs.writeFileSync(conf, confText(lines));
  /** A config of its own (for a gate started with `new Gate`). */
  const confAt = (name: string, lines: string[]): string => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, confText(lines));
    return file;
  };
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
    assert.ok(fs.existsSync(GATE), `no gate at ${GATE}: build it (cd apps/gate && go build -o dist/md-runbook-gate ./cmd/md-runbook-gate) or set MD_RUNBOOK_GATE_BIN`);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdrb-gate-'));
    conf = path.join(dir, 'gate.conf');
    key = path.join(dir, 'signer');
    otherKey = path.join(dir, 'stranger');
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'ops@example.net', '-f', key]);
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'stranger', '-f', otherKey]);
    const pub = fs.readFileSync(key + '.pub', 'utf8').trim().split(' ').slice(0, 2).join(' ');
    fs.writeFileSync(path.join(dir, 'allowed_signers'), `ops@example.net,release@example.net namespaces="md-runbook" ${pub}\n`);
    keysAt('authorized_keys', [keyLine()]);
    writeConf([]);
  });
  after(() => {
    for (const g of gates) g.child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('answers the hello with its banner and the session number (what a stop request names)', async () => {
    const g = start();
    const r = await g.hello();
    assert.match(r.out, /\x1e__MDRB_GATE__ 3 unsigned=refuse\n/);
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

  it('runs version 2 manifests (the whole text signed) and version 1 ones, signed before', async () => {
    for (const version of [2, 1] as const) {
      const g = start();
      await g.hello();
      const r = buildManifest(RUNBOOK, meta({ patterns: PATTERNS }), { version });
      if ('errors' in r) throw new Error(r.errors.join('; '));
      const manifest = formatManifest(r.manifest);
      assert.equal(/^text [0-9a-f]{64}$/m.test(manifest), version === 2);
      const load = await g.request('load', toBase64(manifest), await sshSign(manifest, key));
      assert.equal(load.code, 0, load.err);
      const one = await g.request('run', '1');
      assert.deepEqual([one.code, one.out], [0, 'one kept\n']);
      await g.close();
    }
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

  it('refuses a signed manifest it would read otherwise than core does (security review, 2026-11-16)', async () => {
    const g = start();
    await g.hello();
    const manifest = formatManifest(manifestOf(RUNBOOK, { patterns: PATTERNS }));
    assert.match(manifest, /^version 1$/m);
    const load = async (m: string) => g.request('load', toBase64(m), await sshSign(m, key));
    const twice = await load(manifest.replace(/^version 1$/m, 'version 1\nversion 9'));
    assert.equal(twice.code, 126);
    assert.match(twice.err, /more than one version line/);
    const word = await load(manifest.replace(/^version 1$/m, 'version one'));
    assert.equal(word.code, 126);
    assert.match(word.err, /version is not a whole number/);
    const expires = await load(manifest.replace(/^version 1$/m, 'version 1\nexpires soon'));
    assert.equal(expires.code, 126);
    assert.match(expires.err, /expires is not a date/);
    // Each refusal leaves the session usable: the real manifest still loads.
    const good = await load(manifest);
    assert.equal(good.code, 0, good.err);
    await g.close();
  });

  it('called: the next load is logged as loaded by that call of that runbook; a bad request is refused', async () => {
    const g = start();
    await g.hello();
    const [m, s] = await signed(RUNBOOK, { patterns: PATTERNS, name: 'ops/called' });
    const caller = 'ab'.repeat(32);
    assert.equal((await g.request('called', caller, '3')).code, 0);
    assert.equal((await g.request('load', m, s)).code, 0);
    // For one load only.
    assert.equal((await g.request('load', m, s)).code, 0);
    assert.notEqual((await g.request('called', 'nothex', '3')).code, 0);
    await g.close();
    const loads = fs
      .readFileSync(path.join(dir, 'gate.log'), 'utf8')
      .split('\n')
      .filter((l) => /"event":"load".*"runbook":"ops\/called"/.test(l));
    assert.equal(loads.length, 2);
    assert.match(loads[0]!, new RegExp(`"called-by":"${caller}","call":"3"`));
    assert.doesNotMatch(loads[1]!, /called-by/);
  });

  it('note: the next load is logged with the alert it answers; nothing runs, and only for one load', async () => {
    const g = start();
    await g.hello();
    const [m, s] = await signed(RUNBOOK, { patterns: PATTERNS, name: 'ops/noted' });
    const b = (v: string): string => toBase64(v);
    // What a hostile link could put in the name: logged as text, never run.
    const name = 'ApiDown "x" $(touch pwned-1) `touch pwned-2`; touch pwned-3 \\ é';
    const note = await g.request('note', 'ALERT', b(name), 'ALERT_FINGERPRINT', b('5f3c9e:a.b_c-d'), 'ALERT_STARTS_AT', b('2026-11-14T08:58:00.123Z'));
    assert.deepEqual([note.code, note.out, note.err], [0, '', '']);
    assert.equal((await g.request('load', m, s)).code, 0);
    const one = await g.request('run', '1');
    assert.deepEqual([one.code, one.out], [0, 'one kept\n']);
    // The next load has no alert unless a note comes again; a note after a load is for the next one.
    assert.equal((await g.request('load', m, s)).code, 0);
    assert.equal((await g.request('note', 'ALERT', b('DiskFull'), 'ALERT_STARTS_AT', b('2026-11-14 08:58+01:00'))).code, 0);
    assert.equal((await g.request('run', '1')).code, 0);
    assert.equal((await g.request('load', m, s)).code, 0);
    await g.close();
    for (const f of ['pwned-1', 'pwned-2', 'pwned-3']) assert.equal(fs.existsSync(path.join(dir, f)) || fs.existsSync(f), false, f);
    const loads = fs
      .readFileSync(path.join(dir, 'gate.log'), 'utf8')
      .split('\n')
      .filter((l) => /"event":"load".*"runbook":"ops\/noted"/.test(l))
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.equal(loads.length, 3);
    assert.deepEqual([loads[0]!.alert, loads[0]!['alert-fingerprint'], loads[0]!['alert-starts-at']], [name, '5f3c9e:a.b_c-d', '2026-11-14T08:58:00.123Z']);
    assert.equal(loads[1]!.alert, undefined);
    assert.deepEqual([loads[2]!.alert, loads[2]!['alert-fingerprint'], loads[2]!['alert-starts-at']], ['DiskFull', undefined, '2026-11-14 08:58+01:00']);
  });

  it('note: a malformed or oversize note is refused whole, and the session goes on', async () => {
    const g = start();
    await g.hello();
    const [m, s] = await signed(RUNBOOK, { patterns: PATTERNS, name: 'ops/badnote' });
    const b = (v: string): string => toBase64(v);
    const bad: string[][] = [
      [],
      ['ALERT'],
      ['ALERT_FINGERPRINT', b('abc')], // no ALERT
      ['ALERT', b('A'), 'ALERT', b('B')], // a key twice
      ['ALERT', b('A'), 'ALERT_LABELS', b('a=b')], // not one of the keys
      ['ALERT', 'not base64!'],
      ['ALERT', b('two\nlines')],
      ['ALERT', b('bell\x07')],
      ['ALERT', b('x'.repeat(401))],
      ['ALERT', 'QUFB'.repeat(151)], // 604 base64 characters: not decoded
      ['ALERT', b('A'), 'ALERT_FINGERPRINT', b('has space')],
      ['ALERT', b('A'), 'ALERT_FINGERPRINT', b('f'.repeat(129))],
      ['ALERT', b('A'), 'ALERT_STARTS_AT', b('yesterday')],
      ['ALERT', b('A'), 'ALERT_STARTS_AT', b('2026-11-14T08:58:00Z; rm -rf /')],
      ['ALERT', b('A'), 'ALERT_FINGERPRINT', b('a'), 'ALERT_STARTS_AT', b('2026-11-14T08:58Z'), 'ALERT', b('B')],
    ];
    // A good one first: a refused note leaves it as it was.
    assert.equal((await g.request('note', 'ALERT', b('x'.repeat(400)))).code, 0);
    for (const args of bad) {
      const r = await g.request('note', ...args);
      assert.equal(r.code, 126, JSON.stringify(args));
      assert.match(r.err, /bad note request/);
      assert.equal(r.out, '');
    }
    assert.equal((await g.request('load', m, s)).code, 0);
    const one = await g.request('run', '1');
    assert.deepEqual([one.code, one.out], [0, 'one kept\n']);
    await g.close();
    const log = fs.readFileSync(path.join(dir, 'gate.log'), 'utf8').split('\n');
    const load = log.find((l) => /"event":"load".*"runbook":"ops\/badnote"/.test(l));
    assert.equal((JSON.parse(load!) as { alert?: string }).alert, 'x'.repeat(400));
    // The refusals are logged without the values.
    assert.ok(log.filter((l) => /"reason":"bad note request"/.test(l)).length >= bad.length);
    assert.ok(!log.some((l) => l.includes('has space') || l.includes('rm -rf')));
  });

  it("note: what the app sends (gateAlertNote, gateNoteCommand) is what the gate takes", async () => {
    const g = start();
    await g.hello();
    const [m, s] = await signed(RUNBOOK, { patterns: PATTERNS, name: 'ops/appnote' });
    // 300 two-byte characters, a control character and a fingerprint the gate wouldn't take.
    const note = gateAlertNote({ name: 'é'.repeat(300) + '\x07', fingerprint: 'not one', startsAt: '2026-11-14T08:58:00+01:00' })!;
    const r = await g.send((id) => gateNoteCommand(id, note));
    assert.equal(r.code, 0, r.err);
    assert.equal((await g.request('load', m, s)).code, 0);
    await g.close();
    const load = fs
      .readFileSync(path.join(dir, 'gate.log'), 'utf8')
      .split('\n')
      .find((l) => /"event":"load".*"runbook":"ops\/appnote"/.test(l));
    const e = JSON.parse(load!) as Record<string, unknown>;
    assert.deepEqual([e.alert, e['alert-fingerprint'], e['alert-starts-at']], ['é'.repeat(200), undefined, '2026-11-14T08:58:00+01:00']);
  });

  it('answers a context request with kubectl config current-context, also where only signed cells run', async () => {
    // A kubeconfig for a real kubectl (CI runners have one), and a stand-in where there is none.
    const kubeconfig = path.join(dir, 'kubeconfig');
    fs.writeFileSync(
      kubeconfig,
      'apiVersion: v1\nkind: Config\ncurrent-context: prod-eu\ncontexts:\n- name: prod-eu\n  context: {cluster: c, user: u}\n' +
        'clusters:\n- name: c\n  cluster: {server: "https://127.0.0.1:1"}\nusers:\n- name: u\n  user: {}\n',
    );
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'kubectl'), '#!/bin/sh\necho prod-eu\n', { mode: 0o755 });
    // The cells' PATH is gate.conf's `path`, not the gate's.
    const ctxConf = confAt('context.conf', [`path = ${shPath(bin)}:/usr/local/bin:/usr/bin:/bin`]);
    const g = new Gate([`--config=${ctxConf}`], { ...env(), KUBECONFIG: kubeconfig });
    gates.push(g);
    assert.match((await g.hello()).out, /unsigned=refuse/);
    const r = await g.request('context');
    assert.deepEqual([r.code, r.out], [0, 'prod-eu\n']);
    const bad = await g.request('context', 'extra');
    assert.equal(bad.code, 126);
    await g.close();
    assert.match(fs.readFileSync(path.join(dir, 'gate.log'), 'utf8'), /"event":"context"/);
  });

  it("enforces a signed block's kube-context= itself, with the block's env.KUBECONFIG (security review, 2026-11-16)", async () => {
    // kubectl reads the context from $KUBECONFIG: a stand-in that does the same.
    const bin = path.join(dir, 'kube-bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'kubectl'), '#!/bin/sh\nsed -n "s/^current-context: //p" "$KUBECONFIG"\n', { mode: 0o755 });
    const unix = (p: string): string => p.replace(/\\/g, '/');
    const prod = unix(path.join(dir, 'prod.kubeconfig'));
    const lab = unix(path.join(dir, 'lab.kubeconfig'));
    fs.writeFileSync(prod, 'current-context: prod-eu\n');
    fs.writeFileSync(lab, 'current-context: lab-1\n');
    const kconf = confAt('kube.conf', [`path = ${shPath(bin)}:/usr/bin:/bin`]);
    const g = new Gate([`--config=${kconf}`], env());
    gates.push(g);
    await g.hello();
    const text =
      fence(`bash kube-context=prod-eu env.KUBECONFIG=${prod}`, 'echo ran-1') +
      fence(`bash Kube-Context="prod-eu" env.KUBECONFIG=${lab}`, 'echo ran-2') +
      fence(`bash kube-context=\${param:CTX} env.KUBECONFIG=${lab}`, 'echo ran-3');
    const [m, s] = await signed(text, { patterns: { CTX: 'lab-[0-9]+|prod-eu' } });
    assert.equal((await g.request('load', m, s)).code, 0);
    // The client never sends `context`: the gate checks all the same.
    const one = await g.request('run', '1');
    assert.deepEqual([one.code, one.out], [0, 'ran-1\n']);
    const two = await g.request('run', '2');
    assert.deepEqual([two.code, two.out], [126, '']);
    assert.match(two.err, /for the Kubernetes context prod-eu; the current context here is lab-1: nothing ran/);
    assert.match((await g.request('run', '3')).err, /needs a value for the parameter CTX \(its kube-context\)/);
    assert.equal((await g.request('param', 'CTX', toBase64('prod-eu'))).code, 0);
    assert.equal((await g.request('run', '3')).code, 126);
    assert.equal((await g.request('param', 'CTX', toBase64('lab-1'))).code, 0);
    const three = await g.request('run', '3');
    assert.deepEqual([three.code, three.out], [0, 'ran-3\n']);
    await g.close();
    assert.match(fs.readFileSync(path.join(dir, 'gate.log'), 'utf8'), /"event":"refused","id":"[0-9a-f]+","reason":"kube-context is lab-1, not prod-eu"/);
  });

  it('runs unsigned text where the key allows it', async () => {
    // An unsigned-trial account: every key line allows unsigned blocks.
    const uconf = confAt('unsigned.conf', [`authorized_keys = ${keysAt('unsigned.keys', [keyLine(' --unsigned=allow --who=trial')])}`]);
    const g = new Gate([`--config=${uconf}`, '--unsigned=allow'], env());
    gates.push(g);
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

  it('a stop request stops every program of the running cell of its own session only', async () => {
    const g = start();
    const session = (await g.hello()).code;
    // A program the cell's program started: a stop of the shell's children only left it running.
    const pidFile = path.join(dir, 'grandchild.pid');
    const [m, s] = await signed(fence('bash', `sh -c 'sleep 31 & echo $! >"$1"; wait' sh ${shPath(pidFile)}`) + fence('bash', 'echo still-here'), {});
    await g.request('load', m, s);
    const running = g.request('run', '1');
    for (let i = 0; i < 300 && !fs.existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 100));
    const grandchild = Number(fs.readFileSync(pidFile, 'utf8').trim());
    // Another session's number (or a pid) stops nothing.
    const stranger = new Gate([`--config=${conf}`], env(), 'pkill -TERM -P 1 2>/dev/null; true');
    assert.equal(await stranger.exited, 2);
    const stop = new Gate([`--config=${conf}`], env(), `pkill -TERM -P ${session} 2>/dev/null; true`);
    assert.equal(await stop.exited, 0);
    const r = await running;
    assert.notEqual(r.code, 0);
    const alive = (): boolean => {
      try {
        process.kill(grandchild, 0);
        return true;
      } catch {
        return false;
      }
    };
    // (A gate run from Windows through a wrapper: its pids are not Windows' own.)
    if (process.platform !== 'win32') {
      for (let i = 0; i < 30 && alive(); i++) await new Promise((r) => setTimeout(r, 100));
      assert.equal(alive(), false, 'the program the cell started was stopped too');
    }
    // The shell survived: the session goes on.
    assert.equal((await g.request('run', '2')).out, 'still-here\n');
    await g.close();
  });

  it("a cell can't plant parameters or a manifest for the next block: the gate keeps them in memory (security review, 2026-11-16)", async () => {
    const g = start();
    await g.hello();
    // Signed code is trusted, but even so: the gate runs only the bytes it verified, and exports
    // only the parameters it checked (before, a file name in params/ went into the shell as is).
    const plant =
      'for d in "${TMPDIR:-/tmp}"/md-runbook-gate.*; do mkdir -p "$d/params"; echo pwned >"$d/params/EVIL"; ' +
      'printf x >"$d/params/x;echo INJECTED;y"; echo "cell 2 all" >>"$d/manifest"; done; echo planted';
    const [m, s] = await signed(fence('bash', plant) + fence('bash', 'echo "second ${EVIL-unset}"'), {});
    await g.request('load', m, s);
    assert.equal((await g.request('run', '1')).out, 'planted\n');
    const two = await g.request('run', '2');
    assert.deepEqual([two.code, two.out], [0, 'second unset\n']);
    assert.doesNotMatch(two.err, /INJECTED/);
    await g.close();
  });

  it("cells run without the account's profile, with gate.conf's PATH and locale, not the client's (security review, 2026-11-16)", async () => {
    // What an `unsigned = allow` period could have planted in the account's home.
    const home = path.join(dir, 'home-profile');
    fs.mkdirSync(home, { recursive: true });
    for (const f of ['.bash_profile', '.bash_login', '.profile', '.bashrc']) fs.writeFileSync(path.join(home, f), 'echo PROFILE-RAN; planted() { echo planted; }\n');
    const startup = path.join(dir, 'bash-env.sh');
    fs.writeFileSync(startup, 'echo BASH_ENV-RAN\n');
    const pconf = confAt('profile.conf', ['path = /usr/bin:/bin', 'locale = C']);
    // sshd passes the client's LANG and LC_* (AcceptEnv); BASH_ENV and ENV only by mistake.
    const g = new Gate([`--config=${pconf}`], { HOME: home, TMPDIR: dir, LANG: 'de_DE.UTF-8', LC_ALL: 'de_DE.UTF-8', LC_MESSAGES: 'fr_FR.UTF-8', BASH_ENV: startup, ENV: startup });
    gates.push(g);
    await g.hello();
    const [m, s] = await signed(fence('bash', 'echo "path=$PATH lang=$LANG all=${LC_ALL-unset} msg=${LC_MESSAGES-unset}"; type planted >/dev/null 2>&1 && echo has-planted; echo done'));
    assert.equal((await g.request('load', m, s)).code, 0);
    const r = await g.request('run', '1');
    assert.deepEqual([r.code, r.out], [0, 'path=/usr/bin:/bin lang=C all=unset msg=unset\ndone\n']);
    await g.close();
    // A relative or empty folder in `path` is refused at the start.
    for (const bad of ['path = /usr/bin::/bin', 'path = bin:/usr/bin', 'locale = de DE']) {
      const b = new Gate([`--config=${confAt('bad-path.conf', [bad])}`], env());
      b.child.stdin!.end();
      assert.equal(await b.exited, 2, bad);
    }
  });

  it('each runbook gets a fresh shell; cells of one runbook (loaded again too) share theirs (security review, 2026-11-16)', async () => {
    const g = start();
    await g.hello();
    const set = 'A=1; f() { echo func; }; alias ll="echo alias"; trap "echo trapped" USR2; set -e; cd /';
    const check = 'echo "A=${A-unset}"; type f >/dev/null 2>&1 && echo has-f; alias ll >/dev/null 2>&1 && echo has-alias; case $- in *e*) echo has-e ;; esac; trap -p USR2; true';
    const [a, as] = await signed(fence('bash', set) + fence('bash', check), { name: 'ops/a' });
    const [b, bs] = await signed(fence('bash', check), { name: 'ops/b' });
    assert.equal((await g.request('load', a, as)).code, 0);
    assert.equal((await g.request('run', '1')).code, 0);
    // The same runbook again (another alert, a co-signature): its shell stays.
    assert.equal((await g.request('load', a, as)).code, 0);
    const same = await g.request('run', '2');
    assert.equal(same.code, 0, same.err);
    assert.match(same.out, /^A=1\nhas-f\nhas-alias\nhas-e\ntrap -- 'echo trapped' (SIG)?USR2\n$/);
    // Another runbook: nothing of the first one.
    assert.equal((await g.request('load', b, bs)).code, 0);
    const other = await g.request('run', '1');
    assert.deepEqual([other.code, other.out], [0, 'A=unset\n']);
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
    // Names that load code or change where programs connect (security review, 2026-11-16).
    for (const name of ['NODE_OPTIONS', 'GIT_CONFIG_KEY_0', 'https_proxy', 'GIT_ASKPASS', 'EDITOR', 'ftp_proxy']) {
      const m = formatManifest(manifestOf(RUNBOOK, { patterns: PATTERNS })).replace(/^env GREETING /m, `env ${name} `);
      const r = await g.request('load', toBase64(m), await sshSign(m, key));
      assert.match(r.err, new RegExp(`sets ${name}, a name the gate doesn't let a runbook set`));
    }
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

  it('report_to: at the end of a session it posts a run summary (client gate) per signed runbook it ran', async () => {
    const got: { auth: string | undefined; planted: string | undefined; body: string }[] = [];
    let answer = 202;
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d: Buffer) => (body += d.toString('utf8')));
      req.on('end', () => {
        got.push({ auth: req.headers.authorization, planted: req.headers['x-planted'] as string | undefined, body });
        res.writeHead(answer).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    const tokenFile = path.join(dir, 'report-token');
    fs.writeFileSync(tokenFile, 'a-report-token-of-at-least-24-chars\n');
    // The account's ~/.curlrc (a block could write it) is never read: curl -q.
    fs.writeFileSync(path.join(dir, '.curlrc'), 'header = "x-planted: from-curlrc"\n');
    const logFile = path.join(dir, 'gate.log');
    const reportEvents = (): string[] => fs.readFileSync(logFile, 'utf8').split('\n').filter((l) => /"event":"report"/.test(l));
    const waitFor = async (what: () => boolean): Promise<void> => {
      for (let i = 0; i < 100 && !what(); i++) await new Promise((r) => setTimeout(r, 150));
      assert.ok(what(), 'timed out');
    };
    writeConf([`report_to = http://127.0.0.1:${port}/v1/runs`, `report_token_file = ${tokenFile}`]);
    try {
      const before = reportEvents().length;
      const g = start();
      await g.hello();
      const text = fence('bash', '  echo   ok  ') + fence('bash', 'false') + fence('bash', 'echo a\necho b') + fence('bash', 'echo never');
      const [m, s, hash] = await signed(text, { name: 'ops/report', version: 4 });
      assert.equal((await g.request('load', m, s)).code, 0);
      assert.equal((await g.request('run', '1')).code, 0);
      assert.equal((await g.request('run', '2')).code, 1);
      assert.equal((await g.request('step', '3', '0')).code, 0);
      assert.equal(await g.close(), 0);
      await waitFor(() => got.length === 1 && reportEvents().length > before);
      assert.equal(got[0]!.auth, 'Bearer a-report-token-of-at-least-24-chars');
      assert.equal(got[0]!.planted, undefined);
      const summary = JSON.parse(got[0]!.body);
      assert.deepEqual(runSummaryProblems(summary), []);
      assert.equal(summary.client, 'gate');
      assert.deepEqual(summary.runbook, { signed: { name: 'ops/report', version: 4, manifest: hash, signer: 'ops@example.net', trusted: true } });
      assert.deepEqual(
        summary.steps.map((x: { label: string; state: string }) => [x.label, x.state]),
        [
          ['echo ok', 'passed'],
          ['false', 'failed'],
          ['echo a', 'not-run'],
          ['echo never', 'not-run'],
        ],
      );
      assert.deepEqual(summary.ran, [1, 2, 3]);
      assert.deepEqual(summary.totals, { steps: 4, passed: 1, failed: 1, skipped: 0, notRun: 2, byHand: 0 });
      assert.equal(summary.green, false);
      assert.equal(summary.who, os.userInfo().username);
      assert.equal(summary.gate.account, os.userInfo().username);
      // The gate's mode, in its gate object only (the library server's contract).
      assert.equal(summary.gate.gate_mode, 'shared');
      assert.equal(summary.gate_mode, undefined);
      assert.ok(summary.started <= summary.ended);
      assert.match(reportEvents().at(-1)!, /"status":"sent","http":"202".*"runbook":"ops\/report","version":"4"/);
      assert.doesNotMatch(fs.readFileSync(logFile, 'utf8'), /a-report-token/, 'the token is never logged');

      // A refusal (4xx) is logged and not tried again; the session itself ended as usual.
      answer = 400;
      const g2 = start();
      await g2.hello();
      await g2.request('load', m, s);
      await g2.request('run', '1');
      assert.equal(await g2.close(), 0);
      await waitFor(() => got.length === 2 && reportEvents().length > before + 1);
      assert.match(reportEvents().at(-1)!, /"status":"failed","http":"400"/);
    } finally {
      server.close();
      writeConf([]);
    }
  });

  it('all signed or none: a mix of keys, or a key that skips the gate, stops the session before it starts', async () => {
    const plain = KEY.replace('test@gate', 'admin@laptop');
    const bad: [string, string[], RegExp][] = [
      ['a plain key', [keyLine(), plain], /line 2: no command=/],
      ['signed and unsigned keys', [keyLine(), keyLine(' --unsigned=allow'), keyLine()], /lines? 2 allows? unsigned blocks and lines? 1 3/],
      ['more than the gate', [keyLine('; sh')], /line 1: command=/],
      ['another gate', [`command="/tmp/elsewhere/md-runbook-gate" ${KEY}`], /line 1: command=/],
      ['an open quote', [`restrict,command="${shPath(GATE)} ${KEY}`], /line 1: can't read its options/],
      ['two commands', [`command="${shPath(GATE)}",command="/bin/sh" ${KEY}`], /line 1: can't read its options/],
      ['a CA without the gate', [`cert-authority,principals="ops" ${KEY}`], /line 1: no command=/],
      // Without restrict, -L to docker.sock or the user's bus runs code unsigned (security review round 3).
      ['no restrict', [keyLine('', '')], /line 1: add restrict/],
      ['some no-* options only', [keyLine('', 'no-pty,no-port-forwarding,')], /line 1: add restrict/],
      ['restrict, then forwarding again', [keyLine('', 'restrict,port-forwarding,'), keyLine('', 'restrict,user-rc,')], /line 1: remove port-forwarding[\s\S]*line 2: remove user-rc/],
      ['restrict, then permitopen', [keyLine('', 'restrict,permitopen="localhost:2375",')], /line 1: remove permitopen/],
      // Only ForceCommand may say it, and gate.conf decides (security review round 3).
      ['--sshd-force-command on a key line', [keyLine(' --sshd-force-command')], /line 1: command=/],
      ['a shell expansion', [keyLine(' --who=$(id)')], /line 1: command=/],
      ['a ; in a value', [keyLine(' --who=a;b')], /line 1: command=/],
      ['an expansion in double quotes', [keyLine(' --who=\\"$HOME\\"')], /line 1: command=/],
      // Security review round 4: sshd's tunnel check looks for restrict itself, environment= can
      // set LD_PRELOAD for the gate, and a config the account can change sets the policy.
      ['the five no-* options instead of restrict', [keyLine('', 'no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty,no-user-rc,')], /line 1: add restrict/],
      ['environment=', [keyLine('', 'restrict,environment="LD_PRELOAD=/tmp/evil.so",')], /line 1: remove environment=/],
      ["a --config= the account can change", [keyLine(` --config=${shPath(conf)}`)], /line 1: its config .* is a file this account can change/],
      // The gate is a program: sh can't run it (the shell gate took `sh md-runbook-gate`).
      ['the gate through sh', [`restrict,command="sh ${shPath(GATE)}" ${KEY}`], /line 1: command=.* runs the gate with a shell/],
      ['the gate through exec bash', [`restrict,command="exec /bin/bash ${shPath(GATE)} --who=x" ${KEY}`], /line 1: command=.* runs the gate with a shell/],
    ];
    for (const [what, lines, re] of bad) {
      const c = confAt('mixed.conf', [`authorized_keys = ${keysAt('mixed.keys', lines)}`]);
      const g = new Gate([`--config=${c}`], env());
      gates.push(g);
      let err = '';
      g.child.stderr!.on('data', (d: Buffer) => (err += d.toString('utf8')));
      g.child.stdin!.end();
      assert.equal(await g.exited, 2, what);
      assert.match(err, re, what);
    }
    // No keys, or a file it can't read: the same.
    const none = new Gate([`--config=${confAt('none.conf', [`authorized_keys = ${keysAt('none.keys', ['# nobody yet', ''])}`])}`], env());
    none.child.stdin!.end();
    assert.equal(await none.exited, 2);
    // Comments, blank lines, CRLF, options with quoted commas and escaped quotes, a CA line, exec
    // and quoted values (security review round 3): fine.
    const good = [
      '# the support team',
      '',
      `restrict,from="10.0.0.0/8,192.168.0.0/16",no-pty,command="${shPath(GATE)} --who=alice --scopes=web,staging" ${KEY}\r`,
      `cert-authority,restrict,principals="ops",command="${shPath(GATE)}" ${KEY}`,
      `restrict,command="exec ${shPath(GATE)} --who='Alice Smith'" ${KEY}`,
      `restrict,command="exec ${shPath(GATE)} --who=\\"Bob B\\" --signers=1" ${KEY}`,
    ];
    const ok = new Gate([`--config=${confAt('good.conf', [`authorized_keys = ${keysAt('good.keys', good)}`])}`], env());
    gates.push(ok);
    assert.match((await ok.hello()).out, /unsigned=refuse/);
    assert.equal(await ok.close(), 0);
    // A login whose own options don't match the account's kind: its key is not in the file.
    const odd = new Gate([`--config=${conf}`, '--unsigned=allow'], env());
    odd.child.stdin!.end();
    assert.equal(await odd.exited, 2);
  });

  it('all signed or none: an unsigned-trial account runs, but sends no run report', async () => {
    let posted = 0;
    const server = http.createServer((req, res) => {
      posted++;
      req.resume();
      res.writeHead(202).end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    try {
      // Each key line allows unsigned blocks. (Not through a --config= of the account's: the gate
      // refuses a key line's config the account can change; security review round 4.)
      const keys = keysAt('trial.keys', [keyLine(' --unsigned=allow'), keyLine(' --unsigned=allow --who=bob')]);
      const c = confAt('trial.conf', ['unsigned = allow', `report_to = http://127.0.0.1:${port}/v1/runs`, `authorized_keys = ${keys}`]);
      const g = new Gate([`--config=${c}`], env());
      gates.push(g);
      assert.match((await g.hello()).out, /unsigned=allow/);
      const [m, s] = await signed(fence('bash', 'echo trial'), { name: 'ops/trial' });
      assert.equal((await g.request('load', m, s)).code, 0);
      assert.equal((await g.request('run', '1')).out, 'trial\n');
      assert.equal(await g.close(), 0);
      await new Promise((r) => setTimeout(r, 3000));
      assert.equal(posted, 0);
      assert.match(fs.readFileSync(path.join(dir, 'gate.log'), 'utf8'), /"event":"report","status":"off","reason":"this account allows unsigned blocks/);
    } finally {
      server.close();
    }
  });

  it('report_to: a bad address is logged at the start of the session, and the runs go on', async () => {
    const logFile = path.join(dir, 'gate.log');
    writeConf(['report_to = ftp://reports.example.net/runs']);
    try {
      const g = start();
      await g.hello();
      const [m, s] = await signed(fence('bash', 'echo fine'), {});
      await g.request('load', m, s);
      assert.equal((await g.request('run', '1')).out, 'fine\n');
      assert.equal(await g.close(), 0);
      assert.match(fs.readFileSync(logFile, 'utf8'), /"event":"report","status":"off","reason":"report_to must be an https address/);
    } finally {
      writeConf([]);
    }
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

  it('fails closed on an empty scope list and a missing --config (security review, 2026-11-16)', async () => {
    // Before, an empty list meant every scope, and a missing file the built-in defaults.
    const cases: [string, string[]][] = [
      ['--scopes=', [`--config=${conf}`, '--scopes=']],
      ['--scopes=,', [`--config=${conf}`, '--scopes=,']],
      ['scopes =', [`--config=${confAt('empty-scopes.conf', ['scopes =  # none'])}`]],
      ['missing --config', [`--config=${path.join(dir, 'no-such.conf')}`]],
    ];
    for (const [what, args] of cases) {
      const g = new Gate(args, env());
      gates.push(g);
      // A gate that started would wait for requests: with none, it ends with 0.
      g.child.stdin!.end();
      assert.equal(await g.exited, 2, what);
    }
  });

  // ---- security review round 3 (2026-11-16) ----

  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  /** The exit code and stderr of a gate that stops before its session (stdin closed at once). */
  const startup = async (args: string[], extra: Record<string, string> = {}): Promise<{ code: number | null; err: string }> => {
    const g = new Gate(args, { ...env(), ...extra });
    gates.push(g);
    let err = '';
    g.child.stderr!.on('data', (d: Buffer) => (err += d.toString('utf8')));
    g.child.stdin!.end();
    return { code: await g.exited, err };
  };
  /** A raw request whose text ends with the marker, as the app's cellCommand does. */
  const rawLine = (id: string, text: string): string =>
    `raw ${id} ${toBase64(`${text}\nprintf '\\036%s %s\\n' __MDRB_${id}__ 0 >&2; printf '\\036%s %s\\n' __MDRB_${id}__ 0\n`)}\n`;

  it("a block can't swap the next block's code or write into the shell's pipe: no run file, no named pipe", async () => {
    const g = start();
    await g.hello();
    // The reviewer's repro (fifo_toctou.sh), as a background program of the account: it swaps each
    // run file for a FIFO that serves the hash check the signed text and the shell other code.
    const attack =
      '( i=0; while [ $i -lt 40 ]; do for f in "${TMPDIR:-/tmp}"/md-runbook-gate.*/run.*; do ' +
      '[ -f "$f" ] && rm -f "$f" && mkfifo "$f" && { printf "echo SIGNED\\n" >"$f"; printf "echo INJECTED\\n" >"$f"; } & done; ' +
      'i=$((i + 1)); sleep 0.1; done ) >/dev/null 2>&1 </dev/null & echo armed';
    // The named pipe the shell read: anything written there ran in the shell.
    const pipes =
      'n=0; for f in "${TMPDIR:-/tmp}"/md-runbook-gate.*/* "${TMPDIR:-/tmp}"/md-runbook-gate.*/*/*; do ' +
      '[ -p "$f" ] && n=$((n + 1)); case ${f##*/} in run.*) n=$((n + 1)) ;; esac; done; echo "pipes and run files: $n"';
    const [m, s] = await signed(fence('bash', attack) + fence('bash', 'echo SIGNED') + fence('bash', pipes), { name: 'ops/swap' });
    assert.equal((await g.request('load', m, s)).code, 0);
    assert.equal((await g.request('run', '1')).out, 'armed\n');
    for (let i = 0; i < 5; i++) {
      const r = await g.request('run', '2');
      assert.deepEqual([r.code, r.out], [0, 'SIGNED\n']);
    }
    assert.equal((await g.request('run', '3')).out, 'pipes and run files: 0\n');
    await g.close();
  });

  it("a block's background programs end with its shell, at the latest with the session", { skip: process.platform === 'win32' && "a gate run through a wrapper: its pids are not Windows' own" }, async () => {
    const pidFile = path.join(dir, 'background.pid');
    fs.rmSync(pidFile, { force: true });
    const [m, s] = await signed(fence('bash', `sleep 300 >/dev/null 2>&1 </dev/null & echo $! >${shPath(pidFile)}; echo started`), { name: 'ops/background' });
    const g = start();
    await g.hello();
    await g.request('load', m, s);
    assert.equal((await g.request('run', '1')).out, 'started\n');
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    assert.ok(alive(pid));
    assert.equal(await g.close(), 0);
    for (let i = 0; i < 50 && alive(pid); i++) await pause(100);
    assert.equal(alive(pid), false, 'the background program ended with the session');
  });

  it('a runbook keeps its shell across a call into another runbook, which has its own', async () => {
    const g = start();
    await g.hello();
    const [a, as, ah] = await signed(
      fence('bash', 'A=1; cd /; f() { echo func; }; set -e') +
        fence('bash', 'echo "A=${A-unset} pwd=$PWD"; type f >/dev/null 2>&1 && echo has-f; case $- in *e*) echo has-e ;; esac; true'),
      { name: 'ops/caller' },
    );
    const [b, bs] = await signed(fence('bash', 'echo "callee: A=${A-unset}"; B=2') + fence('bash', 'echo "B=${B-unset}"'), { name: 'ops/callee' });
    assert.equal((await g.request('load', a, as)).code, 0);
    assert.equal((await g.request('run', '1')).code, 0);
    // As the app runs a call: the callee loads, runs, and the caller's next block loads it again.
    assert.equal((await g.request('called', ah, '1')).code, 0);
    assert.equal((await g.request('load', b, bs)).code, 0);
    assert.equal((await g.request('run', '1')).out, 'callee: A=unset\n');
    assert.equal((await g.request('load', a, as)).code, 0);
    const back = await g.request('run', '2');
    assert.deepEqual([back.code, back.out], [0, 'A=1 pwd=/\nhas-f\nhas-e\n']);
    assert.equal((await g.request('load', b, bs)).code, 0);
    assert.equal((await g.request('run', '2')).out, 'B=2\n');
    await g.close();
  });

  it('unsigned text never shares a shell with a signed runbook loaded after it', async () => {
    const uconf = confAt('dirty.conf', [`authorized_keys = ${keysAt('dirty.keys', [keyLine(' --unsigned=allow')])}`]);
    const g = new Gate([`--config=${uconf}`, '--unsigned=allow'], env());
    gates.push(g);
    await g.hello();
    const check = 'echo "A=${A-unset}"; type f >/dev/null 2>&1 && echo has-f; true';
    const [m, s] = await signed(fence('bash', check) + fence('bash', 'echo "C=${C-unset}"; C=signed'), { name: 'ops/after-raw' });
    // Before the first load: before, the first signed runbook got this shell.
    g.child.stdin!.write(rawLine('0000aa01', 'A=planted; f() { echo planted; }'));
    assert.equal((await g.reply('0000aa01')).code, 0);
    assert.equal((await g.request('load', m, s)).code, 0);
    assert.deepEqual((await g.request('run', '1')).out, 'A=unset\n');
    // After it: the next load of that runbook gets a fresh shell.
    assert.equal((await g.request('run', '2')).out, 'C=unset\n');
    g.child.stdin!.write(rawLine('0000aa02', 'A=again; f() { echo planted; }'));
    assert.equal((await g.reply('0000aa02')).code, 0);
    assert.equal((await g.request('load', m, s)).code, 0);
    assert.equal((await g.request('run', '1')).out, 'A=unset\n');
    assert.equal((await g.request('run', '2')).out, 'C=unset\n');
    await g.close();
  });

  it("the blocks' environment: the gate's own names only, not what sshd's environment= adds", async () => {
    const kconf = confAt('env.conf', ['kubeconfig = /etc/md-runbook/kubeconfig']);
    // What environment= in a key line or ~/.ssh/environment could pass (PermitUserEnvironment).
    const g = new Gate([`--config=${kconf}`], { ...env(), https_proxy: 'http://evil:3128', PYTHONPATH: '/tmp/evil', KUBECONFIG: '/tmp/evil', NOTE: 'x', TZ: 'UTC' });
    gates.push(g);
    await g.hello();
    const [m, s] = await signed(fence('bash', 'echo "[${https_proxy-}|${PYTHONPATH-}|${NOTE-}|${KUBECONFIG-}|${TZ-}|${HOME:+home}]"; case $SHELL in */bash | */sh) echo shell ;; esac'), {
      name: 'ops/env',
    });
    assert.equal((await g.request('load', m, s)).code, 0);
    const r = await g.request('run', '1');
    assert.deepEqual([r.code, r.out], [0, '[|||/etc/md-runbook/kubeconfig|UTC|home]\nshell\n']);
    await g.close();
    assert.equal((await startup([`--config=${confAt('bad-kube.conf', ['kubeconfig = relative/config'])}`])).code, 2);
  });

  it('sshd_force_command counts only from a gate.conf the account can\'t change, never from a key line\'s option', async () => {
    // The test's files are the account's own, as a planted config would be.
    const force = confAt('force.conf', ['sshd_force_command = yes']);
    const withFlag = await startup([`--config=${force}`, '--sshd-force-command']);
    assert.equal(withFlag.code, 2);
    assert.match(withFlag.err, /a file this account can change/);
    // gate.conf alone: key lines that share it skipped their check (security review round 4).
    const confAlone = await startup([`--config=${force}`]);
    assert.equal(confAlone.code, 2);
    assert.match(confAlone.err, /sshd_force_command = yes in .* needs --sshd-force-command on sshd_config's ForceCommand line/);
    // The option alone switched the check of the key lines off.
    const alone = await startup([`--config=${conf}`, '--sshd-force-command']);
    assert.equal(alone.code, 2);
    assert.match(alone.err, /--sshd-force-command needs sshd_force_command = yes/);
  });

  it('authorized_keys: %h, %U and %% as sshd expands them; any other token stops the session', async () => {
    const uid = spawnSync(SH, ['-c', 'id -u'], { encoding: 'utf8' }).stdout.trim();
    keysAt(`keys-${uid}%x`, [keyLine()]);
    const g = new Gate([`--config=${confAt('tokens.conf', ['authorized_keys = %h/keys-%U%%x'])}`], env());
    gates.push(g);
    assert.match((await g.hello()).out, /unsigned=refuse/);
    assert.equal(await g.close(), 0);
    // Before, %U (and any token but %h and %u) stayed as it was: a file the gate never read.
    const bad = await startup([`--config=${confAt('bad-tokens.conf', ['authorized_keys = %h/keys-%z'])}`]);
    assert.equal(bad.code, 2);
    assert.match(bad.err, /unknown token %z/);
  });

  it("under sshd it refuses a login shell that reads the account's files first (bash's ~/.bashrc)", async (t) => {
    const sshd = { SSH_CLIENT: '192.0.2.1 5555 22', SSH_CONNECTION: '192.0.2.1 5555 192.0.2.2 22' };
    // The reviewer's repro (bashrc_ssh.sh): Debian's bash runs ~/.bashrc for `bash -c` under sshd.
    const bash = spawnSync(SH, ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout.trim();
    if (bash) {
      const home = fs.mkdtempSync(path.join(dir, 'bashrc-'));
      fs.writeFileSync(path.join(home, '.bashrc'), 'echo BASHRC-RAN\n');
      const run = (extra: Record<string, string>): string =>
        spawnSync(SH, ['-c', 'exec bash -c "echo the-forced-command"'], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: shPath(home), ...extra } }).stdout;
      t.diagnostic(`bash -c under sshd read ~/.bashrc: ${/BASHRC-RAN/.test(run(sshd))} (control, without SSH_CLIENT: ${/BASHRC-RAN/.test(run({}))})`);
    }
    // The login shell the gate finds: getent's, else $SHELL (which the test sets).
    const found = spawnSync(SH, ['-c', 'command -v getent >/dev/null 2>&1 && getent passwd "$(id -un)" | cut -d: -f7'], { encoding: 'utf8' }).stdout.trim() || '/bin/bash';
    if (/^(sh|dash|ash|busybox|ksh|ksh93|mksh|lksh|oksh|posh)$/.test(path.posix.basename(found))) {
      t.skip(`this account's login shell is ${found}, which reads nothing first`);
      return;
    }
    const r = await startup([`--config=${conf}`], { ...sshd, SHELL: '/bin/bash' });
    assert.equal(r.code, 2);
    assert.match(r.err, /login shell is .*: it can run files of the account before the gate .*Make it \/bin\/sh/);
    // An allowlist (security review round 4): before, any other shell passed while the home folder
    // was read-only and had no ~/.bashrc, though fish or a planted file elsewhere may run first.
    if (process.platform !== 'win32' && process.getuid?.() !== 0) {
      const home = fs.mkdtempSync(path.join(dir, 'ro-home-'));
      fs.mkdirSync(path.join(home, '.md-runbook-gate', 'pids'), { recursive: true });
      fs.chmodSync(home, 0o555);
      try {
        const ro = await startup([`--config=${conf}`], { ...sshd, SHELL: '/usr/bin/fish', HOME: home });
        assert.equal(ro.code, 2);
        assert.match(ro.err, /login shell is .*Make it \/bin\/sh/);
      } finally {
        fs.chmodSync(home, 0o755);
      }
    }
    // login_shell_check = no (for tests on servers whose accounts have bash): it starts.
    const g = new Gate([`--config=${confAt('no-shell-check.conf', ['login_shell_check = no'])}`], { ...env(), ...sshd, SHELL: '/bin/bash' });
    gates.push(g);
    assert.match((await g.hello()).out, /unsigned=refuse/);
    assert.equal(await g.close(), 0);
  });

  it("report_to: a block can't write the exit of another run", async () => {
    const got: string[] = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d: Buffer) => (body += d.toString('utf8')));
      req.on('end', () => {
        got.push(body);
        res.writeHead(202).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    writeConf([`report_to = http://127.0.0.1:${(server.address() as { port: number }).port}/v1/runs`]);
    try {
      const g = start();
      await g.hello();
      // A line for run 2 after its real one: before, the last line counted, so `false` passed.
      const mark = path.join(dir, 'forged');
      fs.rmSync(mark, { force: true });
      const forge =
        `t=$(printf '\\t'); for w in "\${TMPDIR:-/tmp}"/md-runbook-gate.*; do ( i=0; ` +
        `while [ $i -lt 200 ] && ! grep -q "^2$t" "$w/report-exits" 2>/dev/null; do sleep 0.1; i=$((i + 1)); done; ` +
        `printf '2\\t0\\t2026-01-01T00:00:00Z\\t0123abcd\\n' >>"$w/report-exits"; : >${shPath(mark)} ) >/dev/null 2>&1 </dev/null & done; echo armed`;
      const [m, s] = await signed(fence('bash', forge) + fence('bash', 'false'), { name: 'ops/forged' });
      assert.equal((await g.request('load', m, s)).code, 0);
      assert.equal((await g.request('run', '1')).out, 'armed\n');
      assert.equal((await g.request('run', '2')).code, 1);
      for (let i = 0; i < 200 && !fs.existsSync(mark); i++) await pause(100);
      assert.ok(fs.existsSync(mark), 'the forged line was written');
      assert.equal(await g.close(), 0);
      for (let i = 0; i < 100 && got.length === 0; i++) await pause(150);
      const summary = JSON.parse(got[0]!);
      assert.deepEqual(
        summary.steps.map((x: { state: string }) => x.state),
        ['passed', 'failed'],
      );
    } finally {
      server.close();
      writeConf([]);
    }
  });

  // ---- security review round 4 (2026-11-16) ----

  it("a block's program that ignores TERM ends with the session all the same (KILL a second later)", { skip: process.platform === 'win32' && "a gate run through a wrapper: its pids are not Windows' own" }, async () => {
    const pidFile = path.join(dir, 'ignores-term.pid');
    fs.rmSync(pidFile, { force: true });
    const [m, s] = await signed(fence('bash', `(trap '' TERM; exec sleep 300) >/dev/null 2>&1 </dev/null & echo $! >${shPath(pidFile)}; echo started`), { name: 'ops/ignores-term' });
    const g = start();
    await g.hello();
    await g.request('load', m, s);
    assert.equal((await g.request('run', '1')).out, 'started\n');
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    assert.ok(alive(pid));
    assert.equal(await g.close(), 0);
    // Before, only TERM was sent: the program ran on, into later sessions.
    for (let i = 0; i < 50 && alive(pid); i++) await pause(100);
    assert.equal(alive(pid), false, 'the program was killed');
  });

  // In a user and PID namespace of its own, where every process is this test's: kill_leftovers
  // ends the account's processes outside a live session (elsewhere: the CI runner's own).
  const unshare = process.platform === 'linux' && spawnSync('unshare', ['-rpf', '--mount-proc', 'true']).status === 0;
  it('kill_leftovers: no program of an earlier session outlives it or writes into a later session\'s shell', { skip: !unshare && 'needs unshare -rpf (Linux user namespaces)' }, async () => {
    const d = fs.mkdtempSync(path.join(dir, 'leftovers-'));
    const lconf = confAt('leftovers.conf', ['kill_leftovers = yes', 'isolation = none']);
    // Session 1: a block leaves a program in a session of its own (setsid) and one that ignores TERM.
    const [m1, s1] = await signed(fence('bash', "setsid sh -c 'exec sleep 41' >/dev/null 2>&1 </dev/null & (trap '' TERM; exec sleep 42) >/dev/null 2>&1 </dev/null & echo started"), { name: 'ops/leaves' });
    fs.writeFileSync(path.join(d, 'req1'), `: mdrb-gate-hello feed0001; x\nload 00000001 ${m1} ${s1}\nrun 00000002 1\n`);
    // Session 2: a block that runs a second, long enough for an injector to find its shell.
    const [m2, s2] = await signed(fence('bash', 'sleep 1.5; echo second'), { name: 'ops/later' });
    fs.writeFileSync(path.join(d, 'req2'), `: mdrb-gate-hello feed0002; x\nload 00000003 ${m2} ${s2}\nrun 00000004 1\n`);
    // The reviewer's leftover.sh: a program of the account writes into every cells' shell it finds
    // through /proc. Started between the sessions, its parent gone (PID 1 adopts it). (The shells
    // read an anonymous pipe, pipe:[N]: here, every process whose stdin is a pipe.)
    fs.writeFileSync(
      path.join(d, 'injector.sh'),
      "trap '' TERM HUP; i=0; while [ $i -lt 100 ]; do for f in /proc/[0-9]*/fd/0; do t=$(readlink \"$f\" 2>/dev/null) || continue; " +
        `case $t in pipe:*) printf 'echo INJECTED >>%s\\n' '${d}/injected' >"$f" 2>/dev/null ;; esac; done; sleep 0.05; i=$((i + 1)); done\n`,
    );
    fs.writeFileSync(
      path.join(d, 'driver.sh'),
      [
        `${GATE} --config=${lconf} <${d}/req1 >${d}/out1 2>&1`,
        'sleep 1',
        `ps -e -o args= >${d}/ps1`,
        `( setsid sh ${d}/injector.sh >/dev/null 2>&1 </dev/null & )`,
        'sleep 0.5',
        `${GATE} --config=${lconf} <${d}/req2 >${d}/out2 2>&1`,
        'sleep 0.5',
        `ps -e -o args= >${d}/ps2`,
      ].join('\n') + '\n',
    );
    const r = spawnSync('unshare', ['-rpf', '--mount-proc', 'sh', '-c', `sh ${d}/driver.sh; :`], { env: { ...process.env, HOME: dir, TMPDIR: dir }, encoding: 'utf8', timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    const read = (f: string): string => fs.readFileSync(path.join(d, f), 'utf8');
    assert.match(read('out1'), /\x1e__MDRB_00000002__ 0/);
    assert.match(read('out2'), /second\n/);
    assert.doesNotMatch(read('ps1'), /sleep 4[12]/, 'the programs of session 1 ended with it');
    assert.equal(fs.existsSync(path.join(d, 'injected')), false, 'nothing was written into session 2\'s shell');
    assert.doesNotMatch(read('ps2'), /injector/, 'the leftover was ended when session 2 started');
    assert.match(fs.readFileSync(path.join(dir, 'gate.log'), 'utf8'), /"event":"leftovers","status":"killed".*"when":"start"/);
  });

  // ---- security review round 5 (2026-11-16) ----

  it('kill_leftovers: a leftover that forks and exits again and again (its pid never holds still) is ended too', { skip: !unshare && 'needs unshare -rpf (Linux user namespaces)' }, async () => {
    const d = fs.mkdtempSync(path.join(dir, 'hopper-'));
    const lconf = confAt('hopper.conf', ['kill_leftovers = yes', 'isolation = none']);
    const [m, s] = await signed(fence('bash', 'sleep 1.5; echo second'), { name: 'ops/later' });
    fs.writeFileSync(path.join(d, 'req'), `: mdrb-gate-hello feed0003; x\nload 00000005 ${m} ${s}\nrun 00000006 1\n`);
    // The reviewer's hop.pl: each generation forks the next and exits, and writes into every
    // cells' shell it finds through /proc. Before, the sweep stopped a pid already gone, 4 times.
    fs.writeFileSync(
      path.join(d, 'hop.pl'),
      [
        "$SIG{TERM} = 'IGNORE'; $SIG{HUP} = 'IGNORE';",
        'my ($out, $end) = ($ARGV[0], time + 8);',
        'while (time < $end) {',
        '  my $p = fork; exit 0 if !defined $p || $p;',
        "  for my $fd (glob '/proc/[0-9]*/fd/0') {",
        '    my $t = readlink $fd or next;',
        '    next unless $t =~ m{^pipe:};',
        "    if (open my $w, '>', $fd) { print $w \"echo INJECTED >>$out\\n\"; close $w }",
        '  }',
        '  select undef, undef, undef, 0.003;',
        '}',
      ].join('\n') + '\n',
    );
    fs.writeFileSync(
      path.join(d, 'driver.sh'),
      [
        `( setsid perl ${d}/hop.pl ${d}/injected >/dev/null 2>&1 </dev/null & )`,
        'sleep 0.5',
        `${GATE} --config=${lconf} <${d}/req >${d}/out 2>&1`,
        'sleep 0.3',
        `ps -e -o args= >${d}/ps`,
      ].join('\n') + '\n',
    );
    const r = spawnSync('unshare', ['-rpf', '--mount-proc', 'sh', '-c', `sh ${d}/driver.sh; :`], { env: { ...process.env, HOME: dir, TMPDIR: dir }, encoding: 'utf8', timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    const read = (f: string): string => fs.readFileSync(path.join(d, f), 'utf8');
    assert.match(read('out'), /second\n/);
    assert.equal(fs.existsSync(path.join(d, 'injected')), false, "nothing was written into the session's shell");
    assert.doesNotMatch(read('ps'), /hop\.pl/, 'the fork loop was ended when the session started');
  });

  it("kill_leftovers: when the client goes first, the gate's end leaves sshd and other sessions alone", { skip: !unshare && 'needs unshare -rpf (Linux user namespaces)' }, async () => {
    // As in the ops image, where sshd runs as the account: a listener (its parent PID 1) starts a
    // connection, which starts the gate and ends while a block runs (the client went). Before, the
    // gate's parent was then PID 1, its session the gate alone, and the end sweep killed the
    // listener: the ops image's container ended (exit 137 in the Ops host workflow).
    const d = fs.mkdtempSync(path.join(dir, 'orphan-'));
    const lconf = confAt('orphan.conf', ['kill_leftovers = yes', 'isolation = none']);
    const [m, s] = await signed(fence('bash', 'sleep 1.5; echo second'), { name: 'ops/later' });
    fs.writeFileSync(path.join(d, 'req'), `: mdrb-gate-hello feed0004; x\nload 00000007 ${m} ${s}\nrun 00000008 1\n`);
    fs.writeFileSync(
      path.join(d, 'conn.sh'),
      `${GATE} --config=${lconf} <${d}/req >${d}/out 2>&1 &\n` +
        `i=0; while [ $i -lt 200 ] && ! grep -q SIGNED ${d}/out; do sleep 0.05; i=$((i + 1)); done\n`,
    );
    fs.writeFileSync(path.join(d, 'listener.sh'), `echo $$ >${d}/listener.pid\nsh ${d}/conn.sh\nexec sleep 30\n`);
    fs.writeFileSync(
      path.join(d, 'driver.sh'),
      [
        `sh ${d}/listener.sh &`,
        // (Each sleep short: the start sweep may end one; the driver is no session's.)
        'i=0; while [ $i -lt 20 ]; do sleep 0.2; i=$((i + 1)); done',
        `kill -0 "$(cat ${d}/listener.pid)" && echo alive >${d}/listener`,
        `kill "$(cat ${d}/listener.pid)"`,
      ].join('\n') + '\n',
    );
    const r = spawnSync('unshare', ['-rpf', '--mount-proc', 'sh', '-c', `sh ${d}/driver.sh; :`], { env: { ...process.env, HOME: dir, TMPDIR: dir }, encoding: 'utf8', timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    assert.match(fs.readFileSync(path.join(d, 'out'), 'utf8'), /second\n/);
    assert.equal(fs.existsSync(path.join(d, 'listener')), true, 'the listener outlived the gate');
  });

  it('a request longer than 4000000 bytes ends the session; the gate never reads more of it', { skip: process.platform === 'win32' && 'a gate run through a wrapper reads a 4 MB line slowly' }, async () => {
    const g = start();
    let err = '';
    let out = '';
    g.child.stderr!.on('data', (d: Buffer) => (err += d.toString('utf8')));
    g.child.stdout!.on('data', (d: Buffer) => (out += d.toString('utf8')));
    // (What it never read: written into a closed pipe.)
    g.child.stdin!.on('error', () => undefined);
    // Before, the gate read the whole line (a 32 MB one: 67 MB and 24 seconds), said so, and went on.
    g.child.stdin!.write('a'.repeat(4_000_050) + '\n: mdrb-gate-hello feed0001; x\n');
    const code = await Promise.race([g.exited, pause(60_000).then(() => 'still running')]);
    assert.equal(code, 0);
    assert.match(err, /request too long: the session ends/);
    assert.doesNotMatch(out, /__MDRB_GATE__/, 'nothing after it was read');
    // A request at the limit is read as one.
    const ok = start();
    ok.child.stdin!.write('b'.repeat(3_999_990) + '\n');
    assert.match((await ok.hello()).out, /__MDRB_GATE__/);
    await ok.close();
  });

  it("report_to: the signer comes from the gate's memory, not a file a block can change", async () => {
    const got: string[] = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d: Buffer) => (body += d.toString('utf8')));
      req.on('end', () => {
        got.push(body);
        res.writeHead(202).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    writeConf([`report_to = http://127.0.0.1:${(server.address() as { port: number }).port}/v1/runs`]);
    try {
      const g = start();
      await g.hello();
      // The reviewer's c_meta.sh: before, line 3 of rb-HASH.meta was the reported signer.
      const forge = 'for w in "${TMPDIR:-/tmp}"/md-runbook-gate.*; do for r in "$w"/rb-*; do case $r in *.meta) continue ;; esac; ' +
        "printf 'x\\n1\\nceo@example.net (forged)\\n' >\"$r.meta\"; done; done; echo forged";
      const [m, s] = await signed(fence('bash', forge), { name: 'ops/meta' });
      assert.equal((await g.request('load', m, s)).code, 0);
      assert.equal((await g.request('run', '1')).out, 'forged\n');
      assert.equal(await g.close(), 0);
      for (let i = 0; i < 100 && got.length === 0; i++) await pause(150);
      assert.equal(JSON.parse(got[0]!).runbook.signed.signer, 'ops@example.net');
    } finally {
      server.close();
      writeConf([]);
    }
  });

  it('unsigned text in the loaded runbook\'s shell: its next signed block runs in a fresh one', async () => {
    const uconf = confAt('dirty-run.conf', ['unsigned = allow', `authorized_keys = ${keysAt('dirty-run.keys', [keyLine(' --unsigned=allow')])}`]);
    const g = new Gate([`--config=${uconf}`], env());
    gates.push(g);
    await g.hello();
    const [m, s] = await signed(fence('bash', 'X=signed') + fence('bash', 'echo "X=${X-unset}"'), { name: 'ops/raw-then-run' });
    assert.equal((await g.request('load', m, s)).code, 0);
    assert.equal((await g.request('run', '1')).code, 0);
    // The reviewer's req_dirty: before, the next run (no load in between) found X=from-raw.
    g.child.stdin!.write(rawLine('0000ab01', 'X=from-raw'));
    assert.equal((await g.reply('0000ab01')).code, 0);
    const r = await g.request('run', '2');
    assert.deepEqual([r.code, r.out], [0, 'X=unset\n']);
    await g.close();
  });

  it("the gate's own environment: no ~/.ssh/environment, and LD_PRELOAD and the like never reach its programs", async () => {
    const home = fs.mkdtempSync(path.join(dir, 'ssh-env-'));
    fs.mkdirSync(path.join(home, '.ssh'));
    fs.writeFileSync(path.join(home, '.ssh', 'environment'), 'LD_PRELOAD=/tmp/evil.so\n');
    const r = await startup([`--config=${conf}`], { HOME: home });
    assert.equal(r.code, 2);
    assert.match(r.err, /\.ssh\/environment can set the gate's environment/);
    // glibc says so for each program a missing LD_PRELOAD library was meant for: the shell gate
    // let it reach every program it ran (ssh-keygen, awk, ...) before round 4, and sh itself after.
    // The gate is a static program now (no loader reads LD_PRELOAD), and removes it before it
    // starts any program: never.
    if (process.platform === 'win32') return;
    const g = new Gate([`--config=${conf}`], { ...env(), LD_PRELOAD: '/nonexistent/md-runbook-test.so' });
    gates.push(g);
    let err = '';
    g.child.stderr!.on('data', (d: Buffer) => (err += d.toString('utf8')));
    await g.hello();
    const [m, s] = await signed(fence('bash', 'echo "[${LD_PRELOAD-}]"'), { name: 'ops/preload' });
    assert.equal((await g.request('load', m, s)).code, 0);
    assert.equal((await g.request('run', '1')).out, '[]\n');
    await g.close();
    assert.doesNotMatch(err, /md-runbook-test\.so/);
  });

  it('fails closed on a bad kill_leftovers, allow_no_group_kill or memory_limit', async () => {
    for (const bad of ['kill_leftovers = maybe', 'allow_no_group_kill = 1', 'memory_limit = lots', 'memory_limit = 0512']) {
      const r = await startup([`--config=${confAt('bad-r4.conf', [bad])}`]);
      assert.equal(r.code, 2, bad);
    }
  });

  // ---- the Go gate (0.28.0) ----

  it('allow_no_group_kill is obsolete: an old gate.conf with it starts, and the log says it is ignored', async () => {
    const old = confAt('old.conf', ['allow_no_group_kill = yes']);
    const g = new Gate([`--config=${old}`], env());
    gates.push(g);
    await g.hello();
    const [m, s] = await signed(fence('bash', 'echo old-conf'), { name: 'ops/old-conf' });
    assert.equal((await g.request('load', m, s)).code, 0);
    assert.equal((await g.request('run', '1')).out, 'old-conf\n');
    assert.equal(await g.close(), 0);
    assert.match(fs.readFileSync(path.join(dir, 'gate.log'), 'utf8'), /"event":"notice","reason":"allow_no_group_kill in .*old\.conf is obsolete and ignored/);
  });

  it('memory_limit: a session that makes the gate hold more ends', async () => {
    const small = confAt('small.conf', ['memory_limit = 2']);
    const g = new Gate([`--config=${small}`], env());
    gates.push(g);
    let err = '';
    let out = '';
    g.child.stderr!.on('data', (d: Buffer) => (err += d.toString('utf8')));
    g.child.stdout!.on('data', (d: Buffer) => (out += d.toString('utf8')));
    g.child.stdin!.on('error', () => undefined);
    g.child.stdin!.write('x'.repeat(3_000_000) + '\n: mdrb-gate-hello feed0001; x\n');
    assert.equal(await g.exited, 0);
    assert.match(err, /over memory_limit: the session ends/);
    assert.doesNotMatch(out, /__MDRB_GATE__/);
    assert.match(fs.readFileSync(path.join(dir, 'gate.log'), 'utf8'), /"event":"refused","reason":"memory_limit reached"/);
  });

  it('a TERM ends the session at once, also while the gate waits to write to a busy shell', async () => {
    // The second block's text (100 KB) doesn't fit in the shell's pipe while the first one sleeps:
    // the gate waits in that write. Before the shells ended there, a TERM waited for the block.
    const [m, s] = await signed(fence('bash', 'sleep 30') + fence('bash', 'echo big # ' + 'x'.repeat(100_000)), { name: 'ops/busy' });
    const g = start();
    await g.hello();
    assert.equal((await g.request('load', m, s)).code, 0);
    g.child.stdin!.write('run 0000c001 1\nrun 0000c002 2\nrun 0000c003 2\n');
    await pause(1000);
    g.child.kill('SIGTERM');
    const code = await Promise.race([g.exited, pause(15_000).then(() => 'still running')]);
    assert.equal(code, 1);
  });

  it('each shell leads a process group and session of its own (no setsid or perl needed)', { skip: process.platform !== 'linux' && 'reads /proc' }, async () => {
    // The gate starts its shells with setsid(2) itself. (Before, the shell gate needed setsid or
    // perl on the server, else the shells shared the gate's group; security review round 3.)
    const g = start();
    await g.hello();
    const [m, s] = await signed(fence('bash', 'read -r _ _ _ _ pgid sid _ </proc/self/stat; [ "$pgid" = "$$" ] && [ "$sid" = "$$" ] && echo own-group; echo "$$"'), { name: 'ops/group' });
    assert.equal((await g.request('load', m, s)).code, 0);
    const r = await g.request('run', '1');
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^own-group\n\d+\n$/);
    assert.notEqual(Number(r.out.split('\n')[1]), g.child.pid);
    await g.close();
  });

  // ---- isolation (0.28.0): each session's cells in a scope of their own ----

  /** The isolations this server must have, best first (CI says; else the tests take what is there). */
  const HAVE = (process.env.MD_RUNBOOK_GATE_ISOLATIONS ?? '').split(',').filter(Boolean);
  /** The newest session event of a log. */
  const lastSession = (log: string): Record<string, string> => {
    const lines = log.split('\n').filter((l) => /"event":"session"/.test(l));
    assert.ok(lines.length, 'a session event');
    return JSON.parse(lines.at(-1)!) as Record<string, string>;
  };
  /** The pids whose command line has `marker` (Linux: /proc; the namespace's pids as the host sees them). */
  const procsWith = (marker: string): number[] => {
    const out: number[] = [];
    for (const d of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(d)) continue;
      try {
        if (fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').split('\0').join(' ').includes(marker)) out.push(Number(d));
      } catch {
        // gone meanwhile
      }
    }
    return out;
  };
  const gone = async (marker: string): Promise<boolean> => {
    for (let i = 0; i < 50 && procsWith(marker).length; i++) await pause(100);
    return procsWith(marker).length === 0;
  };
  /** A block that leaves a program behind: a double fork into a session of its own, out of the shell's group. */
  const escape = (marker: string): string => `( setsid sh -c '${marker} >/dev/null 2>&1 </dev/null & exit 0' & ); sleep 0.3; echo started`;

  it('isolation = auto: the session logs its mode and isolation; a double-forked program ends with the session where there is a scope or bwrap', { skip: process.platform !== 'linux' && 'reads /proc' }, async (t) => {
    const marker = 'sleep 3031';
    const [m, s] = await signed(fence('bash', escape(marker)), { name: 'ops/escape' });
    const g = start();
    await g.hello();
    const ev = lastSession(fs.readFileSync(path.join(dir, 'gate.log'), 'utf8'));
    assert.equal(ev.gate_mode, 'shared');
    assert.ok(['scope', 'bwrap', 'none'].includes(ev.isolation!), ev.isolation);
    if (HAVE.length) assert.equal(ev.isolation, HAVE[0], `auto found ${ev.isolation}: ${ev.isolation_off ?? ''}`);
    assert.equal((await g.request('load', m, s)).code, 0);
    assert.equal((await g.request('run', '1')).out, 'started\n');
    assert.ok(procsWith(marker).length > 0, 'the program runs');
    assert.equal(await g.close(), 0);
    if (ev.isolation === 'none') {
      // Only kill_leftovers ends it there (as before).
      for (const p of procsWith(marker)) process.kill(p, 'SIGKILL');
      t.skip(`no scope or bwrap here (${ev.isolation_off ?? ''})`);
      return;
    }
    assert.ok(await gone(marker), `the program ended with the session's ${ev.isolation}`);
  });

  for (const iso of ['scope', 'bwrap'] as const) {
    it(`isolation = ${iso}: required (no ${iso}: the gate doesn't start); with it, programs left behind end with the session and a stop request still reaches the cell`, { skip: process.platform !== 'linux' && 'Linux only' }, async (t) => {
      const iconf = confAt(`${iso}.conf`, [`isolation = ${iso}`]);
      const first = await startup([`--config=${iconf}`]);
      if (first.code !== 0) {
        assert.equal(first.code, 2);
        assert.match(first.err, new RegExp(`isolation = ${iso}: .*Use isolation = auto or none`));
        assert.ok(!HAVE.includes(iso), `this server should have ${iso}: ${first.err}`);
        t.skip(`no ${iso} here: ${first.err.trim()}`);
        return;
      }
      const marker = `sleep 304${iso.length}`;
      const [m, s] = await signed(fence('bash', escape(marker)) + fence('bash', 'sleep 3050 && echo late') + fence('bash', 'echo "still-here $$"'), { name: `ops/${iso}` });
      const g = new Gate([`--config=${iconf}`], env());
      gates.push(g);
      const session = (await g.hello()).code;
      assert.equal(lastSession(fs.readFileSync(path.join(dir, 'gate.log'), 'utf8')).isolation, iso);
      assert.equal((await g.request('load', m, s)).code, 0);
      assert.equal((await g.request('run', '1')).out, 'started\n');
      assert.ok(procsWith(marker).length > 0);
      const running = g.request('run', '2');
      for (let i = 0; i < 100 && !procsWith('sleep 3050').length; i++) await pause(50);
      const stop = new Gate([`--config=${iconf}`], env(), `pkill -TERM -P ${session} 2>/dev/null; true`);
      assert.equal(await stop.exited, 0);
      const r = await running;
      assert.notEqual(r.code, 0);
      assert.doesNotMatch(r.out, /late/);
      // The shell went on: the stop reached its programs only.
      assert.match((await g.request('run', '3')).out, /^still-here \d+\n$/);
      assert.equal(await g.close(), 0);
      assert.ok(await gone(marker), `the program ended with the session's ${iso}`);
    });
  }

  // ---- separated mode: the cells as an account of their own ----
  // CI prepares the accounts (.github/workflows/ci.yml, gate job): MD_RUNBOOK_GATE_ACCOUNT runs
  // the gate and has exactly the one sudoers line for MD_RUNBOOK_GATE_CELLS_ACCOUNT;
  // MD_RUNBOOK_GATE_WIDE_ACCOUNT (optional) has a wider one. The test runs them through its own
  // sudo, and keeps their files in folders of theirs.
  const CELLS = process.env.MD_RUNBOOK_GATE_CELLS_ACCOUNT ?? '';
  const GATE_ACCOUNT = process.env.MD_RUNBOOK_GATE_ACCOUNT ?? '';
  const WIDE_ACCOUNT = process.env.MD_RUNBOOK_GATE_WIDE_ACCOUNT ?? '';
  describe('separated mode (cells_account)', { skip: !(CELLS && GATE_ACCOUNT && process.platform === 'linux') && 'needs MD_RUNBOOK_GATE_CELLS_ACCOUNT and MD_RUNBOOK_GATE_ACCOUNT (Linux; set up as in the CI gate job)' }, () => {
    /** `sh -c cmd` as an account, with input; its stdout. */
    const as = (account: string, cmd: string, input = ''): string => {
      const r = spawnSync('sudo', ['-n', '-u', account, '--', '/bin/sh', '-c', cmd], { input, encoding: 'utf8' });
      assert.equal(r.status, 0, `${account}: ${cmd}: ${r.stderr}`);
      return r.stdout;
    };
    const folders: string[] = [];
    /** A folder of the account's own (0700), with its key lines and the trusted keys. */
    const prepare = (account: string): string => {
      const d = as(account, 'mktemp -d /tmp/mdrb-separated.XXXXXX').trim();
      folders.push(d);
      as(account, `cat >${d}/allowed_signers`, fs.readFileSync(path.join(dir, 'allowed_signers'), 'utf8'));
      as(account, `cat >${d}/authorized_keys`, keyLine() + '\n');
      return d;
    };
    const confOf = (account: string, d: string, name: string, lines: string[]): string => {
      const f = `${d}/${name}`;
      as(account, `cat >${f}`, [`allowed_signers = ${d}/allowed_signers`, `log = ${d}/gate.log`, `authorized_keys = ${d}/authorized_keys`, `cells_account = ${CELLS}`, ...lines].join('\n') + '\n');
      return f;
    };
    const startAs = (account: string, d: string, conf: string, command?: string): Gate => {
      const g = new Gate([`--config=${conf}`], { HOME: d, TMPDIR: d }, command, account);
      gates.push(g);
      return g;
    };
    const startupAs = async (account: string, d: string, conf: string): Promise<{ code: number | null; err: string }> => {
      const g = startAs(account, d, conf);
      let err = '';
      g.child.stderr!.on('data', (b: Buffer) => (err += b.toString('utf8')));
      g.child.stdin!.end();
      return { code: await g.exited, err };
    };
    const alive = (pid: number): boolean => spawnSync('sudo', ['-n', 'kill', '-0', String(pid)]).status === 0;
    let gdir = '';
    let conf = '';
    let log = '';
    const readLog = (): string => as(GATE_ACCOUNT, `cat ${log}`);
    before(() => {
      gdir = prepare(GATE_ACCOUNT);
      log = `${gdir}/gate.log`;
      as(GATE_ACCOUNT, `printf 'a-report-token-of-at-least-24-chars\\n' >${gdir}/report-token`);
      conf = confOf(GATE_ACCOUNT, gdir, 'gate.conf', [`report_token_file = ${gdir}/report-token`]);
    });
    after(() => {
      for (const d of folders) spawnSync('sudo', ['-n', 'rm', '-rf', d]);
    });

    it("runs the cells as the cells' account: no report token, no log, no gate folder, its own HOME", async () => {
      const g = startAs(GATE_ACCOUNT, gdir, conf);
      await g.hello();
      const ev = lastSession(readLog());
      assert.deepEqual([ev.gate_mode, ev.cells], ['separated', CELLS]);
      const probe =
        `id -un; cat ${gdir}/report-token 2>/dev/null && echo TOKEN; cat ${log} >/dev/null 2>&1 && echo LOG; ls ${gdir} >/dev/null 2>&1 && echo GATE-FOLDER; ` +
        `for d in /tmp/md-runbook-gate.*; do ls "$d" >/dev/null 2>&1 && echo WORK-FOLDER; done; echo "home=$HOME user=$USER logname=$LOGNAME tmp=\${TMPDIR-unset} pwd=$PWD"; true`;
      const [m, s] = await signed(fence('bash', probe), { name: 'ops/separated' });
      assert.equal((await g.request('load', m, s)).code, 0);
      const r = await g.request('run', '1');
      assert.equal(r.code, 0, r.err);
      assert.match(r.out, new RegExp(`^${CELLS}\\nhome=(/\\S*) user=${CELLS} logname=${CELLS} tmp=unset pwd=\\1\\n$`));
      assert.equal(await g.close(), 0);
      // The gate logged the end event itself, from the exit the shell gave it.
      assert.match(readLog(), /"event":"end","id":"[0-9a-f]{8}","exit":0\}/);
    });

    it('a double-forked program ends with the session; a stop request reaches the running cell (as the cells\' account)', async (t) => {
      const marker = 'sleep 3061';
      const [m, s] = await signed(fence('bash', escape(marker)) + fence('bash', 'sleep 3062 && echo late') + fence('bash', 'echo still-here'), { name: 'ops/separated-stop' });
      const g = startAs(GATE_ACCOUNT, gdir, conf);
      const session = (await g.hello()).code;
      const ev = lastSession(readLog());
      if (HAVE.length) assert.equal(ev.isolation, HAVE[0], `auto found ${ev.isolation}: ${ev.isolation_off ?? ''}`);
      assert.equal((await g.request('load', m, s)).code, 0);
      assert.equal((await g.request('run', '1')).out, 'started\n');
      const left = procsWith(marker);
      assert.ok(left.length > 0);
      const running = g.request('run', '2');
      for (let i = 0; i < 100 && !procsWith('sleep 3062').length; i++) await pause(50);
      const stop = startAs(GATE_ACCOUNT, gdir, conf, `pkill -TERM -P ${session} 2>/dev/null; true`);
      assert.equal(await stop.exited, 0);
      const r = await running;
      assert.notEqual(r.code, 0);
      assert.doesNotMatch(r.out, /late/);
      assert.equal((await g.request('run', '3')).out, 'still-here\n');
      assert.equal(await g.close(), 0);
      if (ev.isolation === 'none') {
        for (const p of left) spawnSync('sudo', ['-n', 'kill', '-KILL', String(p)]);
        t.skip(`no scope or bwrap here (${ev.isolation_off ?? ''})`);
        return;
      }
      assert.ok(await gone(marker), `the program ended with the session's ${ev.isolation}`);
      assert.equal(left.some(alive), false);
    });

    it('report_to: the summary says gate_mode separated (in its gate object), with each block\'s state from the shell', async () => {
      const got: string[] = [];
      const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (d: Buffer) => (body += d.toString('utf8')));
        req.on('end', () => {
          got.push(body);
          res.writeHead(202).end();
        });
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
      try {
        const port = (server.address() as { port: number }).port;
        const rconf = confOf(GATE_ACCOUNT, gdir, 'report.conf', [`report_to = http://127.0.0.1:${port}/v1/runs`, `report_token_file = ${gdir}/report-token`]);
        const g = startAs(GATE_ACCOUNT, gdir, rconf);
        await g.hello();
        const [m, s] = await signed(fence('bash', 'echo ok') + fence('bash', 'false') + fence('bash', 'echo never'), { name: 'ops/separated-report' });
        assert.equal((await g.request('load', m, s)).code, 0);
        assert.equal((await g.request('run', '1')).code, 0);
        assert.equal((await g.request('run', '2')).code, 1);
        assert.equal(await g.close(), 0);
        for (let i = 0; i < 100 && !got.length; i++) await pause(150);
        assert.equal(got.length, 1);
        const summary = JSON.parse(got[0]!);
        assert.deepEqual(runSummaryProblems(summary), []);
        assert.equal(summary.gate.gate_mode, 'separated');
        assert.equal(summary.gate.account, GATE_ACCOUNT);
        assert.equal(summary.gate_mode, undefined);
        assert.deepEqual(
          summary.steps.map((x: { state: string }) => x.state),
          ['passed', 'failed', 'not-run'],
        );
      } finally {
        server.close();
      }
    });

    it('the self-check refuses to start: a token the cells can read, root, the gate\'s own account, a wider sudo rule', async (t) => {
      // A token in a folder anyone can enter, readable by anyone.
      const open = as(GATE_ACCOUNT, 'd=$(mktemp -d /tmp/mdrb-open.XXXXXX) && chmod 755 "$d" && printf token >"$d/token" && chmod 644 "$d/token" && echo "$d"').trim();
      folders.push(open);
      const readable = await startupAs(GATE_ACCOUNT, gdir, confOf(GATE_ACCOUNT, gdir, 'open-token.conf', [`report_token_file = ${open}/token`]));
      assert.equal(readable.code, 2);
      assert.match(readable.err, new RegExp(`${CELLS} can read ${open}/token`));
      assert.match(readLog(), /"event":"self-check","status":"refused"/);
      for (const [account, why] of [
        ['root', /is root/],
        [GATE_ACCOUNT, /the gate's own account/],
      ] as const) {
        const f = `${gdir}/cells-${account}.conf`;
        as(GATE_ACCOUNT, `sed 's/^cells_account = .*/cells_account = ${account}/' ${conf} >${f}`);
        const r = await startupAs(GATE_ACCOUNT, gdir, f);
        assert.equal(r.code, 2, account);
        assert.match(r.err, why);
      }
      if (!WIDE_ACCOUNT) {
        t.skip('a wider sudo rule: set MD_RUNBOOK_GATE_WIDE_ACCOUNT');
        return;
      }
      const wdir = prepare(WIDE_ACCOUNT);
      const wide = await startupAs(WIDE_ACCOUNT, wdir, confOf(WIDE_ACCOUNT, wdir, 'gate.conf', []));
      assert.equal(wide.code, 2);
      assert.match(wide.err, /not exactly the one rule/);
      assert.ok(wide.err.includes(`${WIDE_ACCOUNT} ALL=(${CELLS}) NOPASSWD: ${fs.realpathSync(GATE)} __cells`), wide.err);
    });
  });
});
