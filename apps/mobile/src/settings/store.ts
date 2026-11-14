/**
 * App settings that mirror the extension's: how many earlier runs each cell keeps in the file
 * (mdRunbook.output.historySize there, 0 by default: the file only has the latest run), and how
 * output is coloured (mdRunbook.output.colorLevels, stderrInRed and forceColor), and the name the
 * app signs runbooks with, and whether a runbook's `no-confirm` is honoured; and whether runs notify
 * (asked once, at the first Run all); and for run reports (`report-runs:`), the addresses allowed
 * without asking (the extension's mdRunbook.reports.allowedAddresses) and the signers whose
 * runbook signatures the app trusts (allowed_signers lines).
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
  /** The app's key asks for Face ID, Touch ID, a fingerprint or the screen lock on every use (made with that flag in the hardware). */
  keyNeedsUser: boolean;
  /**
   * A cell's `no-confirm` option is honoured (the extension's mdRunbook.execution.allowNoConfirmOption):
   * off, a runbook can't switch off the question before a risky cell.
   */
  allowNoConfirm: boolean;
  /**
   * Who signs runbooks on this device (the signature block's signer=, e.g. an e-mail address),
   * and the principal suggested for the servers' allowed_signers. Empty until set.
   */
  signerName: string;
  /**
   * Notifications when a run is done, fails or waits for you while the app is in the background
   * (the web: the tab is hidden). Undefined until asked (the first Run all offers them); false
   * after Not now or a refused permission, and then never offered again (the setting turns them on).
   */
  notifyRuns?: boolean;
  /**
   * The team library's address (runbooks/library.ts), an https URL of a folder such as
   * https://runbooks.example.net/runbooks/. Empty: on the web the app's own /runbooks/, on the
   * phones no library.
   */
  libraryUrl: string;
  /**
   * Run report addresses sent to without asking (core addressAllowed: a host, an origin, or an
   * address prefix), one per entry.
   */
  reportAddresses: string[];
  /**
   * allowed_signers lines (OpenSSH's format): the signers whose runbook signatures this app trusts.
   * Only a runbook signed by one of them can make reporting required or signed (core reportPlan).
   */
  trustedSigners: string;
}

const DEFAULTS: Settings = {
  historySize: 0,
  colorLevels: true,
  stderrInRed: true,
  forceColor: false,
  cloudViews: true,
  signedLinksOnly: false,
  keyNeedsUser: false,
  allowNoConfirm: false,
  signerName: '',
  libraryUrl: '',
  reportAddresses: [],
  trustedSigners: '',
};

/** Saved settings, older ones (only historySize) completed with the defaults. */
const isSaved = (v: unknown): v is Partial<Settings> =>
  typeof v === 'object' && v !== null && typeof (v as Settings).historySize === 'number';

type OutputFlag = 'colorLevels' | 'stderrInRed' | 'forceColor' | 'cloudViews' | 'signedLinksOnly' | 'keyNeedsUser' | 'allowNoConfirm';

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
      keyNeedsUser: flag('keyNeedsUser'),
      allowNoConfirm: flag('allowNoConfirm'),
      signerName: typeof saved.signerName === 'string' ? saved.signerName : '',
      libraryUrl: typeof saved.libraryUrl === 'string' ? saved.libraryUrl : '',
      ...(typeof saved.notifyRuns === 'boolean' ? { notifyRuns: saved.notifyRuns } : {}),
      reportAddresses: Array.isArray(saved.reportAddresses) ? saved.reportAddresses.filter((a): a is string => typeof a === 'string') : [],
      trustedSigners: typeof saved.trustedSigners === 'string' ? saved.trustedSigners : '',
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

/** Whether runs notify: undefined until asked (see Settings.notifyRuns). */
export const notifyRuns = (): boolean | undefined => settings.notifyRuns;

export function setNotifyRuns(on: boolean): void {
  update({ notifyRuns: on });
}

export function setSignerName(name: string): void {
  update({ signerName: name.trim() });
}

/** The team library's address as set ('' when not set: see Settings.libraryUrl). */
export const libraryUrlSetting = (): string => settings.libraryUrl;

/** Set (or with '' remove) the team library's address; runbooks/library.ts checks it first. */
export function setLibraryUrl(url: string): void {
  update({ libraryUrl: url.trim() });
}

export function useLibraryUrlSetting(): string {
  return useSettings().libraryUrl;
}

/** Run report addresses allowed without asking. */
export const reportAddresses = (): readonly string[] => settings.reportAddresses;

/** From text: one address per line (or separated by commas or spaces). */
export function setReportAddresses(text: string): void {
  update({ reportAddresses: [...new Set(text.split(/[\s,]+/).filter((a) => a !== ''))] });
}

/** The allowed_signers lines of the signers this app trusts. */
export const trustedSigners = (): string => settings.trustedSigners;

export function setTrustedSigners(text: string): void {
  update({ trustedSigners: text.trim() });
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
