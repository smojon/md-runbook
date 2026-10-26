/**
 * App settings that mirror the extension's: how many earlier runs each cell keeps in the file
 * (mdRunbook.output.historySize there, 0 by default: the file only has the latest run), and how
 * output is coloured (mdRunbook.output.colorLevels, stderrInRed and forceColor), and the name the
 * app signs runbooks with.
 */
import { useSyncExternalStore } from 'react';
import { getJson, setJson } from '../storage/kv';

const KEY = 'settings.v1';
export const HISTORY_SIZES = [0, 1, 3, 5, 10] as const;

export interface Settings {
  historySize: number;
  /** Log levels in their colours (ERROR red, WARN yellow, …). */
  colorLevels: boolean;
  /** What a cell writes to stderr in red. */
  stderrInRed: boolean;
  /** Cells get FORCE_COLOR=1 and CLICOLOR_FORCE=1, so programs colour their output. */
  forceColor: boolean;
  /** AWS / Google Cloud JSON output: a list of the resources with console links (mdRunbook.output.cloudViews). */
  cloudViews: boolean;
  /** Runbooks from links (QR codes, pager alerts, mails) open only when signed; off: unsigned ones open with a warning. */
  signedLinksOnly: boolean;
  /**
   * Who signs runbooks on this device (the signature block's signer=, e.g. an e-mail address),
   * and the principal suggested for the servers' allowed_signers. Empty until set.
   */
  signerName: string;
}

const DEFAULTS: Settings = {
  historySize: 0,
  colorLevels: true,
  stderrInRed: true,
  forceColor: false,
  cloudViews: true,
  signedLinksOnly: false,
  signerName: '',
};

/** Saved settings, older ones (only historySize) completed with the defaults. */
const isSaved = (v: unknown): v is Partial<Settings> =>
  typeof v === 'object' && v !== null && typeof (v as Settings).historySize === 'number';

type OutputFlag = 'colorLevels' | 'stderrInRed' | 'forceColor' | 'cloudViews' | 'signedLinksOnly';

let settings: Settings = DEFAULTS;
const listeners = new Set<() => void>();
const emit = (): void => listeners.forEach((l) => l());

let loaded: Promise<void> | undefined;

/** Read the saved settings, once (later calls wait for the same read). */
export function loadSettings(): Promise<void> {
  return (loaded ??= readSettings());
}

async function readSettings(): Promise<void> {
  const saved = await getJson(KEY, isSaved);
  if (saved) {
    const flag = (k: OutputFlag): boolean => (typeof saved[k] === 'boolean' ? saved[k] : DEFAULTS[k]);
    settings = {
      historySize: saved.historySize ?? 0,
      colorLevels: flag('colorLevels'),
      stderrInRed: flag('stderrInRed'),
      forceColor: flag('forceColor'),
      cloudViews: flag('cloudViews'),
      signedLinksOnly: flag('signedLinksOnly'),
      signerName: typeof saved.signerName === 'string' ? saved.signerName : '',
    };
  }
  emit();
}

function update(next: Partial<Settings>): void {
  settings = { ...settings, ...next };
  emit();
  void setJson(KEY, settings).catch(() => undefined);
}

export const historySize = (): number => settings.historySize;
export const outputSettings = (): Settings => settings;

export function setHistorySize(n: number): void {
  update({ historySize: Math.max(0, Math.min(10, Math.floor(n))) });
}

export function setOutputSetting(key: OutputFlag, on: boolean): void {
  update({ [key]: on });
}

export const signerName = (): string => settings.signerName;

export function setSignerName(name: string): void {
  update({ signerName: name.trim() });
}

export function useSignerName(): string {
  return useSettings().signerName;
}

function useSettings(): Settings {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => settings,
  );
}

export function useHistorySize(): number {
  return useSettings().historySize;
}

export function useOutputSettings(): Settings {
  return useSettings();
}

/** Tests. */
export function resetSettings(): void {
  settings = DEFAULTS;
  loaded = undefined;
  emit();
}
