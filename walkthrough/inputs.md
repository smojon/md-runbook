# Secrets, inputs and parameters

Write placeholders instead of values; they are passed as environment variables, never pasted
into the script, and the file keeps the placeholder:

```bash
curl -H "Authorization: Bearer ${secret:API_TOKEN}" "https://${param:HOST}/health"
psql "postgresql://app:${input:DB_PASSWORD}@db/app"
```

- `${secret:NAME}`: the OS keychain (**md-runbook: Set Secret**)
- `${input:NAME}`: asked once per session
- `${param:NAME}`: a parameter declared in the front matter, with a default
