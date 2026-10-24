// A throwaway VS Code with the dev build for record.js and stills.js: a fresh profile (VS Code would
// restore the last take's scroll position), the default dark theme, no welcome pages or tips.
const { _electron } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch({ repo, out, exe, file, width, height }) {
  const ud = path.join(out, 'ud');
  fs.rmSync(ud, { recursive: true, force: true });
  fs.mkdirSync(path.join(ud, 'User'), { recursive: true });
  fs.writeFileSync(
    path.join(ud, 'User', 'settings.json'),
    JSON.stringify(
      {
        'workbench.editorAssociations': { '*.md': 'md-runbook' },
        'workbench.startupEditor': 'none',
        'workbench.colorTheme': 'Default Dark Modern',
        'workbench.welcomePage.walkthroughs.openOnInstall': false,
        'workbench.secondarySideBar.defaultVisibility': 'hidden',
        'workbench.tips.enabled': false,
        'security.workspace.trust.enabled': false,
        'window.restoreWindows': 'none',
        'window.commandCenter': false,
        'chat.disableAIFeatures': true,
        'editor.minimap.enabled': false,
        'breadcrumbs.enabled': false,
        'notebook.globalToolbar': true,
        'mdRunbook.params.useDefaults': true,
        'update.mode': 'none',
        'extensions.autoCheckUpdates': false,
        'editor.lightbulb.enabled': 'off',
        'editor.cursorBlinking': 'solid',
      },
      null,
      2,
    ),
  );
  // The text view opens without a visible command palette (the toolbar button may not fit).
  fs.writeFileSync(path.join(ud, 'User', 'keybindings.json'), JSON.stringify([{ key: 'ctrl+alt+shift+m', command: 'mdRunbook.openAsText' }]));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({
    executablePath: exe,
    env,
    args: [
      file,
      `--extensionDevelopmentPath=${repo}`,
      `--user-data-dir=${ud}`,
      `--extensions-dir=${path.join(out, 'ext')}`,
      '--disable-workspace-trust',
      '--skip-release-notes',
      '--skip-welcome',
      '--disable-telemetry',
      '--disable-renderer-backgrounding',
      // The same pixel size on any screen (a 125% display made 1253-px frames of a 1000-px window).
      '--force-device-scale-factor=1',
    ],
  });
  const win = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }, [w, h]) => {
    const b = BrowserWindow.getAllWindows()[0];
    b.setSize(w, h);
    b.center();
  }, [width, height]);
  await win
    .locator('.cell-list-container .code-cell-row')
    .first()
    .waitFor({ timeout: 90_000 })
    .catch(async (e) => {
      await win.screenshot({ path: path.join(out, 'debug.png') });
      throw e;
    });
  await sleep(4000); // extension activation, kernel, first render
  const close = async () => {
    const pid = app.process().pid;
    await Promise.race([app.close(), sleep(10_000)]);
    try { require('child_process').execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' }); } catch {}
  };
  return { app, win, close };
}

module.exports = { launch, sleep };
