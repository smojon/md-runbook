# Runbooks open slowly or blank: investigation

Investigated 2026-10-19 and 2026-10-20 on Windows 11 with VS Code 1.142.0. Status: cause confirmed,
workaround found, a one-line fix for VS Code tested, VS Code issue drafted (not filed yet).

## Summary

Opening a runbook sometimes shows an empty notebook for 15 to 60 s, or never shows its cells. The
wait is inside VS Code 1.142.0, not in md-runbook: no cell, not even a code cell, appears until the
notebook's hidden webview has loaded VS Code's Markdown renderer and every renderer that extends
it. Under heavy CPU load, that webview stalls: one 185 KB renderer file took 10.9 to 13.4 s to load,
while direct reads of the same file at the same moment took 50 to 100 ms.

- **Confirmed:** where the wait is (VS Code source and measurements agree); the window is idle while
  it waits; the disk and antivirus reads are fast; Mermaid adds 2 to 3 s but is not the cause.
- **Also confirmed, the cause:** the hidden webview's process runs at Windows priority class Idle
  while VS Code keeps it hidden, so under load it gets almost no CPU. Starting VS Code with
  `--disable-renderer-backgrounding` cut the wait from 8 to 64 s to 0 to 1.6 s in 6 alternating
  pairs, and the same with all extensions disabled.
- **Fix for VS Code, tested:** hiding the webview with `opacity: 0` instead of `visibility: hidden`
  during the warmup cut the wait from 9.8 to 62.7 s to 0 to 1.1 s in 6 alternating pairs.
- **Recommendation:** file the VS Code issue below after review; meanwhile, start VS Code with
  `--disable-renderer-backgrounding`. md-runbook itself can do little: VS Code would need to keep
  the webview at normal priority, show code cells before the Markdown renderers are ready, or time
  out.

## Symptom and setup

The runbook tab opens and shows the notebook toolbar, with the kernel already selected, but the cell
area stays empty with a progress bar. Usually the cells appear after a few seconds; sometimes after
a minute; sometimes never.

| | |
| --- | --- |
| VS Code | 1.142.0 (commit 6d62b1d), the same build as the user's own install |
| OS | Windows 11 Enterprise, 8 logical processors |
| Load during the tests | 77 to 100% CPU, mostly Windows Defender (MsMpEng, MsSense), an installer (msiexec), the search indexer and WMI |
| Extensions | built-ins plus the md-runbook development build |
| Test file | a small runbook: front matter with one parameter, a heading, one bash cell with 3 kubectl lines |

The same symptom on macOS CI runners was investigated on 2026-10-19 without a cause
([HANDOFF.md](../HANDOFF.md), Known gaps).

## Method

Every measurement launches a separate, throwaway VS Code (the repo's test build in `.vscode-test`,
its own profile folder) through Playwright, opens the test file, and closes it again. The user's
own VS Code is never touched. Fixes and causes are judged only by alternating runs with and without
them, because the machine's load varies a lot.

| Probe | What it records |
| --- | --- |
| State probe | Every second: notebook editor present, hidden webview present, cell rows present, progress bar, whether the window answers within 3 s; console errors and warnings; VS Code's logs of the session; machine CPU load |
| CPU profile | The window's (renderer's) CPU profile from launch until the cells show, through the Chrome DevTools Protocol |
| Webview timings | The hidden webview's own resource timings: when each script was requested and how long it took, on one timeline from launch |
| Direct reads | A separate Node process reads the same VS Code files every 250 ms and logs each read slower than 50 ms |
| Priority sampler | Every 2 to 5 s: Windows priority class and CPU time of each process of the throwaway VS Code |

A source review of VS Code 1.142.0 (notebook editor, back-layer webview, webview preloads, resource
loading) was done in parallel and checked against the measurements.

"Wait" below always means the time from the hidden webview appearing to the first cell row
appearing.

## Measurements

The slow part is always the same step: the hidden webview loading VS Code's Markdown renderer
(`extensions/markdown-language-features/notebook-out/index.js`, 185 KB). Times from 19 October
2026, 23:00 to 23:45.

