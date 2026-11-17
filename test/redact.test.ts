import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { DEFAULT_PATTERNS, createRedactor } from '@md-runbook/core';

const r = createRedactor(DEFAULT_PATTERNS);
const R = '[REDACTED]';

describe('default redaction patterns', () => {
  it('compile without errors', () => assert.deepEqual(r.errors, []));

  const cases: Array<[string, string, string]> = [
    ['bearer token', 'curl -H "Authorization: Bearer abc.def-ghi"', `curl -H "Authorization: ${R}"`],
    ['bare bearer', 'token type Bearer sk_live_123/abc==', `token type Bearer ${R}`],
    ['authorization basic', '> Authorization: Basic dXNlcjpwYXNz\r\n', `> Authorization: ${R}\r\n`],
    ['proxy-authorization', 'Proxy-Authorization: Negotiate YII=', `Proxy-Authorization: ${R}`],
    ['cookie header', '> Cookie: session=abc; csrftoken=def', `> Cookie: ${R}`],
    ['set-cookie header', '< set-cookie: id=1; HttpOnly', `< set-cookie: ${R}`],
    [
      'JWT',
      'id_token eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk end',
      `id_token ${R} end`,
    ],
    ['password key=value', 'password=hunter2 next', `password=${R} next`],
    ['json secret', '{"client_secret": "s3cr3t", "x": 1}', `{"client_secret": "${R}", "x": 1}`],
    ['yaml token', 'data:\n  token: c2VjcmV0\n  name: x', `data:\n  token: ${R}\n  name: x`],
    ['env var', 'export API_KEY=abc123', `export API_KEY=${R}`],
    ['cli flag', 'oc login --token=sha256~abcdefghijklmnopqrstuvwxyz0123 --server=x', `oc login --token=${R} --server=x`],
    ['query string', 'GET /cb?access_token=abc&state=1', `GET /cb?access_token=${R}&state=1`],
    ['url credentials', 'git clone https://user:p%40ss@github.com/x', `git clone https://user:${R}@github.com/x`],
    ['openshift token alone', 'sha256~abcdefghijklmnopqrstuvwxyz0123', R],
    ['aws key id', 'AKIAIOSFODNN7EXAMPLE', R],
    ['github token', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', R],
    // escaped JSON: the key's and the value's quotes escaped (review of 0.30)
    ['escaped JSON key', '{\\"password\\":\\"hunter2\\"}', `{\\"password\\":\\"${R}\\"}`],
    ['JSON in a JSON string', 'log line {"cfg":"{\\"db_password\\":\\"hunter2\\"}"}', `log line {"cfg":"{\\"db_password\\":\\"${R}\\"}"}`],
    ['escaped JSON, spaces', '{\\"api_key\\" : \\"a b c\\", \\"x\\": 1}', `{\\"api_key\\" : \\"${R}\\", \\"x\\": 1}`],
    ['escaped JSON header', '{\\"Authorization\\":\\"Basic dXNlcjpwYXNz\\"}', `{\\"Authorization\\":\\"${R}\\"}`],
    // an escaped quote inside a quoted value
    ['escaped quote in a value', '{"password": "abc\\"defgh"}', `{"password": "${R}"}`],
    ['escaped quote in single quotes', "token: 'it\\'s-a-secret'", `token: '${R}'`],
    ['backslash before the line end', 'password = "pa ss\\"', `password = "${R}"`],
    ['escaped backslash at the end', '"secret": "abc\\\\", "x": 1', `"secret": "${R}", "x": 1`],
    // JSON escaped twice: `\\\"` is a quote in the value, `\\\\\"` a backslash then the end (second review of 0.30)
    ['escaped quote in escaped JSON', '{\\"password\\":\\"s3c\\\\\\"ret more\\"}', `{\\"password\\":\\"${R}\\"}`],
    ['escaped backslash in escaped JSON', '{\\"password\\":\\"s3c\\\\\\\\\\", \\"x\\":1}', `{\\"password\\":\\"${R}\\", \\"x\\":1}`],
    // a pass key's whole value in quotes, escaped too
    ['pass key, quoted value with a space', 'DB_PASS="p@ss w0rd"', `DB_PASS="${R}"`],
    ['pass key, escaped quoted value', 'DB_PASS=\\"p@ss w0rd\\"', `DB_PASS=\\"${R}\\"`],
    ['pass key in escaped JSON', '{\\"db_pass\\":\\"p@ss w0rd\\"}', `{\\"db_pass\\":\\"${R}\\"}`],
    // a URL with a password but no user
    ['url password, no user', 'REDIS_URL=redis://:s3cretPw@cache:6379', `REDIS_URL=redis://:${R}@cache:6379`],
    ['url password, no user, in text', 'connect to rediss://:s3cretPw@cache:6380/0 now', `connect to rediss://:${R}@cache:6380/0 now`],
  ];
  for (const [name, input, expected] of cases) {
    it(name, () => assert.equal(r.redact(input), expected));
  }

  it('PEM private keys (keeps the BEGIN/END lines)', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nIBAAK\n-----END RSA PRIVATE KEY-----\n';
    assert.equal(r.redact(pem), `-----BEGIN RSA PRIVATE KEY-----${R}-----END RSA PRIVATE KEY-----\n`);
  });

  it('truncated PEM private key with no END line', () => {
    assert.equal(r.redact('-----BEGIN PRIVATE KEY-----\nMIIE\nabc'), `-----BEGIN PRIVATE KEY-----${R}`);
  });

  it('does not touch certificates or ordinary output', () => {
    const plain = [
      '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----',
      'NAME      READY   STATUS',
      'secret/my-secret created',
      'kubectl get secrets -n iam',
      'password reset flow',
      'echo "hello world"',
    ].join('\n');
    assert.equal(r.redact(plain), plain);
  });

  it('does not run across lines for an empty value', () => {
    assert.equal(r.redact('password=\nnext line'), 'password=\nnext line');
  });

  it('is idempotent', () => {
    const once = r.redact('Authorization: Bearer x\npassword=y\neyJabcdefgh.ijklmnopq.rst');
    assert.equal(r.redact(once), once);
  });
});

