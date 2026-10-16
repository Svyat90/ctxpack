import { phpRules } from './php.js';
import { vueRules } from './vue.js';
import { testRules } from './tests.js';
import { MAX_DEPTH } from '../config.js';

export { createContext } from './context.js';

// Order here is also the display order within one level.
const ALL = [...phpRules, ...vueRules, ...testRules];
const ORDER = ['controller-routes', 'controller-deps', 'inertia-page', 'vue-imports', 'vue-routes', 'php-inheritance', 'model-extras', 'tests'];
export const RULES = ORDER.map(name => ALL.find(r => r.name === name));
export const RULE_NAMES = ORDER;

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
          if (seedSet.has(hit.path) || found.has(hit.path) || !ctx.has(hit.path)) continue;
          found.set(hit.path, { path: hit.path, rule: rule.name, reason: hit.reason, from: src, level, tokens: ctx.tokens(hit.path) });
          next.push(hit.path);
        }
      }
    }
    frontier = next;
  }

  const rank = new Map(ORDER.map((n, i) => [n, i]));
  return [...found.values()]
    .sort((a, b) => a.level - b.level || rank.get(a.rule) - rank.get(b.rule) || (a.path < b.path ? -1 : 1))
    .slice(0, rel.maxSuggestions ?? 60);
}
