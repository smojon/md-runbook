# Existing outputs

```sh
echo hello
```
<!-- md-runbook:output start exit=0 ran=2026-10-18T14:20:00+02:00 -->
```text
hello
```
<!-- md-runbook:output end -->

With a blank gap and a failing command:

```bash
false
```

<!-- md-runbook:output start exit=1 ran=2026-10-18T14:21:00+02:00 -->
```text
```
<!-- md-runbook:output end -->

Output that itself contains fences:

```sh
printf '```\ncode\n```\n'
```
<!-- md-runbook:output start exit=0 ran="2026-10-18T14:22:00+02:00" shell=bash -->
````text
```
code
```
<!-- md-runbook:output end -->
````
<!-- md-runbook:output end -->

1. A list item with an indented block:

   ```pwsh
   Write-Output 'in a list'
   ```
   <!-- md-runbook:output start exit=0 ran=2026-10-18T14:23:00+02:00 -->
   ```text
   in a list
   ```
   <!-- md-runbook:output end -->

An orphan output block after a non-runnable fence stays markdown:

```json
{}
```
<!-- md-runbook:output start exit=0 ran=2026-10-18T14:24:00+02:00 -->
```text
orphan
```
<!-- md-runbook:output end -->

A malformed output block (no end marker) stays markdown:

```sh
echo broken
```
<!-- md-runbook:output start exit=0 -->
```text
broken
```

The end.
