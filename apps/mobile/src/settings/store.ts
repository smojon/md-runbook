/**
 * App settings that mirror the extension's: how many earlier runs each cell keeps in the file
 * (mdRunbook.output.historySize there, 0 by default: the file only has the latest run), and how
 * output is coloured (mdRunbook.output.colorLevels, stderrInRed and forceColor), and the name the
 * app signs runbooks with, and whether a runbook's `no-confirm` is honoured; and whether runs notify
 * (asked once, at the first Run all); the team library's address; and for run reports
 * (`report-runs:`), the addresses allowed without asking (the extension's
 * mdRunbook.reports.allowedAddresses); and whether Edit as Text highlights while typing on iOS and
 * Android. The signers the app trusts are one list of their own
 * (signing/trust.ts), for the team library and run reports alike.
 */
import { useSyncExternalStore } from 'react';
import { DEFAULT_CONFIRM_PATTERNS } from '@md-runbook/core/confirm';
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
   * Run all opens the launch form first when it has something on it (the extension's
   * mdRunbook.execution.launchForm, on by default).
   */
  launchForm: boolean;
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
   * The team library's server, where Publish to Library… and Remove from Library… send (as VS
   * Code's mdRunbook.library.server), https only. Empty: the origin of the library the app reads.
   */
  libraryServer: string;
  /**
   * The web app's public address (Hosts & settings → Public address of this web app), e.g. a
   * tunnel's https://…trycloudflare.com: share links, QR codes and pairing links use it instead of
   * the address the page was opened from. Empty: the container's MD_RUNBOOK_PUBLIC_URL
   * (settings/runtimeConfig.ts), else the page's own origin.
   */
  publicUrl: string;
  /**
   * Run report addresses sent to without asking (core addressAllowed: a host, an origin, or an
   * address prefix), one per entry.
   */
  reportAddresses: string[];
  /**
   * The risky commands that ask before they run: case-insensitive JavaScript regular expressions
   * (the extension's mdRunbook.execution.confirmPatterns). Undefined: the extension's defaults.
   */
  confirmPatterns?: string[];
  /**
   * More output to redact (mdRunbook.redaction.patterns): JavaScript regular expressions, each
   * whole match becomes [REDACTED]. The built-in patterns always apply too.
   */
  redactionPatterns: string[];
  /** A cell without `timeout=` is stopped after this many seconds; 0: never (mdRunbook.execution.timeoutSeconds). */
  timeoutSeconds: number;
  /** Run all stops at the first step that fails (mdRunbook.execution.stopOnFailure). */
  stopOnFailure: boolean;
  /** A line of a cell was tapped once: the hint that lines have actions is no longer shown. */
  lineHintSeen: boolean;
  /**
   * Each run records where it ran in its output marker: the host's Kubernetes context
   * (`context=`) and the account (`on=`), as VS Code's mdRunbook.output.recordContext. Off by default.
   */
  recordContext: boolean;
  /** Get Started was skipped or done: it no longer shows by itself on the start screen. */
  tourSeen: boolean;
  /**
   * Edit as Text on iOS and Android colours the runbook while you type (ui/RunbookTextInput.tsx),
   * on by default; off: a plain text field. The web app always highlights.
   */
  highlightEditing: boolean;
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
  launchForm: true,
  signerName: '',
  libraryUrl: '',
  libraryServer: '',
  publicUrl: '',
  reportAddresses: [],
  redactionPatterns: [],
  timeoutSeconds: 0,
  stopOnFailure: true,
  lineHintSeen: false,
  recordContext: false,
  tourSeen: false,
  highlightEditing: true,
};

/** The timeouts offered (seconds; 0: none, the extension's default). */
export const TIMEOUTS = [0, 60, 300, 600, 1800, 3600] as const;

/** Saved settings, older ones (only historySize) completed with the defaults. */
const isSaved = (v: unknown): v is Partial<Settings> =>
  typeof v === 'object' && v !== null && typeof (v as Settings).historySize === 'number';

