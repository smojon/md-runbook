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

(async () => {
  for (const options of builds) {
    if (watch) await (await esbuild.context(options)).watch();
    else await esbuild.build(options);
  }
})().catch(() => process.exit(1));
