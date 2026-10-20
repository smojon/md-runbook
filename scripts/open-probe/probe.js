// Open probe: launches a throwaway VS Code with the dev build N times, opens the demo runbook and
// records, every second, what the window shows and whether it answers. Usage:
//   node probe.js <repo> <outDir> <Code.exe> <runs> [extra VS Code args...]
const { _electron } = require('playwright-core');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const [repo, out, exe, runsArg, ...extraArgs] = process.argv.slice(2);
const runs = Number(runsArg || 5);
const work = path.join(out, 'work');
const ud = path.join(out, 'ud');
const results = [];

const cpu = () => {
  try {
    return execSync('powershell -NoProfile -Command "(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average"', { encoding: 'utf8', timeout: 15000 }).trim();
  } catch {
    return '?';
  }
};

const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r('TIMEOUT'), ms))]);

async function once(i) {
  const runDir = path.join(out, `run${i}`);
  fs.mkdirSync(runDir, { recursive: true });
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const t0 = Date.now();
  const at = () => Date.now() - t0;
  const events = [];
  const log = (e) => events.push(`${String(at()).padStart(6)} ${e}`);
  log(`cpu ${cpu()}%`);
  const app = await _electron.launch({
    executablePath: exe,
    env,
    args: [
      work,
      path.join(work, 'restart-web.md'),
      `--extensionDevelopmentPath=${repo}`,
      `--user-data-dir=${ud}`,
      `--extensions-dir=${path.join(out, 'ext')}`,
      '--disable-workspace-trust',
      '--skip-release-notes',
      '--skip-welcome',
      '--disable-telemetry',
      ...extraArgs,
    ],
  });
  const pid = app.process().pid;
  let opened;
  try {
    const win = await app.firstWindow();
    log('window');
    win.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') log(`console.${m.type()}: ${m.text().slice(0, 400)}`);
    });
    win.on('pageerror', (e) => log(`pageerror: ${String(e).slice(0, 400)}`));
    app.on('window', (w) => log(`new window ${w.url().slice(0, 120)}`));
    let last = '';
    for (let s = 0; s < 60; s++) {
      const state = await withTimeout(
        win.evaluate(() => {
          const q = (sel) => document.querySelectorAll(sel).length;
          return JSON.stringify({
            nb: q('.notebook-editor'),
            rows: q('.notebook-editor .monaco-list-row'),
            lines: [...document.querySelectorAll('.notebook-editor .view-line')].filter((l) => l.textContent.includes('kubectl')).length,
            webview: q('.notebook-editor .webview, .notebook-editor webview, .webview.ready'),
            iframes: q('iframe'),
            progress: q('.notebook-editor .monaco-progress-container.active, .monaco-progress-container.active'),
          });
        }),
        3000,
      );
      if (state !== last) log(`state ${state}`);
      last = state;
      if (state !== 'TIMEOUT' && JSON.parse(state).lines > 0) {
        opened = at();
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!opened) {
      log(`cpu ${cpu()}%`);
      const shot = await withTimeout(win.screenshot({ path: path.join(runDir, 'stuck.png') }).then(() => 'ok'), 10000);
      log(`screenshot ${shot}`);
    }
  } catch (e) {
    log(`error ${String(e).slice(0, 300)}`);
  } finally {
    await withTimeout(app.close(), 10000);
    try {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
    } catch {}
  }
  // VS Code's logs of this session (the newest folder).
  try {
    const logs = path.join(ud, 'logs');
    const newest = fs.readdirSync(logs).sort().pop();
    fs.cpSync(path.join(logs, newest), path.join(runDir, 'logs'), { recursive: true });
  } catch {}
  fs.writeFileSync(path.join(runDir, 'events.txt'), events.join('\n') + '\n');
  results.push({ run: i, opened: opened ?? 'NOT OPENED (60 s)' });
  console.log(`run ${i}: ${opened === undefined ? 'NOT OPENED' : `${opened} ms`}`);
}

(async () => {
  for (let i = 1; i <= runs; i++) await once(i);
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(results, null, 2));
})();
