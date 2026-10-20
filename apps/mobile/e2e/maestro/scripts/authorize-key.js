/* global http, maestro, output, KEY_URL */
// Runs on the machine that runs Maestro, not on the device: posts the public key the flow copied
// from the app to e2e/key-server.mjs, which appends it to the test server's authorized_keys.
const response = http.post(KEY_URL, { body: maestro.copiedText, headers: { 'content-type': 'text/plain' } });
if (!response.ok) throw new Error('authorizing the key failed: ' + response.status + ' ' + response.body);
output.authorized = maestro.copiedText.split(' ')[0];
