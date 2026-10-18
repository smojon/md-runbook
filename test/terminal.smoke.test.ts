/**
 * The command line terminal mode types into a terminal, run in a plain shell process: cells run
 * in a child process (nothing leaks into the terminal) and the status file follows normal-run
 * exit-code rules. Each suite skips when its shell isn't installed.
 */
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { ShellSettings, nodeShellEnv, resolveShell } from '../src/core';
import { terminalCommandLine } from '../src/core/terminalCommand';

const settings: ShellSettings = { pwshPath: process.env.MD_RUNBOOK_PWSH, bashPath: process.env.MD_RUNBOOK_BASH };
const isWin = process.platform === 'win32';

for (const kind of ['bash', 'pwsh'] as const) {
  const resolved = resolveShell(kind, settings, nodeShellEnv());
  describe(`terminal command line (${kind})`, { skip: !resolved.ok && `${kind} not found` }, () => {
    if (!resolved.ok) return;
    const shell = resolved.shell;
    // A folder whose name needs quoting, including a typographic quote for PowerShell.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdrb term it's ’q’ "));
    const asArg = (p: string): string => (kind === 'bash' ? (shell.args(p)[0] ?? p) : p);

    /** Types the command line into a fresh shell (as the terminal would), then reports what is left behind. */
    const typeInto = (source: string): { status: string | undefined; after: string; stdout: string } => {
      const script = path.join(dir, `cell${shell.extension}`);
      const status = path.join(dir, 'status');
      fs.rmSync(status, { force: true });
      fs.writeFileSync(script, shell.script(source), 'utf8');
      const line = terminalCommandLine(kind, shell.command, asArg(script), asArg(status));
      const probe = kind === 'bash' ? 'echo "AFTER:$(pwd):${MDRB_LEAK:-unset}"' : '"AFTER:$((Get-Location).Path):$(if ($env:MDRB_LEAK) { $env:MDRB_LEAK } else { "unset" })"';
      const args = kind === 'bash' ? ['-c', `${line}\n${probe}`] : ['-NoProfile', '-NonInteractive', ...(isWin ? ['-ExecutionPolicy', 'Bypass'] : []), '-Command', `${line}\n${probe}`];
      const r = spawnSync(shell.command, args, { cwd: os.tmpdir(), encoding: 'utf8', input: '' });
      let written: string | undefined;
      try {
        written = fs.readFileSync(status, 'utf8');
      } catch {
        written = undefined;
      }
      return { status: written, after: /AFTER:(.*)/.exec(r.stdout)?.[1]?.trim() ?? '', stdout: r.stdout };
    };

    it('the cell runs in a child process: cd, variables and exit stay inside it', () => {
      const source = kind === 'bash' ? 'cd /\nexport MDRB_LEAK=yes\necho in-cell\nexit 4' : "Set-Location ([IO.Path]::GetTempPath())\nSet-Location ..\n$env:MDRB_LEAK = 'yes'\n'in-cell'\nexit 4";
      const r = typeInto(source);
      assert.match(r.stdout, /in-cell/);
      assert.equal(r.status, '4');
      const [where, leak] = [r.after.slice(0, r.after.lastIndexOf(':')), r.after.slice(r.after.lastIndexOf(':') + 1)];
      assert.equal(leak, 'unset', r.stdout);
      if (!isWin) assert.equal(fs.realpathSync(where), fs.realpathSync(os.tmpdir()));
    });

    it('exit codes follow the normal-run rules', () => {
      if (kind === 'bash') {
        assert.equal(typeInto('true').status, '0');
        assert.equal(typeInto('echo x\nfalse').status, '1');
        return;
      }
      const native = isWin ? 'cmd /c exit 7' : 'sh -c "exit 7"';
      assert.equal(typeInto("'fine'").status, '0');
      assert.equal(typeInto(`${native}\n'after'`).status, '7');
      assert.equal(typeInto("'before'\nthrow 'boom'").status, '1');
      assert.equal(typeInto("Write-Error 'nt'\n'continues'").status, '0');
    });
  });
}
