/**
 * @md-runbook/ssh: runs runbook cells in a persistent shell on a remote host over SSH. Pure
 * TypeScript, no platform code: the caller brings the transport (`@md-runbook/ssh/node` has a
 * TCP one for Node; the app has React Native and relay ones).
 */
export {
  CellCommandOptions,
  GateInfo,
  RemotePlatform,
  SHELL_COMMAND,
  WINDOWS_SHELL_COMMAND,
  cellCommand,
  gateBanner,
  gateLoadCommand,
  gateParamCommand,
  gateRawCommand,
  gateRunCommand,
  helloCommand,
  markerFor,
  psq,
  randomId,
  signedReply,
  sq,
  stopCommand,
  windowsCellCommand,
  windowsHelloCommand,
  windowsStopCommand,
} from './command';
export { ConnectOptions, RemoteRunOptions, RemoteRunResult, RemoteShell, ShellEndedError, wrongPlatform } from './remoteShell';
export { RemoteSession, SessionRunResult, SignedRun } from './session';
export { generateKey, hostKeyId, importPrivateKey, privateKeyPem, publicKeyLine } from './keys';
export { ECDSA_P256, ExternalAwareEcdsaP256, ExternalKeyPair, ExternalP256Key, derToRs } from './externalKey';
