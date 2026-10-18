// Merge contrib/*.json fragments into package.json "contributes" (idempotent).
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const pkgPath = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const c = pkg.contributes;
const byKey = (arr, key) => new Map(arr.map((x) => [key(x), x]));
for (const f of fs.readdirSync(path.join(root, 'contrib')).filter((f) => f.endsWith('.json')).sort()) {
  const frag = JSON.parse(fs.readFileSync(path.join(root, 'contrib', f), 'utf8'));
  if (frag.commands) {
    const m = byKey(c.commands, (x) => x.command);
    for (const cmd of frag.commands) m.set(cmd.command, cmd);
    c.commands = [...m.values()];
  }
  for (const [menu, items] of Object.entries(frag.menus || {})) {
    c.menus[menu] = c.menus[menu] || [];
    for (const it of items) if (!c.menus[menu].some((x) => x.command === it.command && x.when === it.when)) c.menus[menu].push(it);
  }
  if (frag.keybindings) {
    c.keybindings = c.keybindings || [];
    for (const k of frag.keybindings) if (!c.keybindings.some((x) => x.command === k.command && x.key === k.key)) c.keybindings.push(k);
  }
  Object.assign(c.configuration.properties, frag.configuration?.properties || {});
}
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
console.log('merged contributions into package.json');
