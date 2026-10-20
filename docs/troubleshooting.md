# Troubleshooting

## A runbook opens slowly or stays empty

**Symptom:** the runbook's tab opens with its toolbar, but no cell shows for 10 seconds to a minute,
sometimes not at all; a progress bar runs at the top. It happens when the computer is busy (an
antivirus scan, an installer, a build).

**Cause:** VS Code shows a notebook's cells only after the notebook's hidden web page has loaded
VS Code's Markdown renderers, and while that page is hidden, Chromium runs it at the lowest CPU
priority. On a busy computer it gets almost no CPU. This is VS Code's behaviour for every notebook,
not md-runbook's; it was measured in detail in
[investigations/notebook-open-slow.md](investigations/notebook-open-slow.md).

md-runbook notices a slow open and says so once, with a link to this page ("Don't Show Again"
turns that off).

**Workaround:** start VS Code with `--disable-renderer-backgrounding`. In tests, the wait went from
8 to 64 seconds down to 0 to 2 seconds.

- **Windows:** right-click the VS Code shortcut (Start menu or taskbar: right-click, then right-click
  "Visual Studio Code" again) → **Properties** → at the end of **Target**, after
  `...\Code.exe"`, add a space and `--disable-renderer-backgrounding` → **OK**. Close every VS Code
  window and start it from that shortcut.
- **macOS and Linux:** start VS Code from a terminal with
  `code --disable-renderer-backgrounding`, or make that an alias.

The switch only takes effect when VS Code starts; VS Code's `argv.json` does not accept it. It keeps
hidden pages and background windows of VS Code at normal priority, which costs a little CPU when
VS Code is in the background.

**Also helps a little:** disabling the built-in Mermaid extension (Extensions view, search
`@builtin mermaid`, **Disable**) saves 2 to 3 seconds per open, but turns off Mermaid diagrams in
Markdown previews and notebooks.
