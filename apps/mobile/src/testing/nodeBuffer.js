// Jest only (package.json moduleNameMapper): `buffer` is Node's own module in tests, as it is for
// the extension and the CLI. Otherwise the SSH library would get the npm polyfill while Node's
// crypto hands it native Buffers, and its `Buffer.isBuffer` checks would fail ("Buffer expected").
// The app itself uses the polyfill everywhere (Metro aliases it), with the native crypto module's
// Buffers of the same make.
module.exports = require('node:buffer');
