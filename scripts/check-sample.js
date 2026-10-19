// Runs examples/sample.runbook.md with the command line and checks that its steps do what the
// sample says they do (CI). The sample fails on purpose in places, so the run's exit code is
// not checked; each listed step's result is.
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'md-runbook-sample-')), 'results.json');
const tmp = process.env.TMPDIR || os.tmpdir();
fs.rmSync(path.join(tmp, 'md-runbook-sample-retry'), { force: true }); // section 14's counter
const r = spawnSync(process.execPath, [path.join(root, 'out', 'dist', 'cli.js'), 'run', path.join(root, 'examples', 'sample.runbook.md'), '--check', '--keep-going', '--json', out], {
  stdio: ['ignore', 'inherit', 'inherit'],
});
if (r.error || !fs.existsSync(out)) {
  console.error(`check-sample: the run produced no results (${r.error ? r.error.message : `exit ${r.status}`})`);
  process.exit(1);
}
const { steps } = JSON.parse(fs.readFileSync(out, 'utf8'));
const win = process.platform === 'win32';

// [what the block's first line contains, expected status, optional check on the step]
const expectations = [
  // 3. Exit codes and failures
  ['echo "about to fail"', 'failed', (s) => s.exit === '3'],
  ['echo "sleeping 10s"', 'failed', (s) => s.exit === 'timeout'],
  ['echo "skipped cells', 'skipped'],
  // 5. Inputs have no value on the command line
  ['${input:YOUR_NAME}', 'not run', (s) => /--input YOUR_NAME=/.test(s.message || '')],
  // 7. Risky command needs --yes; 8. proposed cells never run
  ['kubectl delete pod demo', 'not run', (s) => /--yes/.test(s.message || '')],
  ['date', 'not run', (s) => /proposed/.test(s.message || '')],
  // 13. Line by line (as whole cells here)
  ['echo "step one"', 'passed', (s) => /now in .*md-runbook/.test(s.output)],
  ['$items = 1..3', 'passed', (s) => /item 3/.test(s.output)],
  // 14. Checks and retries
  ['echo "status: all good"', 'passed'],
  ['echo "status: degraded"', 'failed', (s) => /does not contain "all good"/.test(s.message || '')],
  ['echo "setting not found"', 'passed', (s) => s.exit === '1'],
  ['f="${TMPDIR:-/tmp}/md-runbook-sample-retry"', 'passed', (s) => /attempt 3/.test(s.output)],
  // 15. Passing values
  ['echo "logs of ${out:POD}"', 'passed', (s) => /logs of web-7c9d5b-x2kqp/.test(s.output)],
  ['echo "using token ${out:SESSION_TOKEN}"', 'passed', (s) => /\[REDACTED\]/.test(s.output) && !/tok-\d/.test(s.output)],
  // 16. Blocks for one OS: the one for this system runs
  [win ? 'Write-Output "Temp folder' : 'echo "Temp folder', 'passed'],
  // 17. The misspelled option is ignored
  ['echo "the misspelled option is ignored"', 'passed'],
];

let failed = 0;
for (const [needle, status, check] of expectations) {
  // An exact title first: some needles (`date`) are short.
  const step = steps.find((s) => s.title === needle) ?? steps.find((s) => s.title.includes(needle));
  const where = `"${needle}"`;
  if (!step) {
    console.error(`✗ ${where}: no such step in the results`);
    failed++;
  } else if (step.status !== status || (check && !check(step))) {
    console.error(`✗ ${where} (step ${step.step}, line ${step.line}): expected ${status}, got ${step.status} (exit ${step.exit}${step.message ? `, ${step.message}` : ''})\n  output: ${JSON.stringify(step.output.slice(-300))}`);
    failed++;
  } else {
    console.log(`✓ ${where}: ${status}`);
  }
}
// Section 16's other block must not run at all.
const other = steps.find((s) => s.title.includes(win ? 'echo "Temp folder' : 'Write-Output "Temp folder'));
if (other) {
  console.error(`✗ the os= block for the other system ran (step ${other.step})`);
  failed++;
}
console.log(failed ? `\n✗ ${failed} of the sample's promises broken` : `\n✓ the sample does what it says (${expectations.length} checks)`);
process.exit(failed ? 1 : 0);
