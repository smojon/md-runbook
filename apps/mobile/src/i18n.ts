/**
 * All user-visible text comes from here, so translations can be added later without touching the
 * screens (ESLint's react/jsx-no-literals rejects text written in a screen). English only for
 * now; a second language would add a catalog per language and pick one with expo-localization.
 */
const en = {
  appTitle: 'md-runbook',
  commands: (n: number) => (n === 1 ? '1 command' : `${n} commands`),
  coreOk: 'Core OK',
  coreFailed: (why: string) => `Core check failed: ${why}`,
  notFound: 'Runbook not found',
  openRunbook: 'Open a runbook…',
  fileTooLarge: (name: string) => `${name} is larger than 2 MB and was not opened`,
  fileUnreadable: (name: string, why: string) => `${name} could not be read: ${why}`,
  outputExit: (exit: string) => `Output · exit ${exit}`,
  output: 'Output',

  // Hosts
  hosts: 'Hosts',
  hostsTitle: 'Hosts',
  addHost: 'Add a host',
  noHosts: 'No hosts yet. Add one to run cells over SSH.',
  newHostTitle: 'New host',
  editHostTitle: 'Host',
  hostName: 'Name',
  hostNamePlaceholder: 'web-1',
  hostHostname: 'Host name or IP',
  hostHostnamePlaceholder: 'server.example.net',
  hostPort: 'Port',
  hostUsername: 'User',
  hostUsernamePlaceholder: 'deploy',
  save: 'Save',
  deleteHost: 'Delete this host',
  forgetHostKey: 'Forget the trusted host key',
  hostKeyTrusted: 'Host key trusted',
  hostKeyNotTrusted: 'Host key not trusted yet',
  hostErrors: {
    nameMissing: 'Give the host a name.',
    hostnameMissing: 'Enter the host name or IP address (no spaces).',
    portInvalid: 'The port must be a number from 1 to 65535.',
    usernameMissing: 'Enter the user to log in as (no spaces).',
  },

  // The app's key
  appKeyTitle: "This app's SSH key",
  appKeyHelp: 'The key was made on this device and stays here. Add its public key to ~/.ssh/authorized_keys on each host:',
  appKeyLoading: 'Making the key…',
  appKeyFailed: (why: string) => `The key could not be made: ${why}`,
  appKeyStorage: {
    hardware: "The private key was made in this device's secure hardware and cannot be read out, not even by the app.",
    keystore: "The private key is in this device's keystore and never handed to the app.",
    'secure-store': "The private key is kept in this device's secure storage.",
    browser: "The private key is kept in this browser's storage for this site.",
  },
  copy: 'Copy',
  copied: 'Copied',

  // Relay (web)
  relayTitle: 'Relay (web)',
  relayHelp: 'A browser cannot open SSH connections itself: the web app goes through your relay, which only sees encrypted traffic.',
  relayUrl: 'Relay address',
  relayUrlPlaceholder: 'wss://relay.example.net',
  relayToken: 'Relay token',
  relaySaved: 'Relay saved',
  relayNotConfigured: 'No relay is configured: set its address and token under Hosts.',
  relayRefused: (url: string) => `The relay at ${url} refused the connection (address, token or target not allowed).`,
  relayUnreachable: (url: string) => `The relay at ${url} did not answer (address, network, or the page's origin not allowed).`,
  relayTooOld: (url: string) => `The relay at ${url} is older than this app: update it.`,
  relayTooNew: (url: string) => `The relay at ${url} is newer than this app: update the app.`,

  // Running cells
  runOn: 'Run on',
  addHostToRun: 'Add a host to run cells',
  run: 'Run',
  stop: 'Stop',
  running: 'Running…',
  busy: 'Another cell is running',
  cellGone: 'The cell is no longer in the runbook',
  notRunnable: {
    language: (_detail?: string) => 'Only bash and sh cells run over SSH',
    os: (_detail?: string) => 'For Windows · not run over SSH',
    skip: (_detail?: string) => 'Skipped (skip option)',
    invalid: (detail?: string) => `Invalid options: ${detail ?? ''}`,
  },
  timedOutNote: (seconds: number) => `[md-runbook] timed out after ${seconds}s; the cell's processes were stopped`,
  checkFailedNote: (why: string) => `[md-runbook] check failed: ${why}`,
  lineFailedNote: (lines: string) => `[md-runbook] line ${lines} failed; the lines after it were not run`,
  cellChanged: 'The cell changed while it ran: its output was not written',

  // Code cells (the VS Code-like view)
  runCell: 'Run cell',
  stopCell: 'Stop',
  runLine: (lines: string) => `Run line ${lines}`,
  runLinesTo: (lines: string) => `Run lines ${lines}`,
  runLinesFrom: (lines: string) => `Run lines ${lines}`,
  checkLine: 'Check',
  uncheckLine: 'Uncheck',
  runChecked: (n: number) => (n === 1 ? 'Run 1 checked line' : `Run ${n} checked lines`),
  lineActions: (lines: string) => `Line ${lines}`,
  closeActions: 'Close',
  ranOk: 'Succeeded',
  ranFailed: 'Failed',
  runningLine: (lines: string) => `Running line ${lines}…`,
  newShell: 'A new shell was opened: the folder and variables of earlier cells are gone.',
  trustTitle: (host: string) => `First connection to ${host}`,
  trustChangedTitle: (host: string) => `The host key of ${host} has changed`,
  trustBody:
    'Compare this fingerprint with the one shown on the server (ssh-keygen -lf /etc/ssh/ssh_host_ecdsa_key.pub) before trusting it.',
  trustChangedBody: 'Another machine may be answering at this address. Trust the new key only if you know why it changed.',
  trustAccept: 'Trust and run',
  trustDecline: 'Cancel',
} as const;

export type Strings = typeof en;
export const t: Strings = en;
