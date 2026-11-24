// The Expo updates workflow's push job runs this on the update job's package.json and
// package-lock.json before it commits them (security reviews, 2026-11-16). The update job ran
// npm, so its files are checked, not trusted:
// - The summary: package names, and plain versions (1.2.3 or 1.2.3-rc.1).
// - package.json: only the packages the summary names changed, to the version it names;
//   everything else is as on main.
// - package-lock.json: only the packages the named ones depend on (directly or not) may differ
//   from main's lock. Each entry that differs is checked against registry.npmjs.org:
//   - only the keys npm writes in a lock entry;
//   - resolved is that package's own tarball URL (`<registry><name>/-/<base>-<version>.tgz`);
//   - integrity, dependencies, engines, os, cpu and bin are the registry's for that version, and libc when the lock has it;
//   - that version was published at least 7 days before the check (the package's `time`);
//   - no new install script or shrinkwrap, no bundled package, link, alias, git or file spec.
//   The registry is asked again after a 429 or 5xx, as long as Retry-After says (at most 60 s).
// When all is fine, it writes CLEAN.md, the list the pull request gets: rebuilt from the checked
// names and versions alone, the old versions from main's package.json. No other summary text.
//
//   node .github/scripts/check-expo-update.mjs SUMMARY.md [CLEAN.md]   (in apps/mobile, files copied in)
//   node --test .github/scripts/check-expo-update.test.mjs  (the tests)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

export const REGISTRY = 'https://registry.npmjs.org/';
const SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const SUMMARY_VERSION = /^\d+\.\d+\.\d+(-[\w.]+)?$/;
const LOCK_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const NAME = /^(@[a-z0-9][\w.~-]*\/)?[A-Za-z0-9][\w.~-]*$/;
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall'];
/** The keys npm writes in a lock entry: any other is refused. */
const LOCK_KEYS = new Set([
  'version', 'resolved', 'integrity', 'name', 'dev', 'optional', 'devOptional', 'peer', 'license',
  'dependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta', 'bin', 'engines',
  'os', 'cpu', 'libc', 'funding', 'hasInstallScript', 'deprecated', 'link', 'inBundle', 'extraneous',
  'hasShrinkwrap', 'bundleDependencies',
]);
/** A changed lock entry's version must be this old: e2e/expo-updates.mjs's minimum age. */
export const MIN_AGE_DAYS = 7;

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

/** The wait a Retry-After header asks for (seconds or an HTTP date), in ms, at most 60 s; undefined: none. */
export function retryAfterMs(value, now = Date.now()) {
  const s = String(value ?? '').trim();
  if (s === '') return undefined;
  const ms = /^\d+$/.test(s) ? Number(s) * 1000 : Date.parse(s) - now;
  return Number.isNaN(ms) ? undefined : Math.min(Math.max(ms, 0), 60_000);
}

/**
 * GETs a registry document as JSON. A 429, a 5xx or a network error is tried again, up to
 * `attempts` times in all, after the wait Retry-After asks for (else 1, 2, 4 s); a 404 or another
 * 4xx stops at once.
 */
export async function registryJson(url, { fetch: get = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), attempts = 4, timeoutMs = 30_000 } = {}) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let wait = 1000 * 2 ** (attempt - 1);
    try {
      const res = await get(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) return await res.json();
      await res.body?.cancel().catch(() => {});
      last = new Error(`HTTP ${res.status}`);
      if (res.status !== 429 && res.status < 500) break;
      wait = retryAfterMs(res.headers.get('retry-after')) ?? wait;
    } catch (e) {
      last = e;
    }
    if (attempt < attempts) await sleep(wait);
  }
  throw last;
}

/** The registry's version document: https://registry.npmjs.org/<name>/<version>. */
export async function registryManifest(name, version) {
  try {
    return await registryJson(`${REGISTRY}${name}/${version}`);
  } catch (e) {
    throw new Error(`${name}@${version} from ${REGISTRY}: ${e?.message ?? e}`);
  }
}

/** The registry's full document of a package (its `time` has each version's publish time). */
export async function registryPackument(name) {
  try {
    return await registryJson(`${REGISTRY}${name.replace('/', '%2f')}`, { timeoutMs: 120_000 });
  } catch (e) {
    throw new Error(`${name} from ${REGISTRY}: ${e?.message ?? e}`);
  }
}

/** A lock entry's or a manifest's bin as npm installs it: `{name: path}`, a string under the unscoped name, paths without `./`. */
export function normalizeBin(bin, name) {
  if (bin === undefined || bin === null) return undefined;
  const o = typeof bin === 'string' ? { [name.split('/').pop()]: bin } : bin;
  if (typeof o !== 'object' || Array.isArray(o)) return bin;
  const out = {};
  for (const [key, target] of Object.entries(o)) {
    const base = path.posix.basename(key.replace(/[\\:]/g, '/'));
    const to = typeof target === 'string' ? path.posix.join('/', target.replace(/\\/g, '/')).slice(1) : '';
    if (base && base !== '.' && base !== '..' && to) out[base] = to;
  }
  return Object.keys(out).length > 0 ? out : undefined;
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
 * gives the registry's version document, `packument(name)` its full document (fetched once per
 * name), `now` the time of the check in ms.
 */
export async function checkUpdate({ summary, before, after, lockBefore, lockAfter, manifest = registryManifest, packument = registryPackument, now = Date.now() }) {
  const problems = [];
  const packuments = new Map();
  const packumentOf = (name) => {
    if (!packuments.has(name)) packuments.set(name, packument(name));
    return packuments.get(name);
  };
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
    if (typeof e !== 'object' || e === null || Array.isArray(e)) return say('is not an object');
    const unknown = Object.keys(e).filter((k) => !LOCK_KEYS.has(k));
    if (unknown.length > 0) return say(`has keys npm doesn't write in a lock: ${unknown.map((k) => JSON.stringify(k)).join(', ')}`);
    if (e.link || e.inBundle) return say(e.link ? 'is a link' : 'is bundled in another package: its contents are not checked');
    if (e.hasShrinkwrap && !old?.hasShrinkwrap) return say('has a shrinkwrap now: npm would install what it lists, unchecked');
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
      ['engines', m.engines],
      ['os', m.os],
      ['cpu', m.cpu],
    ]) {
      if (!same(e[field], want)) say(`${field} are not the registry's`);
    }
    // npm 10 (Node 22's) writes no libc in a lock: none is fine, any other must be the registry's.
    // It only chooses which platform's package installs; leaving it out adds no code.
    if (e.libc !== undefined && !same(e.libc, m.libc)) say("libc are not the registry's");
    if (!same(normalizeBin(e.bin, name), normalizeBin(m.bin, name))) say("bin is not the registry's");
    // Old enough: published at least MIN_AGE_DAYS before this check, as the update job asked.
    let p;
    try {
      p = await packumentOf(name);
    } catch (err) {
      return say(`can't be checked for its age: ${err.message}`);
    }
    const published = Date.parse(p?.name === name ? p?.time?.[e.version] : undefined);
    if (Number.isNaN(published)) return say(`has no publish time on the registry for ${e.version}`);
    if (published > now - MIN_AGE_DAYS * 86_400_000) say(`was published ${new Date(published).toISOString()}, less than ${MIN_AGE_DAYS} days ago`);
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
