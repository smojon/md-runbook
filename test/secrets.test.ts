import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { dotenvSecrets, envRef, findRefs, isRedactableValue, looksLikeSecretValue, looksSecret, looksSecretKey, parseDotenv, parseFrontMatter, rewriteRefs } from '../src/core/secrets';

describe('variable references', () => {
  it('finds unique references in order, with secrecy', () => {
    const src = 'curl -H "Bearer ${secret:API_TOKEN}" ${param:HOST}/${input:PATH_X}\necho ${secret:API_TOKEN} ${input:pw:secret} ${input:DB_PASSWORD}';
    assert.deepEqual(findRefs(src), [
      { kind: 'secret', name: 'API_TOKEN', secret: true },
      { kind: 'param', name: 'HOST', secret: false },
      { kind: 'input', name: 'PATH_X', secret: false },
      { kind: 'input', name: 'pw', secret: true },
      { kind: 'input', name: 'DB_PASSWORD', secret: true },
    ]);
  });

  it('ignores malformed references and :secret on non-inputs', () => {
    assert.deepEqual(findRefs('${secret:1X} ${env:X} $secret:X ${param:X:secret} ${input:}'), []);
    assert.equal(rewriteRefs('${param:X:secret}', 'bash'), '${param:X:secret}');
  });

  it('rejects one name used with two kinds', () => {
    assert.throws(() => findRefs('${secret:X} ${input:X}'), /X is referenced as both secret and input/);
  });

  it('rewrites per shell', () => {
    const src = 'echo "${secret:TOKEN}x" ${input:pw:secret} ${param:P}';
    assert.equal(rewriteRefs(src, 'bash'), 'echo "${TOKEN}x" ${pw} ${P}');
    assert.equal(rewriteRefs(src, 'pwsh'), 'echo "${env:TOKEN}x" ${env:pw} ${env:P}');
    // cmd: delayed expansion (!NAME!), so a value like `p&calc` or `a>b` is never parsed as syntax.
    assert.equal(rewriteRefs(src, 'cmd'), '@setlocal EnableDelayedExpansion\necho "!TOKEN!x" !pw! !P!');
    assert.equal(envRef('A_1', 'cmd'), '!A_1!');
  });

  it('enables delayed expansion only in cmd scripts that had references, keeping the EOL', () => {
    assert.equal(rewriteRefs('echo hi!\r\n', 'cmd'), 'echo hi!\r\n');
    assert.equal(rewriteRefs('echo ${param:X}\r\necho y\r\n', 'cmd'), '@setlocal EnableDelayedExpansion\r\necho !X!\r\necho y\r\n');
    assert.equal(rewriteRefs('echo ${param:X}', 'bash'), 'echo ${X}');
  });

  it('keeps line endings and other text', () => {
    assert.equal(rewriteRefs('a\r\n${param:X}\r\n$HOME', 'bash'), 'a\r\n${X}\r\n$HOME');
  });

  it('treats credential-like names as secret', () => {
    assert.ok(looksSecret('DB_PASSWORD') && looksSecret('gh_token') && looksSecret('X_SECRET'));
    assert.ok(!looksSecret('TOKENIZER') && !looksSecret('PASSWORD_HINT_FILE'));
  });
});

