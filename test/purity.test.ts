import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { it } from 'node:test';

const core = path.resolve(__dirname, '..', '..', 'packages', 'core', 'src');
const sources = (dir: string): string[] => fs.readdirSync(dir).filter((f) => f.endsWith('.ts')).map((f) => path.join(dir, f));
const imports = (file: string): string[] => [...fs.readFileSync(file, 'utf8').matchAll(/(?:from |import\(|require\()['"]([^'"]+)['"]/g)].map((m) => m[1]!);

it('@md-runbook/core does not depend on vscode', () => {
  for (const f of [...sources(core), ...sources(path.join(core, 'node'))]) {
    assert.ok(!imports(f).includes('vscode'), `${path.basename(f)} imports vscode`);
  }
});

it('the neutral part of @md-runbook/core uses no Node modules (the app runs it)', () => {
  for (const f of sources(core)) {
    const bad = imports(f).filter((m) => m.startsWith('node:') || m.startsWith('./node') || ['fs', 'path', 'os', 'child_process', 'crypto', 'vm'].includes(m));
    assert.deepEqual(bad, [], `${path.basename(f)} imports ${bad.join(', ')}`);
  }
});
