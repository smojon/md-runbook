# Watch a run

Open the sample (**md-runbook: Open Sample Runbook**) and press **Run All**.

- **The Steps view** on the left lists every step by name, with its state and time. Before the
  run, its top line says what the steps will need from you: `Before you run: 1 confirmation · 1
  value to type · 1 step by hand`. Click a count to go there.
- **The status bar** says where the run is: `Step 3/6 · Roll out · 12s left`. Open another file
  and it stays, with the runbook's name; click it to come back.
- **Steps done by hand** (checklist items) wait for you on the cell: **Done**, **Skip** or
  **Stop**, on the cell and on its row. Ticking the box counts as Done.
- **When a step fails**, its cell has **Retry**, **Resume from Here** and **Mark Done**, and the
  Steps view has **Retry step** and **Resume** at the top.
- **Blocks without `estimate=`** learn their usual time from their runs (`est. ~1m15s`), so the
  time left gets better with every run.
- **Looking away?** A notification says when the run ends or waits for you.

Keys: **Ctrl+Alt+S** shows the steps, **Ctrl+Alt+N** goes to the next step, **Ctrl+Alt+R**
resumes, **Ctrl+Alt+D** marks a step done (Ctrl+Cmd on a Mac).
