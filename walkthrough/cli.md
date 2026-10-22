# Problems, reports and the command line

- **Problems:** mistakes such as a misspelled cell option (`retires=3`) or a `${out:NAME}` with
  nothing captured are underlined while you edit and listed in the **Problems** panel.
- **Reports:** **Export Report (HTML)** writes every step with its result and output into one
  file; **Export Report (PDF)** prints it with the Chrome or Edge you have.
- **Command line:** the same runbook runs without VS Code, in CI or on a schedule:

```sh
md-runbook lint runbooks/*.md
md-runbook run deploy.md --param TARGET=staging --report report.html --junit junit.xml
```

On GitHub Actions: `uses: smojon/md-runbook@v0.8.0`. Section 17 of the sample runbook tries all
three.
