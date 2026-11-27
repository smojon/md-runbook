// `expo install --check` as a CI gate that doesn't break on every Expo patch release: a package
// whose major or minor version differs from what the SDK expects fails the build; one that is only
// a patch behind is a warning on the run, and so is one the SDK expects that is younger than 7 days. The daily Expo updates workflow (expo-updates.yml) opens
// a pull request with the patch releases (`npx expo install --fix`, then e2e/pin-exact.mjs).
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
// A minor or major the SDK expects that is younger than MIN_AGE_DAYS is held, as by the daily
// Expo updates workflow (expo-updates.mjs): a warning until it is old enough to take.
const minAgeDays = Number(process.env.MIN_AGE_DAYS ?? 7);
const DAY = 24 * 60 * 60 * 1000;
/** When `name`'s first release of wantMajor.wantMinor was published (undefined: unknown). */
function firstRelease(name, wantMajor, wantMinor) {
  const v = spawnSync('npm', ['view', name, 'time', '--json'], { encoding: 'utf8', shell: process.platform === 'win32' });
  if (v.status !== 0) return undefined;
  try {
    const times = JSON.parse(v.stdout);
    const dates = Object.keys(times)
      .filter((k) => k.startsWith(`${wantMajor}.${wantMinor}.`) && /^\d+\.\d+\.\d+$/.test(k))
      .map((k) => new Date(times[k]).getTime());
    return dates.length ? Math.min(...dates) : undefined;
  } catch {
    return undefined;
  }
}
let drift = false;
for (const [, name, major, minor, wantMajor, wantMinor] of lines) {
  const patchOnly = major === wantMajor && minor === wantMinor;
  const line = lines.find((l) => l[1] === name)[0].trim();
  if (patchOnly) {
    console.log(`::warning title=Expo patch available::${line} (npx expo install --fix, then pin)`);
    continue;
  }
  const published = firstRelease(name, wantMajor, wantMinor);
  if (published !== undefined && Date.now() - published < minAgeDays * DAY) {
    const ripe = new Date(published + minAgeDays * DAY).toISOString().slice(0, 10);
    console.log(`::warning title=Expo release held::${line} (published ${new Date(published).toISOString().slice(0, 10)}, held until ${ripe})`);
    continue;
  }
  console.error(`::error title=Expo version mismatch::${line}`);
  drift = true;
}
process.exit(drift ? 1 : 0);
