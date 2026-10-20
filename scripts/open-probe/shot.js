// Opens a demo runbook in a throwaway VS Code with the dev build of md-runbook, hovers a line and
// screenshots the window. Usage: node shot.js <repo> <outDir> <Code.exe>
const { _electron } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const [repo, out, exe] = process.argv.slice(2);
const work = path.join(out, 'work');
const ud = path.join(out, 'ud');
fs.mkdirSync(work, { recursive: true });
fs.mkdirSync(path.join(ud, 'User'), { recursive: true });
fs.writeFileSync(
  path.join(ud, 'User', 'settings.json'),
  JSON.stringify(
    {
      'workbench.editorAssociations': { '*.md': 'md-runbook' },
      'workbench.startupEditor': 'none',
      'workbench.colorTheme': 'Default Dark Modern',
      'security.workspace.trust.enabled': false,
      'window.restoreWindows': 'none',
      'chat.disableAIFeatures': true,
      'mdRunbook.params.useDefaults': true,
      'mdRunbook.ai.provider': 'vscode',
      'mdRunbook.output.recordContext': { cluster: 'echo prod-eu' },
      'mdRunbook.statusBar.contextAttr': 'cluster',
      'editor.hover.delay': 200,
    },
    null,
    2,
  ),
);
const runbook = path.join(work, 'restart-web.md');
fs.writeFileSync(
  runbook,
  [
    '---',
    'params:',
    '  - ns: web',
    '---',
    '',
    '# Restart the web pods',
    '',
    '```bash',
    'kubectl get pods -n ${param:ns}',
    'kubectl delete pod -l app=web -n ${param:ns}',
    'kubectl rollout status deploy/web -n ${param:ns}',
    '```',
    '',
  ].join('\n'),
);

(async () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({
    executablePath: exe,
    env,
    args: [
      work,
      runbook,
      `--extensionDevelopmentPath=${repo}`,
      `--user-data-dir=${ud}`,
      `--extensions-dir=${path.join(out, 'ext')}`,
      '--disable-workspace-trust',
      '--skip-release-notes',
      '--skip-welcome',
      '--disable-telemetry',
      '--disable-renderer-backgrounding',
    ],
  });
  try {
    const win = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      w.setSize(1100, 720);
      w.center();
    });
    const line = win.locator('.view-line', { hasText: 'kubectl delete' }).first();
    await line.waitFor({ timeout: 60_000 }).catch(async (e) => { await win.screenshot({ path: path.join(out, 'debug.png') }); throw e; });
    await win.waitForTimeout(4000); // extension activation, context command
    // Move off and back so the hover provider (registered on activation) is asked.
    await win.mouse.move(5, 5);
    const box = await line.boundingBox();
    await win.mouse.move(box.x + 70, box.y + box.height / 2);
    const hover = win.locator('.monaco-hover:not(.hidden)').first();
    await hover.waitFor({ state: 'visible', timeout: 15_000 });
    await win.waitForTimeout(800);
    await win.screenshot({ path: path.join(out, 'window.png') });
    const hb = await hover.boundingBox();
    const x = Math.max(0, Math.min(hb.x, box.x) - 40);
    const y = Math.max(0, Math.min(hb.y, box.y) - 40);
    const right = Math.max(hb.x + hb.width, box.x + 520) + 40;
    const bottom = Math.max(hb.y + hb.height, box.y + box.height) + 60;
    await win.screenshot({ path: path.join(out, 'hover.png'), clip: { x, y, width: right - x, height: bottom - y } });
    console.log('ok', JSON.stringify(hb));
  } finally {
    const pid = app.process().pid;
    await Promise.race([app.close(), new Promise((r) => setTimeout(r, 10_000))]);
    try { require('child_process').execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' }); } catch {}
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
