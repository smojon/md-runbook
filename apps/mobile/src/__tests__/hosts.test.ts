import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  addHost,
  getHost,
  hostLabel,
  loadHosts,
  pinHostKey,
  removeHost,
  resetHosts,
  setHostPlatform,
  updateHost,
  validateHost,
} from '../hosts/store';
import { t } from '../i18n';

const input = { name: ' web-1 ', hostname: 'web1.example.net ', port: 22, username: 'deploy' };

beforeEach(async () => {
  resetHosts();
  await AsyncStorage.clear();
});

describe('hosts', () => {
  it('adds, trims, labels and saves', async () => {
    const h = addHost(input);
    expect(h).toMatchObject({ name: 'web-1', hostname: 'web1.example.net', port: 22, username: 'deploy' });
    expect(hostLabel(h)).toBe('deploy@web1.example.net');
    expect(hostLabel({ ...h, port: 2222 })).toBe('deploy@web1.example.net:2222');
    await Promise.resolve();
    const saved = JSON.parse((await AsyncStorage.getItem('hosts.v1')) ?? '[]') as unknown[];
    expect(saved).toHaveLength(1);
    expect(JSON.stringify(saved)).not.toContain('PRIVATE');
  });

  it('loads what was saved and ignores garbage', async () => {
    await AsyncStorage.setItem(
      'hosts.v1',
      JSON.stringify([{ id: 'a', name: 'A', hostname: 'a', port: 22, username: 'u', hostKey: 'ecdsa-sha2-nistp256 AAAA' }]),
    );
    await loadHosts();
    expect(getHost('a')?.hostKey).toBe('ecdsa-sha2-nistp256 AAAA');
    resetHosts();
    await AsyncStorage.setItem('hosts.v1', '{"not":"a list"}');
    await loadHosts();
    expect(getHost('a')).toBeUndefined();
  });

  it('keeps the trusted key across a rename but not across an address change', () => {
    const h = addHost(input);
    pinHostKey(h.id, 'ecdsa-sha2-nistp256 KEY');
    updateHost(h.id, { ...input, name: 'renamed' });
    expect(getHost(h.id)).toMatchObject({ name: 'renamed', hostKey: 'ecdsa-sha2-nistp256 KEY' });
    updateHost(h.id, { ...input, port: 2222 });
    expect(getHost(h.id)?.hostKey).toBeUndefined();
    pinHostKey(h.id, 'k');
    pinHostKey(h.id, undefined);
    expect(getHost(h.id)?.hostKey).toBeUndefined();
    removeHost(h.id);
    expect(getHost(h.id)).toBeUndefined();
  });

  it("remembers what the server runs, until the host's address changes", () => {
    const h = addHost(input);
    setHostPlatform(h.id, 'windows');
    updateHost(h.id, { ...input, name: 'renamed' });
    expect(getHost(h.id)?.platform).toBe('windows');
    updateHost(h.id, { ...input, hostname: 'other.example.net' });
    expect(getHost(h.id)?.platform).toBeUndefined();
  });

  it('validates what the form sends', () => {
    expect(validateHost(input, t.hostErrors)).toEqual([]);
    expect(validateHost({ name: '', hostname: 'a b', port: 0, username: '' }, t.hostErrors)).toEqual([
      t.hostErrors.nameMissing,
      t.hostErrors.hostnameMissing,
      t.hostErrors.portInvalid,
      t.hostErrors.usernameMissing,
    ]);
    expect(validateHost({ ...input, port: NaN }, t.hostErrors)).toEqual([t.hostErrors.portInvalid]);
    expect(validateHost({ ...input, port: 70000 }, t.hostErrors)).toEqual([t.hostErrors.portInvalid]);
  });
});
