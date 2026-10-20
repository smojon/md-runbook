# Open probe scripts

The tools behind [docs/investigations/notebook-open-slow.md](../../docs/investigations/notebook-open-slow.md):
they launch a throwaway VS Code (the repo's test build in `.vscode-test`, its own profile folder),
open a notebook, and measure how long it takes to show its cells. Your own VS Code is not touched.

They are not part of the build or the tests. They need `playwright-core`, installed outside the
repo:

```sh
mkdir /tmp/pw && cd /tmp/pw && npm init -y && npm i playwright-core@1.55.0
cp <repo>/scripts/open-probe/* /tmp/pw/
```

Run them from that folder with `ELECTRON_RUN_AS_NODE` unset (from a VS Code terminal:
`env -u ELECTRON_RUN_AS_NODE node …`). `<Code.exe>` is the test build, e.g.
`<repo>/.vscode-test/vscode-win32-x64-archive-1.142.0/Code.exe` (run `npm run test:integration`
once to download it). `<out>` is a scratch folder.

Judge a fix only by alternating runs with and without it (the `exp*.js` scripts do): the
machine's load changes too much between separate series.

| Script | What it does |
| --- | --- |
| `shot.js <repo> <out> <Code.exe>` | Writes a demo runbook and VS Code settings into `<out>` (run it first), opens the runbook, hovers line 2 and saves `hover.png` |
| `probe.js <repo> <out> <Code.exe> <runs> [args…]` | Per open, every second: notebook editor, webview, cell rows, progress bar, window answering; console errors; VS Code's logs; CPU load |
| `profile.js <repo> <out> <Code.exe> <maxRuns>` | CPU profile of the window until the cells show; stops at the first slow open. Read it with `analyze.js <file.cpuprofile>` |
| `frames.js <repo> <out> <Code.exe> <maxRuns>` | The hidden webview's resource timings (when each renderer script loaded) on one timeline |
| `reader.js <vscode app dir> <outFile> <seconds>` | Direct reads of VS Code's renderer files every 250 ms, logging slow ones (disk or antivirus check) |
| `sampler.ps1 -Out <file> -Seconds <n>` | Windows: priority class and CPU time of the throwaway VS Code's processes |
| `exp.js <repo> <out> <Code.exe> <pairs>` | A/B: runbook opens with and without `--disable-renderer-backgrounding`, alternating |
| `exp-ipynb.js <repo> <out> <Code.exe> <pairs>` | The same on a built-in .ipynb with all extensions disabled (needs `work/restart-web.ipynb` and `ud/User/settings.json` in `<out>`) |
| `patch.py <workbench.desktop.main.js>` | Patches a COPY of VS Code 1.142.0: the notebook webview is hidden with `opacity: 0` instead of `visibility: hidden` during its warmup |
| `exp-patch.js <repo> <out> <Code.exe> <pairs> <patched Code.exe>` | A/B: original vs patched build, .ipynb, all extensions disabled |
