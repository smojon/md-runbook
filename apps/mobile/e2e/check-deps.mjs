// `expo install --check` as a CI gate that doesn't break on every Expo patch release: a package
// whose major or minor version differs from what the SDK expects fails the build; one that is only
// a patch behind is a warning on the run (update with `npx expo install --fix`, then pin exact).
//
//   node e2e/check-deps.mjs
import { spawnSync } from 'node:child_process';

const r = spawnSync('npx', ['expo', 'install', '--check'], { encoding: 'utf8', shell: process.platform === 'win32' });
const out = `${r.stdout}${r.stderr}`;
if (r.status === 0) {
  console.log('expo install --check: dependencies are up to date');
  process.exit(0);
}
// "  expo@58.0.14 - expected version: ~58.0.16"
const lines = [...out.matchAll(/^\s*(\S+)@(\d+)\.(\d+)\.\d+\S* - expected version: \D*(\d+)\.(\d+)\.\d+/gm)];
if (lines.length === 0) {
  console.error(out);
  console.error('expo install --check failed for a reason this script does not know');
  process.exit(1);
}
let drift = false;
for (const [, name, major, minor, wantMajor, wantMinor] of lines) {
  const patchOnly = major === wantMajor && minor === wantMinor;
  const line = lines.find((l) => l[1] === name)[0].trim();
  if (patchOnly) console.log(`::warning title=Expo patch available::${line} (npx expo install --fix, then pin)`);
  else {
    console.error(`::error title=Expo version mismatch::${line}`);
    drift = true;
  }
}
process.exit(drift ? 1 : 0);
