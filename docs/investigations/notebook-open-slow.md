# Runbooks open slowly or blank: investigation

Investigated 2026-10-19 and 2026-10-20 on Windows 11 with VS Code 1.142.0. Status: cause confirmed,
workaround found, a one-line fix for VS Code tested, VS Code issue filed:
[microsoft/vscode#342813](https://github.com/microsoft/vscode/issues/342813).

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
- **Why, from Chromium's source (read 2026-10-20):** CSS `visibility: hidden` on an out-of-process
  iframe makes Blink report the frame as "not rendered", the browser process then hides the frame's
  widget, the renderer process has no visible widget left and gets `IDLE_PRIORITY_CLASS` plus
  Windows EcoQoS ("efficiency mode"). Section "Why a hidden frame becomes an Idle process".
- **Without patching VS Code:** nothing elegant. The warmup is unconditional, no setting skips it,
  and `argv.json` cannot carry the flag (checked in the 1.142.0 build). The one lever an extension
  has is to raise the webview process's priority itself from the extension host (Windows only,
  permitted, a hack); section "What md-runbook can do".
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

A flash is not possible with `opacity: 0`: the element is painted fully transparent, so nothing of
the pre-rendered Markdown can appear, whatever its position (the reason for `visibility = 'hidden'`
per VS Code's comment). The one real difference is hit-testing: a `visibility: hidden` element
takes no pointer events, an `opacity: 0` element does, so during the warmup the transparent webview
could swallow a click on the empty cell area. `pointer-events: none` for the same span closes that;
the patched build has not been looked at by eye during an open yet.

## Why a hidden frame becomes an Idle process

Read on 2026-10-20 in Chromium's `main` branch (not the exact revision in Electron's VS Code
1.142.0, but this code has been stable for years). The webview is an `<iframe>` with the origin
`vscode-webview://…`, which is cross-origin to the window (`vscode-file://…`), so with site
isolation it runs in its own renderer process. The chain from VS Code's one CSS line to the process
priority:

1. `third_party/blink/renderer/core/layout/layout_embedded_content.cc`, `StyleDidChange`: if the
   iframe's computed `visibility` is not `visible`, `embedded_content_view->Hide()`; otherwise
   `Show()`. CSS `display` is not looked at here; `opacity` is not either, so `opacity: 0` keeps
   the frame "shown".
2. `third_party/blink/renderer/core/frame/remote_frame_view.cc`: `Hide()` sets the frame
   self-invisible and reports `FrameVisibility::kNotRendered` to the browser process
   (`VisibilityChanged`); shown frames report `kRenderedInViewport` or `kRenderedOutOfViewport`.
3. `content/browser/renderer_host/cross_process_frame_connector.cc`, `OnVisibilityChanged`:
   `visible = visibility != kNotRendered`; when not visible, `view_->Hide()`.
4. `render_widget_host_view_child_frame.cc`, `Hide()`: `host()->WasHidden()`, so the process's
   count of visible clients drops.
5. `render_process_host_impl.cc`, `UpdateProcessPriority`: the priority is computed from
   `visible_clients_ > 0`, media streams, foreground service workers, pending views and a few
   boosts; with none of them, the process is `kBestEffort`. It is applied through
   `child_process_launcher_->SetProcessPriority` only when the computed value changes.
   `--disable-renderer-backgrounding` acts in `ComputeAppliedPriority`: it forces `visible = true`
   for every renderer (and ignores priority overrides on desktop), which is why the flag works.
6. `base/process/process_win.cc`, `SetPriority`: `kBestEffort` → `IDLE_PRIORITY_CLASS` (what the
   sampler saw: base priority 4), and, with `kUseEcoQoSForBackgroundProcess` (on by default), the
   EcoQoS power-throttling state too, so on Windows 11 the process also runs as "efficiency mode"
   (lower clock, efficiency cores where present). Normal/visible is `NORMAL_PRIORITY_CLASS`.

Two consequences:

- Nothing inside the webview can change this: the priority is driven by the parent's CSS and by
  media streams; a kernel preload or renderer script in the webview has no handle on it.
