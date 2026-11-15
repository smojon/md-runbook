# Keep state between cells

By default every cell runs in a new process. **Session mode** keeps one bash and one PowerShell
process per runbook, so `cd`, variables and logins carry over between cells. Turn it on with the
**Session: off** button in the notebook toolbar, or `mode: session` in the front matter.
