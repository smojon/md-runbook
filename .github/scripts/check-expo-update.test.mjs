// node --test .github/scripts/check-expo-update.test.mjs: the checks of check-expo-update.mjs,
// with the bypasses of the security review (2026-11-16, round 4). No network: the registry is a
// stub.
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { checkUpdate, cleanSummary, dependencyTree, pathName, tarballUrl } from './check-expo-update.mjs';

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
});
