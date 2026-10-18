# Output history

```sh
cat counter.txt
```
<!-- md-runbook:output start exit=0 ran=2026-10-18T14:22:00+02:00 changed=yes -->
```text
3
```
<!-- md-runbook:output end -->
<details><summary>md-runbook: 2 previous runs</summary>

<!-- md-runbook:output start exit=0 ran=2026-10-18T14:21:00+02:00 changed=yes -->
```text
2
```
<!-- md-runbook:output end -->

<!-- md-runbook:output start exit=1 ran=2026-10-18T14:20:00+02:00 -->
````text
```
1
````
<!-- md-runbook:output end -->

</details>

1. In a list:

   ```bash
   echo step
   ```
   <!-- md-runbook:output start exit=0 ran=2026-10-18T14:23:00+02:00 changed=no -->
   ```text
   step
   ```
   <!-- md-runbook:output end -->

   <details><summary>md-runbook: 1 previous run</summary>

   <!-- md-runbook:output start exit=0 ran=2026-10-18T14:20:00+02:00 -->
   ```text
   step
   ```
   <!-- md-runbook:output end -->

   </details>

A `<details>` that is not right after an output block stays Markdown:

<details><summary>md-runbook: 1 previous run</summary>

<!-- md-runbook:output start exit=0 -->
```text
orphan
```
<!-- md-runbook:output end -->

</details>
