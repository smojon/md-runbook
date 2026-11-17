/**
 * The CLI's pinned progress line (src/cli/progressBar.ts), drawn on a small terminal emulator:
 * the output scrolls above it, \r redraws stay on their line, a resize moves it, and the terminal
 * is given back on exit and on Ctrl+C. No timing: the ticker is never waited for.
 */
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { ShellSettings } from '@md-runbook/core';
import { nodeShellEnv, resolveShell } from '@md-runbook/core/node';
import { parseArgs } from '../src/cli/main';
import { EscapeState, PinnedBar, Signals, barLine, canPinBar } from '../src/cli/progressBar';
import { runRunbook } from '../src/cli/run';

/** A character on the screen, and the SGR it was written with ('' plain). */
interface Cell {
  ch: string;
  sgr: string;
}
const chars = (line: Cell[]): string => line.map((c) => c.ch).join('').replace(/\s+$/, '');

/** Enough of a VT100 for the bar: text, \r, \n, IND, DECSC/DECRC, DECSTBM, CUP, CUU, EL, ED, SGR. */
class Screen extends EventEmitter {
  readonly isTTY = true;
  lines: Cell[][];
  scrollback: string[] = [];
  x = 0;
  y = 0;
  top = 0;
  bottom: number;
  /** The SGR that text is written with: the parameters since the last reset. */
  sgr = '';
  private saved = { x: 0, y: 0, sgr: '' };
  constructor(
    public rows: number,
    public columns: number,
  ) {
    super();
    this.lines = Array.from({ length: rows }, () => []);
    this.bottom = rows - 1;
  }
  text(row: number): string {
    return chars(this.lines[row] ?? []);
  }
  all(): string[] {
    return this.lines.map((_, i) => this.text(i));
  }
  /** The SGRs a row's characters were written with. */
  sgrs(row: number): Set<string> {
    return new Set((this.lines[row] ?? []).filter((c) => c.ch !== ' ').map((c) => c.sgr));
  }
  /** Down a line, scrolling at the region's bottom; \n also goes to the first column (ONLCR). */
  private feed(cr = true): void {
    if (cr) this.x = 0;
    if (this.y === this.bottom) {
      const gone = this.lines.splice(this.top, 1)[0]!;
      if (this.top === 0) this.scrollback.push(chars(gone));
      this.lines.splice(this.bottom, 0, []);
    } else if (this.y < this.rows - 1) this.y++;
  }
  write(s: string): boolean {
    for (let i = 0; i < s.length; i++) {
      const ch = s[i]!;
      if (ch === '\x1b') {
        const next = s[i + 1];
        if (next === '7') (this.saved = { x: this.x, y: this.y, sgr: this.sgr }), i++;
        else if (next === '8') ((this.x = this.saved.x), (this.y = this.saved.y), (this.sgr = this.saved.sgr), i++);
        else if (next === 'D') (this.feed(false), i++);
        else if (next === '[') {
          const m = /^\[([\d;]*)([A-Za-z])/.exec(s.slice(i + 1))!;
          i += m[0].length;
          const ps = m[1] === '' ? [] : m[1]!.split(';').map(Number);
          const p = (k: number, d: number): number => ps[k] || d;
          switch (m[2]) {
            case 'r':
              this.top = p(0, 1) - 1;
              this.bottom = p(1, this.rows) - 1;
              this.x = 0;
              this.y = 0;
              break;
            case 'H':
              this.y = Math.min(this.rows - 1, p(0, 1) - 1);
              this.x = Math.min(this.columns - 1, p(1, 1) - 1);
              break;
            case 'A':
              this.y = Math.max(this.y >= this.top ? this.top : 0, this.y - p(0, 1));
              break;
            case 'K':
              this.lines[this.y] = [];
              break;
            case 'J':
              if (p(0, 0) === 2) this.lines = this.lines.map(() => []);
              else {
                this.lines[this.y] = this.lines[this.y]!.slice(0, this.x);
                for (let r = this.y + 1; r < this.rows; r++) this.lines[r] = [];
              }
              break;
            case 'm':
              this.sgr = ps.length === 0 || ps.at(-1) === 0 ? '' : `${this.sgr};${m[1]}`.replace(/^;/, '');
              break;
            default:
              throw new Error(`unexpected sequence ${m[0]}`);
          }
        } else throw new Error(`unexpected escape ${next}`);
      } else if (ch === '\r') this.x = 0;
      else if (ch === '\n') this.feed();
      else {
        if (this.x >= this.columns) this.feed();
        const line = this.lines[this.y]!;
        while (line.length < this.x) line.push({ ch: ' ', sgr: '' });
        line[this.x++] = { ch, sgr: this.sgr };
      }
    }
    return true;
  }
  /** As xterm: rows go at the top (the cursor stays in view) or come at the bottom; the margins reset. */
  resize(rows: number, columns: number): void {
    while (this.lines.length > rows) {
      this.scrollback.push(chars(this.lines.shift()!));
      this.y = Math.max(0, this.y - 1);
    }
    while (this.lines.length < rows) this.lines.push([]);
    this.rows = rows;
    this.columns = columns;
    this.top = 0;
    this.bottom = rows - 1;
    this.emit('resize');
  }
}

class FakeSignals extends EventEmitter implements Signals {}

describe('cli: the pinned progress line', () => {
  it('fits the terminal: the words, then a bar as wide as there is room for; never wrapping', () => {
    assert.equal(barLine('Step 3/7 · 54% · 1 min left', 0.54, 80), `Step 3/7 · 54% · 1 min left [${'#'.repeat(16)}${'.'.repeat(14)}]`);
    assert.equal(barLine('Step 3/7 · 54% · 1 min left', 0.5, 50), 'Step 3/7 · 54% · 1 min left [##########.........]');
    assert.equal(barLine('Step 3/7 · 54% · 1 min left', 0.5, 30), 'Step 3/7 · 54% · 1 min left', 'no room for the bar');
    assert.equal(barLine('Step 3/7 · 54% · 1 min left', 0.5, 12), 'Step 3/7 ·…');
    for (const cols of [12, 20, 30, 40, 80, 200]) assert.ok(barLine('Step 3/7 · 54% · 1 min left', 0.5, cols).length < cols);
  });

  it('only on a terminal that draws it: not a pipe, not TERM=dumb, not a tiny window', () => {
    assert.equal(canPinBar({ isTTY: true, rows: 24, columns: 80, write: () => true }, {}), true);
    assert.equal(canPinBar({ isTTY: false, rows: 24, columns: 80, write: () => true }, {}), false);
    assert.equal(canPinBar({ rows: 24, columns: 80, write: () => true }, {}), false);
    assert.equal(canPinBar({ isTTY: true, rows: 24, columns: 80, write: () => true }, { TERM: 'dumb' }), false);
    assert.equal(canPinBar({ isTTY: true, rows: 3, columns: 80, write: () => true }, {}), false);
    // CI with a pseudo-terminal: the job's log would get the escape sequences.
    const tty = { isTTY: true, rows: 24, columns: 80, write: () => true };
    for (const CI of ['true', '1', 'yes']) assert.equal(canPinBar(tty, { CI }), false, CI);
    for (const CI of ['', 'false', '0', 'FALSE']) assert.equal(canPinBar(tty, { CI }), true, CI);
  });

  it("is drawn plain, whatever colour the output left on, and gives the output's colour back", () => {
    const screen = new Screen(8, 60);
    const bar = new PinnedBar(screen, new FakeSignals());
    screen.write('\x1b[31mred, and no reset\n');
    bar.show(() => ({ text: 'Step 1/2', fraction: 0 }));
    assert.deepEqual(screen.sgrs(7), new Set(['']));
    screen.write('still red\n');
    assert.deepEqual(screen.sgrs(1), new Set(['31']));
    bar.stop();
  });

  it('comes back within 5 s after a step cleared the screen', (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const screen = new Screen(8, 60);
    const bar = new PinnedBar(screen, new FakeSignals());
    bar.show(() => ({ text: 'Step 1/2', fraction: 0 }));
    for (const clear of ['\x1b[H\x1b[2J', '\x1b[H\x1b[J']) {
      screen.write(clear);
      assert.equal(screen.text(7), '', JSON.stringify(clear));
      t.mock.timers.tick(5000);
      assert.match(screen.text(7), /^Step 1\/2 \[/, JSON.stringify(clear));
    }
    bar.stop();
  });

  it('each second, draws a changed line; an unchanged one every 5 s only', (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const writes: string[] = [];
    const bar = new PinnedBar({ isTTY: true, rows: 10, columns: 80, write: (s) => writes.push(s) }, new FakeSignals());
    let text = 'Step 1/2 · 2 min left';
    bar.show(() => ({ text, fraction: 0 }));
    const n = writes.length;
    t.mock.timers.tick(4000);
    assert.equal(writes.length, n, 'nothing for 4 s: a reader up in the scrollback stays there');
    t.mock.timers.tick(1000);
    assert.equal(writes.length, n + 1, 'drawn again after 5 s');
    text = 'Step 1/2 · 1 min left';
    t.mock.timers.tick(1000);
    assert.equal(writes.length, n + 2, 'a change shows within a second');
    assert.match(writes.at(-1)!, /1 min left/);
    bar.stop();
  });

  it("never draws in the middle of the step's escape sequence or its saved cursor", (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const screen = new Screen(8, 60);
    const bar = new PinnedBar(screen, new FakeSignals());
    let text = 'Step 1/2';
    bar.show(() => ({ text, fraction: 0 }));
    const out = (s: string): void => {
      screen.write(s);
      bar.output(s);
    };
    // The step saves its cursor, writes elsewhere, and restores it in a later chunk.
    out('start ');
    out('\x1b7\x1b[1;50H');
    text = 'Step 1/2 · later';
    t.mock.timers.tick(2000);
    assert.doesNotMatch(screen.text(7), /later/, 'held while the cursor is saved');
    out('X\x1b8');
    out('end\n');
    t.mock.timers.tick(1000);
    assert.match(screen.text(7), /^Step 1\/2 · later/);
    assert.equal(screen.text(0).replace(/ +X$/, ''), 'start end', 'the step put its text where it meant to');
    // A sequence cut between two chunks: the line waits for its end.
    text = 'Step 2/2';
    bar.output('\x1b[3');
    t.mock.timers.tick(1000);
    assert.doesNotMatch(screen.text(7), /Step 2\/2/);
    bar.output('1m');
    t.mock.timers.tick(1000);
    assert.match(screen.text(7), /^Step 2\/2/);
    // One never closed holds the line for 5 s at most.
    text = 'Step 2/2 · stuck';
    bar.output('\x1b]0;a title without its end');
    t.mock.timers.tick(4000);
    assert.doesNotMatch(screen.text(7), /stuck/);
    t.mock.timers.tick(1000);
    assert.match(screen.text(7), /stuck/);
    bar.stop();
  });

  it("a step that leaves a sequence open doesn't slow the next step's line", (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const writes: string[] = [];
    const bar = new PinnedBar({ isTTY: true, rows: 10, columns: 80, write: (s) => writes.push(s) }, new FakeSignals());
    bar.show(() => ({ text: 'Step 1/2', fraction: 0 }));
    // cat of a binary file: an OSC without its end, then the step ends.
    bar.output('\x1b]0;never ended');
    let text = 'Step 2/2 · 2 min left';
    bar.show(() => ({ text, fraction: 0.5 }));
    const n = writes.length;
    text = 'Step 2/2 · 1 min left';
    t.mock.timers.tick(1000);
    assert.equal(writes.length, n + 1, 'a change shows within a second');
    assert.match(writes.at(-1)!, /1 min left/);
    t.mock.timers.tick(5000);
    assert.equal(writes.length, n + 2, 'unchanged: drawn again after 5 s, as usual');
    bar.stop();
  });

  it('knows where escape sequences end', () => {
    const open = (...chunks: string[]): boolean => {
      const e = new EscapeState();
      for (const c of chunks) e.feed(c);
      return e.open();
    };
    assert.equal(open('plain'), false);
    assert.equal(open('\x1b[31mred\x1b[0m'), false);
    assert.equal(open('\x1b[31'), true);
    assert.equal(open('\x1b'), true);
    assert.equal(open('\x1b(', 'B'), false);
    assert.equal(open('\x1b]8;;https://x\x07link'), false);
    assert.equal(open('\x1b]0;title\x1b'), true);
    assert.equal(open('\x1b]0;title\x1b', '\\'), false);
    assert.equal(open('\x1bP+q\x1b\\'), false);
    assert.equal(open('\x1b7'), true, 'the cursor saved');
    assert.equal(open('\x1b7 moved \x1b8'), false);
    assert.equal(open('\x1b[s moved \x1b[u'), false);
    assert.equal(open('\x1b[31\x18'), false, 'CAN cancels it');
  });

  it('a resize or a resume in the middle of an output line keeps its start', () => {
    const screen = new Screen(10, 60);
    const bar = new PinnedBar(screen, new FakeSignals());
    bar.show(() => ({ text: 'Step 1/2', fraction: 0 }));
    for (let i = 1; i <= 15; i++) screen.write(`out ${i}\n`);
    screen.write('partial ');
    screen.resize(6, 40);
    screen.write('rest\n');
    assert.ok(screen.all().includes('partial rest'), JSON.stringify(screen.all()));
    // Resumed with the cursor on the last line (the screen scrolls), in the middle of a line.
    bar.suspend();
    for (let i = 1; i <= 8; i++) screen.write(`ask ${i}\n`);
    screen.write('Password: ');
    assert.equal(screen.y, 5);
    bar.resume();
    screen.write('typed\n');
    assert.ok(screen.all().includes('Password: typed'), JSON.stringify(screen.all()));
    assert.match(screen.text(5), /^Step 1\/2 \[/);
    bar.stop();
  });

  it('--no-progress-bar is an option of run', () => {
    const p = parseArgs(['run', 'x.md', '--no-progress-bar']);
    assert.ok(typeof p === 'object' && p.noProgressBar === true);
    const q = parseArgs(['run', 'x.md']);
    assert.ok(typeof q === 'object' && q.noProgressBar === undefined);
  });

  it('stays on the bottom line while the output scrolls above it, \\r redraws included', () => {
    const screen = new Screen(8, 60);
    screen.write('▶ Step 1 · r.md:3 · bash\n');
    const bar = new PinnedBar(screen, new FakeSignals());
    let text = 'Step 1/2 · 50% · 1m left';
    bar.show(() => ({ text, fraction: 0.5 }));
    try {
      assert.match(screen.text(7), /^Step 1\/2 · 50% · 1m left \[#+\.+\]$/);
      assert.equal(screen.text(0), '▶ Step 1 · r.md:3 · bash', 'the output above is kept');
      for (let i = 1; i <= 12; i++) screen.write(`line ${i}\n`);
      // docker pull, npm: a line redrawn with \r arrives as one line (the CLI passes whole lines).
      screen.write('pull 10%\rpull 55%\rpull 100%\n');
      text = 'Step 2/2 · 99% · 1s left';
      bar.show(() => ({ text, fraction: 0.99 }));
      assert.match(screen.text(7), /^Step 2\/2 · 99% · 1s left \[/);
      assert.deepEqual(screen.all().slice(0, 7), ['line 8', 'line 9', 'line 10', 'line 11', 'line 12', 'pull 100%', '']);
      assert.ok(!screen.scrollback.some((l) => l.includes('Step 1/2')), 'the line never scrolls into the output');
      assert.deepEqual(screen.scrollback, ['▶ Step 1 · r.md:3 · bash', 'line 1', 'line 2', 'line 3', 'line 4', 'line 5', 'line 6', 'line 7']);
    } finally {
      bar.stop();
    }
    // Given back: no line, the whole screen scrolls.
    assert.ok(!screen.all().some((l) => l.includes('Step 2/2')));
    screen.write('✓ r.md: 2 steps\nmore\nand more\n');
    assert.deepEqual(screen.all().slice(4), ['✓ r.md: 2 steps', 'more', 'and more', '']);
  });

  it('a resize moves it to the new bottom line and leaves nothing behind', () => {
    const screen = new Screen(10, 60);
    const bar = new PinnedBar(screen, new FakeSignals());
    bar.show(() => ({ text: 'Step 1/3 · 10% · 4 min left', fraction: 0.1 }));
    for (let i = 1; i <= 15; i++) screen.write(`out ${i}\n`);
    screen.resize(6, 40);
    for (let i = 16; i <= 20; i++) screen.write(`out ${i}\n`);
    assert.match(screen.text(5), /^Step 1\/3 · 10% · 4 min left/);
    assert.equal(screen.text(5).length < 40, true);
    assert.deepEqual(screen.all().slice(0, 5), ['out 17', 'out 18', 'out 19', 'out 20', '']);
    screen.resize(12, 80);
    screen.write('out 21\n');
    assert.match(screen.text(11), /^Step 1\/3 · 10% · 4 min left \[/);
    const rest = [...screen.scrollback, ...screen.all().slice(0, 11)].filter((l) => l !== '');
    assert.ok(!rest.some((l) => l.includes('Step 1/3')), `no stale line: ${JSON.stringify(rest)}`);
    assert.equal(rest[rest.length - 1], 'out 21');
    bar.stop();
    assert.equal(screen.listenerCount('resize'), 0);
  });

  it('Ctrl+C or a kill gives the terminal back, and a step starting after it pins nothing', () => {
    const screen = new Screen(8, 60);
    const signals = new FakeSignals();
    const bar = new PinnedBar(screen, signals);
    bar.show(() => ({ text: 'Step 1/2', fraction: 0 }));
    assert.equal(signals.listenerCount('SIGINT'), 1);
    signals.emit('SIGINT');
    assert.ok(!screen.all().some((l) => l.includes('Step 1/2')));
    assert.deepEqual([signals.listenerCount('SIGINT'), signals.listenerCount('SIGTERM'), signals.listenerCount('exit')], [0, 0, 0], 'a second Ctrl+C ends the process as usual');
    bar.show(() => ({ text: 'Step 2/2', fraction: 0.5 }));
    assert.ok(!screen.all().some((l) => l.includes('Step 2/2')));
    screen.write('a\nb\nc\nd\ne\nf\ng\nh\n');
    assert.equal(screen.text(7), '', 'the whole screen scrolls');
  });

  it('suspends while something asks on the terminal, and comes back', () => {
    const screen = new Screen(8, 60);
    const bar = new PinnedBar(screen, new FakeSignals());
    bar.show(() => ({ text: 'Step 1/2', fraction: 0 }));
    bar.suspend();
    assert.ok(!screen.all().some((l) => l.includes('Step 1/2')));
    screen.write('Password: \n');
    bar.resume();
    assert.match(screen.text(7), /^Step 1\/2 \[/);
    bar.stop();
    bar.stop();
    assert.ok(!screen.all().some((l) => l.includes('Step 1/2')));
  });

  it('draws again only when the line changes', () => {
    const writes: string[] = [];
    const bar = new PinnedBar({ isTTY: true, rows: 10, columns: 80, write: (t) => writes.push(t) }, new FakeSignals());
    bar.show(() => ({ text: 'Step 1/2', fraction: 0 }));
    const n = writes.length;
    bar.show(() => ({ text: 'Step 1/2', fraction: 0 }));
    assert.equal(writes.length, n);
    bar.stop();
  });
});

const settings: ShellSettings = { bashPath: process.env.MD_RUNBOOK_BASH };
const hasBash = resolveShell('bash', settings, nodeShellEnv()).ok;
const fence = (info: string, body: string): string => '```' + info + '\n' + body + '\n```\n\n';

describe('cli: a run with the pinned line', { skip: !hasBash && 'bash not installed' }, () => {
  it('tells it where the run is at each step, and prints no progress lines', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdrb-bar-'));
    const file = path.join(dir, 'r.md');
    fs.writeFileSync(file, '# T\n\n' + fence('bash estimate=2m30s', 'echo one') + fence('bash', 'echo two') + fence('bash estimate=1m', 'echo three'));
    const shown: { text: string; fraction: number }[] = [];
    const printed: string[] = [];
    try {
      const r = await runRunbook(
        { file, write: false, params: {}, inputs: {}, yes: false, keepGoing: false, shell: settings, env: process.env, pinned: { show: (read) => void shown.push(read()) } },
        { out: (t) => printed.push(t), log: (l) => printed.push(l + '\n') },
      );
      assert.equal(r.ok, true, printed.join(''));
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
    // Read as each step starts: the share only once no step left lacks an estimate.
    assert.deepEqual(
      shown.map((s) => s.text),
      ['Step 1/3 · at least 4 min left', 'Step 2/3 · at least 1m left', 'Step 3/3 · 71% · 1m left'],
    );
    assert.ok(shown[2]!.fraction > 0.7 && shown[2]!.fraction < 0.72);
    assert.doesNotMatch(printed.join(''), /^ {2}\[/m, 'no progress lines under the steps');
  });

  it('numbers the steps as VS Code and the app do: the ready check and the teardown by name', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdrb-bar-'));
    const file = path.join(dir, 'r.md');
    fs.writeFileSync(
      file,
      '# T\n\n' +
        fence('bash ready', 'exit 1') +
        fence('bash setup', 'echo up') +
        '- [ ] look at the dashboard\n\n' +
        fence('bash', 'echo body') +
        fence('bash teardown', 'echo down'),
    );
    const shown: string[] = [];
    const printed: string[] = [];
    try {
      const r = await runRunbook(
        { file, write: false, params: {}, inputs: {}, yes: true, keepGoing: false, teardown: 'always', shell: settings, env: process.env, pinned: { show: (read) => void shown.push(read().text) } },
        { out: (t) => printed.push(t), log: (l) => printed.push(l + '\n') },
      );
      assert.equal(r.ok, true, printed.join(''));
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
    // The checklist item is step 2, as in VS Code's status bar; the ▶ lines keep the CLI's numbers.
    assert.deepEqual(shown, ['Ready check', 'Step 1/3', 'Step 3/3', 'Teardown']);
    assert.match(printed.join(''), /▶ Step 3 · r\.md:\d+ · bash/);
  });
});
