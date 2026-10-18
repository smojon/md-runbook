// Print the CHANGELOG section for a version tag (e.g. v0.1.0), for the GitHub release notes.
const fs = require('fs');
const path = require('path');
const version = (process.argv[2] || '').replace(/^v/, '');
const text = fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8');
const m = new RegExp(`^## ${version.replace(/\./g, '\\.')}\\b[^\\n]*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm').exec(text);
process.stdout.write((m ? m[1].trim() : `Release ${version}`) + '\n');
