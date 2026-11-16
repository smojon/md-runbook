import { render, screen } from '@testing-library/react-native';
import { hostsJson } from '../hosts/share';
import { addHost, resetHosts, type Host } from '../hosts/store';
import { HostsImport } from '../screens/HostsImport';

jest.mock('expo-router', () => ({ router: { back: jest.fn() } }));

beforeEach(() => resetHosts());

const host = (name: string, group?: string): Host => ({
  id: name,
  name,
  hostname: `${name}.example.net`,
  port: 22,
  username: 'ops',
  ...(group ? { group } : {}),
});

describe('Import hosts: a host that joins a group you have', () => {
  it('is marked, and the list says Run on a Group would include it', async () => {
    addHost({ name: 'db-1', hostname: 'db1.example.net', port: 22, username: 'ops', group: 'prod' });
    const list = hostsJson([host('db-9', 'Prod'), host('web-1', 'staging'), host('db-1', 'prod')], false);
    await render(<HostsImport packed={list} />);
    expect(screen.getByTestId('hosts-import-joins-db-9')).toHaveTextContent(/joins your group prod/);
    // A new group, or a host you already have (skipped): not marked.
    expect(screen.queryByTestId('hosts-import-joins-web-1')).toBeNull();
    expect(screen.queryByTestId('hosts-import-joins-db-1')).toBeNull();
    expect(screen.getByTestId('hosts-import-joining')).toHaveTextContent(/Run on a Group then runs on them too/);
  });

  it('no note when no host joins one of your groups', async () => {
    addHost({ name: 'db-1', hostname: 'db1.example.net', port: 22, username: 'ops', group: 'prod' });
    await render(<HostsImport packed={hostsJson([host('web-1', 'staging'), host('web-2')], false)} />);
    expect(screen.getByTestId('hosts-import-list')).toBeTruthy();
    expect(screen.queryByTestId('hosts-import-joining')).toBeNull();
  });
});
