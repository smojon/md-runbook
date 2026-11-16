/** Remote hosts in VS Code, the parts without vscode (src/hostList.ts). */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  HostEntry,
  cellTarget,
  findHost,
  groupFooter,
  groupHeader,
  groupMembers,
  groupResult,
  hostGroups,
  hostLabel,
  hostProblems,
  hostSetting,
  osAllows,
  parseSshConfig,
  pinKeyOf,
  practiceChoice,
  readHosts,
  remoteEnv,
  remoteLabel,
} from '../src/hostList';

const web1: HostEntry = { name: 'web-1', hostname: 'web1.example.net', port: 22, user: 'ops', group: 'eu' };
const web2: HostEntry = { name: 'Web-2', hostname: '10.0.0.2', port: 2222, user: 'ops', group: 'eu' };
const lab: HostEntry = { name: 'lab', hostname: 'lab.local', port: 22, user: 'me' };
const hosts = [web1, web2, lab];

describe('hosts: the list', () => {
  it('reads the setting, leaving out hosts that cannot be used and saying why', () => {
    const { hosts: got, problems } = readHosts([
      { name: ' web-1 ', hostname: 'web1.example.net', user: 'ops', group: 'eu' },
      { name: 'b', hostname: '-oProxyCommand=evil', user: 'ops' },
      { name: 'c', hostname: 'two words', user: 'ops' },
      { name: 'd', hostname: 'h', user: '-l root' },
      { name: 'e', hostname: 'h', user: 'ops', port: 70000 },
      { name: 'WEB-1', hostname: 'h', user: 'ops' },
      'not a host',
      { name: 'f', hostname: 'h', port: 2200, user: 'u', group: '' },
    ]);
    assert.deepEqual(got, [
      { name: 'web-1', hostname: 'web1.example.net', port: 22, user: 'ops', group: 'eu' },
      { name: 'f', hostname: 'h', port: 2200, user: 'u' },
    ]);
    assert.equal(problems.length, 6);
    assert.match(problems[0]!, /host 2 \(b\): hostname: one word, not starting with -/);
    assert.match(problems[1]!, /hostname: one word/);
    assert.match(problems[2]!, /user: one word, not starting with -/);
    assert.match(problems[3]!, /port: 1 to 65535/);
    assert.match(problems[4]!, /name: WEB-1 is taken/);
    assert.match(problems[5]!, /host 7: expected/);
    assert.deepEqual(readHosts(undefined), { hosts: [], problems: [] });
    assert.deepEqual(readHosts('x').problems, ['mdRunbook.hosts: expected a list']);
  });

  it('checks one host as typed', () => {
    assert.deepEqual(hostProblems({ name: 'a', hostname: 'h', user: 'u' }), []);
    assert.deepEqual(hostProblems({ name: '', hostname: '', user: '' }), ['name: missing', 'hostname: missing', 'user: missing']);
    assert.deepEqual(hostProblems({ name: 'a', hostname: 'h', user: 'u', port: 1.5 }), ['port: 1 to 65535']);
    assert.deepEqual(hostProblems({ name: 'a\nb', hostname: 'h t', user: 'u' }), ['name: at most 64 characters, on one line', 'hostname: one word, not starting with -']);
  });

  it('stores hosts without the defaults; labels and pins by address', () => {
    assert.deepEqual(hostSetting(web1), { name: 'web-1', hostname: 'web1.example.net', user: 'ops', group: 'eu' });
    assert.deepEqual(hostSetting(web2), { name: 'Web-2', hostname: '10.0.0.2', port: 2222, user: 'ops', group: 'eu' });
    assert.equal(hostLabel(web1), 'ops@web1.example.net');
    assert.equal(hostLabel(web2), 'ops@10.0.0.2:2222');
    assert.equal(pinKeyOf({ hostname: 'Web1.Example.NET', port: 22 }), 'web1.example.net:22');
  });

  it('finds hosts by name whatever the case; groups in order', () => {
    assert.equal(findHost(hosts, 'WEB-2'), web2);
    assert.equal(findHost(hosts, ' lab '), lab);
    assert.equal(findHost(hosts, 'nope'), undefined);
    assert.equal(findHost(hosts, undefined), undefined);
    assert.deepEqual(hostGroups([...hosts, { ...lab, name: 'x', group: 'apac' }]), ['apac', 'eu']);
    assert.deepEqual(groupMembers(hosts, 'eu'), [web1, web2]);
    assert.deepEqual(groupMembers(hosts, 'EU'), []);
  });
});

describe('hosts: ~/.ssh/config', () => {
  it('offers literal Host entries with their address, port and user', () => {
    const got = parseSshConfig(
      [
        '# mine',
        'User fallback',
        'Host bastion jump',
        '  HostName bastion.example.net',
        '  Port 2200',
        '  User ops',
        'Host *.internal !secret',
        '  User nobody',
        'Host web-?',
        'Host db',
        '  HostName=10.1.2.3',
        '  IdentityFile ~/.ssh/db_key',
        'Match host x',
        '  HostName elsewhere',
        'Host alias-only',
        'Host weird',
        '  HostName %h.example.net',
        'Host bad',
        '  HostName -oProxyCommand=x',
        'Host "quoted"',
        '  HostName q.example.net # note',
      ].join('\n'),
    );
    assert.deepEqual(got, [
      { alias: 'bastion', hostname: 'bastion.example.net', port: 2200, user: 'ops' },
      { alias: 'jump', hostname: 'bastion.example.net', port: 2200, user: 'ops' },
      { alias: 'db', hostname: '10.1.2.3', port: 22, user: 'fallback' },
      { alias: 'alias-only', hostname: 'alias-only', port: 22, user: 'fallback' },
      { alias: 'weird', hostname: 'weird.example.net', port: 22, user: 'fallback' },
      { alias: 'quoted', hostname: 'q.example.net', port: 22, user: 'fallback' },
    ]);
    assert.deepEqual(parseSshConfig(''), []);
  });
});

