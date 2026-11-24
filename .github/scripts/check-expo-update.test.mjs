// node --test .github/scripts/check-expo-update.test.mjs: the checks of check-expo-update.mjs,
// with the bypasses of the security review (2026-11-16, round 4). No network: the registry is a
// stub.
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { checkUpdate, cleanSummary, dependencyTree, normalizeBin, pathName, registryJson, retryAfterMs, tarballUrl } from './check-expo-update.mjs';

const sha = (s) => `sha512-${Buffer.from(s).toString('base64')}`;
const entry = (name, version, more = {}) => ({ version, resolved: tarballUrl(name, version), integrity: sha(`${name}@${version}`), ...more });
const REGISTRY = {
  'expo@58.0.19': { dependencies: { '@expo/cli': '^58.1.0' } },
  'expo@58.0.21': { dependencies: { '@expo/cli': '^58.1.0' } },
  '@expo/cli@58.1.0': { dependencies: { semver: '^7.0.0' } },
  '@expo/cli@58.1.2': { dependencies: { semver: '^7.0.0' } },
  'semver@7.6.0': {},
  'semver@7.7.0': {},
  'left-pad@1.3.0': {},
  'left-pad@1.0.0': {},
  'evil@1.0.0': {},
  'evil-hook@1.0.0': { scripts: { postinstall: 'node steal.js' } },
};
const manifest = async (name, version) => {
  const m = REGISTRY[`${name}@${version}`];
  if (!m) throw new Error('HTTP 404');
  return { name, version, dist: { integrity: sha(`${name}@${version}`) }, ...m };
};
// The check runs at NOW; every version in REGISTRY was published a month before, but these.
const NOW = Date.parse('2026-11-16T12:00:00Z');
const PUBLISHED = { 'semver@7.7.0': '2026-11-01T00:00:00.000Z' };
const packumentCalls = [];
const packument = async (name) => {
  packumentCalls.push(name);
  const versions = Object.keys(REGISTRY).filter((k) => k.slice(0, k.lastIndexOf('@')) === name).map((k) => k.slice(k.lastIndexOf('@') + 1));
  if (versions.length === 0) throw new Error('HTTP 404');
  return { name, time: Object.fromEntries(versions.map((v) => [v, PUBLISHED[`${name}@${v}`] ?? '2026-10-16T00:00:00.000Z'])) };
};

const pkg = (expo) => ({ name: '@md-runbook/mobile', version: '1.0.0', dependencies: { expo, 'left-pad': '1.3.0' } });
const lock = (expo, cli, semver, extra = {}) => ({
  name: '@md-runbook/mobile',
  version: '1.0.0',
  lockfileVersion: 3,
  requires: true,
  packages: {
    '': { name: '@md-runbook/mobile', version: '1.0.0', dependencies: { expo, 'left-pad': '1.3.0' } },
    'node_modules/expo': entry('expo', expo, { dependencies: { '@expo/cli': '^58.1.0' } }),
    'node_modules/@expo/cli': entry('@expo/cli', cli, { dependencies: { semver: '^7.0.0' } }),
    'node_modules/semver': entry('semver', semver),
    'node_modules/left-pad': entry('left-pad', '1.3.0'),
    ...extra,
  },
});
const SUMMARY = 'Updated (published at least 7 days ago):\n\n- `expo` 58.0.19 → **58.0.21** (published 2026-11-01)\n';
const base = () => ({
  summary: SUMMARY,
  before: pkg('58.0.19'),
  after: pkg('58.0.21'),
  lockBefore: lock('58.0.19', '58.1.0', '7.6.0'),
  lockAfter: lock('58.0.21', '58.1.2', '7.7.0'),
  manifest,
  packument,
  now: NOW,
});
const problems = (over = (x) => x) => checkUpdate(over(base()));

