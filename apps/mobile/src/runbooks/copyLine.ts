/**
 * Copy Line with Values, as VS Code's (lineRuns.ts copyLine): a command with the values a run
 * would use now filled in. Secrets stay references: `${secret:…}`, a masked or `:secret` input,
 * an input named like a secret (`…_TOKEN`) and a value captured as secret. So does a value not
 * known yet (asked when it runs).
 */
import type { Captured } from '@md-runbook/core/checks';
import { looksSecret } from '@md-runbook/core/secrets';

/** The values a run of the line would use now. */
export interface LineValues {
  /** `${param:NAME}` values typed for the runbook. */
  params: Readonly<Record<string, string>>;
  /** The front matter's defaults (none for a signed cell: it doesn't take them). */
  defaults: Readonly<Record<string, string>>;
  /** `${input:NAME}` values typed this session. */
  inputs: Readonly<Record<string, { value: string; masked: boolean }>>;
  /** `${out:NAME}` values captured this session. */
  captures: Readonly<Record<string, Captured>>;
}

// The pattern of VS Code's copyLine (core's reference syntax).
const REF = /\$\{(secret|input|param|out):([A-Za-z_][A-Za-z0-9_]*)(:secret)?\}/g;

/** Whether the command has `${…}` references (VS Code then says Copy with values). */
export function hasRefs(command: string): boolean {
  return new RegExp(REF.source).test(command);
}

/** `command` with its values filled in, and the references left as they are (in order, once each). */
export function withValues(command: string, v: LineValues): { text: string; left: string[] } {
  const left = new Set<string>();
  const text = command.replace(REF, (whole: string, kind: string, name: string, mod: string | undefined) => {
    const value = valueOf(kind, name, mod !== undefined, v);
    if (value !== undefined) return value;
    left.add(whole);
    return whole;
  });
  return { text, left: [...left] };
}

function valueOf(kind: string, name: string, secretMod: boolean, v: LineValues): string | undefined {
  switch (kind) {
    case 'param': {
      if (secretMod) return undefined; // `:secret` is only valid on inputs
      const typed = v.params[name];
      return typed !== undefined && typed !== '' ? typed : v.defaults[name];
    }
    case 'input': {
      const typed = v.inputs[name];
      return typed && !typed.masked && !secretMod && !looksSecret(name) ? typed.value : undefined;
    }
    case 'out': {
      const c = v.captures[name];
      return c && !c.secret && !secretMod ? c.value : undefined;
    }
    default:
      return undefined; // ${secret:…}: never copied
  }
}
