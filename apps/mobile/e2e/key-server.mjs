// Lets the device tests authorize the app's key on the test SSH server: the Maestro flow copies
// the public key shown in the app and posts it here (from the machine running Maestro); it goes
// into the server's authorized_keys. Loopback only, one line per request, keys only.
//
//   node e2e/key-server.mjs <authorized_keys> [port=8077]
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';

const [file, portArg] = process.argv.slice(2);
if (!file) {
  console.error('usage: node e2e/key-server.mjs <authorized_keys> [port]');
  process.exit(2);
}
const port = Number(portArg ?? 8077);
const KEY_LINE = /^(ecdsa-sha2-nistp(256|384|521)|ssh-rsa) [A-Za-z0-9+/]+=* ?[\w.@-]*$/;

createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/authorize') return void res.writeHead(404).end();
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => (body += chunk.length + body.length > 4096 ? '' : chunk));
  req.on('end', () => {
    const line = body.trim();
    if (!KEY_LINE.test(line)) {
      console.log(`refused: ${JSON.stringify(line.slice(0, 80))}`);
      return void res.writeHead(400, { 'content-type': 'text/plain' }).end('not a public key line');
    }
    appendFileSync(file, line + '\n');
    console.log(`authorized ${line.split(' ')[0]} …${line.split(' ')[1]?.slice(-12)}`);
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
  });
}).listen(port, '127.0.0.1', () => console.log(`key server on 127.0.0.1:${port} -> ${file}`));
