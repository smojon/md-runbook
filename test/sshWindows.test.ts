/**
 * The Windows server protocol (@md-runbook/ssh, windows*Command) against a real Windows
 * PowerShell: the commands an app sends over SSH, fed to `powershell -Command -` on stdin, as
 * OpenSSH on a Windows server would start it. Windows only.
 */
import { strict as assert } from 'node:assert';
import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { WINDOWS_SHELL_COMMAND, markerFor, windowsCellCommand, windowsHelloCommand } from '@md-runbook/ssh';

class Shell {
  readonly child: ChildProcessWithoutNullStreams;
  private out = '';
  private err = '';
  private n = 0;

  constructor() {
    const [exe, ...args] = WINDOWS_SHELL_COMMAND.split(' ');
    this.child = spawn(exe!, args, { stdio: 'pipe', windowsHide: true });
    this.child.stdout.on('data', (d: Buffer) => (this.out += d.toString('utf8')));
    this.child.stderr.on('data', (d: Buffer) => (this.err += d.toString('utf8')));
  }

  /** Send `text(id)`; the output on both streams up to the marker, and its value. */
  async send(text: (id: string) => string): Promise<{ code: number; out: string; err: string }> {
    const id = `cafe${(++this.n).toString(16).padStart(4, '0')}`;
    this.child.stdin.write(text(id));
    const re = new RegExp(`\\x1e${markerFor(id)} (-?\\d+)\\r?\\n`);
    const deadline = Date.now() + 30_000;
    for (;;) {
      const o = re.exec(this.out);
      const e = re.exec(this.err);
      if (o && e) {
        const r = { code: Number(o[1]), out: this.out.slice(0, o.index).replace(/\r\n/g, '\n'), err: this.err.slice(0, e.index).replace(/\r\n/g, '\n') };
        this.out = this.out.slice(o.index + o[0].length);
        this.err = this.err.slice(e.index + e[0].length);
        return r;
      }
      if (Date.now() > deadline) throw new Error(`no marker ${id}; stdout ${JSON.stringify(this.out)} stderr ${JSON.stringify(this.err)}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  ps(source: string, opts?: Parameters<typeof windowsCellCommand>[3]): Promise<{ code: number; out: string; err: string }> {
    return this.send((id) => windowsCellCommand(source, id, 'pwsh', opts));
  }

  cmd(source: string, opts?: Parameters<typeof windowsCellCommand>[3]): Promise<{ code: number; out: string; err: string }> {
    return this.send((id) => windowsCellCommand(source, id, 'cmd', opts));
  }
}

describe('ssh: Windows servers (Windows PowerShell)', { skip: process.platform !== 'win32' && 'Windows only' }, () => {
  let sh: Shell;
  let dir: string;
  before(() => {
    sh = new Shell();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdrb win ü-'));
  });
  after(() => {
    sh.child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('the hello reports the shell process id', async () => {
    const r = await sh.send(windowsHelloCommand);
    assert.equal(r.code, sh.child.pid);
    assert.equal(r.out, '');
  });

  it('PowerShell cells: output in UTF-8, variables, functions and the folder carry over', async () => {
    const one = await sh.ps(`$x = 'kept'\nfunction Hi($n) { "hi $n" }\nSet-Location -LiteralPath '${dir}'\n"Grüße ✓"`);
    assert.deepEqual([one.code, one.out], [0, 'Grüße ✓\n']);
    const two = await sh.ps('Hi $x\n(Get-Location).Path');
    assert.deepEqual([two.code, two.out], [0, `hi kept\n${dir}\n`]);
  });

  it('exit codes: a native command, a failing cmdlet, a terminating error; the shell goes on', async () => {
    assert.equal((await sh.ps('cmd /c exit 3')).code, 3);
    // A non-terminating error is shown, and the cell goes on (as in the extension's sessions).
    const failed = await sh.ps("Get-Item -LiteralPath 'C:\\no\\such\\file'\n'after'");
    assert.deepEqual([failed.code, failed.out], [0, 'after\n']);
    assert.match(failed.err, /no\\such/);
    const thrown = await sh.ps("throw 'boom'\n'not reached'");
    assert.equal(thrown.code, 1);
    assert.doesNotMatch(thrown.out, /not reached/);
    assert.deepEqual([(await sh.ps('"still here"')).out], ['still here\n']);
  });

  it('env values come from the command stream; cwd= runs in a folder and comes back', async () => {
    const r = await sh.ps('"$env:API_TOKEN|$((Get-Location).Path)"', { env: { API_TOKEN: "s3cr'et ü" }, cwd: os.tmpdir() });
    assert.equal(r.out, `s3cr'et ü|${os.tmpdir().replace(/\\$/, '')}\n`);
    assert.equal((await sh.ps('(Get-Location).Path')).out, `${dir}\n`);
    const bad = await sh.ps("'ran'", { cwd: path.join(dir, 'missing') });
    assert.equal(bad.code, 1);
    assert.doesNotMatch(bad.out, /ran/);
    // Nothing left behind in the temp folder.
    assert.deepEqual(fs.readdirSync(os.tmpdir()).filter((f) => /^mdrb-cafe/.test(f)), []);
  });

  it('cmd cells run in a cmd.exe of their own, in the shell\'s folder, with its environment', async () => {
    const r = await sh.cmd('echo %API_TOKEN%\ncd\nset MDRB_X=only-here\necho Grüße', { env: { API_TOKEN: 'from-env' } });
    assert.deepEqual([r.code, r.out], [0, `from-env\n${dir}\nGrüße\n`]);
    assert.equal((await sh.cmd('exit /b 4')).code, 4);
    assert.equal((await sh.ps('"[$env:MDRB_X]"')).out, '[]\n');
  });
});
