import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { SentinelFilter } from '@md-runbook/core';
import {
  cellCommand,
  gateBanner,
  gateLoadCommand,
  gateParamCommand,
  gateRawCommand,
  gateRunCommand,
  helloCommand,
  markerFor,
  PROBED_SHELLS,
  posixShellCommand,
  shellProbeCommand,
  signedReply,
  sq,
  stopCommand,
} from '@md-runbook/ssh';

describe('ssh: md-runbook-gate requests', () => {
  it('one line each, values in base64; the banner and the load reply are recognized', () => {
    assert.equal(gateLoadCommand('ab', 'm\n', 'U1NI'), `load ab ${Buffer.from('m\n').toString('base64')} U1NI\n`);
    assert.equal(gateParamCommand('ab', 'T', "x y'"), `param ab T ${Buffer.from("x y'").toString('base64')}\n`);
    assert.equal(gateRunCommand('ab', 3), 'run ab 3\n');
    assert.equal(gateRunCommand('ab', 3, 0), 'step ab 3 0\n');
    assert.equal(gateRawCommand('ab', 'echo\n'), 'raw ab ZWNobwo=\n');
    assert.deepEqual(gateBanner('motd\n\x1e__MDRB_GATE__ 1 unsigned=refuse\n'), { protocol: 1, unsigned: 'refuse' });
    assert.equal(gateBanner('plain shell\n'), undefined);
    assert.deepEqual(signedReply(`\x1e__MDRB_SIGNED__ ops@example.net ${'a'.repeat(64)}\n`), { principal: 'ops@example.net', hash: 'a'.repeat(64) });
    assert.match(helloCommand('h'), /^: mdrb-gate-hello h; /);
  });
});

// The commands are plain POSIX shell: run them in a local bash, as the remote shell would.
const bash = process.platform === 'win32' ? undefined : 'bash';

/** Feed `parts` to one bash and split its stdout into the output of each part, with its marker value. */
function session(parts: [id: string, text: string][], cwd = os.tmpdir()): { out: string; code: number | undefined }[] {
  const r = spawnSync(bash!, ['-s'], { input: parts.map(([, t]) => t).join(''), cwd, encoding: 'utf8' });
  let rest = r.stdout;
  return parts.map(([id]) => {
    let out = '';
    const f = new SentinelFilter(markerFor(id), (t) => (out += t));
    const end = rest.indexOf('\n', rest.indexOf(markerFor(id)));
    f.write(rest.slice(0, end + 1));
    rest = rest.slice(end + 1);
    return { out, code: f.code };
  });
}

describe('ssh: commands sent to the remote shell', { skip: !bash && 'needs bash' }, () => {
  it('the hello reports the shell pid', () => {
    const [hello] = session([['h', helloCommand('h')]]);
    assert.ok((hello!.code ?? 0) > 1, String(hello!.code));
  });

  it("the shell probe tells bash from sh and zsh; the runbook's shell: picks the login shell", () => {
    const [probe] = session([['p', shellProbeCommand('p')]]);
    assert.equal(PROBED_SHELLS[probe!.code ?? -1], 'bash');
    assert.match(posixShellCommand('zsh'), /exec zsh -l \|\| exec sh -l$/);
    assert.equal(posixShellCommand('sh'), 'exec sh -l');
    assert.equal(posixShellCommand(undefined), posixShellCommand('bash'));
  });

  it('folder and variables carry over; exit codes come back; stdin is empty', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdrb-ssh-'));
    const [a, b, c] = session([
      ['a', cellCommand(`cd ${sq(dir)}\nX=kept\necho one`, 'a')],
      ['b', cellCommand('echo "$X $(basename "$PWD")"\nfalse', 'b')],
      ['c', cellCommand('read -r line || echo no-stdin; exit_code=7; (exit $exit_code)', 'c')],
    ]);
    assert.deepEqual(a, { out: 'one\n', code: 0 });
    assert.deepEqual(b, { out: `kept ${path.basename(dir)}\n`, code: 1 });
    assert.deepEqual(c, { out: 'no-stdin\n', code: 7 });
  });

  it("the cell's text can't end the here-doc; quotes and $ are kept", () => {
    const tricky = "echo '__MDRB_EOF_x' \"$HOME\" '$HOME' \\\n  done\ncat <<'EOF'\n$(not run)\nEOF";
    const [r] = session([['x', cellCommand(tricky, 'x')]]);
    assert.equal(r!.code, 0);
    assert.equal(r!.out, `__MDRB_EOF_x ${os.homedir()} $HOME done\n$(not run)\n`);
  });

  it('env= values are exported (quoted) and cwd= runs in a folder, then goes back', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdrb-ssh-'));
    const [a, b, c] = session([
      ['a', cellCommand('printf "%s|" "$V" "$(basename "$PWD")"', 'a', { env: { V: `it's $x "y"`, 'bad-name': 'x' }, cwd: dir })],
      ['b', cellCommand('printf "%s|" "$V" "$PWD"', 'b')],
      ['c', cellCommand('echo never', 'c', { cwd: path.join(dir, 'missing') })],
    ]);
    assert.deepEqual(a, { out: `it's $x "y"|${path.basename(dir)}|`, code: 0 });
    assert.equal(b!.out, `it's $x "y"|${fs.realpathSync(os.tmpdir())}|`);
    assert.deepEqual(c, { out: '', code: 1 });
  });

  it('the stop command only targets the children of one pid', () => {
    assert.equal(stopCommand(1234.9, 'TERM'), 'pkill -TERM -P 1234 2>/dev/null; true');
  });
});
