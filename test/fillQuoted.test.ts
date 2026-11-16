import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { fillQuoted, quoteValue } from '@md-runbook/core/fillQuoted';

const values: Record<string, string> = { OK: 'prod-eu', EVIL: 'x; rm -rf / #', Q: "it's", D: 'a"b$c`d', CMD: 'a & calc' };
const fill = (command: string, shell: 'bash' | 'pwsh' | 'cmd') => fillQuoted(command, shell, (_k, name) => values[name]);

describe('fillQuoted: Copy Line with Values, quoted for the shell (security review round 3)', () => {
  it('bash: a value stays one piece of text outside quotes, in double quotes and in single quotes', () => {
    assert.deepEqual(fill('kubectl -n ${param:OK} get pods', 'bash'), { text: 'kubectl -n prod-eu get pods', left: [] });
    assert.equal(fill('echo ${param:EVIL}', 'bash').text, "echo 'x; rm -rf / #'");
    assert.equal(fill('echo "at ${param:EVIL} now"', 'bash').text, `echo "at "'x; rm -rf / #'" now"`);
    assert.equal(fill("echo '${param:Q}'", 'bash').text, `echo 'it'\\''s'`);
    assert.equal(fill('echo ${param:Q}', 'bash').text, `echo 'it'\\''s'`);
    // An escaped quote doesn't open a quote.
    assert.equal(fill('echo \\" ${param:EVIL}', 'bash').text, `echo \\" 'x; rm -rf / #'`);
  });

  it('PowerShell: single quotes, or backticks in a double-quoted string', () => {
    assert.equal(fill('Write-Output ${param:EVIL}', 'pwsh').text, "Write-Output 'x; rm -rf / #'");
    assert.equal(fill('Write-Output ${param:Q}', 'pwsh').text, "Write-Output 'it''s'");
    assert.equal(fill('Write-Output "v: ${param:D}"', 'pwsh').text, 'Write-Output "v: a`"b`$c``d"');
    assert.equal(fill("Write-Output 'v: ${param:Q}'", 'pwsh').text, "Write-Output 'v: it''s'");
    assert.equal(quoteValue('it’s', 'pwsh'), "'it’’s'");
  });

  it('cmd: a value with a metacharacter is not filled in, and is listed as left', () => {
    assert.deepEqual(fill('echo ${param:CMD} ${param:OK}', 'cmd'), { text: 'echo ${param:CMD} prod-eu', left: ['${param:CMD}'] });
    assert.equal(quoteValue('50%', 'cmd'), undefined);
    assert.equal(quoteValue('line\nnext', 'cmd'), undefined);
  });

  it('a reference without a value stays, once in left', () => {
    assert.deepEqual(fill('echo ${secret:S} ${secret:S}', 'bash'), { text: 'echo ${secret:S} ${secret:S}', left: ['${secret:S}'] });
  });
});

