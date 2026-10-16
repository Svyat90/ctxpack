'use strict';

// Small regex highlighter: PHP and JS/TS/Vue, plus Markdown with fenced code blocks (the export).
// lex*() return the code as lines of [kind, text] segments (kind is null for plain text), so the viewer
// can lay search marks over them; highlight() returns escaped HTML with <span class="t-kind"> tokens.
(() => {
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const words = list => `\\b(?:${list.split(' ').join('|')})\\b`;
  const build = parts => new RegExp(parts.map(([k, re]) => `(?<${k}>${re})`).join('|'), 'g');

  const STR = `'(?:\\\\.|[^'\\\\\\n])*'?|"(?:\\\\.|[^"\\\\\\n])*"?`;
  const NUM = '\\b\\d[\\d_]*(?:\\.\\d+)?\\b';
  const CLS = '\\b[A-Z][\\w]*';
  const FN = '\\b[a-zA-Z_]\\w*(?=\\s*\\()';

  const LANGS = {
    php: build([
      ['com', '\\/\\/.*|#(?!\\[).*|\\/\\*[\\s\\S]*?(?:\\*\\/|$)'],
      ['str', STR],
      ['var', '\\$\\w+'],
      ['kw', words('abstract and array as break case catch class clone const continue declare default do echo else elseif empty enum extends final finally fn for foreach function global if implements include instanceof insteadof interface isset list match namespace new null or parent private protected public readonly require require_once return self static switch throw trait true false try unset use var while yield void int string bool float mixed never iterable object')],
      ['num', NUM],
      ['cls', CLS],
      ['fn', FN],
    ]),
    js: build([
      ['com', '\\/\\/.*|\\/\\*[\\s\\S]*?(?:\\*\\/|$)|<!--[\\s\\S]*?(?:-->|$)'],
      ['str', STR + '|`(?:\\\\.|[^`\\\\])*`?'],
      ['tag', '<\\/?[A-Za-z][\\w.-]*|\\/?>'],
      ['kw', words('as async await break case catch class const continue default defineEmits defineProps delete do else export extends false finally for from function if import in instanceof let new null of return setup static super switch this throw true try type typeof undefined var void while yield interface enum')],
      ['num', NUM],
      ['cls', CLS],
      ['fn', FN],
    ]),
  };

  const langFor = path => {
    if (/\.php$/.test(path)) return 'php';
    if (/\.(?:vue|js|mjs|cjs|ts|jsx|tsx|json)$/.test(path)) return 'js';
    return null;
  };
  // Info strings of the export's code fences (see languageFor in src/render.js).
  const FENCE_LANG = { php: 'php', blade: 'js', vue: 'js', js: 'js', ts: 'js', jsx: 'js', tsx: 'js', json: 'js', html: 'js', xml: 'js' };

  function lex(code, lang) {
    const lines = [[]];
    const push = (kind, text) => text.split('\n').forEach((part, i) => {
      if (i) lines.push([]);
      if (part) lines[lines.length - 1].push([kind, part]);
    });
    const re = LANGS[lang];
    if (!re) {
      push(null, code);
      return lines;
    }
    let last = 0;
    for (const m of code.matchAll(re)) {
      push(null, code.slice(last, m.index));
      push(Object.keys(m.groups).find(k => m.groups[k] !== undefined), m[0]);
      last = m.index + m[0].length;
    }
    push(null, code.slice(last));
    return lines;
  }

  const lexFile = (code, path) => lex(code, langFor(path));

  // Each fenced block is lexed in its own language; outside them only headings and fences are marked.
  function lexMarkdown(md) {
    const out = [];
    const src = md.split('\n');
    for (let i = 0; i < src.length; i++) {
      const open = /^(`{3,})([\w-]*)\s*$/.exec(src[i]);
      if (!open) {
        out.push(src[i] ? [[/^#{1,6}\s/.test(src[i]) ? 'h' : null, src[i]]] : []);
        continue;
      }
      let end = i + 1;
      while (end < src.length && src[end] !== open[1]) end++;
      out.push([['com', src[i]]]);
      if (end > i + 1) out.push(...lex(src.slice(i + 1, end).join('\n'), FENCE_LANG[open[2]]));
      if (end < src.length) out.push([['com', src[end]]]);
      i = end;
    }
    return out;
  }

  const span = ([kind, text]) => (kind ? `<span class="t-${kind}">${esc(text)}</span>` : esc(text));
  const highlight = (code, path) => lexFile(code, path).map(segs => segs.map(span).join('')).join('\n');

  window.CTXPACK_HL = { highlight, lexFile, lexMarkdown, span };
})();
