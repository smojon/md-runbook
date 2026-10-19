// Bundles the spike with the repository's esbuild:
//   dist/spikeA.js         step A (Node)
//   dist/relay.js          the relay (Node)
//   dist/spikeB.js + .html step B page (browser)
//   dist/spikeB-driver.js  step B driver (Node, headless Chrome)
const fs = require('fs');
const path = require('path');
const esbuild = require(path.join(__dirname, '..', '..', 'node_modules', 'esbuild'));

const src = (f) => path.join(__dirname, 'src', f);
const dist = (f) => path.join(__dirname, 'dist', f);
// Optional legacy RSA code for old Node versions (Node 20+ and browsers use built-in crypto), and
// packages the Node scripts load from node_modules.
const external = ['node-rsa', 'puppeteer-core', 'ws'];

// Node modules in the browser bundle. The library picks Web Crypto in a browser and never uses
// crypto/net there, but it and vscode-jsonrpc load them at startup: those get empty modules.
// Classes are extended from stream, events and util, so those get their browser ports.
const browserNodeModules = {
  name: 'browser-node-modules',
  setup(build) {
    const ports = { stream: 'readable-stream', events: 'events', util: 'util' };
    build.onResolve({ filter: /^(node:)?(stream|events|util)$/ }, async (a) => {
      const port = ports[a.path.replace(/^node:/, '')];
      return build.resolve(port + '/', { resolveDir: __dirname, kind: a.kind });
    });
    build.onResolve({ filter: /^(node:)?(crypto|net|os|path|fs|child_process)$/ }, (a) => ({ path: a.path, namespace: 'empty' }));
    build.onLoad({ filter: /.*/, namespace: 'empty' }, () => ({ contents: 'module.exports = {};', loader: 'js' }));
  },
};

(async () => {
  const node = { bundle: true, platform: 'node', format: 'cjs', target: 'node20', sourcemap: true, logLevel: 'warning', external };
  await esbuild.build({ ...node, entryPoints: [src('spikeA.ts')], outfile: dist('spikeA.js') });
  await esbuild.build({ ...node, entryPoints: [src('relay.ts')], outfile: dist('relay.js') });
  await esbuild.build({ ...node, entryPoints: [src('spikeB-driver.ts')], outfile: dist('spikeB-driver.js') });
  await esbuild.build({
    entryPoints: [src('spikeB.ts')],
    outfile: dist('spikeB.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    sourcemap: 'inline',
    logLevel: 'warning',
    external: ['node-rsa'],
    define: { global: 'globalThis' },
    plugins: [browserNodeModules],
    inject: [src('buffer-shim.ts')],
  });
  fs.writeFileSync(dist('spikeB.html'), '<!doctype html><meta charset="utf-8"><title>md-runbook SSH spike</title><script src="/spikeB.js"></script>\n');
  console.log('built dist/spikeA.js, relay.js, spikeB.js(+html), spikeB-driver.js');
})().catch(() => process.exit(1));
