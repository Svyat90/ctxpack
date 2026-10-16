import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, readUserConfig, saveUserConfig, resolveBudget, clampDepth } from './config.js';
import { listFiles, changedFiles } from './scan.js';
import { createContext, findRelated, RULE_NAMES } from './related/index.js';
import { buildExport, readText } from './export.js';
import { matcher } from './match.js';
import { orderPaths } from './order.js';
import { scanSecrets } from './deny.js';
import { estimateTokens } from './tokens.js';
import { languageFor } from './render.js';
import { t } from './i18n.js';

const PEEK_LIMIT = 400 * 1024;
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

  const runExport = (body, lang) => buildExport({
    lang,
    root,
    name,
    entries: scan.files,
    cfg,
    selected: strings(body.selected),
    task: typeof body.task === 'string' ? body.task : '',
    budget: resolveBudget(cfg, body.budget ?? cfg.defaultBudget, lang),
    split: !!body.split,
    stripDocs: body.stripDocs !== false,
    stripComments: !!body.stripComments,
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

    preview(body = {}, lang = 'en') {
      const r = runExport(body, lang);
      return {
        total: r.total,
        usable: r.usable,
        files: r.files,
        warnings: r.warnings,
        stripped: r.stripped,
        parts: r.parts.map(p => ({ index: p.index, tokens: p.tokens, files: p.files.length })),
      };
    },

    export(body = {}, lang = 'en') {
      const r = runExport(body, lang);
      const result = {
        total: r.total,
        usable: r.usable,
        warnings: r.warnings,
        stripped: r.stripped,
        parts: r.parts.map(p => ({ index: p.index, tokens: p.tokens, files: p.files.length, markdown: p.markdown })),
      };
      if (body.save) result.saved = save(r.parts);
      return result;
    },

    // Read-only preview of one listed file. Denied files are never shown; oversized ones are truncated.
    file(rel, lang = 'en') {
      const entry = typeof rel === 'string' && scan.files.find(f => f.path === rel);
      if (!entry) throw new Error(t(lang, 'fileNotFound'));
      if (entry.flag === 'deny') throw new Error(t(lang, 'fileDenied'));
      const text = readText(root, rel);
      const truncated = text.length > PEEK_LIMIT;
      return {
        path: rel,
        content: truncated ? text.slice(0, PEEK_LIMIT) : text,
        truncated,
        tokens: estimateTokens(text, cfg.tokenCharsRatio),
        lines: text.split('\n').length,
        language: languageFor(rel),
        exportable: !entry.flag,
        secrets: scanSecrets(text),
      };
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

    savePreset(presetName, preset, lang = 'en') {
      if (typeof presetName !== 'string' || !/^[\p{L}\p{N} _.-]{1,60}$/u.test(presetName)) {
        throw new Error(t(lang, 'presetName'));
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
