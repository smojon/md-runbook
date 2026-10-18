import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { base64Prefix, isHighEntropyToken, maskSecret, redactLeaks, scanForLeaks, shannonEntropy, summarizeLeaks } from '../src/core/leaks';

const kinds = (text: string, domains?: string[]): string[] => scanForLeaks(text, { internalDomains: domains }).map((f) => f.kind);

describe('scanForLeaks', () => {
  it('reports known formats with line, column and a masked preview', () => {
    const f = scanForLeaks('ok\n  key AKIAABCDEFGHIJKLMNOP end');
    assert.deepEqual(f, [{ line: 2, column: 7, offset: 9, length: 20, kind: 'aws-access-key-id', preview: 'AKIA…(20 chars)' }]);
  });

  it('finds default redaction formats', () => {
    assert.deepEqual(kinds('Authorization: Basic dXNlcjpwYXNz'), ['authorization-header']);
    assert.deepEqual(kinds('password=hunter2'), ['secret-key-value']);
    assert.deepEqual(kinds('ghp_abcdefghijklmnopqrstuvwxyz0123456789'), ['github-token']);
    assert.deepEqual(kinds('https://user:pa55@host.test/'), ['url-credentials']);
    assert.deepEqual(kinds('eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl'), ['jwt']);
  });

  it('finds private keys and cloud key shapes', () => {
    assert.deepEqual(kinds('-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----'), ['private-key', 'private-key']);
    assert.deepEqual(kinds('AIzaSyA1234567890abcdefghijklmnopqrstuv'), ['gcp-api-key']);
    assert.deepEqual(kinds('ya29.a0AfH6SMBxxxxxxxxxxxxxxxxxxxx'), ['gcp-oauth-token']);
    assert.deepEqual(kinds('DefaultEndpointsProtocol=https;AccountKey=abcdEFGH1234abcdEFGH1234abcd=='), ['azure-storage-key']);
    assert.deepEqual(kinds('https://x.blob.core.windows.net/c?sv=2020&sig=abcdEFGH1234abcdEFGH1234%3D'), ['azure-sas-signature']);
    assert.deepEqual(kinds('secret abc8Q~abcdefghijklmnopqrstuvwxyz0123456'), ['azure-client-secret']);
  });

  it('finds high-entropy tokens', () => {
    assert.deepEqual(kinds('value aZ9xQ2mP7vL4kR8sT1wY6bN3cF5hJ0dG here'), ['high-entropy']);
    assert.ok(shannonEntropy('aZ9xQ2mP7vL4kR8sT1wY6bN3cF5hJ0dG') >= 4);
  });

  it('skips digests, names, paths, references and redacted values', () => {
    assert.deepEqual(kinds('commit 0123456789abcdef0123456789abcdef01234567'), []);
    assert.deepEqual(kinds('sha256 ' + 'ab12'.repeat(16)), []);
    assert.deepEqual(kinds('pod my-deployment-7d4b9c8f6d-x2k9p and 3f2b8c1e-4d5a-4b6c-9e7f-0a1b2c3d4e5f'), []);
    assert.deepEqual(kinds('/usr/lib/x86_64-linux-gnu/libQt5Core.so.5'), []);
    assert.deepEqual(kinds('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1'), []);
    assert.deepEqual(kinds('password=[REDACTED]\nAuthorization: Bearer [REDACTED]'), []);
    assert.deepEqual(kinds('--password "$DB_PASS" token=${TOKEN} secret=%SECRET% api_key=$env:KEY'), []);
    assert.equal(isHighEntropyToken('ThisIsJustAVeryLongCamelCaseIdentifierName'), false);
  });

  it('reports hosts under internal domains, shown in full', () => {
    const f = scanForLeaks('see db1.eu.corp.example.com and corp.example.com, not notcorp.example.com', { internalDomains: ['corp.example.com'] });
    assert.deepEqual(
      f.map((x) => [x.kind, x.preview]),
      [
        ['internal-domain', 'db1.eu.corp.example.com'],
        ['internal-domain', 'corp.example.com'],
      ],
    );
  });

  it('does not report the same span twice', () => {
    assert.deepEqual(kinds('token: AKIAABCDEFGHIJKLMNOP'), ['aws-access-key-id']);
  });
});

