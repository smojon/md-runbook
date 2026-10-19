/** A small runbook bundled with the app, until runbooks can be opened from files and Git. */
export const SAMPLE_RUNBOOK = `# Check a web server

Steps to check that the server answers. Run each block on the server over SSH.

- [ ] Log in to the server

\`\`\`bash
uptime
df -h /
\`\`\`

<!-- md-runbook:output start exit=0 ran=2026-10-19T09:00:00+02:00 -->
\`\`\`text
 09:00:00 up 12 days,  3:04,  1 user,  load average: 0.08, 0.03, 0.01
Filesystem      Size  Used Avail Use% Mounted on
/dev/sda1        40G   11G   27G  29% /
\`\`\`
<!-- md-runbook:output end -->

## Service

\`\`\`bash expect=/active \\(running\\)/
systemctl status nginx --no-pager | head -3
\`\`\`
`;

export interface BundledRunbook {
  id: string;
  title: string;
  text: string;
}

export const BUNDLED: readonly BundledRunbook[] = [{ id: 'sample', title: 'Check a web server', text: SAMPLE_RUNBOOK }];
