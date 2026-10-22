import type { Host } from '../hosts/store';
import { connectionFor, disconnect, isConnected } from '../ssh/connections';

jest.mock('../ssh/appKey', () => ({ appKey: jest.fn(async () => ({})) }));
jest.mock('../ssh/transport', () => ({ openTransport: jest.fn() }));
jest.mock('@md-runbook/ssh', () => ({
  hostKeyId: (line: string) => line,
  RemoteSession: class {
    isConnected = true;
    close = jest.fn(async () => {
      this.isConnected = false;
    });
  },
}));

const host: Host = { id: 'h1', name: 'web-1', hostname: 'web1', port: 22, username: 'deploy' } as Host;

describe('connections', () => {
  it("each runbook has its own shell on a host: one can't read another's secrets", async () => {
    const a = await connectionFor(host, 'runbook-a');
    const b = await connectionFor(host, 'runbook-b');
    expect(a).not.toBe(b);
    expect(a.session).not.toBe(b.session);
    expect(await connectionFor(host, 'runbook-a')).toBe(a);
    a.secrets!.add('s3cr3t-value');
    expect([...b.secrets!]).toEqual([]);
  });

  it("restarting one runbook's session leaves the others; editing the host closes all", async () => {
    const a = await connectionFor(host, 'r1');
    const b = await connectionFor(host, 'r2');
    await disconnect(host.id, 'r1');
    expect([isConnected(host.id, 'r1'), isConnected(host.id, 'r2')]).toEqual([false, true]);
    expect(a.session.close).toHaveBeenCalled();
    await disconnect(host.id);
    expect(b.session.close).toHaveBeenCalled();
    expect(isConnected(host.id)).toBe(false);
  });
});
