// Summarize a .cpuprofile: top functions by self time, and the call chain of the heaviest ones.
//   node analyze.js <file.cpuprofile> [top]
const fs = require('fs');
const [file, topArg] = process.argv.slice(2);
const top = Number(topArg || 25);
const p = JSON.parse(fs.readFileSync(file, 'utf8'));
const byId = new Map(p.nodes.map((n) => [n.id, n]));
const parent = new Map();
for (const n of p.nodes) for (const c of n.children || []) parent.set(c, n.id);

// Self time per node from samples and timeDeltas (microseconds).
const self = new Map();
for (let i = 0; i < p.samples.length; i++) {
  const dt = p.timeDeltas[i + 1] ?? 0;
  self.set(p.samples[i], (self.get(p.samples[i]) || 0) + dt);
}
const total = (p.endTime - p.startTime) / 1000;
const short = (u) => (u || '').replace(/^.*\/(out|resources\/app)\//, '').replace(/^vscode-file:\/\/vscode-app\//, '');
const label = (n) => `${n.callFrame.functionName || '(anonymous)'} ${short(n.callFrame.url)}:${n.callFrame.lineNumber + 1}`;

const agg = new Map();
for (const [id, us] of self) {
  const k = label(byId.get(id));
  const a = agg.get(k) || { us: 0, ids: [] };
  a.us += us;
  a.ids.push([id, us]);
  agg.set(k, a);
}
const rows = [...agg.entries()].sort((a, b) => b[1].us - a[1].us);
console.log(`profile ${total.toFixed(0)} ms, ${p.samples.length} samples`);
console.log('\nself time:');
for (const [k, a] of rows.slice(0, top)) console.log(`${(a.us / 1000).toFixed(0).padStart(7)} ms  ${(100 * a.us / 1000 / total).toFixed(1).padStart(5)}%  ${k}`);

console.log('\ncall chains of the heaviest (excluding idle/program/gc):');
for (const [k, a] of rows.filter(([k]) => !/^\((idle|program|garbage collector)\)/.test(k)).slice(0, 6)) {
  const [id] = a.ids.sort((x, y) => y[1] - x[1])[0];
  const chain = [];
  for (let cur = id; cur !== undefined && chain.length < 30; cur = parent.get(cur)) chain.push(label(byId.get(cur)));
  console.log(`\n# ${k} (${(a.us / 1000).toFixed(0)} ms)`);
  for (const c of chain.slice(1)) console.log(`   <- ${c}`);
}

// Timeline: busy (non-idle) ms per second.
const busy = [];
let t = 0;
for (let i = 0; i < p.samples.length; i++) {
  t += p.timeDeltas[i] ?? 0;
  const n = byId.get(p.samples[i]);
  const sec = Math.floor(t / 1e6);
  busy[sec] = (busy[sec] || 0) + (/^\(idle\)/.test(n.callFrame.functionName) ? 0 : (p.timeDeltas[i + 1] ?? 0) / 1000);
}
console.log('\nbusy ms per second: ' + busy.map((b) => Math.round(b || 0)).join(' '));
