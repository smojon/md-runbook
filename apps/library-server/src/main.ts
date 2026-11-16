/** Starts the library server with the settings from the environment (see README.md). */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ServerConfig, loadConfig } from './config';
import { createLibraryServer } from './server';

const version = (JSON.parse(readFileSync(join(__dirname, '..', '..', '..', '..', 'package.json'), 'utf8')) as { version: string }).version;

let config: ServerConfig;
try {
  config = loadConfig();
  // Runbook and runner signatures are checked with ssh-keygen: without it nothing could be published or verified.
  if ((config.library || config.runs?.allowedRunners) && spawnSync(config.sshKeygen, ['-Y', 'verify', '-h'], { stdio: 'ignore' }).error)
    throw new Error(`${config.sshKeygen} not found: signatures are checked with OpenSSH's ssh-keygen (8.2 or newer)`);
} catch (e) {
  console.error(`md-runbook library server: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
}
const s = createLibraryServer(config, version);
s.server.listen(config.port, config.host, () => {
  console.log(
    JSON.stringify({
      t: new Date().toISOString(),
      event: 'listening',
      version,
      address: `${config.host}:${config.port}`,
      library: config.library?.dir,
      acceptV1: config.library?.acceptV1,
      allowDelete: config.library?.allowDelete,
      runs: config.runs?.dir,
      runsOpen: config.runs ? config.runs.tokens.length === 0 : undefined,
      requireSigned: config.runs?.requireSigned,
      alerts: config.alerts?.map,
      push: config.push ? [...(config.push.apns ? [`ios${config.push.apns.sandbox ? ' (sandbox)' : ''}`] : []), ...(config.push.fcm ? ['android'] : [])].join(', ') : undefined,
    }),
  );
});
// SIGHUP: read the alert map again (a broken one keeps the old map).
process.on('SIGHUP', () => {
  try {
    s.alerts?.reload();
    console.log(JSON.stringify({ t: new Date().toISOString(), event: 'reloaded' }));
  } catch (e) {
    console.log(JSON.stringify({ t: new Date().toISOString(), event: 'reload-failed', why: e instanceof Error ? e.message : String(e) }));
  }
});
const stop = (): void => void s.close().then(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
