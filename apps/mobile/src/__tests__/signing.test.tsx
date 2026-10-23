import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { parseManifest, readSignature, signedStatus } from '@md-runbook/core/signing';
import { generateKey } from '@md-runbook/ssh';
import type { KeyPair } from '@microsoft/dev-tunnels-ssh';
import { addRunbook, getRunbook, resetRunbooks } from '../runbooks/store';
import { resetSettings, setSignerName, signerName } from '../settings/store';
import { RunbookView } from '../screens/RunbookView';
import { checkSignInput, cosignCheck, cosignRunbook, signPlan, signRunbook } from '../signing/sign';

jest.mock('expo-router', () => ({
  Link: ({ children }: { children: unknown }) => children,
  Stack: { Screen: () => null },
  router: { push: jest.fn(), back: jest.fn() },
}));
jest.mock('../ssh/transport', () => ({ openTransport: jest.fn(), transportReady: async () => undefined }));
let mockKey: KeyPair | undefined;
jest.mock('../ssh/appKey', () => ({ appKey: async () => mockKey }));

const fence = (info: string, body: string): string => '```' + info + '\n' + body + '\n```\n\n';
const RUNBOOK = '# Restart\n\n' + fence('bash', 'systemctl restart api') + fence('bash', 'kubectl -n ${param:NS} get pods');

beforeAll(async () => {
  mockKey = await generateKey();
});
beforeEach(() => {
  resetRunbooks();
  resetSettings();
});

describe('signing in the app (the logic)', () => {
  it('a first signing asks for a name and the missing patterns; the signature goes into the file', async () => {
    const plan = signPlan(RUNBOOK, 'restart-api.runbook.md');
    expect(plan).toEqual({ name: 'restart-api', version: 1, needs: [{ name: 'NS', kind: 'param' }] });
    const input = { name: 'ops/restart-api', scopes: 'prod', days: '', patterns: {} as Record<string, string> };
    expect(checkSignInput(plan, input)).toEqual(['pattern:NS']);
    expect(checkSignInput(plan, { ...input, name: 'bad name!', scopes: 'a/b', days: 'soon' })).toEqual([
      'name',
      'scopes',
      'days',
      'pattern:NS',
    ]);
    const r = await signRunbook(
      RUNBOOK,
      plan,
      { ...input, days: '30', patterns: { NS: '[a-z-]+' } },
      'me@example.net',
      mockKey!,
      new Date('2026-10-24T00:00:00Z'),
    );
    if (!r.ok) throw new Error(r.errors.join('; '));
    const block = readSignature(r.text)!;
    expect([block.signer, block.signed]).toEqual(['me@example.net', '2026-10-24']);
    const m = parseManifest(block.manifest);
    expect([m.name, m.version, m.scopes, m.patterns, m.expires, m.cells.length]).toEqual([
      'ops/restart-api',
      1,
      ['prod'],
      { NS: '[a-z-]+' },
      '2026-11-23',
      2,
    ]);
    expect(signedStatus(r.text)?.changed).toEqual([]);

    // Signing again keeps the name, scopes and patterns and counts the version up.
    const again = signPlan(r.text, 'whatever.md');
    expect([again.name, again.version, again.needs]).toEqual(['ops/restart-api', 2, []]);
    const r2 = await signRunbook(r.text, again, { name: '', scopes: '', days: '', patterns: {} }, 'me@example.net', mockKey!);
    expect(r2.ok && parseManifest(readSignature(r2.text)!.manifest).version).toBe(2);
  });

  it('what the core refuses comes back as errors (a secret in a signed cell)', async () => {
    const text = '# S\n\n' + fence('bash', 'curl -H "${secret:TOKEN}" https://x');
    const r = await signRunbook(text, signPlan(text, 's.md'), { name: 's', scopes: '', days: '', patterns: {} }, 'me', mockKey!);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors.join('\n')).toMatch(/\$\{secret:TOKEN\} can't be signed/);
  });

  it('co-signing adds a signature to the manifest as it is; refused before signing and after a change', async () => {
    expect(cosignCheck(RUNBOOK)).toEqual({ why: 'unsigned' });
    const plan = signPlan(RUNBOOK, 'r.md');
    const signed = await signRunbook(RUNBOOK, plan, { name: 'r', scopes: '', days: '', patterns: { NS: '[a-z]+' } }, 'author', mockKey!);
    if (!signed.ok) throw new Error(signed.errors.join('; '));
    const reviewer = await generateKey();
    const co = await cosignRunbook(signed.text, 'reviewer@example.net', reviewer);
    if (!co.ok) throw new Error(co.errors.join('; '));
    const block = readSignature(co.text)!;
    expect(block.manifest).toBe(readSignature(signed.text)!.manifest);
    expect(block.cosigners?.map((c) => c.signer)).toEqual(['reviewer@example.net']);
    // Co-signing again replaces the reviewer's earlier signature.
    const twice = await cosignRunbook(co.text, 'reviewer@example.net', reviewer);
    expect(twice.ok && readSignature(twice.text)!.cosigners?.length).toBe(1);
    expect(cosignCheck(signed.text.replace('restart api', 'stop api'))).toEqual({ why: 'changed' });
  });
});

describe('signing in the app (the screen)', () => {
  it('⋯ More → Sign Runbook: the card asks, the app key signs, the banner shows the signer', async () => {
    const r = addRunbook('restart-api.md', RUNBOOK);
    await render(<RunbookView id={r.id} />);
    await act(async () => fireEvent.press(screen.getByTestId('more-actions')));
    // Co-sign needs a signed runbook first.
    expect(screen.getByTestId('action-cosignRunbook').props.accessibilityState).toEqual({ disabled: true });
    await act(async () => fireEvent.press(screen.getByTestId('action-signRunbook')));
    expect(screen.getByTestId('sign-card')).toBeTruthy();
    expect(screen.getByTestId('sign-name').props.value).toBe('restart-api');
    // Nothing is signed until the pattern and the signer's name are given.
    await act(async () => fireEvent.press(screen.getByTestId('sign-go')));
    expect(readSignature(getRunbook(r.id)!.text)).toBeUndefined();
    await act(async () => {
      fireEvent.changeText(screen.getByTestId('sign-pattern:NS'), '[a-z-]+');
      fireEvent.changeText(screen.getByTestId('sign-signer'), 'me@example.net');
    });
    await act(async () => fireEvent.press(screen.getByTestId('sign-go')));
    await waitFor(() => expect(readSignature(getRunbook(r.id)!.text)?.signer).toBe('me@example.net'));
    expect(screen.queryByTestId('sign-card')).toBeNull();
    expect(signerName()).toBe('me@example.net');
    expect(screen.getByText(/restart-api version 1 is signed by me@example\.net \(2 blocks\)/)).toBeTruthy();

    // Co-sign: the card shows what is being signed; the signer's saved name is filled in.
    setSignerName('reviewer@example.net');
    await act(async () => fireEvent.press(screen.getByTestId('more-actions')));
    await act(async () => fireEvent.press(screen.getByTestId('action-cosignRunbook')));
    expect(screen.getByTestId('cosign-summary').props.children).toMatch(/Signed by me@example\.net\. .*these 2 blocks/);
    await act(async () => fireEvent.press(screen.getByTestId('sign-go')));
    await waitFor(() => expect(readSignature(getRunbook(r.id)!.text)?.cosigners?.[0]?.signer).toBe('reviewer@example.net'));
  });
});
