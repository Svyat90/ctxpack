import { orderPaths } from './order.js';

const LANG = {
  php: 'php', vue: 'vue', js: 'js', mjs: 'js', cjs: 'js', ts: 'ts', jsx: 'jsx', tsx: 'tsx',
  json: 'json', css: 'css', scss: 'scss', sass: 'sass', less: 'less', html: 'html',
  md: 'markdown', yml: 'yaml', yaml: 'yaml', neon: 'yaml', xml: 'xml', sh: 'bash',
  sql: 'sql', ini: 'ini', toml: 'toml', env: 'ini',
};

export function languageFor(file) {
  if (file.endsWith('.blade.php')) return 'blade';
  const base = file.split('/').pop();
  if (base === 'Dockerfile') return 'dockerfile';
  if (base === 'Makefile') return 'makefile';
  const ext = base.includes('.') ? base.split('.').pop().toLowerCase() : '';
  return LANG[ext] || '';
}

// A fence longer than any backtick run inside the content, so the file cannot close it early.
export function fenceFor(text) {
  let longest = 0;
  for (const m of text.matchAll(/`{3,}/g)) longest = Math.max(longest, m[0].length);
  return '`'.repeat(Math.max(3, longest + 1));
}

// Indented tree; chains of single sub-directories collapse into one line ("app/Http/Controllers/").
export function treeText(paths) {
  const root = new Map();
  for (const p of orderPaths(paths)) {
    const parts = p.split('/');
    let node = root;
    parts.forEach((part, i) => {
      if (i === parts.length - 1) return node.set(part, null);
      if (!node.has(part)) node.set(part, new Map());
      node = node.get(part);
    });
  }
  const lines = [];
  const walk = (node, depth) => {
    for (let [name, kids] of node) {
      while (kids && kids.size === 1) {
        const [[childName, childKids]] = kids;
        if (!childKids) break;
        name += '/' + childName;
        kids = childKids;
      }
      lines.push('  '.repeat(depth) + (kids ? name + '/' : name));
      if (kids) walk(kids, depth + 1);
    }
  };
  walk(root, 0);
  return lines.join('\n');
}

const pad = n => String(n).padStart(2, '0');
const stamp = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

// files: [{ path, content }] in output order. part: { index, total }.
export function renderMarkdown({ name, files, task = '', part = { index: 1, total: 1 }, now = new Date() }) {
  const multi = part.total > 1;
  const meta = [`Generated: ${stamp(now)}`, `Files: ${files.length}`];
  if (multi) meta.push(`Part ${part.index}/${part.total}`);
  const out = [`# Project context: ${name}`, meta.join(' · '), ''];
  if (task.trim() && part.index === 1) out.push('## Task', task.trim(), '');
  if (multi && part.index > 1) out.push(`> Continuation: part ${part.index} of ${part.total}. The task and earlier files are in the previous parts.`, '');
  out.push('## File tree', '```', treeText(files.map(f => f.path)), '```', '', '## Files', '');
  for (const f of files) {
    const fence = fenceFor(f.content);
    out.push(`### \`${f.path}\``, fence + languageFor(f.path), f.content.replace(/\n+$/, ''), fence, '');
  }
  return out.join('\n');
}