type OutputFlag =
  | 'colorLevels'
  | 'stderrInRed'
  | 'forceColor'
  | 'cloudViews'
  | 'signedLinksOnly'
  | 'keyNeedsUser'
  | 'allowNoConfirm'
  | 'launchForm'
  | 'stopOnFailure'
  | 'lineHintSeen'
  | 'recordContext'
  | 'tourSeen'
  | 'highlightEditing';

/** The strings of a saved list, or undefined when it isn't one. */
const strings = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((a): a is string => typeof a === 'string') : undefined);

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
      launchForm: flag('launchForm'),
      signerName: typeof saved.signerName === 'string' ? saved.signerName : '',
      libraryUrl: typeof saved.libraryUrl === 'string' ? saved.libraryUrl : '',
      libraryServer: typeof saved.libraryServer === 'string' ? saved.libraryServer : '',
      publicUrl: typeof saved.publicUrl === 'string' ? saved.publicUrl : '',
      ...(typeof saved.notifyRuns === 'boolean' ? { notifyRuns: saved.notifyRuns } : {}),
      reportAddresses: strings(saved.reportAddresses) ?? [],
      ...(strings(saved.confirmPatterns) ? { confirmPatterns: strings(saved.confirmPatterns)! } : {}),
      redactionPatterns: strings(saved.redactionPatterns) ?? [],
      timeoutSeconds:
        typeof saved.timeoutSeconds === 'number' && saved.timeoutSeconds >= 0 ? Math.floor(saved.timeoutSeconds) : DEFAULTS.timeoutSeconds,
      stopOnFailure: flag('stopOnFailure'),
      lineHintSeen: flag('lineHintSeen'),
      recordContext: flag('recordContext'),
      tourSeen: flag('tourSeen'),
      highlightEditing: flag('highlightEditing'),
      // `trustedSigners` (allowed_signers text, before the one list) is moved by signing/trust.ts
      // migrateTrustedSigners and left out here: the next save drops it.
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

/** The library server as set ('' when not set: see Settings.libraryServer). */
export const libraryServerSetting = (): string => settings.libraryServer;

/** Set (or with '' remove) the library server's address. */
export function setLibraryServer(url: string): void {
  update({ libraryServer: url.trim().replace(/\/+$/, '') });
}

export function useLibraryServerSetting(): string {
  return useSettings().libraryServer;
}

/** The web app's public address as set ('' when not set: see Settings.publicUrl). */
export const publicUrlSetting = (): string => settings.publicUrl;

/** Set (or with '' remove) the public address; settings/publicAddress.ts checks it first. */
export function setPublicUrl(url: string): void {
  update({ publicUrl: url.trim() });
}

export function usePublicUrlSetting(): string {
  return useSettings().publicUrl;
}

/** Run report addresses allowed without asking. */
export const reportAddresses = (): readonly string[] => settings.reportAddresses;

/** From text: one address per line (or separated by commas or spaces). */
export function setReportAddresses(text: string): void {
  update({ reportAddresses: [...new Set(text.split(/[\s,]+/).filter((a) => a !== ''))] });
}

/** The risky-command patterns as set, or the extension's defaults. */
export const confirmPatterns = (): readonly string[] => settings.confirmPatterns ?? DEFAULT_CONFIRM_PATTERNS;

/** Set the risky-command patterns; undefined: back to the defaults. */
export function setConfirmPatterns(list: readonly string[] | undefined): void {
  if (list === undefined) {
    const { confirmPatterns: _drop, ...rest } = settings;
    settings = rest;
    return update({});
  }
  update({ confirmPatterns: [...list] });
}

/** The extra redaction patterns. */
export const redactionPatterns = (): readonly string[] => settings.redactionPatterns;

export function setRedactionPatterns(list: readonly string[]): void {
  update({ redactionPatterns: [...list] });
}

/** A cell's timeout when it has no `timeout=` (seconds; 0: none). */
export const timeoutSeconds = (): number => settings.timeoutSeconds;

export function setTimeoutSeconds(n: number): void {
  update({ timeoutSeconds: Math.max(0, Math.floor(n)) });
}

/** The hint under a cell's commands has been seen (a line was tapped). */
export function setLineHintSeen(): void {
  update({ lineHintSeen: true });
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
