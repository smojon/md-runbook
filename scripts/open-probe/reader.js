// Reads a few of VS Code's files directly every 250 ms and logs each read's time, so slow reads
// (disk / antivirus) can be told apart from slowness inside VS Code's resource loading.
//   node reader.js <vscodeAppDir> <outFile> <seconds>
const fs = require('fs');
const path = require('path');
const [app, outFile, secs] = process.argv.slice(2);
const files = [
  'extensions/markdown-language-features/notebook-out/index.js',
  'extensions/shellscript/syntaxes/shell-unix-bash.tmLanguage.json',
  'extensions/markdown-math/notebook-out/katex.js',
].map((f) => path.join(app, f));
const t0 = Date.now();
const lines = [];
let max = 0;
const tick = () => {
  for (const f of files) {
    const s = process.hrtime.bigint();
    let ok = 'ok';
    try {
      const fd = fs.openSync(f, 'r');
      const buf = Buffer.alloc(fs.fstatSync(fd).size);
      fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
    } catch (e) {
      ok = String(e.code || e);
    }
    const ms = Number(process.hrtime.bigint() - s) / 1e6;
    max = Math.max(max, ms);
    if (ms > 50 || ok !== 'ok') lines.push(`${new Date().toISOString()} ${ms.toFixed(0)} ms ${ok} ${path.basename(f)}`);
  }
  if (Date.now() - t0 < Number(secs) * 1000) setTimeout(tick, 250);
  else {
    lines.push(`max ${max.toFixed(0)} ms`);
    fs.writeFileSync(outFile, lines.join('\n') + '\n');
  }
};
tick();
