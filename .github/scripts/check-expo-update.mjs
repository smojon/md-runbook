// The Expo updates workflow's push job runs this on the update job's package.json and
// package-lock.json before it commits them (security review, 2026-11-16). The update job ran
// npm, so its files are checked, not trusted:
// - package.json: only the packages the summary names changed, to the version it names;
//   everything else is as on main.
// - package-lock.json: every package comes from https://registry.npmjs.org/ with an integrity
//   hash, and its root lists the same dependencies as package.json.
//
//   node .github/scripts/check-expo-update.mjs SUMMARY.md   (in apps/mobile, files copied in)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

const REGISTRY = 'https://registry.npmjs.org/';
const SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const problems = [];

const [summaryFile] = process.argv.slice(2);
if (!summaryFile) {
  console.error('usage: node .github/scripts/check-expo-update.mjs SUMMARY.md');
  process.exit(2);
}
// "- `expo` 58.0.19 → **58.0.21** (published …)", as e2e/expo-updates.mjs writes it.
const named = new Map(
  [...fs.readFileSync(summaryFile, 'utf8').matchAll(/^- `([^`]+)` \S+ → \*\*([^*]+)\*\*/gm)].map(([, name, version]) => [name, version]),
);
if (named.size === 0) problems.push('the summary names no updated package');

const before = JSON.parse(execFileSync('git', ['show', 'HEAD:./package.json'], { encoding: 'utf8' }));
const after = JSON.parse(fs.readFileSync('package.json', 'utf8'));

for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
  if (SECTIONS.includes(key)) continue;
  if (!isDeepStrictEqual(before[key], after[key])) problems.push(`package.json: "${key}" changed`);
}
const seen = new Set();
for (const section of SECTIONS) {
  const was = before[section] ?? {};
  const is = after[section] ?? {};
  for (const name of new Set([...Object.keys(was), ...Object.keys(is)])) {
    const version = named.get(name);
    if (version === undefined) {
      if (was[name] !== is[name]) problems.push(`package.json: ${section}.${name} ${was[name]} -> ${is[name]}, not in the summary`);
    } else if (was[name] === undefined || is[name] === undefined) {
      problems.push(`package.json: ${section}.${name} was added or removed`);
    } else if (![version, `~${version}`, `^${version}`].includes(is[name])) {
      problems.push(`package.json: ${section}.${name} is ${is[name]}, the summary says ${version}`);
    } else {
      seen.add(name);
    }
  }
}
for (const name of named.keys()) if (!seen.has(name)) problems.push(`package.json: ${name} is in the summary but not updated`);

const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
const root = lock.packages?.[''];
if (!root) problems.push('package-lock.json: no root package (lockfileVersion 2 or 3 expected)');
else {
  for (const section of SECTIONS) {
    if (!isDeepStrictEqual(root[section] ?? {}, after[section] ?? {})) problems.push(`package-lock.json: the root's ${section} differ from package.json`);
  }
}
for (const [where, entry] of Object.entries(lock.packages ?? {})) {
  if (where === '' || entry.inBundle) continue;
  if (typeof entry.resolved !== 'string' || !entry.resolved.startsWith(REGISTRY)) {
    problems.push(`package-lock.json: ${where} resolves to ${entry.resolved ?? '(nothing)'}, not ${REGISTRY}`);
  } else if (typeof entry.integrity !== 'string' || !entry.integrity.startsWith('sha512-')) {
    problems.push(`package-lock.json: ${where} has no sha512 integrity`);
  }
}

if (problems.length > 0) {
  for (const p of problems) console.log(`::error::${p}`);
  process.exit(1);
}
console.log(`The update changes only ${[...named].map(([n, v]) => `${n} ${v}`).join(', ')}; every package is from ${REGISTRY}.`);
