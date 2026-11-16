import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { loadConfig, readTokens } from '../src/config';

describe('config', () => {
  let dir: string;
  let lib: string;
  const T = 'a-token-of-at-least-24-characters';
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdrb-libcfg-'));
    lib = path.join(dir, 'library');
    fs.mkdirSync(lib);
    fs.writeFileSync(path.join(dir, 'map.json'), '{"routes":[]}');
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('tokens: at least 24 characters; label:token names one in the log, else a short hash', () => {
    assert.throws(() => readTokens({ X: 'short' }, 'X'), /at least 24/);
    const [a, b] = readTokens({ X: `ci:${T}, ${T}x` }, 'X');
    assert.deepEqual(a, { label: 'ci', value: T });
    assert.match(b!.label, /^token-[0-9a-f]{8}$/);
    fs.writeFileSync(path.join(dir, 'tokens'), `alice:${T}\nbob:${T}y\n`);
    assert.deepEqual(
      readTokens({ X_FILE: path.join(dir, 'tokens') }, 'X').map((t) => t.label),
      ['alice', 'bob'],
    );
  });

  it('fails closed: the library needs upload tokens and the signers it checks; something must be on', () => {
    assert.throws(() => loadConfig({}), /Nothing to serve/);
    assert.throws(() => loadConfig({ LIBRARY_DIR: lib }), /LIBRARY_UPLOAD_TOKENS/);
    assert.throws(() => loadConfig({ LIBRARY_DIR: lib, LIBRARY_UPLOAD_TOKENS: T }), /LIBRARY_ALLOWED_SIGNERS/);
    assert.throws(() => loadConfig({ LIBRARY_UPLOAD_TOKENS: T }), /LIBRARY_DIR is not/);
    fs.writeFileSync(path.join(lib, 'allowed_signers'), '');
    const c = loadConfig({ LIBRARY_DIR: lib, LIBRARY_UPLOAD_TOKENS: T });
    assert.equal(c.library!.allowedSigners, path.join(lib, 'allowed_signers'));
    assert.deepEqual([c.library!.acceptV1, c.library!.allowDelete, c.library!.signedOnly, c.host, c.port], [false, false, true, '127.0.0.1', 8090]);
    assert.throws(() => loadConfig({ LIBRARY_DIR: lib, LIBRARY_UPLOAD_TOKENS: T, LIBRARY_ACCEPT_V1: 'maybe' }), /true or false/);
  });

  it('runs: RUNS_REQUIRE_SIGNED needs runner keys or gate tokens; alerts: PUBLIC_URL is https', () => {
    assert.throws(() => loadConfig({ RUNS_DIR: dir, RUNS_REQUIRE_SIGNED: 'true' }), /RUNS_ALLOWED_RUNNERS/);
    assert.equal(loadConfig({ RUNS_DIR: dir, RUNS_REQUIRE_SIGNED: 'true', RUNS_GATE_TOKENS: T }).runs!.requireSigned, true);
    const map = path.join(dir, 'map.json');
    assert.throws(() => loadConfig({ ALERT_MAP: map }), /PUBLIC_URL/);
    assert.throws(() => loadConfig({ ALERT_MAP: map, PUBLIC_URL: 'http://runbooks.example.net' }), /https/);
    const a = loadConfig({ ALERT_MAP: map, PUBLIC_URL: 'https://runbooks.example.net/', LIBRARY_PUBLIC_PATH: 'sop', RUNS_READ_TOKENS: T, ALERTS_TOKENS: T }).alerts!;
    assert.deepEqual([a.publicUrl, a.libraryPath, a.readTokens.length], ['https://runbooks.example.net', '/sop/', 1]);
    // No token: refused, unless the operator says anyone may post (security review, 2026-11-16).
    assert.throws(() => loadConfig({ ALERT_MAP: map, PUBLIC_URL: 'https://runbooks.example.net/' }), /ALERTS_TOKENS/);
    assert.equal(loadConfig({ ALERT_MAP: map, PUBLIC_URL: 'https://runbooks.example.net/', ALERTS_ALLOW_ANYONE: 'true' }).alerts!.tokens.length, 0);
  });
});
