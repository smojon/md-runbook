import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { isHighEntropyToken, maskSecret, redactLeaks, scanForLeaks, shannonEntropy, summarizeLeaks } from '../src/core/leaks';

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
});
