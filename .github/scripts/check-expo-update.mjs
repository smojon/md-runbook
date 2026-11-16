// The Expo updates workflow's push job runs this on the update job's package.json and
// package-lock.json before it commits them (security reviews, 2026-11-16). The update job ran
// npm, so its files are checked, not trusted:
// - The summary: package names, and plain versions (1.2.3 or 1.2.3-rc.1).
// - package.json: only the packages the summary names changed, to the version it names;
//   everything else is as on main.
// - package-lock.json: only the packages the named ones depend on (directly or not) may differ
//   from main's lock. Each entry that differs is checked against registry.npmjs.org:
//   - resolved is that package's own tarball URL (`<registry><name>/-/<base>-<version>.tgz`);
//   - integrity and dependencies are the registry's for that version;
//   - no new install script, bundled package, link, alias, git or file spec.
// When all is fine, it writes CLEAN.md, the list the pull request gets: rebuilt from the checked
// names and versions alone, the old versions from main's package.json. No other summary text.
//
//   node .github/scripts/check-expo-update.mjs SUMMARY.md [CLEAN.md]   (in apps/mobile, files copied in)
//   node --test .github/scripts/check-expo-update.test.mjs  (the tests)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

export const REGISTRY = 'https://registry.npmjs.org/';
const SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const SUMMARY_VERSION = /^\d+\.\d+\.\d+(-[\w.]+)?$/;
const LOCK_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const NAME = /^(@[a-z0-9][\w.~-]*\/)?[A-Za-z0-9][\w.~-]*$/;
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall'];

/** "- `expo` 58.0.19 → **58.0.21** (published …)", as e2e/expo-updates.mjs writes it: name → version. */
export const parseSummary = (text) =>
  new Map([...text.matchAll(/^- `([^`]+)` \S+ → \*\*([^*]+)\*\*/gm)].map(([, name, version]) => [name, version]));

/**
 * The list the pull request gets, "- `name` from → **to**" lines rebuilt from the checked names
 * and versions only; `from` is main's package.json (`before`). For after checkUpdate passed.
 */
export function cleanSummary(summary, before) {
  const plain = /^[~^]?\d+\.\d+\.\d+(-[\w.]+)?$/;
  const lines = [];
  for (const [name, to] of parseSummary(summary)) {
    if (!NAME.test(name) || !SUMMARY_VERSION.test(to)) throw new Error(`not a checked name and version: ${JSON.stringify(name)} ${JSON.stringify(to)}`);
    const from = SECTIONS.map((s) => before?.[s]?.[name]).find((v) => v !== undefined);
    lines.push(`- \`${name}\` ${typeof from === 'string' && plain.test(from) ? from : '?'} → **${to}**`);
  }
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

/** The package name a lock path installs:`node_modules/a/node_modules/@s/b` → `@s/b`. */
export const pathName = (where) => where.slice(where.lastIndexOf('node_modules/') + 'node_modules/'.length);

/** The registry's tarball URL of name@version (a scope's name has no scope in the file name). */
export const tarballUrl = (name, version) => `${REGISTRY}${name}/-/${name.split('/').pop()}-${version}.tgz`;

/** Where Node finds `dep` from the package at `from` (a lock path, '' for the root). */
function resolveFrom(packages, from, dep) {
  let base = from;
  for (;;) {
    const at = `${base ? `${base}/` : ''}node_modules/${dep}`;
    if (packages[at]) return at;
    if (base === '') return undefined;
    const up = base.lastIndexOf('/node_modules/');
    base = up < 0 ? '' : base.slice(0, up);
  }
}

/** The lock paths of the named packages and of everything they depend on, directly or not. */
export function dependencyTree(packages, names) {
  const seen = new Set();
  const todo = [];
  for (const name of names) {
    const at = resolveFrom(packages, '', name);
    if (at) todo.push(at);
  }
  while (todo.length > 0) {
    const at = todo.pop();
    if (seen.has(at)) continue;
    seen.add(at);
    const e = packages[at];
    for (const dep of Object.keys({ ...e.dependencies, ...e.optionalDependencies, ...e.peerDependencies })) {
      const next = resolveFrom(packages, at, dep);
      if (next && !seen.has(next)) todo.push(next);
    }
  }
  return seen;
}

