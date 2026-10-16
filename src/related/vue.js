import path from 'node:path';
import { escapeRe, isPhp, lineHits, sitesIn } from './util.js';
import { phpInfo } from './php.js';

const SCRIPT = /\.(?:vue|js|mjs|cjs|ts|jsx|tsx)$/;
const EXT = ['.vue', '.ts', '.js', '.tsx', '.jsx', '.mjs'];
const PAGE_DIRS = ['resources/js/Pages', 'resources/js/pages', 'resources/ts/Pages', 'resources/ts/pages'];
const IMPORT_RE = /(?:import|export)\s+(?:[\w*{}\s,$]+?\s+from\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g;

// Only relative paths and the project's own aliases are followed.
// Bare specifiers ("vue", "@inertiajs/vue3", "lodash/debounce") are npm packages and are skipped.
export function resolveSpecifier(spec, from, ctx) {
  let base;
  if (spec.startsWith('./') || spec.startsWith('../')) {
    base = path.posix.join(path.posix.dirname(from), spec);
  } else {
    const alias = Object.keys(ctx.aliases)
      .sort((a, b) => b.length - a.length)
      .find(a => spec === a || spec.startsWith(a + '/'));
    if (!alias) return null;
    base = path.posix.join(ctx.aliases[alias], spec.slice(alias.length));
  }
  base = base.replace(/\?.*$/, '');
  const candidates = [base, ...EXT.map(e => base + e), ...EXT.map(e => `${base}/index${e}`)];
  return candidates.find(c => ctx.has(c)) || null;
}

function pageFile(name, ctx) {
  for (const dir of PAGE_DIRS) {
    for (const ext of EXT) {
      const file = `${dir}/${name}${ext}`;
      if (ctx.has(file)) return file;
    }
  }
  return null;
}

const quoted = s => new RegExp(`['"]${escapeRe(s)}['"]`);

// Line of the route named `name` (or of the Route::resource that generates it): its 1-based number
// and the text from two lines before it, where the controller of a chained route is.
function findRoute(text, name) {
  const lines = text.split('\n');
  const named = new RegExp(`name\\(\\s*['"]${escapeRe(name)}['"]`);
  let i = lines.findIndex(l => named.test(l));
  if (i < 0 && name.includes('.')) {
    const resource = new RegExp(`Route::(?:api)?[Rr]esources?\\(\\s*['"]${escapeRe(name.split('.').slice(0, -1).join('.'))}['"]`);
    i = lines.findIndex(l => resource.test(l));
  }
  return i < 0 ? null : { line: i + 1, text: lines.slice(Math.max(0, i - 2), i + 1).join('\n') };
}

function controllerIn(text, routeFile, ctx) {
  const m = /([\w\\]+Controller)::class/.exec(text) || /['"]([\w\\]+Controller)@/.exec(text);
  if (!m) return null;
  return ctx.classFile(phpInfo(ctx, routeFile).resolve(m[1])) || ctx.classFile(`App\\Http\\Controllers\\${m[1]}`);
}

export const vueRules = [
  {
    name: 'inertia-page',
    applies: isPhp,
    find(p, ctx) {
      const text = ctx.read(p);
      const names = [
        ...[...text.matchAll(/(?:Inertia::render|\binertia)\(\s*['"]([\w./-]+)['"]/g)].map(m => m[1]),
        ...[...text.matchAll(/Route::inertia\(\s*['"][^'"]*['"]\s*,\s*['"]([\w./-]+)['"]/g)].map(m => m[1]),
      ];
      const out = [];
      for (const name of names) {
        const page = pageFile(name, ctx);
        if (page) out.push({ path: page, reason: `Inertia::render('${name}')`, sites: sitesIn(p, lineHits(text, quoted(name), { max: 2 })) });
      }
      return out;
    },
  },
  {
    name: 'vue-imports',
    applies: p => SCRIPT.test(p),
    find(p, ctx) {
      const src = ctx.read(p).replace(/\/\*[\s\S]*?\*\//g, '');
      const out = [];
      for (const m of src.matchAll(IMPORT_RE)) {
        const spec = m[1] || m[2] || m[3];
        const file = resolveSpecifier(spec, p, ctx);
        if (file && file !== p) out.push({ path: file, reason: `import ${path.posix.basename(spec)}`, sites: sitesIn(p, lineHits(ctx.read(p), quoted(spec), { max: 1 })) });
      }
      return out;
    },
  },
  {
    name: 'vue-routes',
    applies: p => SCRIPT.test(p),
    find(p, ctx) {
      const text = ctx.read(p);
      const names = new Set([...text.matchAll(/\broute\(\s*['"]([\w.-]+)['"]/g)].map(m => m[1]));
      const out = [];
      for (const name of names) {
        const calls = sitesIn(p, lineHits(text, new RegExp(`\\broute\\(\\s*${quoted(name).source}`), { max: 2 }));
        for (const r of ctx.under('routes/').filter(isPhp)) {
          const hit = findRoute(ctx.read(r), name);
          if (!hit) continue;
          const sites = [...calls, { file: r, line: hit.line }];
          out.push({ path: r, reason: `route('${name}')`, sites });
          const controller = controllerIn(hit.text, r, ctx);
          if (controller) out.push({ path: controller, reason: `route('${name}') → ${controller.split('/').pop().replace(/\.php$/, '')}`, sites });
        }
      }
      return out;
    },
  },
];
