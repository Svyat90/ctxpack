import { phpRules } from './php.js';
import { vueRules } from './vue.js';
import { testRules } from './tests.js';
import { groupOf } from './groups.js';
import { MAX_DEPTH } from '../config.js';

export { createContext } from './context.js';

// Order here is also the display order within one level.
const ALL = [...phpRules, ...vueRules, ...testRules];
const ORDER = ['controller-routes', 'controller-deps', 'inertia-page', 'vue-imports', 'vue-routes', 'php-inheritance', 'model-extras', 'tests'];
export const RULES = ORDER.map(name => ALL.find(r => r.name === name));
export const RULE_NAMES = ORDER;
export { GROUPS, groupOf } from './groups.js';

const MAX_SITES = 4;
const CONTEXT = 2;
const MAX_LINE = 240;

// The places a file was found from, as a few lines of code around each, for the hover popup in the UI.
// Places close to each other in one file share a snippet: `lines` are the hit lines, `start` its first line.
function snippets(ctx, sites) {
  const byFile = new Map();
  for (const { file, line } of sites) byFile.set(file, [...(byFile.get(file) || []), line]);
  const out = [];
  for (const [file, hits] of byFile) {
    const text = ctx.read(file).split('\n');
    let cur = null;
    for (const line of [...new Set(hits)].sort((a, b) => a - b)) {
      if (cur && line - CONTEXT <= cur.end + 1) {
        cur.lines.push(line);
        cur.end = Math.min(text.length, line + CONTEXT);
        continue;
      }
      cur = { file, lines: [line], start: Math.max(1, line - CONTEXT), end: Math.min(text.length, line + CONTEXT) };
      out.push(cur);
    }
    for (const s of out) {
      if (s.file !== file) continue;
      s.code = text.slice(s.start - 1, s.end).map(l => (l.length > MAX_LINE ? l.slice(0, MAX_LINE) + '…' : l)).join('\n');
      delete s.end;
    }
  }
  return out;
}

// Breadth-first walk from the selected files. A hit at level L from rule R is kept only if
// L <= depthByRule[R] ?? depth, so e.g. Vue imports can go deep while other chains stay short.
export function findRelated(ctx, seeds, rel) {
  if (!rel || rel.enabled === false) return [];
  const rules = RULES.filter(r => rel.rules?.[r.name] !== false);
  const limit = r => Math.min(MAX_DEPTH, Math.max(1, Number(rel.depthByRule?.[r.name] ?? rel.depth ?? 1)));
  const maxLevel = Math.max(0, ...rules.map(limit));
  const seedSet = new Set(seeds);
  const found = new Map();

  let frontier = [...seedSet].filter(ctx.has);
  for (let level = 1; level <= maxLevel && frontier.length; level++) {
    const next = [];
    for (const src of frontier) {
      for (const rule of rules) {
        if (level > limit(rule) || !rule.applies(src)) continue;
        for (const hit of rule.find(src, ctx)) {
          if (seedSet.has(hit.path) || !ctx.has(hit.path)) continue;
          // A file found again keeps its first reason; only the new places it was found from are added.
          const known = found.get(hit.path);
          if (known) {
            known.sites.push(...(hit.sites || []));
            continue;
          }
          found.set(hit.path, { path: hit.path, rule: rule.name, reason: hit.reason, from: src, level, group: groupOf(hit.path), tokens: ctx.tokens(hit.path), sites: [...(hit.sites || [])] });
          next.push(hit.path);
        }
      }
    }
    frontier = next;
  }

  const rank = new Map(ORDER.map((n, i) => [n, i]));
  const out = [...found.values()]
    .sort((a, b) => a.level - b.level || rank.get(a.rule) - rank.get(b.rule) || (a.path < b.path ? -1 : 1))
    .slice(0, rel.maxSuggestions ?? 60);
  for (const s of out) {
    const all = snippets(ctx, s.sites);
    s.sites = all.slice(0, MAX_SITES);
    s.moreSites = all.length - s.sites.length;
  }
  return out;
}