- Hiding the frame also throttles its JavaScript timers. Chromium's `features.cc` states the
  rule: "1 wake up per second in a background page or hidden cross-origin frame". The webview
  preload's dimension updates and other steps use `setTimeout`, so each hop can cost up to 1 s
  while the frame is hidden. This is a likely reason why the waits with the flag were 1.0 to 1.6 s
  in 7 of 12 pairs while the opacity patch gave 0.0 s in 4 of 6: the flag fixes the CPU priority
  but the frame stays "hidden" for the timer throttling; `opacity: 0` removes both. Not tested;
  the test would be the flag plus `--disable-background-timer-throttling` against the flag alone.

## What md-runbook can do, and workarounds

md-runbook cannot make the cells show earlier: every notebook waits for the hidden webview, and no
extension API changes that. Its own renderer is one 1.5 KB file in the chain; removing it would
save well under 0.1 s.

Checked in the 1.142.0 build on 2026-10-20, looking for a setting or a file shape that avoids the
hidden phase:

- The warmup always runs: `_attachModel` awaits `_warmupWithMarkdownRenderer` unconditionally, and
  the no-view-state path sends the first 5 Markdown cells (`viewCells.filter(kind ===
  Markup).slice(0, 5)`), whatever their edit state or collapsed state. No runbook has fewer than one
  Markdown cell, and even an empty request still round-trips through the Idle process.
- No setting touches it. The only "warmup" in the bundle, `workbench.notebook.viewportWarmup`, is a
  contribution that pre-renders outputs after the view model is attached, i.e. after the wait.
- `argv.json` passes exactly five Chromium switches (`mainImpl.js`): `disable-hardware-acceleration`,
  `force-color-profile`, `disable-lcd-text`, `proxy-bypass-list`, `remote-debugging-port` (Linux also
  `force-renderer-accessibility`, `password-store`). VS Code itself never passes
  `--disable-renderer-backgrounding` or `--disable-background-timer-throttling`.
- The webview process keeps normal priority if any other visible frame lives in the same process.
  The back-layer webviews of one notebook type share an origin (`BackLayerWebView.getOriginStore`),
  so a second runbook opened next to a visible one warms up at normal priority. Extension webviews
  (`createWebviewPanel`) have their own origins and cannot serve as that visible frame.

The one lever an extension has: the extension host is a normal-priority process of the same user,
and Windows lets it raise the priority class of VS Code's sandboxed renderer processes. Checked on
2026-10-20 from Node 22: `os.getPriority(pid)` reads a renderer's class and `os.setPriority(pid, …)`
succeeds on it (tested as a no-op, setting the current value). A "priority nudge" would: while a
runbook editor has no visible range (the state `openTiming.ts` already tracks), list the children of
the main process (`process.ppid` from the extension host) with `Get-CimInstance Win32_Process`, and
set every `--type=renderer` child at priority class Idle to Normal. Chromium re-applies its own value
only when its inputs change, so the nudge holds until the webview is shown, when Chromium sets Normal
anyway. Against it: Windows only (on macOS Chromium uses a task policy that `nice` cannot undo; on
Linux an unprivileged process cannot raise priority); it spawns PowerShell during every slow open
(about 1 s on an idle machine, more under load); it briefly un-backgrounds every hidden renderer of
that VS Code, hidden windows included; it does nothing about the timer throttling; and an extension
that spawns PowerShell to change process priorities is the kind of thing a security review flags.
If ever done, it would be an opt-in `"scope": "machine"` setting, off by default, and the advantage
over the flag would be that it applies however VS Code was started (file association, `code .`,
Start menu), not only from one patched shortcut.

