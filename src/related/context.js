import fs from 'node:fs';
import path from 'node:path';

// Files from installed packages are never suggested: the Laravel framework and composer packages
// live in vendor/, npm packages in node_modules/.
const PACKAGE_DIRS = /^(?:vendor|node_modules)\//;
const DEFAULT_PSR4 = {
  'App\\': 'app',
  'Database\\Factories\\': 'database/factories',
  'Database\\Seeders\\': 'database/seeders',
  'Tests\\': 'tests',
};

export function createContext(root, entries, cfg) {
  const rel = cfg.related;
  const guard = rel.skipPackages !== false;
  const tokens = new Map(entries.filter(e => !e.flag).map(e => [e.path, e.tokens]));
  const has = p => tokens.has(p) && !(guard && PACKAGE_DIRS.test(p));
  const all = [...tokens.keys()].filter(has);
  const texts = new Map();
  const memo = new Map();
  const psr4 = loadPsr4(root);

  return {
    root,
    all,
    has,
    aliases: rel.aliases || {},
    tokens: p => tokens.get(p) ?? 0,
    under: prefix => all.filter(p => p.startsWith(prefix)),
    read(p) {
      if (!texts.has(p)) {
        let text = '';
        try {
          text = fs.readFileSync(path.join(root, p), 'utf8');
        } catch {}
        texts.set(p, text);
      }
      return texts.get(p);
    },
    memo(key, fn) {
      if (!memo.has(key)) memo.set(key, fn());
      return memo.get(key);
    },
    // Only the project's own PSR-4 roots are used, so Illuminate\…, Inertia\… and other package classes never resolve.
    classFile(fqcn) {
      for (const { prefix, dir } of psr4) {
        if (!fqcn.startsWith(prefix)) continue;
        const p = path.posix.join(dir, fqcn.slice(prefix.length).replace(/\\/g, '/') + '.php');
        if (has(p)) return p;
      }
      return null;
    },
  };
}

function loadPsr4(root) {
  const list = [];
  try {
    const composer = JSON.parse(fs.readFileSync(path.join(root, 'composer.json'), 'utf8'));
    for (const section of [composer.autoload, composer['autoload-dev']]) {
      for (const [prefix, dirs] of Object.entries(section?.['psr-4'] || {})) {
        for (const dir of [].concat(dirs)) list.push({ prefix, dir: dir.replace(/^\.\//, '').replace(/\/+$/, '') });
      }
    }
  } catch {}
  for (const [prefix, dir] of Object.entries(DEFAULT_PSR4)) {
    if (!list.some(e => e.prefix === prefix)) list.push({ prefix, dir });
  }
  return list
    .filter(e => !PACKAGE_DIRS.test(e.dir + '/'))
    .sort((a, b) => b.prefix.length - a.prefix.length);
}
