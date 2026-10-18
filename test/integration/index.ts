/** Entry point for --extensionTestsPath: runs the integration suite sequentially. */
import { setTrace, tests } from './suite';

export async function run(log: (line: string) => void = (line) => console.log(line)): Promise<void> {
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
