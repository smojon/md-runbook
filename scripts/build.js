// Bundles the extension into one file (out/dist/extension.js) and the notebook renderer into one
// ES module (out/webview/index.js). One file loads much faster than dozens of small modules when
// VS Code starts the extension. `tsc` still type-checks everything and builds the tests.
const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');

const builds = [
  {
    entryPoints: ['src/extension.ts'],
    outfile: 'out/dist/extension.js',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode'],
    sourcemap: true,
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
