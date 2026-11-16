// Print the CHANGELOG section for a version tag (e.g. v0.1.0), for the GitHub release notes.
// GitHub's release page turns each line break into a break, and the CHANGELOG wraps at 100
// columns: the lines of a paragraph or list item are joined into one.
const fs = require('fs');
const path = require('path');

/** The wrapped lines of each paragraph and list item joined; code blocks, tables and headings as they are. */
function unwrap(text) {
  const out = [];
  let fence = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const prev = out.length > 0 ? out[out.length - 1] : '';
    const starts = /^\s*$/.test(line) || /^\s*([-*+]|\d+[.)])\s/.test(line) || /^\s*(#|\||>|```|~~~)/.test(line);
    const joinable = !fence && !starts && prev.trim() !== '' && !/^\s*(```|~~~|\||#)/.test(prev);
    if (joinable) out[out.length - 1] = `${prev.replace(/\s+$/, '')} ${line.trim()}`;
    else out.push(line);
  }
  return out.join('\n');
}

function notes(version, text) {
  const v = version.replace(/^v/, '');
  const m = new RegExp(`^## ${v.replace(/\./g, '\\.')}\\b[^\\n]*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm').exec(text.replace(/\r\n/g, '\n'));
  return m ? unwrap(m[1].trim()) : `Release ${v}`;
}

if (require.main === module) {
  const text = fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8');
  process.stdout.write(notes(process.argv[2] || '', text) + '\n');
}

module.exports = { notes, unwrap };