describe('hosts: where a cell runs', () => {
  it('host= picks a listed host; practice wins over host=', () => {
    assert.deepEqual(cellTarget(hosts, undefined, undefined), { kind: 'local' });
    assert.deepEqual(cellTarget(hosts, 'web-1', undefined), { kind: 'host', host: web1, by: 'host=' });
    assert.deepEqual(cellTarget(hosts, 'prod', undefined), { kind: 'missing', name: 'prod', by: 'host=' });
    assert.deepEqual(cellTarget(hosts, 'web-1', 'LAB'), { kind: 'host', host: lab, by: 'practice' });
    assert.deepEqual(cellTarget(hosts, undefined, 'lab'), { kind: 'host', host: lab, by: 'practice' });
    assert.deepEqual(cellTarget(hosts, 'web-1', 'gone'), { kind: 'missing', name: 'gone', by: 'practice' });
  });

  it("practice: the front matter's host asks first unless the runbook is signed by someone you trust", () => {
    assert.deepEqual(practiceChoice(hosts, undefined, undefined, false, false), { kind: 'none' });
    assert.deepEqual(practiceChoice(hosts, 'lab', undefined, false, false), { kind: 'host', host: lab, from: 'picked', ask: false });
    assert.deepEqual(practiceChoice(hosts, undefined, 'lab', false, false), { kind: 'host', host: lab, from: 'front matter', ask: true });
    assert.deepEqual(practiceChoice(hosts, undefined, 'lab', true, false), { kind: 'host', host: lab, from: 'front matter', ask: false });
    assert.deepEqual(practiceChoice(hosts, undefined, 'lab', false, true), { kind: 'host', host: lab, from: 'front matter', ask: false });
    // Picked wins over the front matter; a name not in the list stops the run.
    assert.deepEqual(practiceChoice(hosts, 'web-1', 'lab', false, false), { kind: 'host', host: web1, from: 'picked', ask: false });
    assert.deepEqual(practiceChoice(hosts, undefined, 'training-1', true, true), { kind: 'missing', name: 'training-1' });
  });

  it("os= is judged against the host's platform", () => {
    assert.equal(osAllows(undefined, 'posix'), true);
    assert.equal(osAllows(['linux'], 'posix'), true);
    assert.equal(osAllows(['macos'], 'posix'), true);
    assert.equal(osAllows(['windows'], 'posix'), false);
    assert.equal(osAllows(['windows'], 'windows'), true);
    assert.equal(osAllows(['linux', 'macos'], 'windows'), false);
  });

  it("a remote cell gets its own env= and its placeholders' values, nothing else", () => {
    assert.deepEqual(remoteEnv({ A: '1', TOKEN: 's', PATH: '/x', HOME: '/h' }, ['A', 'TOKEN', 'MISSING']), { A: '1', TOKEN: 's' });
  });
});

describe('hosts: a group run', () => {
  it('a section per host; exit and attributes as in the app', () => {
    assert.equal(groupHeader(web2), '── Web-2 (ops@10.0.0.2:2222) ──\n');
    assert.equal(groupFooter({ host: web1, exit: '0', text: '' }), '── web-1: exit 0 ──\n');
    assert.equal(groupFooter({ host: web1, exit: '3', text: '' }), '── web-1: exit 3 ──\n');
    assert.equal(groupFooter({ host: web1, exit: '0', check: 'failed', text: '' }), '── web-1: check failed ──\n');
    assert.equal(groupFooter({ host: web1, exit: 'skipped', text: '' }), '── web-1: skipped ──\n');
    assert.equal(groupFooter({ host: web1, exit: 'timeout', text: '' }), '── web-1: timeout ──\n');

    assert.deepEqual(groupResult('eu', [{ host: web1, exit: '0', text: '' }, { host: web2, exit: '0', check: 'ok', text: '' }]), {
      exitCode: 0,
      attrs: { group: 'eu', hosts: 'web-1,Web-2' },
    });
    assert.deepEqual(groupResult('eu', [{ host: web1, exit: '0', check: 'failed', text: '' }, { host: web2, exit: '4', text: '' }]), {
      exitCode: 1,
      attrs: { group: 'eu', hosts: 'web-1,Web-2', failed: 'web-1,Web-2' },
    });
    assert.equal(groupResult('eu', [{ host: web1, exit: '0', text: '' }, { host: web2, exit: '4', text: '' }]).exitCode, 4);
    assert.equal(groupResult('eu', [{ host: web1, exit: 'skipped', text: '' }]).exitCode, 1);
    assert.equal(remoteLabel({ hosts: [web1, web2], group: 'eu' }), 'group eu');
    assert.equal(remoteLabel({ hosts: [lab] }), 'lab');
  });
});
