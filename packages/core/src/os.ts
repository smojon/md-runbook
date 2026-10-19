/**
 * Per-OS alternatives: `os=windows`, `os=linux,macos` on a code block. A block for another OS is
 * not run, and blocks with `os=` that follow each other (only Markdown between them, no OS
 * twice) are alternatives of one step.
 */

export type OsName = 'windows' | 'linux' | 'macos';

const ALIASES: Record<string, OsName> = {
  windows: 'windows',
  win: 'windows',
  win32: 'windows',
  linux: 'linux',
  macos: 'macos',
  mac: 'macos',
  osx: 'macos',
  darwin: 'macos',
};

const LABEL: Record<OsName, string> = { windows: 'Windows', linux: 'Linux', macos: 'macOS' };

/** `windows,linux` → the OS names, or an error message for an unknown name. */
export function parseOsList(value: string): OsName[] | string {
  const names: OsName[] = [];
  for (const raw of value.split(',').map((s) => s.trim().toLowerCase())) {
    const name = ALIASES[raw];
    if (!name) return `unknown OS "${raw}" (expected windows, linux or macos)`;
    if (!names.includes(name)) names.push(name);
  }
  return names.length > 0 ? names : 'expected windows, linux or macos';
}

/** The OS this runs on; other Unix-like systems count as linux. */
export function currentOs(platform: NodeJS.Platform = process.platform): OsName {
  return platform === 'win32' ? 'windows' : platform === 'darwin' ? 'macos' : 'linux';
}

/** "Linux, macOS", for messages. */
export function osLabel(names: readonly OsName[]): string {
  return names.map((n) => LABEL[n]).join(', ');
}

export interface OsCell {
  kind: 'code' | 'markup';
  /** The block's `os=` list, if it has one. */
  os?: readonly OsName[];
}

/** Where a block with `os=` belongs: its group of alternatives, and whether it is for this OS. */
export interface OsSlot {
  group: number;
  active: boolean;
}

/** Group the alternatives of a runbook's cells; undefined for cells without `os=`. */
export function osGroups(cells: readonly OsCell[], here: OsName = currentOs()): (OsSlot | undefined)[] {
  let group = -1;
  let seen = new Set<OsName>();
  let open = false;
  return cells.map((c, i) => {
    if (c.kind === 'markup') return undefined;
    if (!c.os) {
      open = false;
      return undefined;
    }
    if (!open || c.os.some((n) => seen.has(n))) {
      group = i;
      seen = new Set();
    }
    open = true;
    for (const n of c.os) seen.add(n);
    return { group, active: c.os.includes(here) };
  });
}
