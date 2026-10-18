// The GitHub Action's runner (action.yml): turns its inputs (environment variables) into
// command-line arguments for out/dist/cli.js, without a shell in between.
const { spawnSync } = require('child_process');
const path = require('path');

const env = process.env;
const on = (v) => /^(true|yes|1)$/i.test((v || '').trim());
const lines = (v) =>
  (v || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));

const args = ['run', env.MDRB_RUNBOOK || ''];
for (const p of lines(env.MDRB_PARAMS)) args.push('--param', p);
for (const p of lines(env.MDRB_INPUTS)) args.push('--input', p);
if (on(env.MDRB_YES)) args.push('--yes');
if (on(env.MDRB_KEEP_GOING)) args.push('--keep-going');
if (env.MDRB_OUT) args.push('--out', env.MDRB_OUT);
else if (!on(env.MDRB_WRITE || 'true')) args.push('--check');
for (const [flag, value] of [
  ['--report', env.MDRB_REPORT],
  ['--pdf', env.MDRB_PDF],
  ['--junit', env.MDRB_JUNIT],
]) {
  if (value) args.push(flag, value);
}
if ((env.MDRB_SESSION || '').trim() !== '') args.push(on(env.MDRB_SESSION) ? '--session' : '--isolated');

const cli = path.join(__dirname, '..', 'out', 'dist', 'cli.js');
const r = spawnSync(process.execPath, [cli, ...args], { stdio: 'inherit' });
if (r.error) {
  console.error(`md-runbook: ${r.error.message}`);
  process.exit(1);
}
process.exit(r.status === null ? 1 : r.status);
