import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { cellRefs } from '@md-runbook/core/cellOptions';
import { choiceProblem, dotenvSecrets, envRef, fillShown, findRefs, hasShownRefs, isRedactableValue, looksLikeSecretValue, looksSecret, looksSecretKey, paramComment, parseDotenv, parseFrontMatter, rewriteRefs, withDotenv } from '@md-runbook/core/secrets';

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

  it('keeps a comment after an item as its description, with or without a default (as docs/syntax.md shows)', () => {
    const fm = '---\nparams:\n  - ENV          # DEV or PROD: asked, no default\n  - REPLICAS: "3"    # quotes are removed\n  - A: 1 # x\n  - TAG: "v1 #2"\n  - URL: a#b\n  - B: ""  # empty default\n  - C: \'\'\n  - D:\n  - E: #\n---\n';
    assert.deepEqual(parseFrontMatter(fm)?.params, [
      { name: 'ENV', description: 'DEV or PROD: asked, no default' },
      { name: 'REPLICAS', default: '3', description: 'quotes are removed' },
      { name: 'A', default: '1', description: 'x' },
      { name: 'TAG', default: 'v1 #2' },
      { name: 'URL', default: 'a#b' },
      { name: 'B', default: '', description: 'empty default' },
      { name: 'C', default: '' },
      { name: 'D' },
      { name: 'E' },
    ]);
  });

  it('takes the choices from a trailing "One of:" in the comment', () => {
    const fm = [
      '---',
      'params:',
      '  - NAMESPACE: staging  # The namespace to deploy to. One of: staging, prod.',
      '  - MODE   # one of: fast, safe',
      '  - TAG: "v1 # not a comment"  # Release tag. ONE OF: v1 # not a comment, v2',
      "  - SIZE: m # Size, one of: s, m or l",
      "  - Q: 'a#b'#Quoted. One of: 'a#b', \"c d\", , c d.",
      '  - X: 1 # One of: a. Then more text.',
      '  - Y: 1 # One of:',
      '---',
      '',
    ].join('\n');
    assert.deepEqual(parseFrontMatter(fm)?.params, [
      { name: 'NAMESPACE', default: 'staging', description: 'The namespace to deploy to.', choices: ['staging', 'prod'] },
      { name: 'MODE', choices: ['fast', 'safe'] },
      { name: 'TAG', default: 'v1 # not a comment', description: 'Release tag.', choices: ['v1 # not a comment', 'v2'] },
      { name: 'SIZE', default: 'm', description: 'Size', choices: ['s', 'm', 'l'] },
      { name: 'Q', default: 'a#b', description: 'Quoted.', choices: ['a#b', 'c d'] },
      { name: 'X', default: '1', description: 'One of: a. Then more text.' },
      { name: 'Y', default: '1', description: 'One of:' },
    ]);
  });

  it('paramComment: description and choices', () => {
    assert.deepEqual(paramComment(''), {});
    assert.deepEqual(paramComment('  Where it goes  '), { description: 'Where it goes' });
    assert.deepEqual(paramComment('One of: a, b'), { choices: ['a', 'b'] });
    assert.deepEqual(paramComment('Pick (one of: a, b, a)'), { description: 'Pick', choices: ['a', 'b'] });
    assert.deepEqual(paramComment('Version (one of: 1.2, 1.3)'), { description: 'Version', choices: ['1.2', '1.3'] });
    assert.deepEqual(paramComment('Pick: one of: a, b, or c.'), { description: 'Pick', choices: ['a', 'b', 'c'] });
    assert.deepEqual(paramComment('someone of: a'), { description: 'someone of: a' });
  });

  it('choiceProblem: a value from anywhere must be one of the choices', () => {
    const p = { name: 'ENV', choices: ['dev', 'prod'] };
    assert.equal(choiceProblem(p, 'dev'), undefined);
    assert.equal(choiceProblem({ name: 'ENV' }, 'anything'), undefined);
    assert.equal(choiceProblem(undefined, 'anything'), undefined);
    assert.equal(choiceProblem(p, 'prod; rm -rf /'), '${param:ENV} is "prod; rm -rf /", not one of its choices: dev, prod');
    assert.match(choiceProblem(p, 'x'.repeat(100))!, /"x{60}…"/);
  });

  it('fillShown: non-secret values filled in, secrets and unknown ones as written', () => {
    const src = 'kubectl ${param:VERB} ${input:POD} --token ${secret:TOKEN} ${input:pw:secret} ${out:ID} ${param:LATER}';
    const values: Record<string, { value: string; secret: boolean }> = {
      VERB: { value: 'delete', secret: false },
      POD: { value: 'web-1', secret: false },
      TOKEN: { value: 'tok', secret: true },
      pw: { value: 'hunter2', secret: true },
      ID: { value: 'captured-secret', secret: true },
    };
    assert.equal(fillShown(src, (r) => values[r.name]), 'kubectl delete web-1 --token ${secret:TOKEN} ${input:pw:secret} ${out:ID} ${param:LATER}');
    assert.ok(hasShownRefs('echo ${param:X}'));
    assert.ok(hasShownRefs('echo ${out:X}'));
    assert.ok(!hasShownRefs('echo ${secret:X} ${input:DB_PASSWORD}'));
    assert.ok(!hasShownRefs('echo $HOME'));
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

  it('goes over the settings but under the cell’s own env.NAME= options', () => {
    // plan.env holds mdRunbook.execution.env with the cell's options already over it.
    const env = { PATH_HINT: 'settings', REGION: 'cell', LEVEL: 'settings' };
    const vars = { REGION: 'dotenv', LEVEL: 'dotenv', API_URL: 'dotenv' };
    assert.deepEqual(withDotenv(env, vars, { REGION: 'cell' }), { PATH_HINT: 'settings', REGION: 'cell', LEVEL: 'dotenv', API_URL: 'dotenv' });
    // Cell options off (or none): the file wins over the settings.
    assert.deepEqual(withDotenv(env, vars, {}), { PATH_HINT: 'settings', REGION: 'dotenv', LEVEL: 'dotenv', API_URL: 'dotenv' });
  });
});

describe('declared parameters no block uses', () => {
  it('are no reference of any block, so nothing asks for them (VS Code upFrontRefs and the launch form, the CLI)', () => {
    // An alert link's values (p.ALERT=…), declared with empty defaults, used by no cell: the run
    // report reads them, the run never waits for them.
    const text = '---\nparams:\n  - ALERT: ""\n  - ALERT_FINGERPRINT: ""\n  - ALERT_STARTS_AT: ""\n  - REGION: eu\n---\n\n# SOP\n';
    const fm = parseFrontMatter(text)!;
    assert.deepEqual(
      fm.params.map((p) => [p.name, p.default]),
      [['ALERT', ''], ['ALERT_FINGERPRINT', ''], ['ALERT_STARTS_AT', ''], ['REGION', 'eu']],
    );
    // upFrontRefs collects cellRefs of the cells to run: the code, its checks, its kube-context.
    assert.deepEqual(cellRefs('kubectl get pods -n ${param:REGION}', 'bash expect="ok"', fm).map((r) => r.name), ['REGION']);
    assert.deepEqual(cellRefs('echo hi', 'bash', fm), []);
    // Only a kube-context naming one makes it a block's reference.
    assert.deepEqual(cellRefs('echo hi', 'bash', { ...fm, kubeContext: '${param:ALERT}' }).map((r) => r.name), ['ALERT']);
  });
});
