import fs from 'node:fs';
import path from 'node:path';
import { orderPaths } from './order.js';
import { renderMarkdown } from './render.js';
import { estimateTokens, packParts } from './tokens.js';
import { scanSecrets } from './deny.js';
import { t } from './i18n.js';

export function readText(root, rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

// entries: scan result files. budget: { limit, reserve } or null (no limit).
export function buildExport({ root, name, entries, cfg, selected, task = '', budget = null, split = false, now = new Date(), lang = 'en' }) {
  const ratio = cfg.tokenCharsRatio;
  const warnings = [];
  const byPath = new Map(entries.map(e => [e.path, e]));

  const picked = [];
  for (const p of new Set(selected)) {
    const e = byPath.get(p);
    if (e && !e.flag) {
      picked.push(p);
      continue;
    }
    const why = !e ? t(lang, 'why.notFound') : e.flag === 'deny' ? t(lang, 'why.denied') : t(lang, 'why.tooBig', { kb: cfg.maxFileKb });
    warnings.push({ level: 'warn', text: t(lang, 'skipped', { path: p, why }) });
  }

  const files = [];
  for (const p of orderPaths(picked)) {
    let content;
    try {
      content = readText(root, p);
    } catch (err) {
      warnings.push({ level: 'warn', text: t(lang, 'readFailed', { path: p, err: err.code || err.message }) });
      continue;
    }
    for (const hit of scanSecrets(content)) {
      const kind = t(lang, `kind.${hit.kind}`);
      warnings.push({ level: 'secret', text: t(lang, 'secret', { kind, path: p, line: hit.line }), path: p, line: hit.line });
    }
    files.push({ path: p, content, tokens: estimateTokens(content, ratio) });
  }

  const usable = budget?.limit ? budget.limit - (budget.reserve || 0) : null;
  let groups = [files];
  if (split && usable && files.length) {
    // Room for the header, tree line and fences of each file, plus the task in part 1.
    const cap = usable - 80 - estimateTokens(task, ratio);
    groups = packParts(files.map(f => ({ ...f, cost: f.tokens + estimateTokens(f.path, ratio) * 2 + 8 })), cap);
  }

  const parts = groups.map((group, i) => {
    const markdown = renderMarkdown({ name, files: group, task, now, part: { index: i + 1, total: groups.length } });
    return { index: i + 1, markdown, tokens: estimateTokens(markdown, ratio), files: group.map(f => f.path) };
  });
  const total = parts.reduce((s, p) => s + p.tokens, 0);
  if (usable) {
    for (const part of parts) {
      if (part.tokens <= usable) continue;
      warnings.push({
        level: 'over',
        text: parts.length > 1
          ? t(lang, 'overPart', { n: part.index, tokens: part.tokens, usable })
          : t(lang, 'over', { tokens: part.tokens, usable }),
      });
    }
  }
  return { parts, total, usable, files: files.map(f => ({ path: f.path, tokens: f.tokens })), warnings };
}
