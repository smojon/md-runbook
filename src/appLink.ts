/** Links that open a runbook in the md-runbook app (Open in the App). No vscode import: unit-tested. */

/** The web page of a file in a repository, from its remote URL; undefined for hosts it doesn't know. */
export function fileWebUrl(remote: string, ref: string, relPath: string): string | undefined {
  const r = remote.trim().replace(/\.git$/, '');
  // git@github.com:owner/repo, ssh://git@host/owner/repo, https://host/owner/repo
  const m = /^(?:git@([^:]+):|ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/|https:\/\/(?:[^@/]+@)?([^/]+)\/)(.+)$/.exec(r);
  if (!m) return undefined;
  const host = (m[1] ?? m[2] ?? m[3])!.toLowerCase();
  const repo = m[4]!;
  // Each part encoded, the slashes kept (a branch like feature/x, folders).
  const seg = (s: string): string => s.split(/[\\/]/).map(encodeURIComponent).join('/');
  const file = seg(relPath);
  if (host === 'github.com') return `https://github.com/${repo}/blob/${seg(ref)}/${file}`;
  if (host.includes('gitlab')) return `https://${host}/${repo}/-/blob/${seg(ref)}/${file}`;
  return undefined;
}

/** The app's link for a runbook at `url`. */
export const appLink = (url: string): string => `mdrunbook://open?url=${encodeURIComponent(url)}`;
