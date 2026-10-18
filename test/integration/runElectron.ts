/** Downloads VS Code and runs the integration suite in it (used by CI and `npm run test:integration`). */
import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  const root = path.resolve(__dirname, '..', '..', '..');
  await runTests({
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(__dirname, 'index.js'),
    launchArgs: ['--disable-extensions', '--disable-workspace-trust'],
    extensionTestsEnv: { MD_RUNBOOK_TEST: '1' },
  });
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
