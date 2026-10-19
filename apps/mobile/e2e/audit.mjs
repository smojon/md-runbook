// npm audit of the runtime dependencies as a CI gate: fails on any high or critical advisory
// except the reviewed ones below (no fixed version exists; review again when one does). Also
// fails when a reviewed advisory is gone, so the list doesn't go stale.
//
//   node e2e/audit.mjs
import { execFileSync } from 'node:child_process';

const REVIEWED = {
  // braces <=3.0.3 (latest): glob patterns of the build tooling (Metro, micromatch), not in the app bundle.
  'GHSA-vfj7-8cjw-p6xm': '2026-10-19',
  // node-forge <=1.4.0 (latest): via @expo/code-signing-certificates, used by the Expo CLI, not in the app bundle.
  'GHSA-86w9-cpqp-85rv': '2026-10-19',
};

let out;
try {
  out = execFileSync('npm', ['audit', '--omit=dev', '--json'], { encoding: 'utf8', shell: process.platform === 'win32' });
} catch (e) {
  out = e.stdout; // npm audit exits 1 when it finds anything
}
const report = JSON.parse(out);
const seen = new Set();
const unexpected = [];
for (const [name, v] of Object.entries(report.vulnerabilities ?? {})) {
  for (const via of v.via) {
    if (typeof via !== 'object' || !['high', 'critical'].includes(via.severity)) continue;
    const id = via.url.split('/').pop();
    seen.add(id);
    if (!(id in REVIEWED)) unexpected.push(`${name}: ${via.severity} ${id} ${via.title}`);
  }
}
const stale = Object.keys(REVIEWED).filter((id) => !seen.has(id));
for (const line of unexpected) console.error(`new advisory: ${line}`);
for (const id of stale) console.error(`reviewed advisory ${id} no longer applies: remove it from e2e/audit.mjs`);
if (unexpected.length || stale.length) process.exit(1);
console.log(`audit: no new high or critical advisories (${seen.size} reviewed)`);
