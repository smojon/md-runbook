// Metro for the spike app: Node modules the SSH library and its dependencies ask for.
//   crypto  -> react-native-quick-crypto (Node's crypto API, native)
//   stream  -> readable-stream, buffer -> buffer, events -> events, util -> util
//   path/os/net/fs/child_process -> empty (loaded by vscode-jsonrpc at startup, never used here)
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
const empty = path.join(__dirname, 'src', 'empty.js');
const aliases = {
  crypto: 'react-native-quick-crypto',
  stream: 'readable-stream',
  buffer: 'buffer',
  events: 'events',
  util: 'util',
};
const emptied = new Set(['path', 'os', 'net', 'fs', 'child_process', 'node-rsa']);

config.resolver.resolveRequest = (context, moduleName, platform) => {
  const name = moduleName.replace(/^node:/, '');
  if (emptied.has(name)) return { type: 'sourceFile', filePath: empty };
  if (aliases[name] && aliases[name] !== moduleName) return context.resolveRequest(context, aliases[name], platform);
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
