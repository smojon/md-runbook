// Takes the README stills: docs/1-notebook.png (a runbook after Run All) and
// docs/2-saved-markdown.png (the same file saved, as plain Markdown: output blocks, secrets
// redacted). Same needs as record.js (Git Bash for the bash blocks). Usage:
//   node stills.js <repo> <outDir> <Code.exe>   → <outDir>/1-notebook.png, <outDir>/2-saved-markdown.png
const fs = require('fs');
const path = require('path');
const { launch, sleep } = require('./vscode');

const [repo, out, exe] = process.argv.slice(2);
const work = path.join(out, 'stills');
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });
const runbook = path.join(work, 'rotate-token.md');
fs.writeFileSync(
  runbook,
  [
    '# Rotate service account token',
    '',
    'Check where we are before touching anything.',
    '',
    '```bash',
    'echo "cluster: shop-prod"',
    'echo "bash $BASH_VERSION"',
    '```',
    '',
    '```powershell',
    "Get-Date -Format 'yyyy-MM-dd HH:mm'",
    '"PowerShell $($PSVersionTable.PSVersion)"',
    '```',
    '',
    'Fetch a token from the IAM endpoint (secrets are redacted when saved):',
    '',
    '```bash',
    "echo 'HTTP/1.1 200 OK'",
    "echo 'Authorization: Bearer eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJkZW1vIn0.c2lnbmF0dXJlLXZhbHVl'",
    'echo \'{"client_id": "ops", "client_secret": "s3cr3t-value"}\'',
    '```',
    '',
    'Verify the rollout (this one fails, so Run All stops here):',
    '',
    '```bash',
    'echo "waiting for pods..."',
    'exit 2',
    '```',
    '',
    'Revoke the old token:',
    '',
    '```bash',
    'echo "revoked"',
    '```',
    '',
  ].join('\n'),
);

(async () => {
  const width = 1400;
  const height = 930;
  const { win, close } = await launch({ repo, out, exe, file: runbook, width, height });
  // Without the custom title bar ("[Extension Development Host] …").
  const shot = (name) => win.screenshot({ path: path.join(out, name), clip: { x: 0, y: 30, width, height: height - 30 } });
  try {
    await win.locator('.notebook-toolbar-container a.action-label[aria-label^="Run All"]').first().click();
    await win
      .waitForFunction(() => /stopped|failed/i.test(document.querySelector('.part.statusbar')?.textContent ?? ''), null, { timeout: 60_000 })
      .catch(() => console.error('the stop was not seen in the status bar'));
    await win.mouse.move(25, 500); // the empty activity bar: no hover, no tooltip
    await win.keyboard.press('Control+Home');
    await sleep(2500);
    await shot('1-notebook.png');

    await win.keyboard.press('Control+S');
    await sleep(500);
    await win.keyboard.press('Control+Alt+Shift+M');
    await win.locator('.monaco-editor .view-line', { hasText: 'md-runbook:output start' }).first().waitFor({ timeout: 15_000 });
    await win.mouse.move(25, 500);
    await sleep(1500);
    await shot('2-saved-markdown.png');
    console.log(fs.readFileSync(runbook, 'utf8').includes('[REDACTED]') ? 'ok, secrets redacted' : 'NOT REDACTED');
  } finally {
    await close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