describe('check-expo-update', () => {
  it('a real update: the named package and its dependencies, as the registry has them', async () => {
    assert.deepEqual(await problems(), []);
    // The lock keeps the range npm wrote; e2e/pin-exact.mjs pins package.json only.
    const ranged = await problems((x) => {
      x.lockAfter.packages[''].dependencies.expo = '~58.0.21';
      return x;
    });
    assert.deepEqual(ranged, []);
    const other = await problems((x) => {
      x.lockAfter.packages[''].dependencies['left-pad'] = '^1.3.0';
      return x;
    });
    assert.match(other.join('\n'), /the root's dependencies\.left-pad is \^1\.3\.0, package\.json has 1\.3\.0/);
  });

  it('lock paths and tarball URLs, scoped names too', () => {
    assert.equal(pathName('node_modules/a/node_modules/@s/b'), '@s/b');
    assert.equal(tarballUrl('@expo/cli', '1.2.3'), 'https://registry.npmjs.org/@expo/cli/-/cli-1.2.3.tgz');
    assert.deepEqual([...dependencyTree(lock('58.0.21', '58.1.2', '7.7.0').packages, ['expo'])].sort(), ['node_modules/@expo/cli', 'node_modules/expo', 'node_modules/semver']);
  });

  it("refuses a resolved URL of another registry package, with that package's real hash", async () => {
    const p = await problems((x) => {
      x.lockAfter.packages['node_modules/semver'] = { ...entry('evil', '1.0.0'), version: '7.7.0' };
      return x;
    });
    assert.match(p.join('\n'), /node_modules\/semver resolves to https:\/\/registry\.npmjs\.org\/evil\/-\/evil-1\.0\.0\.tgz, not https:\/\/registry\.npmjs\.org\/semver\/-\/semver-7\.7\.0\.tgz/);
  });

  it("refuses an integrity that isn't the registry's", async () => {
    const p = await problems((x) => {
      x.lockAfter.packages['node_modules/semver'].integrity = sha('something else');
      return x;
    });
    assert.match(p.join('\n'), /node_modules\/semver has the integrity .*, the registry's is/);
  });

  it('refuses a summary version that is a spec, not a version (npm:evil@1.0.0)', async () => {
    const p = await problems((x) => ({
      ...x,
      summary: '- `expo` 58.0.19 → **npm:evil@1.0.0** (published 2026-11-01)\n',
      after: pkg('npm:evil@1.0.0'),
    }));
    assert.match(p.join('\n'), /the summary gives expo the version "npm:evil@1\.0\.0", not a plain version/);
  });

  it('refuses a new bundled entry (inBundle skipped every check before)', async () => {
    const p = await problems((x) => {
      x.lockAfter.packages['node_modules/expo/node_modules/evil'] = { version: '1.0.0', inBundle: true, resolved: 'https://evil.example/evil.tgz' };
      x.lockAfter.packages['node_modules/expo'].dependencies.evil = '1.0.0';
      return x;
    });
    assert.match(p.join('\n'), /node_modules\/expo\/node_modules\/evil is bundled in another package/);
  });

  it('refuses a change to a package no named package depends on', async () => {
    const p = await problems((x) => {
      x.lockAfter.packages['node_modules/left-pad'] = entry('left-pad', '1.0.0');
      return x;
    });
    assert.match(p.join('\n'), /node_modules\/left-pad changed, but no package in the summary depends on it/);
  });

  it('refuses git, file and link specs', async () => {
    for (const [change, why] of [
      [{ resolved: 'git+ssh://git@github.com/evil/semver.git#abc' }, /resolves to git\+ssh/],
      [{ resolved: 'file:../evil' }, /resolves to file:/],
      [{ resolved: undefined, link: true }, /is a link/],
    ]) {
      const p = await problems((x) => {
        Object.assign(x.lockAfter.packages['node_modules/semver'], change);
        return x;
      });
      assert.match(p.join('\n'), why);
    }
  });

  it('refuses an alias (another package under the name)', async () => {
    const p = await problems((x) => {
      x.lockAfter.packages['node_modules/semver'] = { ...entry('evil', '1.0.0'), name: 'evil' };
      return x;
    });
    assert.match(p.join('\n'), /node_modules\/semver has another package name \(evil for semver\): an alias/);
  });

  it('refuses install scripts: a changed hasInstallScript, or one the lock leaves out', async () => {
    const flagged = await problems((x) => {
      x.lockAfter.packages['node_modules/semver'].hasInstallScript = true;
      return x;
    });
    assert.match(flagged.join('\n'), /node_modules\/semver has an install script now/);
    const hidden = await problems((x) => {
      x.lockAfter.packages['node_modules/expo'].dependencies['evil-hook'] = '1.0.0';
      x.lockAfter.packages['node_modules/evil-hook'] = entry('evil-hook', '1.0.0');
      return x;
    });
    assert.match(hidden.join('\n'), /node_modules\/evil-hook has an install script on the registry/);
  });

  it("refuses dependencies that aren't the registry's (they would widen the tree)", async () => {
    const p = await problems((x) => {
      x.lockAfter.packages['node_modules/expo'].dependencies['left-pad'] = '1.0.0';
      x.lockAfter.packages['node_modules/left-pad'] = entry('left-pad', '1.0.0');
      return x;
    });
    assert.match(p.join('\n'), /node_modules\/expo dependencies are not the registry's/);
  });

  it("refuses a lock whose named package isn't the summary's version, or whose root changed", async () => {
    const p = await problems((x) => {
      x.lockAfter.packages['node_modules/expo'] = entry('expo', '58.0.19', { dependencies: { '@expo/cli': '^58.1.0' } });
      x.lockAfter.packages[''].scripts = { postinstall: 'node evil.js' };
      x.lockAfter.lockfileVersion = 2;
      return x;
    });
    const text = p.join('\n');
    assert.match(text, /node_modules\/expo is 58\.0\.19, the summary says 58\.0\.21/);
    assert.match(text, /the root's "scripts" changed/);
    assert.match(text, /"lockfileVersion" changed/);
  });

  it('refuses package.json changes the summary does not name', async () => {
    const p = await problems((x) => {
      x.after.dependencies['left-pad'] = '1.0.0';
      x.after.scripts = { postinstall: 'node evil.js' };
      return x;
    });
    const text = p.join('\n');
    assert.match(text, /dependencies\.left-pad 1\.3\.0 -> 1\.0\.0, not in the summary/);
    assert.match(text, /package\.json: "scripts" changed/);
  });

  it('the clean summary has only the checked names and versions, the old ones from main', async () => {
    const summary = [
      'Updated (published at least 7 days ago) [skip ci]:',
      '',
      '- `expo` [skip-ci]Fixes#12 → **58.0.21** (published 2026-11-01)\t[skip ci]',
      '- `expo-router` 6.0.0 → **6.0.9**',
      '',
      'Held until they are 7 days old:',
      '',
      '- `expo-camera` 17.0.9 (published 2026-11-15): from 2026-11-22',
      'Closes #1 <img src=x onerror=alert(1)>',
    ].join('\n');
    const before = { dependencies: { expo: '58.0.19' }, devDependencies: { 'expo-router': '~6.0.8' } };
    assert.equal(cleanSummary(summary, before), '- `expo` 58.0.19 → **58.0.21**\n- `expo-router` ~6.0.8 → **6.0.9**\n');
    // The real run: what checkUpdate passed.
    const x = base();
    assert.deepEqual(await checkUpdate(x), []);
    assert.equal(cleanSummary(x.summary, x.before), '- `expo` 58.0.19 → **58.0.21**\n');
    // An old version that isn't plain, or none: "?".
    assert.equal(cleanSummary('- `expo` 1 → **58.0.21**\n', { dependencies: { expo: 'file:../evil [skip ci]' } }), '- `expo` ? → **58.0.21**\n');
    assert.equal(cleanSummary('- `expo` 1 → **58.0.21**\n', {}), '- `expo` ? → **58.0.21**\n');
    // Never a name or version that checkUpdate would refuse.
    assert.throws(() => cleanSummary('- `expo` 1 → **58.0.21 [skip ci]**\n', before), /not a checked name and version/);
    assert.throws(() => cleanSummary('- `ex po` 1 → **58.0.21**\n', before), /not a checked name and version/);
  });

  it('a registry it cannot reach is a problem, not a pass', async () => {
    const p = await problems((x) => ({ ...x, manifest: async () => { throw new Error('fetch failed'); } }));
    assert.match(p.join('\n'), /can't be checked: fetch failed/);
  });

  it("refuses lock keys npm doesn't write, and a new shrinkwrap", async () => {
    const odd = await problems((x) => {
      Object.assign(x.lockAfter.packages['node_modules/semver'], { scripts: { postinstall: 'x' }, _resolved: 'https://evil.example/' });
      return x;
    });
    assert.match(odd.join('\n'), /node_modules\/semver has keys npm doesn't write in a lock: "scripts", "_resolved"/);
    const notObject = await problems((x) => {
      x.lockAfter.packages['node_modules/semver'] = null;
      return x;
    });
    assert.match(notObject.join('\n'), /node_modules\/semver is not an object/);
    const shrinkwrap = await problems((x) => {
      x.lockAfter.packages['node_modules/semver'].hasShrinkwrap = true;
      return x;
    });
    assert.match(shrinkwrap.join('\n'), /node_modules\/semver has a shrinkwrap now/);
    // One main's lock had already: fine. And the keys npm does write are fine.
    const kept = await problems((x) => {
      x.lockBefore.packages['node_modules/semver'].hasShrinkwrap = true;
      Object.assign(x.lockAfter.packages['node_modules/semver'], { hasShrinkwrap: true, dev: true, license: 'ISC', funding: { url: 'https://example.net' }, deprecated: 'old' });
      return x;
    });
    assert.deepEqual(kept, []);
  });

  it("refuses engines, os, cpu, libc and bin that aren't the registry's; bin as npm normalizes it", async () => {
    const withRegistry = (fields) => async (name, version) => ({ ...(await manifest(name, version)), ...(name === 'semver' ? fields : {}) });
    const run = (lockFields, registryFields) =>
      problems((x) => {
        Object.assign(x.lockAfter.packages['node_modules/semver'], lockFields);
        return { ...x, manifest: withRegistry(registryFields) };
      });
    assert.deepEqual(await run({ engines: { node: '>=10' }, os: ['linux'], cpu: ['x64'], bin: { semver: 'bin/semver.js' } }, { engines: { node: '>=10' }, os: ['linux'], cpu: ['x64'], bin: './bin/semver.js' }), []);
    assert.match((await run({ engines: { node: '>=10' } }, {})).join('\n'), /node_modules\/semver engines are not the registry's/);
    assert.match((await run({}, { os: ['darwin'] })).join('\n'), /node_modules\/semver os are not the registry's/);
    assert.match((await run({ cpu: ['arm64'] }, { cpu: ['x64'] })).join('\n'), /node_modules\/semver cpu are not the registry's/);
    assert.match((await run({ bin: { semver: 'bin/evil.js' } }, { bin: 'bin/semver.js' })).join('\n'), /node_modules\/semver bin is not the registry's/);
    assert.match((await run({ bin: { semver: 'bin/semver.js', node: 'bin/evil.js' } }, { bin: { semver: './bin/semver.js' } })).join('\n'), /bin is not the registry's/);
    assert.match((await run({ bin: { semver: 'bin/semver.js' } }, {})).join('\n'), /bin is not the registry's/);
    // libc: npm 10 writes none in a lock (the 19 Nov failures); one it writes must be the registry's.
    assert.deepEqual(await run({}, { libc: ['glibc'] }), []);
    assert.deepEqual(await run({ libc: ['glibc'] }, { libc: ['glibc'] }), []);
    assert.match((await run({ libc: ['musl'] }, { libc: ['glibc'] })).join('\n'), /node_modules\/semver libc are not the registry's/);
    assert.match((await run({ libc: ['glibc'] }, {})).join('\n'), /node_modules\/semver libc are not the registry's/);
    // npm's own normalizing: a string under the unscoped name, no "./", folded paths.
    assert.deepEqual(normalizeBin('./cli.js', '@expo/cli'), { cli: 'cli.js' });
    assert.deepEqual(normalizeBin({ 'bin/x': './a/../b.js', y: '' }, 'x'), { x: 'b.js' });
    assert.equal(normalizeBin(undefined, 'x'), undefined);
  });

  it('refuses a changed entry published less than 7 days before the check, or without a time', async () => {
    const young = await problems((x) => ({
      ...x,
      packument: async (name) => ({ ...(await packument(name)), ...(name === 'semver' ? { time: { '7.7.0': '2026-11-12T00:00:00.000Z' } } : {}) }),
    }));
    assert.match(young.join('\n'), /node_modules\/semver was published 2026-11-12T00:00:00\.000Z, less than 7 days ago/);
    assert.equal(young.length, 1);
    const none = await problems((x) => ({ ...x, packument: async (name) => ({ ...(await packument(name)), time: {} }) }));
    assert.match(none.join('\n'), /node_modules\/expo has no publish time on the registry for 58\.0\.21/);
    const other = await problems((x) => ({ ...x, packument: async () => ({ name: 'evil', time: { '58.0.21': '2020-01-01T00:00:00Z' } }) }));
    assert.match(other.join('\n'), /node_modules\/expo has no publish time on the registry/);
    const down = await problems((x) => ({ ...x, packument: async () => { throw new Error('HTTP 503'); } }));
    assert.match(down.join('\n'), /node_modules\/expo can't be checked for its age: HTTP 503/);
    // Exactly 7 days old is old enough.
    const edge = await problems((x) => ({ ...x, now: Date.parse('2026-11-08T00:00:00.000Z'), packument: async (name) => ({ name, time: { '58.0.21': '2026-11-01T00:00:00.000Z', '58.1.2': '2026-11-01T00:00:00.000Z', '7.7.0': '2026-11-01T00:00:00.000Z' } }) }));
    assert.deepEqual(edge, []);
  });

  it('fetches each package document once', async () => {
    packumentCalls.length = 0;
    const p = await problems((x) => {
      // A second copy of semver 7.7.0, under @expo/cli.
      x.lockAfter.packages['node_modules/@expo/cli/node_modules/semver'] = entry('semver', '7.7.0');
      return x;
    });
    assert.deepEqual(p, []);
    assert.deepEqual(packumentCalls.sort(), ['@expo/cli', 'expo', 'semver']);
  });

  it('asks the registry again after a 429 or 5xx, as Retry-After says; a 404 stops at once', async () => {
    const answers = (...list) => {
      const calls = [];
      const fetch = async (url, init) => {
        calls.push([url, init.headers.accept]);
        const a = list.shift();
        if (a instanceof Error) throw a;
        return new Response(a.body ?? '', { status: a.status, headers: a.headers ?? {} });
      };
      return { calls, fetch };
    };
    const waits = [];
    const sleep = async (ms) => void waits.push(ms);

    let r = answers({ status: 429, headers: { 'retry-after': '5' } }, { status: 503 }, new Error('ECONNRESET'), { status: 200, body: '{"ok":true}' });
    assert.deepEqual(await registryJson('https://registry.npmjs.org/semver', { fetch: r.fetch, sleep }), { ok: true });
    assert.deepEqual(waits, [5000, 2000, 4000]);
    assert.deepEqual(r.calls[0], ['https://registry.npmjs.org/semver', 'application/json']);

    waits.length = 0;
    r = answers({ status: 404 });
    await assert.rejects(registryJson('u', { fetch: r.fetch, sleep }), /HTTP 404/);
    assert.deepEqual([r.calls.length, waits], [1, []]);

    r = answers({ status: 500 }, { status: 502 }, { status: 503 }, { status: 504 }, { status: 200, body: '{}' });
    await assert.rejects(registryJson('u', { fetch: r.fetch, sleep }), /HTTP 504/);
    assert.equal(r.calls.length, 4, 'four tries in all');

    // Retry-After: seconds or an HTTP date, never more than 60 s.
    const now = Date.parse('2026-11-16T12:00:00Z');
    assert.equal(retryAfterMs('7', now), 7000);
    assert.equal(retryAfterMs('3600', now), 60_000);
    assert.equal(retryAfterMs('Mon, 16 Nov 2026 12:00:30 GMT', now), 30_000);
    assert.equal(retryAfterMs('Mon, 16 Nov 2026 11:00:00 GMT', now), 0);
    assert.equal(retryAfterMs('soon', now), undefined);
    assert.equal(retryAfterMs(null, now), undefined);
  });
});
