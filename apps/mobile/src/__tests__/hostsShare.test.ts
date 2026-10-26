import { hostsJson, hostsLink, importHosts, readHosts } from '../hosts/share';
import { addHost, getHosts, resetHosts } from '../hosts/store';

beforeEach(() => resetHosts());

describe('sharing hosts', () => {
  const web = { name: 'web-1', hostname: 'web1.example.net', port: 22, username: 'deploy', group: 'acme' };

  it('a link carries names, addresses, users and groups, and host keys only when asked', () => {
    const h = addHost(web);
    const withKey = [{ ...h, hostKey: 'ecdsa-sha2-nistp256 AAAAkey=' }];
    const plain = readHosts(hostsLink(withKey, false));
    expect(plain).toEqual({ hosts: [{ name: 'web-1', hostname: 'web1.example.net', port: 22, username: 'deploy', group: 'acme' }] });
    const keyed = readHosts(hostsLink(withKey, true));
    expect('hosts' in keyed && keyed.hosts[0]!.hostKey).toBe('ecdsa-sha2-nistp256 AAAAkey=');
    // Never anything about the app's own key.
    expect(hostsJson(withKey, true)).not.toMatch(/PRIVATE|pkcs8/i);
  });

  it('imports new hosts only; their keys are trusted only when the user says so', () => {
    addHost({ name: 'web-1', hostname: 'other.example.net', port: 22, username: 'me' });
    const list = [
      { ...web, hostKey: 'ecdsa-sha2-nistp256 AAAA1=' },
      { name: 'db-1', hostname: 'db1.example.net', port: 2222, username: 'ops', hostKey: 'ecdsa-sha2-nistp256 AAAA2=' },
    ];
    expect(importHosts(list, false)).toEqual({ added: ['db-1'], skipped: ['web-1'] });
    expect(getHosts().find((h) => h.name === 'db-1')!.hostKey).toBeUndefined();
    expect(getHosts().find((h) => h.name === 'web-1')!.hostname).toBe('other.example.net');
    resetHosts();
    importHosts(list, true);
    expect(getHosts().find((h) => h.name === 'db-1')!.hostKey).toBe('ecdsa-sha2-nistp256 AAAA2=');
  });

  it('reads a pasted file; refuses anything else, and a list with a broken host', () => {
    const json = hostsJson([{ id: 'x', ...web }], false);
    expect(readHosts(json)).toEqual({ hosts: [web] });
    expect(readHosts('{"hosts": []}')).toEqual({ error: expect.stringMatching(/Not a hosts list/) });
    expect(readHosts('mdrunbook://hosts/import?h=AAAA')).toEqual({ error: expect.stringMatching(/damaged/) });
    const broken = json.replace('"web1.example.net"', '"web 1"');
    expect(readHosts(broken)).toEqual({ error: expect.stringMatching(/web-1 in this list/) });
  });
});
