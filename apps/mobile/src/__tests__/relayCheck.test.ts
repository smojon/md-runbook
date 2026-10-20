import { checkRelay, relayBases } from '../ssh/transport.web';

const answer = (status: number, body?: unknown) =>
  jest.fn(async () => ({ ok: status === 200, status, json: async () => body }) as unknown as Response);

describe('the web app and its relay', () => {
  it('takes the relay address as wss:// or https://', () => {
    expect(relayBases('wss://relay.example.net/')).toEqual({ ws: 'wss://relay.example.net', http: 'https://relay.example.net' });
    expect(relayBases('https://relay.example.net')).toEqual({ ws: 'wss://relay.example.net', http: 'https://relay.example.net' });
    expect(relayBases(' ws://127.0.0.1:8022 ')).toEqual({ ws: 'ws://127.0.0.1:8022', http: 'http://127.0.0.1:8022' });
  });

  it('checks the protocol version before connecting', async () => {
    const ok = answer(200, { name: 'md-runbook-relay', protocol: 1, version: '1.0.0', capabilities: ['ssh'] });
    expect(await checkRelay('wss://r.example', ok)).toBeUndefined();
    expect(ok).toHaveBeenCalledWith('https://r.example/v1/server-info', { cache: 'no-store' });
    expect(await checkRelay('wss://r.example', answer(200, { protocol: 2 }))).toMatch(/newer than this app/);
    expect(await checkRelay('wss://r.example', answer(200, { protocol: 0 }))).toMatch(/older than this app/);
    expect(await checkRelay('wss://r.example', answer(404))).toMatch(/older than this app/);
    expect(await checkRelay('wss://r.example', answer(200, 'not json'))).toMatch(/did not answer/);
    const down = jest.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(await checkRelay('wss://r.example', down)).toMatch(/did not answer/);
  });
});
