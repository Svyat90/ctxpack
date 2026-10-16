import { escapeRe } from './util.js';

const CODE = /\.(?:php|vue|js|mjs|ts|jsx|tsx)$/;
const isTest = p => p.startsWith('tests/') || /(?:^|\/)__tests__\//.test(p) || /\.(?:test|spec)\.\w+$/.test(p);
// Names too generic to find a meaningful test by.
const GENERIC = new Set(['index', 'app', 'main', 'create', 'edit', 'show', 'form', 'web', 'api', 'routes', 'bootstrap']);
const MAX_PER_FILE = 5;

const testFiles = ctx => ctx.memo('tests', () => ctx.all.filter(p => CODE.test(p) && isTest(p)));

export const testRules = [
  {
    name: 'tests',
    applies: p => CODE.test(p) && !isTest(p),
    find(p, ctx) {
      const base = p.split('/').pop().replace(/\.blade\.php$|\.\w+$/, '');
      if (base.length < 4 || GENERIC.has(base.toLowerCase())) return [];
      const re = new RegExp(`\\b${escapeRe(base)}\\b`);
      const out = [];
      for (const t of testFiles(ctx)) {
        if (out.length >= MAX_PER_FILE) break;
        if (re.test(ctx.read(t))) out.push({ path: t, reason: `mentions ${base}` });
      }
      return out;
    },
  },
];
