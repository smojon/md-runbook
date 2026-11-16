/** The command line's record of call copies (core/node/callCopyRecord.ts): its file, and one read of a copy (security review, round 4). */
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { callCopyRecorded, ownedOnly, recordCallCopy, resumableCopy } from '@md-runbook/core/node/callCopyRecord';

const posix = process.platform !== 'win32';
const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'mdrb-rec-'));

/** A symbolic link, or undefined where this account may not make one (Windows without developer mode). */
function link(target: string, at: string): string | undefined {
  try {
    fs.symlinkSync(target, at);
    return at;
  } catch {
    return undefined;
  }
}

describe('the record of call copies', () => {
  it('is written through a new file of a random name, never through a link already there', (t) => {
    const dir = tmp();
    const file = path.join(dir, 'call-copies.json');
    const victim = path.join(tmp(), 'victim.txt');
    fs.writeFileSync(victim, 'keep me');
    // The name the record used before (pid): planted as a link to another file.
    if (!link(victim, `${file}.${process.pid}.tmp`)) return t.skip('no symbolic links here');
    recordCallCopy(path.join(dir, 'a.md'), 'text', file);
    assert.equal(fs.readFileSync(victim, 'utf8'), 'keep me');
    assert.equal(callCopyRecorded(path.join(dir, 'a.md'), 'text', file), true);
    assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp') && !n.includes(String(process.pid))), []);
  });

  it('a record file that is a link is neither read nor written', (t) => {
    const dir = tmp();
    const file = path.join(dir, 'call-copies.json');
    const elsewhere = path.join(tmp(), 'theirs.json');
    fs.writeFileSync(elsewhere, JSON.stringify({ version: 1, copies: {} }));
    if (!link(elsewhere, file)) return t.skip('no symbolic links here');
    recordCallCopy(path.join(dir, 'a.md'), 'text', file);
    assert.equal(callCopyRecorded(path.join(dir, 'a.md'), 'text', file), false);
    assert.equal(fs.readFileSync(elsewhere, 'utf8'), JSON.stringify({ version: 1, copies: {} }));
  });

  it('Linux and macOS: a folder or file others can write is not used', { skip: !posix }, () => {
    const dir = tmp();
    const file = path.join(dir, 'call-copies.json');
    recordCallCopy(path.join(dir, 'a.md'), 'text', file);
    assert.equal(callCopyRecorded(path.join(dir, 'a.md'), 'text', file), true);
    assert.equal(ownedOnly(dir, true), true);
    fs.chmodSync(file, 0o666);
    assert.equal(callCopyRecorded(path.join(dir, 'a.md'), 'text', file), false);
    fs.chmodSync(file, 0o600);
    fs.chmodSync(dir, 0o777);
    assert.equal(callCopyRecorded(path.join(dir, 'a.md'), 'text', file), false);
    recordCallCopy(path.join(dir, 'b.md'), 'text', file);
    fs.chmodSync(dir, 0o700);
    assert.equal(callCopyRecorded(path.join(dir, 'b.md'), 'text', file), false);
  });

  it('a copy is read once: the text checked is the text returned', () => {
    const dir = tmp();
    const target = path.join(dir, 'child.md');
    const body = '# Child\n\n```bash\necho a\n```\n';
    fs.writeFileSync(target, body);
    const copy = path.join(dir, 'child.20261116-100000.md');
    fs.writeFileSync(copy, body);
    let reads = 0;
    const r = resumableCopy(copy, target, {}, {}, (_c, text) => (reads++, text === body));
    assert.deepEqual([r, reads], [{ text: body }, 1]);
    const no = resumableCopy(copy, target, {}, {}, () => false);
    assert.ok('problem' in no && /not written by md-runbook/.test(no.problem));
  });
});
