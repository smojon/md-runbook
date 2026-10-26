# Drills and training

A disaster-recovery drill or a training session is a runbook run on purpose, timed, with a
record. md-runbook keeps it apart from production and gives you the evidence afterwards.

## A drill, step by step

1. **Start the drill.** **Start Incident** (Run ▾ in VS Code, ⋯ More in the app), and choose
   *a drill*: a dated copy of the runbook with `incident: DRILL-…` and `drill: true` in its front
   matter. Every run then records who ran it (`by=`) and where (`on=`), and every attempt is
   kept, failed ones included.
2. **Set the target.** `rto: 30m` in the runbook's front matter (seconds, `90s`, `30m`,
   `1h30m`): the report says whether the drill met it, from the first run to *resolved* (or the
   last event).
3. **Practise on a practice server.** In the app, **⋯ More → Practice on a Host…** (or
   `practice: training-1` in the front matter): every cell runs on that host, whatever a cell's
   `host=` says, so a drill can't reach production. If the app has no host of that name, nothing
   runs. In VS Code cells run on your machine: run drills from a practice machine.
4. **Mark the milestones.** **Add Note** with *detected*, *mitigated* and *resolved*, plus
   whatever was decided ("failover approved by the DBA").
5. **Close it.** **Export Report** gives the **Drill record**: start, end, time to mitigate and to
   resolve, the RTO met or missed, failed attempts, who did what, and the timeline. **Sign Run
   Record** vouches for it, and the drill lead co-signs (the same command, on a signed record).

## Training

The same setup, with the trainee running the steps on a practice server:

- **Checks** (`expect=`, `expect-exit=`) tell the trainee at once whether a step did what it
  should ([checks](checks.md)).
- **Explain Output** (the assistant) explains an output they don't understand ([AI](ai.md)).
- **Step through** runs a block one command at a time, with a pause before each.

```yaml
---
incident: DRILL-2026-Q4-failover
drill: true
rto: 30m
practice: training-1
params:
  - SERVICE: api
---
```
