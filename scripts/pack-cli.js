// Lays out the npm package of the command-line runner in out/npm: the bundled cli.js (built by
// scripts/build.js), cli/README.md, LICENSE and a package.json with only what npm needs.
// Publish with `npm publish out/npm --access public` (the Release workflow does it when the
// NPM_TOKEN secret is set).
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const out = path.join(root, 'out', 'npm');
const cli = path.join(root, 'out', 'dist', 'cli.js');
if (!fs.existsSync(cli)) {
  console.error('out/dist/cli.js is missing: run `node scripts/build.js` (or `npm run compile`) first');
  process.exit(1);
}
const ext = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.copyFileSync(cli, path.join(out, 'cli.js'));
fs.chmodSync(path.join(out, 'cli.js'), 0o755);
fs.copyFileSync(path.join(root, 'cli', 'README.md'), path.join(out, 'README.md'));
fs.copyFileSync(path.join(root, 'LICENSE'), path.join(out, 'LICENSE'));

const pkg = {
  name: 'md-runbook',
  version: ext.version,
  description: 'Run the shell blocks of a Markdown runbook (bash, PowerShell, cmd) and keep their output in the file: checks, retries, secret redaction, HTML/PDF/JUnit reports. For CI, servers and scheduled checks.',
  license: ext.license,
  author: 'Stephane Mojon',
  repository: ext.repository,
  homepage: 'https://github.com/smojon/md-runbook/blob/main/docs/features/cli.md',
  bugs: ext.bugs,
  keywords: ['runbook', 'markdown', 'shell', 'bash', 'powershell', 'cmd', 'ci', 'devops', 'sre', 'automation', 'cli', 'junit'],
  bin: { 'md-runbook': 'cli.js' },
  files: ['cli.js', 'README.md', 'LICENSE'],
  engines: { node: '>=20' },
};
fs.writeFileSync(path.join(out, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
console.log(`npm package md-runbook@${pkg.version} laid out in out/npm`);
