/** Starts the relay with the settings from the environment (see README.md). */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './config';
import { createRelay } from './relay';

const version = (JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as { version: string }).version;

let config;
try {
  config = loadConfig();
} catch (e) {
  console.error(`md-runbook relay: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
}
const relay = createRelay(config, version);
relay.server.listen(config.port, config.host, () => {
  console.log(
    JSON.stringify({
      t: new Date().toISOString(),
      event: 'listening',
      version,
      address: `${config.host}:${config.port}`,
      targets: config.targets.join(','),
      origins: config.origins.join(',') || '*',
    }),
  );
});
const stop = (): void => void relay.close().then(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
