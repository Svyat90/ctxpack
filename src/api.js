import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, readUserConfig, saveUserConfig, resolveBudget, clampDepth } from './config.js';
import { listFiles, changedFiles } from './scan.js';
import { createContext, findRelated, RULE_NAMES } from './related/index.js';
import { buildExport } from './export.js';
import { matcher } from './match.js';
import { orderPaths } from './order.js';

const strings = v => (Array.isArray(v) ? v.filter(x => typeof x === 'string') : []);

// Only the related settings the UI is allowed to change.
function pickRelated(r = {}) {
  const out = {};
  if ('enabled' in r) out.enabled = !!r.enabled;
  if ('depth' in r) out.depth = clampDepth(r.depth);
  const byRule = obj => Object.entries(obj && typeof obj === 'object' ? obj : {}).filter(([k]) => RULE_NAMES.includes(k));
  if ('depthByRule' in r) out.depthByRule = Object.fromEntries(byRule(r.depthByRule).map(([k, v]) => [k, clampDepth(v)]));
  if ('rules' in r) out.rules = Object.fromEntries(byRule(r.rules).map(([k, v]) => [k, !!v]));
  return out;
}

// Everything the CLI and the HTTP server do, on one project root.
export function createApi(root, { outDir = path.resolve('ctxpack-out'), useGit = true } = {}) {
  root = path.resolve(root);
  const name = path.basename(root);
  let cfg;
  let scan;
  let ctx;
  const refresh = () => {
    cfg = loadConfig(root);
    scan = listFiles(root, cfg, { useGit });
    ctx = createContext(root, scan.files, cfg);
  };
  refresh();

  const runExport = body => buildExport({
    root,
    name,
    entries: scan.files,
    cfg,
    selected: strings(body.selected),
    task: typeof body.task === 'string' ? body.task : '',
    budget: resolveBudget(cfg, body.budget ?? cfg.defaultBudget),
    split: !!body.split,
  });

  function save(parts) {
    fs.mkdirSync(outDir, { recursive: true });
    const prefix = `${name}-context`;
    for (const f of fs.readdirSync(outDir)) {
      if (f.startsWith(prefix + '.part') && f.endsWith('.md')) fs.unlinkSync(path.join(outDir, f));
    }
    return parts.map(p => {
      const file = path.join(outDir, parts.length > 1 ? `${prefix}.part${p.index}.md` : `${prefix}.md`);
      fs.writeFileSync(file, p.markdown);
      return file;
    });
  }

  return {
    get config() { return cfg; },
    get files() { return scan.files; },

    tree() {
      refresh();
      return {
        name,
        root,
        git: scan.git,
        files: scan.files,
        rules: RULE_NAMES,
        config: {
          budgets: cfg.budgets,
          defaultBudget: cfg.defaultBudget,
          related: cfg.related,
          presets: cfg.presets,
          tokenCharsRatio: cfg.tokenCharsRatio,
          maxFileKb: cfg.maxFileKb,
        },
      };
    },

    related(body = {}) {
      const rel = { ...cfg.related, ...pickRelated(body.related) };
      return { suggestions: findRelated(ctx, strings(body.selected), rel) };
    },

    preview(body = {}) {
      const r = runExport(body);
      return {
        total: r.total,
        usable: r.usable,
        files: r.files,
        warnings: r.warnings,
        parts: r.parts.map(p => ({ index: p.index, tokens: p.tokens, files: p.files.length })),
      };
    },

    export(body = {}) {
      const r = runExport(body);
      const result = {
        total: r.total,
        usable: r.usable,
        warnings: r.warnings,
        parts: r.parts.map(p => ({ index: p.index, tokens: p.tokens, files: p.files.length, markdown: p.markdown })),
      };
      if (body.save) result.saved = save(r.parts);
      return result;
    },

    changed() {
      const list = changedFiles(root);
      return { git: list !== null, files: (list || []).filter(p => ctx.has(p)) };
    },

    // Files, directories and globs ("app/Http/**/*.php") → exportable files.
    expand(includes) {
      const pickable = scan.files.filter(f => !f.flag).map(f => f.path);
      const out = new Set();
      const missing = [];
      for (const raw of strings(includes)) {
        const inc = raw.trim().replace(/^\.\//, '').replace(/\/+$/, '');
        const test = /[*?]/.test(inc) ? matcher('/' + inc) : p => p === inc || p.startsWith(inc + '/');
        const hits = pickable.filter(test);
        if (hits.length) hits.forEach(p => out.add(p));
        else missing.push(raw);
      }
      return { files: orderPaths(out), missing };
    },

    saveRelated(patch) {
      const user = readUserConfig(root);
      user.related = { ...(user.related || {}), ...pickRelated(patch) };
      saveUserConfig(root, user);
      refresh();
      return { related: cfg.related };
    },

    savePreset(presetName, preset) {
      if (typeof presetName !== 'string' || !/^[\p{L}\p{N} _.-]{1,60}$/u.test(presetName)) {
        throw new Error('Назва пресету: 1–60 символів (літери, цифри, пробіл, _ . -)');
      }
      const user = readUserConfig(root);
      user.presets = { ...(user.presets || {}) };
      if (preset === null) {
        delete user.presets[presetName];
      } else {
        user.presets[presetName] = {
          include: strings(preset.include),
          ...(typeof preset.related === 'boolean' && { related: preset.related }),
          ...(typeof preset.budget === 'string' && preset.budget && { budget: preset.budget }),
          ...(typeof preset.task === 'string' && preset.task.trim() && { task: preset.task }),
        };
      }
      saveUserConfig(root, user);
      refresh();
      return { presets: cfg.presets };
    },
  };
}
