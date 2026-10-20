# Patches a copy of VS Code 1.142.0: during the notebook's markdown warmup the back-layer webview is
# made transparent (opacity 0) instead of invisible (visibility hidden), so Chromium should not treat
# its frame as hidden and lower its process priority.  Usage: python patch.py <workbench.desktop.main.js>
import sys

p = sys.argv[1]
s = open(p, encoding='utf-8').read()
pairs = [
    ('this.logService.debug("NotebookEditorWidget","warmup - webview resolved"),this._webview.element.style.visibility="hidden",',
     'this.logService.debug("NotebookEditorWidget","warmup - webview resolved"),this._webview.element.style.opacity="0",'),
    ('this._webview.element.style.visibility="visible",this.logService.debug("NotebookEditorWidget","warmup - list view model attached, set to visible")',
     'this._webview.element.style.opacity="",this.logService.debug("NotebookEditorWidget","warmup - list view model attached, set to visible")'),
]
for old, new in pairs:
    assert s.count(old) == 1, (old[:60], s.count(old))
    s = s.replace(old, new)
open(p, 'w', encoding='utf-8', newline='').write(s)
print('patched')
