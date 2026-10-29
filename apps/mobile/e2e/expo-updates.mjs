// The update of the daily Expo updates workflow (.github/workflows/expo-updates.yml): the patch
// releases `expo install --check` lists, but only versions published at least MIN_AGE_DAYS ago
// (default 7). The npm worms of 2025 (Shai-Hulud) published compromised versions that were found
// and pulled within hours or days; a week's wait sidesteps that window. The same rule as
// anotherMoney's `minimumReleaseAge` (pnpm) and `deps:age`.
//
// For each package: the newest release of its major.minor that is old enough, never older than
// the installed one. They are installed with `npm install --before`, so the dependencies they
// bring are old enough too; exact pins are kept (pin-exact.mjs). A package whose expected version
// is newer than that is held, with the date it becomes old enough. Writes a Markdown summary.
//
//   npx expo install --check > check.txt; node e2e/expo-updates.mjs check.txt summary.md
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pinExact } from './pin-exact.mjs';

const DAY = 24 * 60 * 60 * 1000;
const [checkFile, summaryFile] = process.argv.slice(2);
if (!checkFile || !summaryFile) {
  console.error('usage: node e2e/expo-updates.mjs CHECK.txt SUMMARY.md');
  process.exit(2);
}
const minAgeDays = Number(process.env.MIN_AGE_DAYS ?? 7);
const now = new Date(process.env.NOW ?? Date.now());
const cutoff = new Date(now.getTime() - minAgeDays * DAY);
const npm = (args) =>
  execFileSync('npm', args, { encoding: 'utf8', shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'inherit'] });
const num = (v) => v.split('.').map(Number);
const newer = (a, b) => {
  const [x, y] = [num(a), num(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};

// "  expo@58.0.19 - expected version: ~58.0.21" (a scoped name keeps its leading @)
const listed = [
  ...fs.readFileSync(checkFile, 'utf8').matchAll(/^\s*(\S+)@(\d+\.\d+\.\d+)\S* - expected version: \D*(\d+)\.(\d+)\.(\d+)/gm),
].map(([, name, installed, major, minor, patch]) => ({ name, installed, want: `${major}.${minor}.${patch}`, line: `${major}.${minor}.` }));
if (listed.length === 0) {
  console.error(fs.readFileSync(checkFile, 'utf8'));
  console.error('no outdated package found in the expo install --check output');
  process.exit(1);
}

const updates = [];
const held = [];
for (const p of listed) {
  const times = JSON.parse(npm(['view', p.name, 'time', '--json']));
  const releases = Object.keys(times).filter((v) => v.startsWith(p.line) && /^\d+\.\d+\.\d+$/.test(v));
  const ripe = releases.filter((v) => new Date(times[v]) <= cutoff && newer(v, p.installed) && !newer(v, p.want));
  const pick = ripe.sort((a, b) => (newer(a, b) ? -1 : 1))[0];
  if (pick) updates.push({ ...p, to: pick, published: times[pick].slice(0, 10) });
  if (pick !== p.want) {
    const at = times[p.want] ? new Date(new Date(times[p.want]).getTime() + minAgeDays * DAY).toISOString().slice(0, 10) : 'unknown';
    held.push({ ...p, published: times[p.want]?.slice(0, 10) ?? 'unknown', ripeOn: at });
  }
}

if (updates.length > 0) {
  const before = path.join(os.tmpdir(), `package.before.${process.pid}.json`);
  fs.copyFileSync('package.json', before);
  npm([
    'install',
    `--before=${cutoff.toISOString()}`,
    '--save-prefix=~',
    '--no-audit',
    '--no-fund',
    ...updates.map((u) => `${u.name}@${u.to}`),
  ]);
  for (const line of pinExact(before)) console.log(line);
  fs.rmSync(before, { force: true });
}

const lines = [];
if (updates.length > 0) {
  lines.push(`Updated (published at least ${minAgeDays} days ago, before ${cutoff.toISOString().slice(0, 10)}):`, '');
  for (const u of updates) lines.push(`- \`${u.name}\` ${u.installed} → **${u.to}** (published ${u.published})`);
}
if (held.length > 0) {
  if (lines.length > 0) lines.push('');
  lines.push(`Held until they are ${minAgeDays} days old:`, '');
  for (const h of held) lines.push(`- \`${h.name}\` ${h.want} (published ${h.published}): from ${h.ripeOn}`);
}
fs.writeFileSync(summaryFile, lines.join('\n') + '\n');
console.log(lines.join('\n'));