describe('custom patterns', () => {
  it('accepts strings and objects, adds the g flag', () => {
    const c = createRedactor(['internal-[0-9]+', { pattern: 'abc', flags: 'i' }]);
    assert.deepEqual(c.errors, []);
    assert.equal(c.redact('internal-1 internal-22 ABC'), `${R} ${R} ${R}`);
  });

  it('reports invalid patterns and keeps the valid ones', () => {
    const c = createRedactor(['([', { name: 'ok', pattern: 'x' }]);
    assert.equal(c.errors.length, 1);
    assert.match(c.errors[0]!, /^\(\[:/);
    assert.equal(c.redact('x'), R);
  });

  it('ignores zero-length matches', () => {
    assert.equal(createRedactor(['a*']).redact('bab'), `b${R}b`);
  });
});

describe('redaction of real-world IAM/OpenShift output', () => {
  const cases: Array<[string, string, string]> = [
    ['flag with space', 'kcadm.sh config credentials --user admin --password Adm1n-Kc-Pw', `kcadm.sh config credentials --user admin --password ${R}`],
    ['oc login -p', 'oc login -u kubeadmin -p Xk9pass123Q https://api:6443', `oc login -u kubeadmin -p ${R} https://api:6443`],
    ['quoted flag value', '--client-secret "a b c"', `--client-secret ${R}`],
    ['quoted key value with spaces', 'password = "Hunter 2 with spaces"', `password = "${R}"`],
    ['_PASS env', 'RHSSO_ADMIN_PASS=Welcome2024!', `RHSSO_ADMIN_PASS=${R}`],
    ['pwsh $env PASS', '$env:KC_PASS = "Sup3r-S3cret!"', `$env:KC_PASS = "${R}"`],
    ['bypass is not a pass', 'bypass: true\ncompass=north', 'bypass: true\ncompass=north'],
    ['keycloak client secret json', '{"type":"secret","value":"7f3a9c2e-55d1-4b8e-a0f2-9e8d7c6b5a41"}', `{"type":"secret","value":"${R}"}`],
    ['client secret prose', 'client secret for iam-portal is 7f3a9c2e-55d1-4b8e-a0f2-9e8d7c6b5a41', `client secret for iam-portal is ${R}`],
    ['tls.key yaml', '  tls.key: LS0tLS1CRUdJTiBQUklWQVRFIEtFWS0tLS0tCk1JSUV2', `  tls.key: ${R}`],
    ['curl -u', 'curl -u admin:S3cret https://x', `curl -u admin:${R} https://x`],
    ['mysql -p', 'mysql -h db -pS3cretPw keycloak', `mysql -h db -p${R} keycloak`],
    ['anthropic key', 'key sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx', `key ${R}`],
    ['gitlab token', 'glpat-AbCdEfGhIjKlMnOpQrSt12', R],
    ['token_type stays', '"token_type":"Bearer"', '"token_type":"Bearer"'],
    ['bearer needs a token', 'token type: Bearer expires: 300', 'token type: Bearer expires: 300'],
    ['hashtable authorization keeps the rest', '{Authorization=Bearer abc.def.ghi, X-Forwarded-For=203.0.113.50}', `{Authorization=${R}, X-Forwarded-For=203.0.113.50}`],
    // third review of 0.30: quoted user:pass, Redis passwords, literal values that start with $ or %
    ['curl -u "user:pass"', 'curl -u "u:S3cretPW" https://x', `curl -u "u:${R}" https://x`],
    ["curl -u 'user:pass with a space'", "curl -u 'u:S3cret PW' https://x", `curl -u 'u:${R}' https://x`],
    ['curl -u "…" with an escaped quote', 'curl -u "u:S3c\\"ret" https://x', `curl -u "u:${R}" https://x`],
    ['redis-server --requirepass', 'command: redis-server --requirepass S3cretPW', `command: redis-server --requirepass ${R}`],
    ['redis.conf requirepass', 'requirepass S3cretPW', `requirepass ${R}`],
    ['redis.conf masterauth', 'bind 0.0.0.0\nmasterauth S3cretPW\n', `bind 0.0.0.0\nmasterauth ${R}\n`],
    ['CONFIG SET requirepass', 'CONFIG SET requirepass S3cretPW', `CONFIG SET requirepass ${R}`],
    // fourth review of 0.30: bare requirepass/masterauth only where a line starts or after config set
    ['redis.conf commented out', '# requirepass S3cretPW', `# requirepass ${R}`],
    ['redis.conf ; and indent', '  ; masterauth S3cretPW', `  ; masterauth ${R}`],
    ['YAML list item', '  - requirepass S3cretPW', `  - requirepass ${R}`],
    ['redis-cli config set', 'redis-cli -h h config  set masterauth S3cretPW', `redis-cli -h h config  set masterauth ${R}`],
    ['REDISCLI_AUTH=', 'REDISCLI_AUTH=S3cretPW redis-cli', `REDISCLI_AUTH=${R} redis-cli`],
    ["--password '$…' (literal)", "--password '$3cretPW'", `--password ${R}`],
    ['--password %… (no %VAR%)', '--password %3cretPW', `--password ${R}`],
  ];
  for (const [name, input, expected] of cases) {
    it(name, () => assert.equal(r.redact(input), expected));
  }

  it('redacts every data value of a Secret manifest (YAML), keeping key names', () => {
    const yaml = [
      'apiVersion: v1',
      'data:',
      '  ca.crt: LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0t',
      '  username: YWRtaW4=',
      '  .dockerconfigjson: eyJhdXRocyI6e319',
      'kind: Secret',
      'metadata:',
      '  name: keycloak-admin',
      'type: Opaque',
    ].join('\n');
    const out = r.redact(yaml);
    assert.match(out, /  username: \[REDACTED\]\n/);
    assert.match(out, /  ca\.crt: \[REDACTED\]\n/);
    assert.match(out, /  \.dockerconfigjson: \[REDACTED\]\n/);
    assert.match(out, /  name: keycloak-admin/);
    assert.doesNotMatch(out, /YWRtaW4=/);
  });

  it('redacts Secret data in JSON, and leaves ConfigMaps alone', () => {
    const json = '{"apiVersion":"v1","data":{"password":"cGFzcw==","user":"YWRtaW4="},"kind":"Secret"}';
    assert.equal(r.redact(json), `{"apiVersion":"v1","data":{"password":"${R}","user":"${R}"},"kind":"Secret"}`);
    const cm = 'data:\n  LOG_LEVEL: debug\nkind: ConfigMap\n';
    assert.equal(r.redact(cm), cm);
  });

  it("redacts a Secret's escaped JSON in kubectl's last-applied-configuration (third review of 0.30)", () => {
    const applied =
      '"last-applied-configuration": "{\\"apiVersion\\":\\"v1\\",\\"data\\":{\\"db-url\\":\\"cG9zdGdyZXM6Ly91OnBAaA==\\"},\\"kind\\":\\"Secret\\"}"';
    assert.equal(r.redact(applied), `"last-applied-configuration": "{\\"apiVersion\\":\\"v1\\",\\"data\\":{\\"db-url\\":\\"${R}\\"},\\"kind\\":\\"Secret\\"}"`);
    const stringData = '{\\"kind\\":\\"Secret\\",\\"stringData\\":{\\"signing\\":\\"PlainS3cretValue9\\",\\"note\\":\\"a\\\\nb\\"}}';
    assert.equal(r.redact(stringData), `{\\"kind\\":\\"Secret\\",\\"stringData\\":{\\"signing\\":\\"${R}\\",\\"note\\":\\"${R}\\"}}`);
    // and in the whole object kubectl prints
    const full = [
      '{',
      '    "apiVersion": "v1",',
      '    "data": {',
      '        "api-url": "aHR0cHM6Ly9leGFtcGxl"',
      '    },',
      '    "kind": "Secret",',
      '    "metadata": {',
      '        "annotations": {',
      '            "kubectl.kubernetes.io/last-applied-configuration": "{\\"apiVersion\\":\\"v1\\",\\"kind\\":\\"Secret\\",\\"stringData\\":{\\"signing\\":\\"PlainS3cretValue9\\"}}\\n"',
      '        }',
      '    }',
      '}',
    ].join('\n');
    const out = r.redact(full);
    assert.doesNotMatch(out, /PlainS3cretValue9|aHR0cHM6/);
    assert.match(out, /\\"signing\\":\\"\[REDACTED\]\\"/);
    // a ConfigMap's escaped JSON stays
    const cm = '{\\"kind\\":\\"ConfigMap\\",\\"data\\":{\\"LOG_LEVEL\\":\\"debug\\"}}';
    assert.equal(r.redact(cm), cm);
  });
});

it('key=value redaction leaves references intact', () => {
  const r = createRedactor(DEFAULT_PATTERNS);
  assert.equal(r.redact('client_secret=${secret:KC}'), 'client_secret=${secret:KC}');
  assert.equal(r.redact('password="$(cat /run/pw)"'), 'password="$(cat /run/pw)"');
  assert.equal(r.redact('$env:TOKEN; token=$env:TOKEN'), '$env:TOKEN; token=$env:TOKEN');
  assert.equal(r.redact('set PASSWORD=%DB_PW%'), 'set PASSWORD=%DB_PW%');
  assert.equal(r.redact('password=${secret:X}tail'), 'password=[REDACTED]}tail');
  assert.equal(r.redact('password=$ecret123'), 'password=[REDACTED]');
  // in escaped JSON too: the `\` of `\"` ends a reference (second review of 0.30)
  for (const ref of ['${secret:DB_PW}', '${input:pw}', '$(cat /run/tok)', '%PW%']) {
    const s = `curl -d "{\\"password\\":\\"${ref}\\"}"`;
    assert.equal(r.redact(s), s);
  }
  assert.equal(r.redact('{\\"token\\":\\"$env:TOK\\"}'), '{\\"token\\":\\"$env:TOK\\"}');
  // a backslash before anything else is still part of the value
  assert.equal(r.redact('password=${secret:X}\\x'), 'password=[REDACTED]}\\x');
  // a flag's value: references stay, in "…" anything the shell expands, in '…' only REFERENCE (third review of 0.30)
  for (const s of [
    '--password "$PW"',
    '--password "${PW}"',
    '--password ${PW}',
    '--password $(cat f)',
    '--password %PW%',
    '--password "%PW%"',
    "--password '${secret:pw}'",
    '--password $PW',
    // the word AUTH alone is no flag
    'redis-cli AUTH default',
    'Send AUTH first, then the command.',
    // requirepass/masterauth elsewhere than at a line's start or after config set (fourth review of 0.30)
    'grep requirepass /etc/redis/redis.conf',
    'grep -n masterauth redis.conf',
    'redis-cli config get requirepass',
    // a reference after user: in quotes (fourth review of 0.30)
    'curl -u "admin:$PW" https://x',
    'curl -u "admin:${secret:pw}" https://x',
    "curl -u 'admin:${secret:pw}' https://x",
    'curl --user "admin:%PW%" https://x',
  ]) {
    assert.equal(r.redact(s), s, s);
  }
});
