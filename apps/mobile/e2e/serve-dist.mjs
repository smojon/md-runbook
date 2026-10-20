// Serves the exported web app (dist/) for the browser tests, with the single-page fallback.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
};

/** Resolves with the server and its http://127.0.0.1:<port>/ address. */
export async function serveDist(dist, port = 0) {
  const server = createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
    for (const file of [join(dist, path), join(dist, 'index.html')]) {
      try {
        const body = await readFile(file);
        res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
        return res.end(body);
      } catch {
        // try the single-page fallback
      }
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${server.address().port}/` };
}