describe('redactLeaks', () => {
  it('replaces secrets but not internal domains', () => {
    assert.equal(
      redactLeaks('x AKIAABCDEFGHIJKLMNOP on db.corp.example.com\npassword=hunter2', { internalDomains: ['corp.example.com'] }),
      'x [REDACTED] on db.corp.example.com\npassword=[REDACTED]',
    );
  });
});

describe('helpers', () => {
  it('masks and summarizes', () => {
    assert.equal(maskSecret('short'), '****');
    assert.equal(maskSecret('abcdefghijkl'), 'abcd…(12 chars)');
    assert.equal(summarizeLeaks(scanForLeaks('AKIAABCDEFGHIJKLMNOP AKIAABCDEFGHIJKLMNOQ password=x')), '2 aws-access-key-id, 1 secret-key-value');
  });

  it('decodes base64 prefixes', () => {
    assert.equal(base64Prefix(Buffer.from('-----BEGIN X').toString('base64')), '-----BEGIN X');
    assert.equal(base64Prefix('not base64!'), '');
  });
});

describe('scanForLeaks: references and harmless values', () => {
  it('never reports variable references, and redactLeaks leaves them intact', () => {
    const lines = [
      'curl -H "Authorization: Bearer ${secret:API_TOKEN}" https://api.test',
      'curl -H "Authorization: ${secret:API_TOKEN}"',
      'oc login --token=${secret:OC_TOKEN} https://api.test:6443',
      'curl -d "client_secret=${secret:CLIENT_SECRET}" -d "password=${input:DB_PASSWORD}"',
      'psql "password=${param:PW} sslkey=${secretFile:PG_KEY}"',
      'export TOKEN=$(cat token.txt)',
      'export TOKEN=$(kubectl get secret x -o jsonpath="{.data.token}" | base64 -d)',
      'token=${TOKEN:-none} secret=$SECRET password=%PASSWORD% api_key=$env:API_KEY',
    ];
    for (const l of lines) {
      assert.deepEqual(kinds(l), [], l);
      assert.equal(redactLeaks(l), l);
    }
  });

  it('still reports a literal value that only contains a $', () => {
    assert.deepEqual(kinds('password=Pa$sw0rd'), ['secret-key-value']);
  });

  it('skips a private key whose body is already redacted', () => {
    assert.deepEqual(kinds('-----BEGIN RSA PRIVATE KEY-----[REDACTED]-----END RSA PRIVATE KEY-----'), []);
    assert.deepEqual(kinds('-----BEGIN RSA PRIVATE KEY-----\n[REDACTED]\n-----END RSA PRIVATE KEY-----'), []);
    assert.deepEqual(kinds('-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----'), ['private-key', 'private-key']);
  });

  it('splits key=value before the entropy test and keeps the key', () => {
    const uuid = '3f2b8c1e-4d5a-4b6c-9e7f-0a1b2c3d4e5f';
    assert.deepEqual(kinds(`userId=${uuid} AZURE_TENANT_ID=${uuid}`), []);
    assert.deepEqual(kinds('pod-template-hash=7d4b9c8f6d controller-revision-hash=keycloak-6b8f7c9d5f'), []);
    assert.deepEqual(kinds('labels: app=x,pod-template-hash=5d8f9c7b6a'), []);
    assert.deepEqual(kinds('build=0123456789abcdef0123456789abcdef0123'), []);
    assert.equal(redactLeaks('MY_VALUE=aZ9xQ2mP7vL4kR8sT1wY6bN3cF5hJ0dG'), 'MY_VALUE=[REDACTED]');
    assert.equal(redactLeaks(`AZURE_CLIENT_SECRET=${uuid}`), 'AZURE_CLIENT_SECRET=[REDACTED]');
  });
});

