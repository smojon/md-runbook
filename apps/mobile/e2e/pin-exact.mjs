// After `npx expo install --fix`, which writes the SDK's range (`~58.0.21`): the packages that were
// pinned exact before are pinned exact again, at the version it chose. The others keep what it
// wrote. Used by the daily Expo updates workflow (.github/workflows/expo-updates.yml).
//
//   cp package.json /tmp/before.json && npx expo install --fix && node e2e/pin-exact.mjs /tmp/before.json
import fs from 'node:fs';

const [beforeFile, afterFile = 'package.json'] = process.argv.slice(2);
if (!beforeFile) {
  console.error('usage: node e2e/pin-exact.mjs BEFORE.json [package.json]');
  process.exit(2);
}
const before = JSON.parse(fs.readFileSync(beforeFile, 'utf8'));
const text = fs.readFileSync(afterFile, 'utf8');
const after = JSON.parse(text);
const exact = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/;
let changed = 0;
for (const field of ['dependencies', 'devDependencies']) {
  for (const [name, range] of Object.entries(after[field] ?? {})) {
    const was = before[field]?.[name];
    const m = /^[~^](\d+\.\d+\.\d+(?:[-+][\w.-]+)?)$/.exec(range);
    if (was !== undefined && exact.test(was) && m) {
      after[field][name] = m[1];
      console.log(`${name}: ${range} -> ${m[1]} (pinned exact, as before)`);
      changed++;
    }
  }
}
if (changed > 0) fs.writeFileSync(afterFile, JSON.stringify(after, null, 2) + (text.endsWith('\n') ? '\n' : ''));