### Series 1: 6 opens, all extensions on, CPU at 100%

| Open | Wait | Cells after launch |
| --- | --- | --- |
| 1 | never (stopped at 60 s) | never |
| 2 | never (window reported unresponsive) | never |
| 3 | 55.6 s | 67.1 s |
| 4 | 13.4 s | 22.6 s |
| 5 | 44.3 s | 54.5 s |
| 6 | 8.2 s | 17.0 s |

In both hung opens the console showed `Webview.loadLocalResource - Error using fileReader` for a
Mermaid file; in open 2, main.log showed `CodeWindow: detected unresponsive`.

### Series 2 and 3: Mermaid on and off

| Series | Mermaid | Math | Waits |
| --- | --- | --- | --- |
| 2, run after series 1 | off | off | 10.2, 5.2, 3.3, 4.1, 5.1 s |
| 3, alternating | on | on | 9.1, 7.1, 5.2, 6.1 s |
| 3, alternating | off | on | 6.3, 4.1, 4.1, 4.2 s |

Series 2 looked like a fix, but series 3, alternating on and off open by open, shows Mermaid costs
only about 2 to 3 s. Series 2 mostly caught the load easing.

### Series 4: what the hidden webview loads, and when

| Open | Request after webview page | Load of the 185 KB file | Next request after it | Cells after launch |
| --- | --- | --- | --- | --- |
| A | 0.0 s | 0.06 s | | 7.3 s |
| B | 1.6 s | 0.17 s | | 7.5 s |
| C | 0.0 s | 0.8 s | | 7.3 s |
| D | 1.7 s | 0.8 s | | 9.8 s |
| E | 0.0 s | 1.5 s | | 9.8 s |
| F | 0.0 s | 4.2 s | | 12.0 s |
| **Slow 1** | **6.6 s** | **10.9 s** | 0.1 s | **25.7 s** |
| **Slow 2** | 0.0 s | **13.4 s** | **13.1 s** | **34.8 s** |

