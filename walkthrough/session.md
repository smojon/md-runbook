# Keep state between cells

By default every cell runs in a new process. Turn on **session mode** (the **Session: off**
button in the notebook toolbar, or `mode: session` in the front matter) and each runbook keeps
one bash and one PowerShell process, so `cd`, variables and logins carry over between cells.