describe('front matter params', () => {
  it('parses names and defaults, ignoring other keys', () => {
    const fm = '---\r\ntitle: Deploy\r\nparams:\r\n  - REGION: eu-west-1\r\n  - NAMESPACE\r\n  # comment\r\n  - QUOTED: "a: b"\r\n  - SINGLE: \'it\'\'s\'\r\n  - EMPTY:\r\ntags:\r\n  - x\r\n---\r\n# Title';
    assert.deepEqual(parseFrontMatter(fm), {
      params: [{ name: 'REGION', default: 'eu-west-1' }, { name: 'NAMESPACE' }, { name: 'QUOTED', default: 'a: b' }, { name: 'SINGLE', default: "it's" }, { name: 'EMPTY' }],
    });
  });

  it('accepts unindented items and ... as terminator', () => {
    assert.deepEqual(parseFrontMatter('---\nparams:\n- A\n- B: 2\n...\n'), { params: [{ name: 'A' }, { name: 'B', default: '2' }] });
    assert.deepEqual(parseFrontMatter('---\nmode: session\n---\n'), { params: [], mode: 'session' });
    assert.deepEqual(parseFrontMatter('---\r\nmode: "Isolated"  # comment\r\nparams:\r\n- A\r\n---\r\n'), { params: [{ name: 'A' }], mode: 'isolated' });
    assert.deepEqual(parseFrontMatter('---\nmode: sometimes\n---\n'), { params: [] });
  });

  it('needs --- on the first line and a closing line', () => {
    assert.equal(parseFrontMatter('# x\n---\nparams:\n - A\n---\n'), undefined);
    assert.equal(parseFrontMatter('---\nparams:\n - A\n'), undefined);
    assert.deepEqual(parseFrontMatter('---\ntitle: x\n---\n'), { params: [] });
  });
});

describe('.env parser', () => {
  it('parses comments, export, quotes and escapes', () => {
    const text = [
      '﻿# comment',
      'A=1',
      'export B = two words ',
      'C="quoted # not comment\\nnext"',
      "D='single $X \\n'",
      'E=value # trailing comment',
      'F=a#b',
      'G=',
      'not a line',
      '1BAD=x',
      'H="unterminated',
    ].join('\r\n');
    assert.deepEqual(parseDotenv(text), {
      A: '1',
      B: 'two words',
      C: 'quoted # not comment\nnext',
      D: 'single $X \\n',
      E: 'value',
      F: 'a#b',
      G: '',
      H: 'unterminated',
    });
  });

  it('skips trivial values for exact-match redaction', () => {
    assert.ok(!isRedactableValue('true') && !isRedactableValue('8080') && !isRedactableValue('OFF'));
    assert.ok(isRedactableValue('hunter2!') && isRedactableValue('123456'));
  });

  it('redacts only .env values that look like secrets (by key or by value)', () => {
    const vars = parseDotenv(
      [
        'REGION=eu-west-1',
        'NAMESPACE=shop-prod',
        'API_URL=https://api.example.com/v1',
        'LOG_LEVEL=debug',
        'HOME_DIR=/home/me/projects/infra',
        'DB_PASSWORD=hunter2',
        'GITHUB_TOKEN=ghp_x',
        'AWS_SECRET_ACCESS_KEY=abc',
        'AWS_ACCESS_KEY_ID=AKIA1234',
        'STRIPE_KEY=sk_live',
        'CLIENT_CREDENTIALS=c1',
        'DATABASE_URL=postgres://app:s3cr3t@db:5432/app',
        'RANDOM_THING=Zx8kQ2mP9vL4tR7wB3nY6',
        'ENABLED=true',
        'MY_TOKEN=yes',
      ].join('\n'),
    );
    assert.deepEqual(dotenvSecrets(vars).sort(), ['AKIA1234', 'Zx8kQ2mP9vL4tR7wB3nY6', 'abc', 'c1', 'ghp_x', 'hunter2', 'postgres://app:s3cr3t@db:5432/app', 'sk_live'].sort());
    assert.ok(looksSecretKey('DB_PASSWORD') && looksSecretKey('MY_API_KEY') && looksSecretKey('KEY') && looksSecretKey('SESSION_COOKIE'));
    assert.ok(!looksSecretKey('REGION') && !looksSecretKey('KEYCLOAK_URL') && !looksSecretKey('AUTHOR') && !looksSecretKey('MONKEY_COUNT'));
    assert.ok(!looksLikeSecretValue('eu-west-1') && !looksLikeSecretValue('/very/long/path/to/some/dir123') && looksLikeSecretValue('Zx8kQ2mP9vL4tR7wB3nY6'));
  });
});
