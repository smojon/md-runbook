// Bundles the spike with the repository's esbuild: dist/spikeA.js for Node.
const path = require('path');
const esbuild = require(path.join(__dirname, '..', '..', 'node_modules', 'esbuild'));

(async () => {
  await esbuild.build({
    entryPoints: [path.join(__dirname, 'src', 'spikeA.ts')],
    outfile: path.join(__dirname, 'dist', 'spikeA.js'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    sourcemap: true,
    logLevel: 'warning',
    // Optional legacy RSA code for old Node versions; Node 20+ uses its built-in crypto.
    external: ['node-rsa'],
  });
  console.log('built dist/spikeA.js');
})().catch(() => process.exit(1));
