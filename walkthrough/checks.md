# Check results, wait, pass values on

Cell options after the language word:

````markdown
```bash retry=20 every=15s expect="successfully rolled out"
kubectl rollout status deploy/web --timeout=10s
```

```bash capture="POD:/^(web-\S+)/m"
kubectl get pods -o name | sed 's|pod/||'
```

```bash
kubectl logs "${out:POD}" --tail=20
```
````

- `expect=` / `expect-not=` / `expect-exit=` fail a step whose output is wrong.
- `retry=` runs it again until it passes.
- `capture=` keeps a value for later cells as `${out:NAME}`.
