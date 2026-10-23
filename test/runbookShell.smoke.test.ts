/** The runbook's `shell:` with real shells, alone and in a session; each case skips when its shell isn't installed. */
import { strict as assert } from 'node:assert';
import { after, describe, it } from 'node:test';
import { RunbookShells, ShellSettings } from '@md-runbook/core';
import { executeCell, nodeShellEnv, resolveShell } from '@md-runbook/core/node';
import { SessionPool } from '@md-runbook/core/node/session';

const settingsFor = (runbook: RunbookShells): ShellSettings => ({ runbook });
const has = (runbook: RunbookShells): boolean => resolveShell('bash', settingsFor(runbook), nodeShellEnv()).ok;

/** Which shell ran the cell, by its own variables. */
const WHICH = 'if [ -n "$ZSH_VERSION" ]; then echo zsh; elif [ -n "$BASH_VERSION" ]; then echo bash; else echo sh; fi';

async function run(runbook: RunbookShells, source: string, pool?: SessionPool): Promise<{ stdout: string; label: string | undefined; exit: number | null }> {
  let stdout = '';
  const opts = {
    language: 'bash',
    source,
    cwd: process.cwd(),
    settings: settingsFor(runbook),
    timeoutMs: 60_000,
    onStdout: (t: string) => (stdout += t),
    onStderr: () => undefined,
  };
  const r = pool ? await pool.execute(opts) : await executeCell(opts);
  return { stdout, label: r.shell?.label, exit: r.exitCode };
}

describe('shell: zsh', { skip: !has({ unix: 'zsh' }) && 'zsh not installed' }, () => {
  const pool = new SessionPool();
  after(() => pool.dispose());

  it('runs a bash cell in zsh, alone and in a session that keeps its variables', async () => {
    const alone = await run({ unix: 'zsh' }, WHICH);
    assert.equal(alone.stdout.trim(), 'zsh');
    assert.equal(alone.label, 'zsh');
    await run({ unix: 'zsh' }, 'export MDRB_X=kept; setopt extendedglob', pool);
    const next = await run({ unix: 'zsh' }, `${WHICH}; echo "$MDRB_X"`, pool);
    assert.deepEqual(next.stdout.trim().split(/\r?\n/), ['zsh', 'kept']);
    assert.equal(next.label, 'zsh session');
  });
});

describe('shell: sh', { skip: !has({ unix: 'sh' }) && 'sh not found' }, () => {
  const pool = new SessionPool();
  after(() => pool.dispose());

  it('runs a bash cell in sh, alone and in a session; a failure keeps its exit code', async () => {
    const alone = await run({ unix: 'sh' }, 'echo "$0" >/dev/null; exit 3');
    assert.equal(alone.exit, 3);
    assert.equal(alone.label, 'sh');
    await run({ unix: 'sh' }, 'MDRB_Y=kept', pool);
    const next = await run({ unix: 'sh' }, 'echo "$MDRB_Y"', pool);
    assert.equal(next.stdout.trim(), 'kept');
    assert.equal(next.label, 'sh session');
    // A change of shell starts a new session: nothing carries over from the sh one.
    if (has({ unix: 'bash' })) {
      const bash = await run({ unix: 'bash' }, `${WHICH}; echo "[$MDRB_Y]"`, pool);
      assert.deepEqual(bash.stdout.replace(/\[md-runbook\][^\n]*\n/g, '').trim().split(/\r?\n/), ['bash', '[]']);
    }
  });
});
