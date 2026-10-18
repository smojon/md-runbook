import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { DEFAULT_PATTERNS, createRedactor } from '../src/core';

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
