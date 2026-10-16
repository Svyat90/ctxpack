import { escapeRe, isPhp, shortName, lineHits, sitesIn } from './util.js';

const stripComments = src => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*(?:\/\/|#(?!\[)).*$/gm, '');

function addImport(map, item) {
  const [name, alias] = item.trim().split(/\s+as\s+/);
  const fqcn = name.replace(/^\\/, '');
  map.set(alias || shortName(fqcn), fqcn);
}

// Regex-level PHP reading: namespace, imports, first class/interface/trait/enum and what it inherits.
export function parsePhp(text) {
  const src = stripComments(text);
  const decl = /(?<!::)\b(?:(?:abstract|final|readonly)\s+)*(class|interface|trait|enum)\s+(\w+)/.exec(src);
  const head = decl ? src.slice(0, decl.index) : src;
  const ns = (/^\s*namespace\s+([\w\\]+)\s*[;{]/m.exec(head) || [])[1] || '';

  const imports = new Map();
  for (const m of head.matchAll(/^\s*use\s+(?!function\b|const\b)([\w\\]+)\\\{([^}]+)\}\s*;/gm)) {
    for (const item of m[2].split(',')) if (item.trim()) addImport(imports, `${m[1]}\\${item.trim()}`);
  }
  for (const m of head.matchAll(/^\s*use\s+(?!function\b|const\b)([\w\\]+(?:\s+as\s+\w+)?(?:\s*,\s*[\w\\]+(?:\s+as\s+\w+)?)*)\s*;/gm)) {
    for (const item of m[1].split(',')) addImport(imports, item);
  }

  const resolve = raw => {
    const name = raw.trim().replace(/^\?/, '');
    if (name.startsWith('\\')) return name.slice(1);
    const [first, ...rest] = name.split('\\');
    if (imports.has(first)) return [imports.get(first), ...rest].join('\\');
    return ns ? `${ns}\\${name}` : name;
  };

  const info = { ns, imports, resolve, kind: null, name: null, parents: [], interfaces: [], traits: [], body: '' };
  if (!decl) return info;
  info.kind = decl[1];
  info.name = decl[2];
  const brace = src.indexOf('{', decl.index + decl[0].length);
  const header = src.slice(decl.index + decl[0].length, brace < 0 ? undefined : brace);
  const list = s => (s ? s.split(',').map(x => x.trim()).filter(Boolean) : []);
  info.parents = list((/\bextends\s+([\w\\\s,]+?)(?=\s+implements\b|\s*$)/.exec(header) || [])[1]);
  info.interfaces = list((/\bimplements\s+([\w\\\s,]+?)\s*$/.exec(header) || [])[1]);
  info.body = brace < 0 ? '' : src.slice(brace);
  // Trait imports inside the class body; closures (`use ($x)`) start with "(" and are skipped.
  for (const m of info.body.matchAll(/^[ \t]*use\s+([\w\\]+(?:\s*,\s*[\w\\]+)*)\s*[;{]/gm)) info.traits.push(...list(m[1]));
  return info;
}

// Parameter lists of the functions and closures in a class body. The closing parenthesis is found by
// depth, so a default value (`= new Foo()`) or an attribute (`#[Attr(...)]`) does not end the list early.
function paramLists(body) {
  const out = [];
  for (const m of body.matchAll(/\bfunction\s*&?\s*\w*\s*\(/g)) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    for (; i < body.length && depth; i++) {
      if (body[i] === '(') depth++;
      else if (body[i] === ')') depth--;
    }
    out.push(body.slice(start, i - 1).replace(/#\[(?:[^[\]]|\[[^\]]*\])*\]/g, ' '));
  }
  return out;
}

// Class names a class depends on through its signatures: parameter types (constructor injection,
// promoted properties, method parameters, union members) and typed properties.
export function signatureClasses(info) {
  const names = new Set();
  // A type is `Foo`, `?Foo`, `Foo|Bar|null` or `Foo&Bar`; only class names (capitalised) are kept.
  const add = type => type.split(/[|&]/).map(x => x.replace(/^\?/, '')).filter(x => /^[A-Z\\]/.test(x)).forEach(x => names.add(x));
  for (const list of paramLists(info.body)) {
    for (const t of list.matchAll(/(?:^|,)\s*(?:(?:public|protected|private|readonly)\s+)*([?\w\\|&]+)\s+&?(?:\.\.\.)?\$/g)) add(t[1]);
  }
  for (const t of info.body.matchAll(/^[ \t]*(?:(?:public|protected|private|readonly|static|var)\s+)+([?\w\\|&]+)\s+\$/gm)) add(t[1]);
  return names;
}

// Class names referenced from signatures, `new X` and `X::` calls.
export function referencedClasses(info) {
  const names = signatureClasses(info);
  for (const m of info.body.matchAll(/\bnew\s+([A-Z\\][\w\\]*)/g)) names.add(m[1]);
  for (const m of info.body.matchAll(/(?<![\w\\$>])([A-Z\\][\w\\]*)::/g)) names.add(m[1]);
  return names;
}

export const phpInfo = (ctx, p) => ctx.memo('php:' + p, () => parsePhp(ctx.read(p)));

const isController = p => isPhp(p) && (/\/Http\/Controllers\//.test(p) || /Controller\.php$/.test(p));
const routeFiles = ctx => ctx.under('routes/').filter(isPhp);
const MODEL_BASES = /^(?:Model|Authenticatable|Pivot|MorphPivot|Eloquent)$/;
const snake = s => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
// Lines of `p` that use the class name as written there (`Requests\\Store`, `\\App\\X`), imports skipped unless nothing else is found.
function usesOf(ctx, p, name, max) {
  const re = new RegExp(`(?<![\\w\\\\$])${escapeRe(name)}(?![\\w\\\\])`);
  const text = ctx.read(p);
  const lines = lineHits(text, re, { max, imports: false });
  return sitesIn(p, lines.length ? lines : lineHits(text, re, { max: 1 }));
}
const plural = s => (/[^aeiou]y$/.test(s) ? s.slice(0, -1) + 'ies' : /(?:s|x|z|ch|sh)$/.test(s) ? s + 'es' : s + 's');

function kindOf(file) {
  const kinds = [
    [/\/Http\/Requests\//, 'FormRequest'], [/\/Http\/Resources\//, 'Resource'], [/\/Models\//, 'Model'],
    [/\/Policies\//, 'Policy'], [/\/Services\//, 'Service'], [/\/Actions\//, 'Action'],
    [/\/Jobs\//, 'Job'], [/\/Events\//, 'Event'], [/\/Enums\//, 'Enum'],
  ];
  return (kinds.find(([re]) => re.test(file)) || [null, 'uses'])[1];
}

export const phpRules = [
  {
    name: 'controller-routes',
    applies: isController,
    find(p, ctx) {
      const c = phpInfo(ctx, p);
      if (!c.name) return [];
      const needle = new RegExp(`\\b${escapeRe(c.name)}(?:::class|@)`);
      const out = [];
      for (const r of routeFiles(ctx)) {
        const lines = lineHits(ctx.read(r), needle);
        if (lines.length) out.push({ path: r, reason: `${r.split('/').pop()}:${lines[0]}`, sites: sitesIn(r, lines) });
      }
      return out;
    },
  },
  {
    name: 'controller-deps',
    applies: isController,
    find(p, ctx) {
      const c = phpInfo(ctx, p);
      const out = [];
      for (const n of referencedClasses(c)) {
        const fqcn = c.resolve(n);
        const file = ctx.classFile(fqcn);
        if (file && file !== p) out.push({ path: file, reason: `${kindOf(file)} ${shortName(fqcn)}`, sites: usesOf(ctx, p, n, 3) });
      }
      return out;
    },
  },
  {
    // Controllers have controller-deps, which also follows `new X` and `X::`.
    name: 'php-deps',
    applies: p => isPhp(p) && !isController(p),
    find(p, ctx) {
      const c = phpInfo(ctx, p);
      if (!c.kind) return [];
      const out = [];
      for (const n of signatureClasses(c)) {
        const fqcn = c.resolve(n);
        const file = ctx.classFile(fqcn);
        if (file && file !== p) out.push({ path: file, reason: `${kindOf(file)} ${shortName(fqcn)}`, sites: usesOf(ctx, p, n, 3) });
      }
      return out;
    },
  },
  {
    name: 'php-inheritance',
    applies: isPhp,
    find(p, ctx) {
      const c = phpInfo(ctx, p);
      const out = [];
      for (const [names, verb] of [[c.parents, 'extends'], [c.interfaces, 'implements'], [c.traits, 'use']]) {
        for (const n of names) {
          const fqcn = c.resolve(n);
          const file = ctx.classFile(fqcn);
          if (file && file !== p) out.push({ path: file, reason: `${verb} ${shortName(fqcn)}`, sites: usesOf(ctx, p, n, 1) });
        }
      }
      return out;
    },
  },
  {
    name: 'model-extras',
    applies: isPhp,
    find(p, ctx) {
      const c = phpInfo(ctx, p);
      if (c.kind !== 'class') return [];
      const isModel = (p.includes('/Models/') && !p.includes('/Policies/')) || c.parents.some(n => MODEL_BASES.test(shortName(c.resolve(n))));
      if (!isModel) return [];
      const table = (/\$table\s*=\s*['"]([\w.]+)['"]/.exec(c.body) || [])[1] || plural(snake(c.name));
      const tableRe = new RegExp(`Schema::\\w+\\(\\s*['"]${escapeRe(table)}['"]`);
      const out = [];
      for (const m of ctx.under('database/migrations/')) {
        const lines = lineHits(ctx.read(m), tableRe);
        if (lines.length) out.push({ path: m, reason: `migration: ${table}`, sites: sitesIn(m, lines) });
      }
      for (const [file, reason] of [
        [`database/factories/${c.name}Factory.php`, 'factory'],
        [`database/seeders/${c.name}Seeder.php`, 'seeder'],
        [`app/Policies/${c.name}Policy.php`, 'policy'],
        [`app/Models/Policies/${c.name}Policy.php`, 'policy'],
        [`app/Observers/${c.name}Observer.php`, 'observer'],
      ]) {
        if (ctx.has(file)) out.push({ path: file, reason });
      }
      return out;
    },
  },
];
