// Bundles the extension into one file (out/dist/extension.js), the command-line runner into
// out/dist/cli.js and the notebook renderer into one ES module (out/webview/index.js). One file loads much faster than dozens of small modules when
// VS Code starts the extension. `tsc` still type-checks everything and builds the tests.
const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');
// The shared core is bundled from its sources, so this works without building packages/core first
// (the GitHub Action runs only this script).
const alias = { '@md-runbook/core': './packages/core/src' };

const builds = [
  {
    entryPoints: ['src/extension.ts'],
    outfile: 'out/dist/extension.js',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode'],
    alias,
    sourcemap: true,
    minify: !watch,
  },
  {
    // The command-line runner (md-runbook run file.md): @md-runbook/core only, no vscode.
    entryPoints: ['src/cli/main.ts'],
    outfile: 'out/dist/cli.js',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    banner: { js: '#!/usr/bin/env node' },
    alias,
    define: { MD_RUNBOOK_VERSION: JSON.stringify(require('../package.json').version) },
    minify: !watch,
  },
  {
    entryPoints: ['renderer/index.ts'],
    outfile: 'out/webview/index.js',
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    minify: !watch,
  },
];

// The Steps view's row buttons are codicons: the view loads the font and its CSS from out/codicons
// (packaged by .vscodeignore; vsce runs with --no-dependencies, so node_modules is not shipped).
function copyCodicons() {
  const fs = require('node:fs');
  const path = require('node:path');
  const dist = path.dirname(require.resolve('@vscode/codicons/dist/codicon.css'));
  const out = path.join(__dirname, '..', 'out', 'codicons');
  fs.mkdirSync(out, { recursive: true });
  for (const f of ['codicon.css', 'codicon.ttf']) fs.copyFileSync(path.join(dist, f), path.join(out, f));
  // The font is CC BY 4.0: its licence goes with it.
  fs.copyFileSync(path.join(dist, '..', 'LICENSE'), path.join(out, 'LICENSE'));
}

(async () => {
  copyCodicons();
  for (const options of builds) {
    if (watch) await (await esbuild.context(options)).watch();
    else await esbuild.build(options);
  }
})().catch(() => process.exit(1));
