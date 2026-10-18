import { strict as assert } from 'node:assert';
import * as os from 'node:os';
import { describe, it } from 'node:test';
import { parseCellOptions, tokenizeInfo } from '../src/core/cellOptions';
import { DEFAULT_CONFIRM_PATTERNS, compileConfirmPatterns, confirmationFor, findRisky } from '../src/core/confirm';
import { CONTEXT_UNKNOWN, firstLine, runContextCommand } from '../src/core/context';

describe('cell options', () => {
  it('no options', () => {
    assert.deepEqual(parseCellOptions(''), { env: {}, errors: [] });
    assert.deepEqual(parseCellOptions('bash'), { env: {}, errors: [] });
    assert.deepEqual(parseCellOptions(' pwsh  '), { env: {}, errors: [] });
  });

  it('values, quotes and flags', () => {
    const o = parseCellOptions('bash timeout=30 cwd=../infra continue-on-error env.REGION=eu-west name="Rotate token" confirm');
    assert.deepEqual(o, {
      timeoutSeconds: 30,
      cwd: '../infra',
      continueOnError: true,
      env: { REGION: 'eu-west' },
      name: 'Rotate token',
      confirm: true,
      errors: [],
    });
    assert.equal(parseCellOptions("sh name='it''s'").name, 'it');
    assert.equal(parseCellOptions('sh skip').skip, true);
    assert.equal(parseCellOptions('sh no-confirm').confirm, false);
    assert.equal(parseCellOptions('sh timeout=0').timeoutSeconds, 0);
    assert.equal(parseCellOptions('sh timeout=2.5s').timeoutSeconds, 2.5);
  });

  it('quoted values may contain spaces and = signs', () => {
    assert.deepEqual(parseCellOptions('sh env.ARGS="--a=1 --b" x').env, { ARGS: '--a=1 --b' });
    assert.equal(parseCellOptions('sh name="unterminated value').name, 'unterminated value');
  });

  it('windows paths keep their backslashes', () => {
    assert.equal(parseCellOptions('pwsh cwd=..\\infra').cwd, '..\\infra');
    assert.equal(parseCellOptions('cmd cwd="C:\\Program Files\\x"').cwd, 'C:\\Program Files\\x');
  });

  it('ignores pandoc attributes and unknown tokens', () => {
    assert.deepEqual(parseCellOptions('bash {.class #id timeout=9} title=x foo skip'), { env: {}, errors: [], skip: true });
    assert.deepEqual(parseCellOptions('{.bash timeout=9}'), { env: {}, errors: [] });
    assert.equal(parseCellOptions('bash{.x} timeout=3').timeoutSeconds, 3);
  });

  it('reports invalid values', () => {
    assert.equal(parseCellOptions('sh timeout=abc').errors.length, 1);
    assert.equal(parseCellOptions('sh timeout=-1').errors.length, 1);
    assert.equal(parseCellOptions('sh cwd=').errors.length, 1);
  });

  it('tokenizes', () => {
    assert.deepEqual(tokenizeInfo(' a=1\tb  c="x y" =z'), [{ key: 'a', value: '1' }, { key: 'b' }, { key: 'c', value: 'x y' }]);
  });
});

describe('risky command confirmation', () => {
  const { regexes, errors } = compileConfirmPatterns(DEFAULT_CONFIRM_PATTERNS);
  it('default patterns compile', () => assert.deepEqual(errors, []));

  const risky: Array<[string, string]> = [
    ['kubectl delete pod web-1', 'delete'],
    ['oc adm drain node1 --ignore-daemonsets', 'drain'],
    ['kubectl CORDON node1', 'CORDON'],
    ['kubectl scale deploy/web --replicas=0', 'scale deploy/web --replicas=0'],
    ['rm -rf /tmp/x', 'rm -rf'],
    ['git push --force', '--force'],
    ['Remove-Item .\\out -Recurse -Force', 'Remove-Item .\\out -Recurse'],
    ['psql -c "DROP TABLE users"', 'DROP TABLE'],
  ];
  for (const [src, match] of risky) it(`matches ${src}`, () => assert.equal(findRisky(src, regexes), match));

  for (const src of ['kubectl get pods', 'rm file.txt', 'echo deleted', 'kubectl scale deploy/web --replicas=3']) {
    it(`does not match ${src}`, () => assert.equal(findRisky(src, regexes), undefined));
  }

  it('returns the earliest match across patterns', () => {
    assert.equal(findRisky('git push --force\nkubectl delete ns x', regexes), '--force');
  });

  it('reports invalid patterns', () => {
    const c = compileConfirmPatterns(['(', 'ok']);
    assert.equal(c.regexes.length, 1);
    assert.equal(c.errors.length, 1);
  });

  it('modes and cell overrides', () => {
    assert.equal(confirmationFor('kubectl delete x', 'patterns', regexes), 'delete');
    assert.equal(confirmationFor('ls', 'patterns', regexes), undefined);
    assert.equal(confirmationFor('ls', 'always', regexes), '');
    assert.equal(confirmationFor('kubectl delete x', 'never', regexes), undefined);
    assert.equal(confirmationFor('ls', 'never', regexes, true), '');
    assert.equal(confirmationFor('kubectl delete x', 'never', regexes, true), 'delete');
    assert.equal(confirmationFor('kubectl delete x', 'always', regexes, false), undefined);
  });
});

describe('context commands', () => {
  it('first line', () => {
    assert.equal(firstLine('\r\n  prod-eu  \r\nsecond\r\n'), 'prod-eu');
    assert.equal(firstLine(''), '');
  });

  it('runs through the platform shell', async () => {
    assert.equal(await runContextCommand('echo prod-eu', os.tmpdir(), process.env), 'prod-eu');
    assert.equal(await runContextCommand('exit 3', os.tmpdir(), process.env), CONTEXT_UNKNOWN);
    assert.equal(await runContextCommand('md-runbook-no-such-command-xyz', os.tmpdir(), process.env), CONTEXT_UNKNOWN);
  });
});
