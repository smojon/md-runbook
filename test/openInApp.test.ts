import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { appLink, fileWebUrl } from '../src/appLink';

describe('Open in the App', () => {
  it('the file page from the remote: https and ssh forms, GitHub and GitLab', () => {
    const want = 'https://github.com/smojon/md-runbook/blob/main/examples/sample.runbook.md';
    for (const remote of ['https://github.com/smojon/md-runbook.git', 'git@github.com:smojon/md-runbook.git', 'ssh://git@github.com/smojon/md-runbook', 'https://token@github.com/smojon/md-runbook'])
      assert.equal(fileWebUrl(remote, 'main', 'examples/sample.runbook.md'), want, remote);
    assert.equal(fileWebUrl('git@gitlab.example.net:ops/run books.git', 'feature/x', 'a b\\c.md'), 'https://gitlab.example.net/ops/run books/-/blob/feature/x/a%20b/c.md');
    assert.equal(fileWebUrl('https://bitbucket.org/o/r.git', 'main', 'a.md'), undefined);
  });

  it('the app link carries the address', () => {
    assert.equal(appLink('https://github.com/o/r/blob/main/a b.md'), 'mdrunbook://open?url=https%3A%2F%2Fgithub.com%2Fo%2Fr%2Fblob%2Fmain%2Fa%20b.md');
  });
});
