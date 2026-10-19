// Metro for the app:
// - @md-runbook/core and @md-runbook/ssh are used from their sources in ../../packages (no build
//   step), and the libraries they import resolve in this app's node_modules only, so there is
//   one copy of each (the repository root's node_modules is the extension's, not the app's).
// - Node modules the SSH library and its dependencies ask for: crypto -> react-native-quick-crypto
//   (native, iOS/Android; the web uses Web Crypto), stream/buffer/events/util -> browser ports,
//   path/os/net/fs/child_process -> empty (loaded by vscode-jsonrpc at startup, never used).
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const root = path.resolve(__dirname, '../..');
const config = getDefaultConfig(__dirname);

config.watchFolders = [path.join(root, 'packages/core/src'), path.join(root, 'packages/ssh/src')];
const appEntry = path.join(__dirname, 'index.ts');
const fromPackages = (origin) => origin.startsWith(path.join(root, 'packages') + path.sep);

const packages = {
  '@md-runbook/core': path.join(root, 'packages/core/src'),
  '@md-runbook/ssh': path.join(root, 'packages/ssh/src'),
};
const empty = path.join(__dirname, 'src/empty.js');
const emptied = new Set(['path', 'os', 'net', 'fs', 'child_process', 'node-rsa']);
const aliases = { stream: 'readable-stream', buffer: 'buffer', events: 'events', util: 'util' };

config.resolver.resolveRequest = (context, moduleName, platform) => {
  for (const [name, dir] of Object.entries(packages)) {
    if (moduleName === name) return context.resolveRequest(context, path.join(dir, 'index.ts'), platform);
    if (moduleName.startsWith(name + '/'))
      return context.resolveRequest(context, path.join(dir, moduleName.slice(name.length + 1)), platform);
  }
  const bare = moduleName.replace(/^node:/, '');
  if (emptied.has(bare)) return { type: 'sourceFile', filePath: empty };
  if (bare === 'crypto') {
    return platform === 'web'
      ? { type: 'sourceFile', filePath: empty }
      : context.resolveRequest(context, 'react-native-quick-crypto', platform);
  }
  if (aliases[bare] && aliases[bare] !== moduleName) return context.resolveRequest(context, aliases[bare], platform);
  // A library imported by a shared package resolves as if the app imported it.
  if (!moduleName.startsWith('.') && fromPackages(context.originModulePath)) {
    return context.resolveRequest({ ...context, originModulePath: appEntry }, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