describe('scanForLeaks: secrets known by their context', () => {
  const uuid = '6d0e3f1a-2b4c-4d5e-8f9a-0b1c2d3e4f5a';

  it('finds Keycloak client secrets in UUID format', () => {
    assert.equal(redactLeaks(`{"type":"secret","value":"${uuid}"}`), '{"type":"secret","value":"[REDACTED]"}');
    assert.equal(redactLeaks(`{\n  "type" : "secret",\n  "value" : "${uuid}"\n}`), '{\n  "type" : "secret",\n  "value" : "[REDACTED]"\n}');
    assert.equal(redactLeaks(`{"value":"${uuid}","type":"secret"}`), '{"value":"[REDACTED]","type":"secret"}');
    assert.deepEqual(kinds(`Client secret for iam-portal: ${uuid}`), ['uuid-secret']);
    assert.deepEqual(kinds(`{"type":"password","value":"x"} id ${uuid}`), []);
  });

  it('finds the values of a kind: Secret manifest (YAML), not of a ConfigMap', () => {
    const secret = 'apiVersion: v1\ndata:\n  tls.crt: dGxzY3J0\n  username: YWRtaW4=\nkind: Secret\nmetadata:\n  name: db\n  namespace: iam\ntype: Opaque';
    assert.equal(
      redactLeaks(secret),
      'apiVersion: v1\ndata:\n  tls.crt: [REDACTED]\n  username: [REDACTED]\nkind: Secret\nmetadata:\n  name: db\n  namespace: iam\ntype: Opaque',
    );
    assert.deepEqual(kinds('apiVersion: v1\ndata:\n  username: YWRtaW4=\nkind: ConfigMap'), []);
    const list =
      'items:\n- apiVersion: v1\n  kind: Secret\n  stringData:\n    cfg: |\n      user=a\n      pass=b\n    x: "y"\n- apiVersion: v1\n  data:\n    a: b\n  kind: ConfigMap';
    assert.equal(
      redactLeaks(list),
      'items:\n- apiVersion: v1\n  kind: Secret\n  stringData:\n    cfg: |\n      [REDACTED]\n      [REDACTED]\n    x: "[REDACTED]"\n- apiVersion: v1\n  data:\n    a: b\n  kind: ConfigMap',
    );
  });

  it('finds the values of a kind: Secret manifest (JSON, also escaped in an annotation)', () => {
    assert.equal(
      redactLeaks('{"apiVersion":"v1","data":{"user":"YWRtaW4=","pw":"cGFzcw=="},"kind":"Secret"}'),
      '{"apiVersion":"v1","data":{"user":"[REDACTED]","pw":"[REDACTED]"},"kind":"Secret"}',
    );
    assert.equal(
      redactLeaks('last-applied-configuration: "{\\"data\\":{\\"user\\":\\"YWRtaW4=\\"},\\"kind\\":\\"Secret\\"}"'),
      'last-applied-configuration: "{\\"data\\":{\\"user\\":\\"[REDACTED]\\"},\\"kind\\":\\"Secret\\"}"',
    );
    assert.deepEqual(kinds('{"data":{"user":"YWRtaW4="},"kind":"ConfigMap"}'), []);
  });

  it('finds base64 that decodes to a PEM block or a docker config', () => {
    const b64 = (s: string): string => Buffer.from(s).toString('base64');
    assert.deepEqual(kinds('ca: ' + b64('-----BEGIN PRIVATE KEY-----\nMIIB')), ['encoded-secret']);
    assert.deepEqual(kinds('.dockerconfigjson: ' + b64('{"auths":{"r.acme.de":{"auth":"x"}}}')), ['encoded-secret']);
    assert.deepEqual(kinds('msg: ' + b64('hello world!')), []);
  });
});
