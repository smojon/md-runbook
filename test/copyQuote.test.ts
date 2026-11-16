/** Copy Line with Values (src/copyQuote.ts): values quoted for the shell the line is pasted into. */
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { lineWithValues } from '../src/copyQuote';

const NASTY = `x'; rm -rf ~; echo "$(id)" \`id\` $HOME !! & | < > ^ %PATH%`;
const values: Record<string, string> = { NS: 'prod', V: NASTY, DASH: '-Force', EMPTY: '' };
const lookup = (_kind: string, name: string): string | undefined => values[name];
const copy = (line: string, kind: 'bash' | 'pwsh' | 'cmd'): string => lineWithValues(line, kind, lookup).text;

/** What `shell` prints for the copied line (undefined: that shell isn't here). */
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

describe('Copy Line with Values: quoting', () => {
  it('plain values are copied as they are', () => {
    assert.equal(copy('kubectl -n ${param:NS} get pods', 'bash'), 'kubectl -n prod get pods');
    assert.equal(copy('kubectl -n ${param:NS} get pods', 'pwsh'), 'kubectl -n prod get pods');
    assert.equal(copy("Write-Output 'delete ${param:NS}'", 'pwsh'), "Write-Output 'delete prod'");
  });

  it('bash: a value with shell characters stays one word, outside, in single and in double quotes', () => {
    assert.equal(copy('echo ${param:V}', 'bash'), `echo 'x'\\''; rm -rf ~; echo "$(id)" \`id\` $HOME !! & | < > ^ %PATH%'`);
    assert.equal(copy("echo 'a ${param:V} b'", 'bash'), `echo 'a x'\\''; rm -rf ~; echo "$(id)" \`id\` $HOME !! & | < > ^ %PATH% b'`);
    // In double quotes: they close, the value goes in single quotes, they open again.
    assert.equal(copy('echo "a ${param:V} b"', 'bash'), `echo "a "'x'\\''; rm -rf ~; echo "$(id)" \`id\` $HOME !! & | < > ^ %PATH%'" b"`);
    assert.equal(copy('echo ${param:EMPTY}.', 'bash'), "echo ''.");
    // An escaped quote doesn't open a string.
    assert.equal(copy('echo \\" ${param:V}', 'bash').startsWith(`echo \\" 'x'`), true);
  });

  it('PowerShell: single quotes with doubled quotes; in double quotes, backtick escapes', () => {
    assert.equal(copy('Write-Output ${param:V}', 'pwsh'), `Write-Output 'x''; rm -rf ~; echo "$(id)" \`id\` $HOME !! & | < > ^ %PATH%'`);
    assert.equal(copy('Write-Output "a ${param:V}"', 'pwsh'), 'Write-Output "a x\'; rm -rf ~; echo `"`$(id)`" ``id`` `$HOME !! & | < > ^ %PATH%"');
    assert.equal(copy("Write-Output 'it''s ${param:V}'", 'pwsh').startsWith("Write-Output 'it''s x''; rm"), true);
    // A leading - would be a parameter unquoted.
    assert.equal(copy('Remove-Item ${param:DASH}', 'pwsh'), "Remove-Item '-Force'");
  });

  it('cmd: copied as it is, flagged when the value has characters cmd reads', () => {
    const r = lineWithValues('echo ${param:V} ${param:NS}', 'cmd', lookup);
    assert.equal(r.text, `echo ${NASTY} prod`);
    assert.deepEqual(r.risky, ['${param:V}']);
  });

  it('a placeholder without a value is left as written', () => {
    const r = lineWithValues('echo ${secret:TOKEN} ${param:NS}', 'bash', lookup);
    assert.deepEqual([r.text, r.left], ['echo ${secret:TOKEN} prod', ['${secret:TOKEN}']]);
  });

  it('the shells print the value as it is', (t) => {
    const bash = printed('bash', copy("printf '%s|' ${param:V} 'b ${param:V}' \"c ${param:V}\"", 'bash'));
    if (bash === undefined) t.diagnostic('no bash here');
    else assert.equal(bash, `${NASTY}|b ${NASTY}|c ${NASTY}|`);
    const pwsh = printed('pwsh', copy("[Console]::Out.Write(${param:V} + '|' + 'b ${param:V}' + '|' + \"c ${param:V}\")", 'pwsh'));
    if (pwsh === undefined) t.diagnostic('no pwsh here');
    else assert.equal(pwsh, `${NASTY}|b ${NASTY}|c ${NASTY}`);
  });
});
