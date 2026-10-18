# Run steps and keep their output

- **▶** on a cell runs it; **Run All** runs the whole runbook and stops at the first failure.
- Output streams in live. When you save, it is written into the `.md` file below the block:

````markdown
```bash
kubectl get pods
```
<!-- md-runbook:output start exit=0 ran=2026-10-19T09:12:00+02:00 duration=0.8s -->
```text
NAME        READY   STATUS
web-7c9d…   1/1     Running
```
<!-- md-runbook:output end -->
````

- The status bar shows progress (`4/7`); **Resume Run** carries on from the first failed or
  pending step. Secrets are redacted before anything is written.
