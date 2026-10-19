/** Downloads VS Code and runs the integration suite in it (used by CI and `npm run test:integration`). */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  const root = path.resolve(__dirname, '..', '..', '..');
  // MD_RUNBOOK_VSCODE_SETTINGS: user settings (JSON) for the test VS Code, for experiments
  // (macos-open-probe.yml). It uses .vscode-test/user-data as its user data folder.
  const settings = process.env.MD_RUNBOOK_VSCODE_SETTINGS;
  if (settings) {
    const dir = path.join(root, '.vscode-test', 'user-data', 'User');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(JSON.parse(settings), null, 2));
  }
  await runTests({
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(__dirname, 'index.js'),
    // MD_RUNBOOK_VSCODE_ARGS: extra VS Code arguments for experiments (macos-open-probe.yml).
    launchArgs: ['--disable-extensions', '--disable-workspace-trust', ...(process.env.MD_RUNBOOK_VSCODE_ARGS ?? '').split(' ').filter(Boolean)],
    extensionTestsEnv: { MD_RUNBOOK_TEST: '1' },
  });
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
