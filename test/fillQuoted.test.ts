import { strict as assert } from 'node:assert';
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