| Option | Who | Effect | Cost |
| --- | --- | --- | --- |
| Start VS Code with `--disable-renderer-backgrounding` (add it to the shortcut's target, after Code.exe) | User | Waits of 0 to 1.6 s instead of 8 to 26 s in the test | Applies only when VS Code starts from that shortcut; `argv.json` does not accept this switch (VS Code passes only 5 Chromium switches through: disable-hardware-acceleration, force-color-profile, disable-lcd-text, proxy-bypass-list, remote-debugging-port); hidden pages and background windows keep full priority |
| Disable the built-in Mermaid extension (`@builtin mermaid` in the Extensions view) | User | About 2 to 3 s less | No Mermaid diagrams in Markdown previews and notebooks |
| Pass `--disable-renderer-backgrounding` in md-runbook's CI integration tests (`test/integration/runElectron.ts`; done 2026-10-20, `MD_RUNBOOK_VSCODE_KEEP_BACKGROUNDING=1` leaves it out) | md-runbook | Likely removes the macOS CI open hangs of 2026-10-19 | None for users; CI's open probe will show any slow open that remains |
| Raise the webview process's priority from the extension host while a runbook waits (see above) | md-runbook, opt-in | Probably the same as the flag, without a shortcut change; untested | Windows only, spawns PowerShell, acts on VS Code's processes behind Chromium's back |
| Document the symptom and the workaround (docs/features, troubleshooting) | md-runbook | Users know it is VS Code and how to avoid it | None |
| Report it to VS Code | md-runbook | A fix for everyone: keep the webview's process at normal priority while it warms up, or show code cells before the Markdown renderers are ready | The issue draft below |

## Issue draft

Filed on 2026-10-20 as [microsoft/vscode#342813](https://github.com/microsoft/vscode/issues/342813)
with the text below. Nothing in it names the user, the company or local paths.

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

The back-layer webview's renderer process runs at Windows priority class **Idle** (plus EcoQoS) while the notebook warms up, because `_warmupWithMarkdownRenderer` sets the webview to `visibility: hidden` until the list is attached. The list is attached only after the webview has loaded the Markdown renderer and every renderer that extends it, so an Idle-priority process on a busy machine blocks the whole editor.

Why `visibility: hidden` does that: the webview is a cross-origin out-of-process iframe. In Blink, `LayoutEmbeddedContent::StyleDidChange` calls `Hide()` on the frame view when `visibility != visible`, the frame reports `FrameVisibility::kNotRendered`, `CrossProcessFrameConnector::OnVisibilityChanged` hides the child widget (`WasHidden`), the process has no visible client left, and `RenderProcessHostImpl::UpdateProcessPriority` sets `kBestEffort`, which on Windows is `IDLE_PRIORITY_CLASS` and EcoQoS (`base/process/process_win.cc`). A hidden cross-origin frame also gets its timers throttled to one wake-up per second. `opacity` is not part of that rule.

**A tested one-line fix:** hide the webview with `opacity: 0` instead of `visibility: hidden` during the warmup. In 6 alternating pairs the wait went from 9.8-62.7 s to 0-1.1 s (table below). Starting VS Code with `--disable-renderer-backgrounding` has nearly the same effect (it keeps the CPU priority, not the timer throttling).

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

With opacity 0 nothing can flash (the element is painted fully transparent), so the reason given in the comment for `visibility: hidden` still holds. The one difference is hit-testing: adding `pointer-events: none` for the same span keeps the transparent webview from taking clicks during the warmup.

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
- [x] Issue filed: [microsoft/vscode#342813](https://github.com/microsoft/vscode/issues/342813)
      (2026-10-20). Watch it for questions from the VS Code team.
- [ ] Try the workaround in the user's own VS Code: add `--disable-renderer-backgrounding` to the
      shortcut, then compare opens with and without it, alternating.
- [x] CI: the integration tests start VS Code with `--disable-renderer-backgrounding` since
      2026-10-20 (`runElectron.ts`); the macOS open probe can still run without it
      (`keep_backgrounding`, `ab`).
- [ ] Optional: offer the fix as a pull request to microsoft/vscode, if the issue gets a go.
- Open: whether the "window detected unresponsive" hang (series 1, open 2) is the same cause or a
  second effect of heavy load; it did not recur in later series.
- [x] The exact Chromium rule that puts the webview's process at Idle: read from Chromium's source
      on 2026-10-20 (section "Why a hidden frame becomes an Idle process").
- [x] Looked for a way around it without patching VS Code (settings, file shape, argv.json, the
      webview's own scripts): none; only the Windows-only priority nudge from the extension host,
      not recommended (section "What md-runbook can do").
- [ ] Optional: test whether the flag plus `--disable-background-timer-throttling` removes the
      residual ~1 s that the flag alone leaves (timer throttling of hidden cross-origin frames).
- Open: how much the same affects macOS and Linux users.
