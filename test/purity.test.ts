import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { it } from 'node:test';

it('src/core does not depend on vscode', () => {
  const dir = path.resolve(__dirname, '..', '..', 'src', 'core');
  for (const f of fs.readdirSync(dir)) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.ok(!/from ['"]vscode['"]|require\(['"]vscode['"]\)/.test(src), `${f} imports vscode`);
  }
});