/** The registry's version document: https://registry.npmjs.org/<name>/<version>. */
export async function registryManifest(name, version) {
  let last;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${REGISTRY}${name}/${version}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
      if (res.ok) return await res.json();
      last = new Error(`HTTP ${res.status}`);
      if (res.status === 404) break;
    } catch (e) {
      last = e;
    }
  }
  throw new Error(`${name}@${version} from ${REGISTRY}: ${last?.message ?? last}`);
}

/** Runs fn on each item, at most `n` at a time. */
async function pool(items, n, fn) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(n, queue.length) }, async () => {
      while (queue.length > 0) await fn(queue.shift());
    }),
  );
}

const keysOf = (o) => Object.keys(o ?? {});
const sorted = (o) => Object.fromEntries(Object.entries(o ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
const same = (a, b) => isDeepStrictEqual(sorted(a), sorted(b));

/**
 * The problems of an update (empty: fine). `summary` is the summary's text, `before`/`after`
 * package.json, `lockBefore`/`lockAfter` package-lock.json, as objects; `manifest(name, version)`
 * gives the registry's version document.
 */
export async function checkUpdate({ summary, before, after, lockBefore, lockAfter, manifest = registryManifest }) {
  const problems = [];
  const named = parseSummary(summary);
  if (named.size === 0) problems.push('the summary names no updated package');
  for (const [name, version] of named) {
    if (!NAME.test(name)) problems.push(`the summary names ${JSON.stringify(name)}, not a package name`);
    if (!SUMMARY_VERSION.test(version)) problems.push(`the summary gives ${name} the version ${JSON.stringify(version)}, not a plain version`);
  }

  // package.json
  for (const key of new Set([...keysOf(before), ...keysOf(after)])) {
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

  // package-lock.json: the top level and the root as on main, but the root's dependencies.
  for (const key of new Set([...keysOf(lockBefore), ...keysOf(lockAfter)])) {
    if (key !== 'packages' && !isDeepStrictEqual(lockBefore[key], lockAfter[key])) problems.push(`package-lock.json: "${key}" changed`);
  }
  const was = lockBefore.packages ?? {};
  const is = lockAfter.packages ?? {};
  const root = is[''];
  if (!root) problems.push('package-lock.json: no root package (lockfileVersion 2 or 3 expected)');
  else {
    for (const key of new Set([...keysOf(was['']), ...keysOf(root)])) {
      if (SECTIONS.includes(key)) continue;
      if (!isDeepStrictEqual(was['']?.[key], root[key])) problems.push(`package-lock.json: the root's "${key}" changed`);
    }
    // e2e/pin-exact.mjs pins package.json exact again, not the lock: `~58.0.21` there is fine.
    const ranges = (v) => (v === undefined ? [] : [v, `~${v}`, `^${v}`]);
    for (const section of SECTIONS) {
      const locked = root[section] ?? {};
      const want = after[section] ?? {};
      for (const name of new Set([...Object.keys(locked), ...Object.keys(want)])) {
        if (locked[name] === want[name]) continue;
        if (want[name] !== undefined && ranges(named.get(name)).includes(locked[name])) continue;
        problems.push(`package-lock.json: the root's ${section}.${name} is ${locked[name]}, package.json has ${want[name]}`);
      }
    }
  }
  for (const [name, version] of named) {
    const e = is[`node_modules/${name}`];
    if (e?.version !== version) problems.push(`package-lock.json: node_modules/${name} is ${e?.version ?? 'missing'}, the summary says ${version}`);
  }

  // Only the named packages' tree may change.
  const tree = new Set([...dependencyTree(was, named.keys()), ...dependencyTree(is, named.keys())]);
  const changed = [];
  for (const where of new Set([...Object.keys(was), ...Object.keys(is)])) {
    if (where === '' || isDeepStrictEqual(was[where], is[where])) continue;
    if (!tree.has(where)) problems.push(`package-lock.json: ${where} changed, but no package in the summary depends on it`);
    else if (is[where] !== undefined) changed.push(where);
  }

  // Each changed entry: what the registry has for that name and version.
  await pool(changed, 8, async (where) => {
    const e = is[where];
    const old = was[where];
    const say = (p) => problems.push(`package-lock.json: ${where} ${p}`);
    if (e.link || e.inBundle) return say(e.link ? 'is a link' : 'is bundled in another package: its contents are not checked');
    if (e.name !== old?.name) return say(`has another package name (${e.name ?? pathName(where)} for ${old?.name ?? pathName(where)}): an alias`);
    const name = e.name ?? pathName(where);
    if (!NAME.test(name)) return say(`is ${JSON.stringify(name)}, not a package name`);
    if (typeof e.version !== 'string' || !LOCK_VERSION.test(e.version)) return say(`has the version ${JSON.stringify(e.version)}, not a plain version`);
    const url = tarballUrl(name, e.version);
    if (e.resolved !== url) return say(`resolves to ${e.resolved ?? '(nothing)'}, not ${url}`);
    if (Boolean(e.hasInstallScript) !== Boolean(old?.hasInstallScript)) return say(e.hasInstallScript ? 'has an install script now' : 'lost its install script');
    let m;
    try {
      m = await manifest(name, e.version);
    } catch (err) {
      return say(`can't be checked: ${err.message}`);
    }
    if (m?.name !== name || m?.version !== e.version) return say(`is not on the registry as ${name}@${e.version}`);
    if (typeof e.integrity !== 'string' || e.integrity !== m.dist?.integrity) return say(`has the integrity ${e.integrity ?? '(none)'}, the registry's is ${m.dist?.integrity}`);
    if (!old?.hasInstallScript && (INSTALL_SCRIPTS.some((s) => m.scripts?.[s]) || m.gypfile)) return say('has an install script on the registry');
    // The registry lists optional dependencies under dependencies too; a lock entry doesn't.
    const optional = m.optionalDependencies ?? {};
    const deps = Object.fromEntries(Object.entries(m.dependencies ?? {}).filter(([d]) => !(d in optional)));
    for (const [field, want] of [
      ['dependencies', deps],
      ['optionalDependencies', optional],
      ['peerDependencies', m.peerDependencies],
      ['peerDependenciesMeta', m.peerDependenciesMeta],
    ]) {
      if (!same(e[field], want)) say(`${field} are not the registry's`);
    }
  });
  return problems.sort();
}

async function main() {
  const [summaryFile, cleanFile] = process.argv.slice(2);
  if (!summaryFile) {
    console.error('usage: node .github/scripts/check-expo-update.mjs SUMMARY.md [CLEAN.md]');
    process.exit(2);
  }
  const fromMain = (file) => JSON.parse(execFileSync('git', ['show', `HEAD:./${file}`], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }));
  const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
  const summary = fs.readFileSync(summaryFile, 'utf8');
  const before = fromMain('package.json');
  const problems = await checkUpdate({
    summary,
    before,
    after: read('package.json'),
    lockBefore: fromMain('package-lock.json'),
    lockAfter: read('package-lock.json'),
  });
  if (problems.length > 0) {
    // %, CR and LF escaped as GitHub's workflow commands want them.
    for (const p of problems) console.log(`::error::${p.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}`);
    process.exit(1);
  }
  if (cleanFile) fs.writeFileSync(cleanFile, cleanSummary(summary, before));
  console.log(`The update changes only ${[...parseSummary(summary)].map(([n, v]) => `${n} ${v}`).join(', ')} and their dependencies, as ${REGISTRY} has them.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
