// After an install that writes a range (`~58.0.21`): the packages that were pinned exact before
// are pinned exact again, at the version it chose. The others keep what it wrote. Used by the
// daily Expo updates workflow (e2e/expo-updates.mjs).
//
//   node e2e/pin-exact.mjs BEFORE.json [package.json]
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const EXACT = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/;

/** Rewrites `afterFile`; returns the lines describing what it pinned. */
export function pinExact(beforeFile, afterFile = 'package.json') {
  const before = JSON.parse(fs.readFileSync(beforeFile, 'utf8'));
  const text = fs.readFileSync(afterFile, 'utf8');
  const after = JSON.parse(text);
  const pinned = [];
  for (const field of ['dependencies', 'devDependencies']) {
    for (const [name, range] of Object.entries(after[field] ?? {})) {
      const was = before[field]?.[name];
      const m = /^[~^](\d+\.\d+\.\d+(?:[-+][\w.-]+)?)$/.exec(range);
      if (was !== undefined && EXACT.test(was) && m) {
        after[field][name] = m[1];
        pinned.push(`${name}: ${range} -> ${m[1]} (pinned exact, as before)`);
      }
    }
  }
  if (pinned.length > 0) fs.writeFileSync(afterFile, JSON.stringify(after, null, 2) + (text.endsWith('\n') ? '\n' : ''));
  return pinned;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [beforeFile, afterFile] = process.argv.slice(2);
  if (!beforeFile) {
    console.error('usage: node e2e/pin-exact.mjs BEFORE.json [package.json]');
    process.exit(2);
  }
  for (const line of pinExact(beforeFile, afterFile)) console.log(line);
}
