/**
 * The `${input:NAME}` values typed in a runbook's session (VS Code), by name, and whether the name
 * is a secret input. Once secret, a name stays secret for the session: `${input:DB:secret}` in one
 * cell and `${input:DB}` in another are the same value, so both are masked, redacted, and never
 * shown or copied. Before, the cache kept the value only, and the second showed the secret
 * (security review, round 4).
 */
export class InputValues {
  private readonly values = new Map<string, { value: string; secret: boolean }>();

  get(name: string): string | undefined {
    return this.values.get(name)?.value;
  }

  isSecret(name: string): boolean {
    return this.values.get(name)?.secret ?? false;
  }

  /** Keep `value`; `secret` adds to what the name was, never takes it away. */
  set(name: string, value: string, secret: boolean): void {
    this.values.set(name, { value, secret: secret || this.isSecret(name) });
  }

  /** The name is a secret input from now on (its value, if any, too). */
  markSecret(name: string): void {
    const v = this.values.get(name);
    if (v) v.secret = true;
  }
}
