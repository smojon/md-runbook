/**
 * @md-runbook/core/node: the Node-only part of the core (running local processes and shells,
 * context commands, the approval policy). Used by the VS Code extension and the CLI, never by the
 * app.
 */
export { RunOptions, killTree, runProcess } from './runner';
export { executeCell, nodeShellEnv } from './execute';
export { expandWindowsVars, freshenPath, mergePath, parseRegQuery, registryPath } from './freshPath';
export { gitBashCandidates, pwshWrapper, resolveShell } from './shell';