After the Markdown renderer, the extending renderers (KaTeX, Mermaid's chunks, ipynb attachments,
md-runbook's 1.5 KB renderer) each load in 0.03 to 0.2 s. In slow 2, the webview then did nothing
visible for 13.1 s before requesting them: a stall with no file read in it.

### CPU profile of the window

During a 15 s wait, the window's main thread was idle 75% of a 19.6 s profile. Busy milliseconds
per second: 881, 977, 364, 840, 831, 435, 172, then 0 to 17 for 11 seconds, then 302 when the
cells appeared. The window waits; it does not compute.

### Direct reads of the same files

Over 7 minutes, about 5,000 direct reads of the Markdown renderer, the shell grammar and KaTeX: the
slowest took 0.72 s; during slow 2 (21:32:46 to 21:33:09 UTC) they took 54 to 98 ms. The disk and
Defender's on-access scan do not explain 13 s loads.

## What VS Code waits for before showing cells

In VS Code 1.142.0, the notebook list is attached to its cells only after two awaits on the hidden
webview, and neither has a timeout. Paths are under `src/vs/workbench/contrib/`; line numbers
checked against the 1.142.0 source.

1. The notebook model is loaded (the extension's serializer), then `_attachModel` calls
   `await this._warmupWithMarkdownRenderer(...)` (`notebook/browser/notebookEditorWidget.ts:1552`).
2. `_warmupWithMarkdownRenderer` first awaits `_resolveWebview()` (line 1662): the back-layer
   webview is created and must post `initialized`, after its service worker is registered and its
   preload script has run (`backLayerWebView.ts:590-959`, `webview/browser/pre/index.html:269-293`).
   The webview is kept hidden meanwhile (line 1668).
3. It then awaits `_warmupViewportMarkdownCells` (line 1670): the first 5 Markdown cells are sent
   to the webview with `initializeMarkup`, and VS Code waits for `initializedMarkup` (lines
   1727-1731).
4. Rendering a Markdown cell loads the Markdown renderer: kernel preloads first, then
   `await __import(entrypoint)`, `activate()`, and then every renderer whose entrypoint `extends`
   it, all awaited (`webviewPreloads.ts:1986-2024`). Today: KaTeX math, Mermaid, ipynb cell
   attachments and md-runbook's checklist renderer.
5. Only then `this._list.attachViewModel(viewModel)` runs (line 1682) and every cell, code cells
   included, appears.

Timeouts: none in steps 2 and 3. Each file the webview requests goes through its service worker,
which gives up after 30 s (`pre/service-worker.js:44, 92`). A failed read ends in an error message
in the cell, not a hang; a read that hangs costs up to 30 s, and the waits run one after another.
VS Code's own trace log can show the timings: set the log level to Trace and read the Window output
channel, line `[NotebookEditor] open notebook perf` (`notebookEditor.ts:550`), and the
`Webview.loadLocalResource` lines.

## Hypotheses tested

| Hypothesis | Verdict | Evidence |
| --- | --- | --- |
| md-runbook's startup or serializer is slow | Ruled out | The toolbar shows the md-runbook kernel before the wait starts, so the extension is active and the file is read; its renderer is 1.5 KB and loads in under 0.1 s |
| The 19 MB Mermaid renderer causes it | Ruled out as the cause; costs 2 to 3 s | Series 3, alternating on and off |
| The disk or Defender makes reads slow | Ruled out | Direct reads 54 to 98 ms during a 13.4 s load of the same file |
| The VS Code window is busy | Ruled out for slow opens | 11 s idle in the CPU profile; one hung open did report the window unresponsive, so heavy load may add a second effect |
| Machine load alone | Not enough | Other programs slow down; this one step goes from 0.06 s to 13.4 s, and a 13 s stall happens with no file read in it |
| The hidden webview process is starved of CPU | Confirmed | Next section |

## Process priority experiment

Confirmed: while the cells wait, the hidden webview's process runs at Windows priority class Idle,
and Chromium's `--disable-renderer-backgrounding` removes the wait. 6 pairs, control and flag
alternating open by open, 20 October 2026, 06:48 to 06:54, CPU 77 to 100%.

| Pair | Wait, control | Wait, with flag | Markdown renderer file, control | with flag | Cells after launch, control | with flag |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 10.4 s | 1.2 s | 8.5 s | 23 ms | 23.3 s | 6.3 s |
| 2 | 8.0 s | 1.6 s | 2.3 s | 14 ms | 15.3 s | 6.9 s |
| 3 | 26.2 s | 0.0 s | 2.2 s | 25 ms | 31.6 s | 9.4 s |
| 4 | 63.9 s | 1.3 s | 22.1 s | 58 ms | 69.3 s | 7.2 s |
| 5 | 24.9 s | 1.1 s | 23.1 s | 59 ms | 31.0 s | 6.9 s |
| 6 | 16.9 s | 1.1 s | 11.1 s | 28 ms | 25.2 s | 6.2 s |

Priority in the control opens, sampled every 2 to 5 s (the sampler itself slowed under the load):

- The VS Code window's process: priority class Normal (base 8) in every sample.
- The hidden webview's process: priority class Idle (base 4) in 61 of 67 samples; the 3 Normal
  samples are each the last one, when the cells appear (3 more could not be read).
- CPU time it got: 0.4 to 0.6 s per wait; in pair 4, 0.19 s over 27 s.

On Windows, an Idle-class process only runs when no Normal-class thread wants the CPU. With
Defender, an installer and the indexer keeping all 8 processors busy, the webview gets almost
nothing, and VS Code shows no cell until it finishes. That is why load alone does not explain it:
everything else slows down, this one process nearly stops.

## Without md-runbook

The same happens without md-runbook: a built-in .ipynb notebook (one Markdown cell, one code cell),
all extensions disabled (`--disable-extensions`), 6 alternating pairs, 20 October 2026, 06:54 to
06:59.

| Pair | Wait, control | Wait, with flag | Markdown renderer file, control | with flag |
| --- | --- | --- | --- | --- |
| 1 | no webview within 75 s (see below) | 3.4 s | | 764 ms |
| 2 | 9.8 s | 1.3 s | 452 ms | 43 ms |
| 3 | 8.7 s | 1.1 s | 3.2 s | 25 ms |
| 4 | 12.0 s | 0.0 s | 9.5 s | 35 ms |
| 5 | 23.0 s | 0.0 s | 1.6 s | 15 ms |
| 6 | 9.8 s | 1.1 s | 4.1 s | 53 ms |

During each control wait, the webview's process was at priority class Idle in every sample.

Pair 1's control is unexplained: it was the first launch of a fresh profile, and no webview
appeared at all within 75 s, unlike every other open. It is left out of the comparison.

## A one-line fix in VS Code, tested

Making the webview transparent instead of invisible during the warmup removes the wait, with no
command-line flag. In a copy of VS Code 1.142.0, two statements of `_warmupWithMarkdownRenderer`
(`notebookEditorWidget.ts`) were changed (in the built, minified `workbench.desktop.main.js`):

```diff
- this._webview.element.style.visibility = 'hidden';
+ this._webview.element.style.opacity = '0';
  await this._warmupViewportMarkdownCells(viewModel, viewState);
  ...
  this._list.attachViewModel(viewModel);
  ...
- this._webview.element.style.visibility = 'visible';
+ this._webview.element.style.opacity = '';
```

The webview stays invisible to the user (fully transparent), but Chromium no longer treats its frame
as hidden, so its process keeps normal priority. Original and patched builds alternating, built-in
.ipynb, all extensions disabled, 20 October 2026, 07:18 to 07:25:

| Pair | Wait, original | Wait, patched | Markdown renderer file, original | patched |
| --- | --- | --- | --- | --- |
| 1 | 62.7 s | 0.0 s | 9.2 s | 17 ms |
| 2 | 56.6 s | 0.0 s | 11.1 s | 39 ms |
| 3 | 17.0 s | 1.1 s | 13 ms | 74 ms |
| 4 | 15.2 s | 0.0 s | 7.8 s | 15 ms |
| 5 | 48.6 s | 1.0 s | 13.2 s | 63 ms |
| 6 | 9.8 s | 1.1 s | 24 ms | 54 ms |

Not checked yet: whether pre-rendered Markdown can flash at a wrong position (the reason for
`visibility = 'hidden'` per VS Code's comment); opacity 0 should hide it the same way, but the
patched build has not been looked at during an open yet.

## What md-runbook can do, and workarounds

md-runbook cannot make the cells show earlier: every notebook waits for the hidden webview, and no
extension API changes that. Its own renderer is one 1.5 KB file in the chain; removing it would
save well under 0.1 s.

| Option | Who | Effect | Cost |
| --- | --- | --- | --- |
| Start VS Code with `--disable-renderer-backgrounding` (add it to the shortcut's target, after Code.exe) | User | Waits of 0 to 1.6 s instead of 8 to 26 s in the test | Applies only when VS Code starts from that shortcut; `argv.json` does not accept this switch (VS Code passes only 5 Chromium switches through: disable-hardware-acceleration, force-color-profile, disable-lcd-text, proxy-bypass-list, remote-debugging-port); hidden pages and background windows keep full priority |
| Disable the built-in Mermaid extension (`@builtin mermaid` in the Extensions view) | User | About 2 to 3 s less | No Mermaid diagrams in Markdown previews and notebooks |
| Pass `--disable-renderer-backgrounding` in md-runbook's CI integration tests | md-runbook | Likely removes the macOS CI open hangs of 2026-10-19 | None for users; to be confirmed on CI |
| Document the symptom and the workaround (docs/features, troubleshooting) | md-runbook | Users know it is VS Code and how to avoid it | None |
| Report it to VS Code | md-runbook | A fix for everyone: keep the webview's process at normal priority while it warms up, or show code cells before the Markdown renderers are ready | The issue draft below |

## Issue draft

To be filed on github.com/microsoft/vscode from the user's GitHub account, after their approval.
Nothing below names the user, the company or local paths. The review copy with comments is the
Claude Doc "Runbooks open slowly or blank: investigation and VS Code issue draft".

**Is it already known?** No, as far as GitHub's search shows (searched 2026-10-20): no issue in
microsoft/vscode or electron/electron mentions the webview's process priority, `visibility: hidden`
during the warmup, or `--disable-renderer-backgrounding` for notebooks. Related but different:

| Issue | State | Why it is not this |
| --- | --- | --- |
| [#161520 Markup cell initialize fail on window reload](https://github.com/microsoft/vscode/issues/161520) | closed, fixed 2022 | Same code path (`initializeMarkup`), but a failure on reload, not a slow open under load |
| [#125993 Webview Service Worker Error in registration](https://github.com/microsoft/vscode/issues/125993) | open | The service worker fails to register; here it registers and runs, slowly |
| [#129477 Notebook: Invisible markdown cells](https://github.com/microsoft/vscode/issues/129477) | closed, fixed 2021 | Cells with zero height, not a delayed list |
| [#145284 Can't show cells after opening ipynb](https://github.com/microsoft/vscode/issues/145284) | closed, info needed | No cause found; 2022, Jupyter extension |
| [#147253 Rendering extremely slow](https://github.com/microsoft/vscode/issues/147253) | closed, not planned | Slow scrolling and outputs in large notebooks |

On macOS CI (3 runners, each with and without the flag, alternating order), the runners were hardly
slow that day: 2 opens over 5 s without the flag (5.8 and 5.9 s), none with it. Consistent with the
fix, but not proof for macOS.

**Title:** Notebook shows no cells for 10-60 s under CPU load: the back-layer webview's process
runs at Idle priority while hidden during warmup

````markdown
Does this issue occur when all extensions are disabled?: Yes

- VS Code Version: 1.142.0 (6d62b1d5dace93a33b3a6d3eca1317bd5e15bcb1)
- OS Version: Windows 11 Enterprise 10.0.26200, x64, 8 logical processors

## Summary

When other processes keep the CPU busy (here: Windows Defender scans, an installer, the search indexer; 77-100% CPU), opening a notebook shows the notebook toolbar and a progress bar, but **no cell at all, code cells included, for 8 to 64 s** (in one series, twice not within 60 s). The VS Code window itself is idle meanwhile.

The back-layer webview's renderer process runs at Windows priority class **Idle** while the notebook warms up, because `_warmupWithMarkdownRenderer` sets the webview to `visibility: hidden` until the list is attached. The list is attached only after the webview has loaded the Markdown renderer and every renderer that extends it, so an Idle-priority process on a busy machine blocks the whole editor.

**A tested one-line fix:** hide the webview with `opacity: 0` instead of `visibility: hidden` during the warmup. In 6 alternating pairs the wait went from 9.8-62.7 s to 0-1.1 s (table below). Starting VS Code with `--disable-renderer-backgrounding` has the same effect.

## Steps to reproduce

1. Keep all CPU cores busy with other normal-priority processes.
2. `code --disable-extensions` and open a .ipynb with one Markdown cell and one code cell (no Jupyter extension needed).
3. The editor and toolbar appear; no cell is shown for seconds to a minute.
4. Repeat with `code --disable-extensions --disable-renderer-backgrounding`: cells show within about 1 s.

## The fix

In `src/vs/workbench/contrib/notebook/browser/notebookEditorWidget.ts`, `_warmupWithMarkdownRenderer`:

```diff
- this._webview.element.style.visibility = 'hidden';
+ this._webview.element.style.opacity = '0';
  await this._warmupViewportMarkdownCells(viewModel, viewState);
  ...
- this._webview.element.style.visibility = 'visible';
+ this._webview.element.style.opacity = '';
```

The webview stays invisible to the user, but Chromium no longer treats its frame as hidden, so its process keeps normal priority. Tested by patching the built 1.142.0 `workbench.desktop.main.js` (the two minified statements) and alternating original and patched builds, all extensions disabled, built-in .ipynb:

| Pair | Wait, original | Wait, patched | notebook-out/index.js load, original | patched |
|---|---|---|---|---|
| 1 | 62.7 s | 0.0 s | 9.2 s | 17 ms |
| 2 | 56.6 s | 0.0 s | 11.1 s | 39 ms |
| 3 | 17.0 s | 1.1 s | 13 ms | 74 ms |
| 4 | 15.2 s | 0.0 s | 7.8 s | 15 ms |
| 5 | 48.6 s | 1.0 s | 13.2 s | 63 ms |
| 6 | 9.8 s | 1.1 s | 24 ms | 54 ms |

"Wait" = webview present to first cell row, measured in a fresh VS Code per open (Playwright).

Not verified: that pre-rendered Markdown never flashes at a wrong position with opacity 0 (the reason given in the comment for `visibility: hidden`).

## More measurements

- The same with `--disable-renderer-backgrounding` instead of the patch (all extensions disabled): 8.7-23.0 s vs 0-3.4 s; with an extension's notebook type: 8.0-63.9 s vs 0.0-1.6 s.
- Process priority, sampled every 2-5 s during control waits: window process **Normal** in every sample; webview process **Idle** (base priority 4) in 61 of 67 samples, Normal only in the sample where the cells appear. In a 64 s wait the webview process got 0.19 s of CPU in 27 s.
- The window's CPU profile during a slow open: main thread idle for 11 s of the wait.
- Direct reads of the same 185 KB file from another process at the same moment: 54-98 ms (so not disk or antivirus).
- In one slow open, after the Markdown renderer finished loading, the webview stalled another 13 s before requesting the extending renderers: no I/O in that gap, just no CPU.

## Where in the code

- `notebookEditorWidget.ts` `_warmupWithMarkdownRenderer`: hides the webview, awaits `_resolveWebview()` and `_warmupViewportMarkdownCells()` (`initializeMarkup` -> `initializedMarkup`), and only then calls `this._list.attachViewModel(viewModel)`.
- `webviewPreloads.ts` `Renderer._load`: imports and activates the Markdown renderer, then awaits every renderer that `extends` it.
- No timeout on `_resolveWebview` or `initializeMarkup`; only the webview service worker's 30 s `resolveTimeout` per request.

Other options, if opacity is not wanted: attach the list (at least code cells) without waiting for the Markdown renderers, or give the warmup a timeout.

The same symptom ("opening a notebook sometimes takes 5-20 s or never settles") was also seen on macOS CI runners (GitHub Actions). On a day with little slowness there, 3 runners with and without the flag gave 2 opens over 5 s without it and none with it: consistent, but not conclusive for macOS.
````

## Open questions and next steps

Status on 2026-10-20, end of session:

- [x] Cause found and confirmed (webview process at Idle priority while hidden), with and without
      md-runbook.
- [x] Workaround tested: `--disable-renderer-backgrounding`, alternating pairs.
- [x] One-line VS Code fix tested: opacity instead of `visibility: hidden`, alternating pairs.
- [x] Searched for an existing issue: none found (section "Issue draft").
- [x] md-runbook: slow-open hint (more than 10 s, once per session, Learn More, Don't Show Again),
      with an integration test; [troubleshooting page](../troubleshooting.md), linked from the
      README; changelog.
- [x] Probe scripts kept in the repo: [scripts/open-probe](../../scripts/open-probe/README.md).
- [ ] Review this write-up and the issue draft (user); file the issue only after approval.
- [ ] Before filing: watch the patched VS Code during an open (screenshots), to check no Markdown
      flashes at a wrong position.
- [ ] Try the workaround in the user's own VS Code: add `--disable-renderer-backgrounding` to the
      shortcut, then compare opens with and without it, alternating.
- [ ] Decide on CI: add `--disable-renderer-backgrounding` to the integration tests now, or first
      rerun the macOS A/B probe (Actions → macOS open probe → `ab`) on a busier day.
- [ ] Optional: offer the fix as a pull request to microsoft/vscode once the issue is filed.
- Open: whether the "window detected unresponsive" hang (series 1, open 2) is the same cause or a
  second effect of heavy load; it did not recur in later series.
- Open: the exact Chromium rule that puts the webview's process at Idle (the frame being hidden is
  the likely trigger; the patch result supports it, Chromium's source was not read).
- Open: how much the same affects macOS and Linux users.
