/**
 * Values the test-only commands pass (`mdRunbook._test.setParameters`, `_test.setInputs`). A
 * public command takes no values, so a command link can't set any; these take them only under the
 * extension test runner (secrets.ts isTestMode), whoever calls them.
 */

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `NAME → value` from a test command's argument: refused outside test mode; names and values checked. */
export function testOnlyValues(values: unknown, testMode: boolean): Record<string, string> {
  if (!testMode) throw new Error('md-runbook: values are set this way only by the extension test runner');
  if (typeof values !== 'object' || values === null || Array.isArray(values)) throw new Error('md-runbook: expected { NAME: "value" }');
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) if (NAME_RE.test(k) && typeof v === 'string') out[k] = v;
  return out;
}
