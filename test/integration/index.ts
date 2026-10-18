/** Entry point for --extensionTestsPath: runs the integration suite sequentially. */
import { setTrace, tests } from './suite';

/** @vscode/test-electron calls run(testsRoot, callback); other harnesses may pass a logger first. */
export async function run(...args: unknown[]): Promise<void> {
  const log = typeof args[0] === 'function' ? (args[0] as (line: string) => void) : (line: string) => console.log(line);
  setTrace(log);
  const failures: string[] = [];
  for (const t of tests) {
    const started = Date.now();
    try {
      await t.fn();
      log(`  ✔ ${t.name} (${Date.now() - started}ms)`);
    } catch (e) {
      const msg = e instanceof Error ? (e.stack ?? e.message) : String(e);
      log(`  ✖ ${t.name}\n${msg}`);
      failures.push(`${t.name}: ${msg}`);
    }
  }
  log(`\n${tests.length - failures.length}/${tests.length} integration tests passed`);
  if (failures.length) throw new Error(`${failures.length} integration test(s) failed:\n${failures.join('\n\n')}`);
}