describe('fillQuoted: where the quoting is not followed, nothing is filled in (security review, round 4)', () => {
  const with_ = (command: string, shell: 'bash' | 'pwsh' | 'cmd', v: string) => fillQuoted(command, shell, () => v);

  it('bash: after $(…), a backtick, $\'…\' or in an open ${…}', () => {
    for (const [line, v] of [
      ['echo "pods: $(echo \'app=${param:X}\')"', 'x; echo INJECTED-BASH-SUBST'],
      ["echo $'it\\'s ${param:X}'", 'x; echo INJECTED-BASH-ANSIC; echo'],
      ['echo "n=`echo \'${param:X}\'`"', 'x; echo INJECTED-BASH-BACKTICK'],
      ['echo "${HOME:-${param:X}}"', '$(echo INJECTED)'],
      ['echo $(date) ${param:X}', 'prod'],
    ]) assert.deepEqual(with_(line!, 'bash', v!), { text: line, left: ['${param:X}'] }, line);
    // Before the substitution, and after a closed ${…}: filled in.
    assert.equal(with_('echo ${param:X} $(date)', 'bash', 'a b').text, "echo 'a b' $(date)");
    assert.equal(with_('echo "${HOME}/${param:X}"', 'bash', 'a b').text, `echo "\${HOME}/"'a b'""`);
    assert.equal(with_('echo "${param:X}"', 'bash', "a\"b$(echo NOPE)`echo NOPE`'c").text, `echo ""'a"b$(echo NOPE)\`echo NOPE\`'\\''c'""`);
  });

  it('PowerShell: after $( or @(, or --%; a leading - is quoted', () => {
    for (const line of ['Write-Output "pods: $(Write-Output \'app=${param:X}\')"', 'Write-Output @(${param:X})', 'cmd /c --% echo ${param:X}']) {
      assert.deepEqual(with_(line, 'pwsh', "x'; Write-Output INJECTED; '"), { text: line, left: ['${param:X}'] }, line);
    }
    assert.equal(with_('Write-Output ${param:X}', 'pwsh', '-InputObject').text, "Write-Output '-InputObject'");
    assert.equal(with_('Write-Output ${param:X}', 'pwsh', 'a-b').text, 'Write-Output a-b');
    assert.equal(with_("Write-Output '${param:X}'", 'pwsh', 'a’; Write-Output NOPE3; ‘').text, "Write-Output 'a’’; Write-Output NOPE3; ‘‘'");
    assert.equal(with_('Write-Output "${param:X}"', 'pwsh', 'a`"$(Write-Output NOPE)“').text, 'Write-Output "a```"`$(Write-Output NOPE)`“"');
  });

  it('cmd: line breaks, ! and ( ) are metacharacters too', () => {
    for (const v of ['x\r\necho INJECTED-CMD', 'x\recho', '!PATH!', '(x)', 'a % b', 'a^b', 'a"b']) assert.deepEqual(with_('echo ${param:X}', 'cmd', v), { text: 'echo ${param:X}', left: ['${param:X}'] }, JSON.stringify(v));
  });
});

/** What `shell` prints for `line` (undefined: that shell isn't here). */
function printed(shell: 'bash' | 'pwsh', line: string): string | undefined {
  // PowerShell: the line as -EncodedCommand (UTF-16LE), so no command-line quoting gets in between.
  const run = (exe: string): ReturnType<typeof spawnSync> =>
    spawnSync(exe, shell === 'bash' ? ['--noprofile', '--norc', '-c', line] : ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(line, 'utf16le').toString('base64')], {
      encoding: 'utf8',
      timeout: 30_000,
    });
  let r = run(shell);
  if (r.error && shell === 'pwsh' && process.platform === 'win32') r = run('powershell');
  if (r.error) return undefined;
  return String(r.stdout).replace(/\r?\n$/, '');
}

describe('fillQuoted: the shells print the value as it is (VS Code uses it too since round 4)', () => {
  const NASTY = `x'; rm -rf ~; echo "$(id)" \`id\` $HOME !! & | < > ^ %PATH% -Force`;
  const fillNasty = (line: string, shell: 'bash' | 'pwsh'): string => fillQuoted(line, shell, () => NASTY).text;

  it('bash and PowerShell, outside quotes, in single and in double quotes', (t) => {
    const bash = printed('bash', fillNasty("printf '%s|' ${param:V} 'b ${param:V}' \"c ${param:V}\"", 'bash'));
    if (bash === undefined) t.diagnostic('no bash here');
    else assert.equal(bash, `${NASTY}|b ${NASTY}|c ${NASTY}|`);
    const pwsh = printed('pwsh', fillNasty("[Console]::Out.Write(${param:V} + '|' + 'b ${param:V}' + '|' + \"c ${param:V}\")", 'pwsh'));
    if (pwsh === undefined) t.diagnostic('no pwsh here');
    else assert.equal(pwsh, `${NASTY}|b ${NASTY}|c ${NASTY}`);
  });
});
