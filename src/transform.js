import { escapeRe } from './related/util.js';

// Tags laravel-ide-helper writes above classes (models in particular).
export const DEFAULT_DOC_TAGS = ['property', 'property-read', 'property-write', 'method', 'mixin'];

// ---- IDE-helper tags in class docblocks ----

// An attribute such as #[ObservedBy([UserObserver::class])], with one level of nested brackets.
const ATTRIBUTE = String.raw`#\[(?:[^\[\]]|\[[^\]]*\])*\]`;
// A docblock (never spanning another "*/") directly above a class-like declaration,
// optionally separated by attributes and modifiers. The trailing newline is part of the match
// so a removed block does not leave an empty line behind.
const CLASS_DOC = new RegExp(
  String.raw`\/\*\*(?:(?!\*\/)[\s\S])*\*\/[ \t]*\r?\n?(?=(?:\s*${ATTRIBUTE})*\s*(?:(?:abstract|final|readonly)\s+)*(?:class|interface|trait|enum)\s+\w)`,
  'g',
);

const isBlankStar = line => /^\s*\*\s*$/.test(line);

function cleanBlock(block, tagRe) {
  const nl = /\r?\n$/.exec(block)?.[0] ?? '';
  const body = nl ? block.slice(0, -nl.length) : block;
  const lines = body.split('\n');

  if (lines.length === 1) {
    // One-line form: /** @mixin \Eloquent */
    const inner = body.replace(/^\s*\/\*\*|\*\/\s*$/g, '').trim();
    return inner && tagRe.test(' * ' + inner) ? '' : block;
  }

  const kept = lines.filter(l => !tagRe.test(l));
  if (kept.length === lines.length) return block;

  const middle = kept.slice(1, -1);
  const first = kept[0];
  const last = kept[kept.length - 1];
  if (middle.every(isBlankStar) && /^\s*\/\*\*\s*$/.test(first) && /^\s*\*\/\s*$/.test(last)) return '';

  // Drop blank " *" lines at the edges and collapse runs of them inside.
  const tidy = [];
  for (const line of middle) {
    if (isBlankStar(line) && (!tidy.length || isBlankStar(tidy[tidy.length - 1]))) continue;
    tidy.push(line);
  }
  while (tidy.length && isBlankStar(tidy[tidy.length - 1])) tidy.pop();
  return [first, ...tidy, last].join('\n') + nl;
}

// Removes IDE-helper tags (@property, @method, @mixin…) from class-level docblocks.
// Method and property docblocks inside the class are left alone.
export function stripClassDocTags(source, tags = DEFAULT_DOC_TAGS) {
  if (!tags.length || !source.includes('/**')) return source;
  const tagRe = new RegExp(`^\\s*\\*\\s*@(?:${tags.map(escapeRe).join('|')})(?![\\w-])`);
  return source.replace(CLASS_DOC, block => cleanBlock(block, tagRe));
}

// ---- all comments ----

// After these, a "/" starts a regex literal rather than a division.
const REGEX_AFTER_CHAR = new Set([...'(,=:[!&|?{};+-*%<>~^']);
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await', 'instanceof']);

// The last significant token already written: a single punctuation char or a whole word.
function prevToken(out) {
  let k = out.length - 1;
  while (k >= 0 && /\s/.test(out[k])) k--;
  if (k < 0) return '';
  if (!/[\w$]/.test(out[k])) return out[k];
  let s = k;
  while (s > 0 && /[\w$]/.test(out[s - 1])) s--;
  return out.slice(s, k + 1);
}

// End index (exclusive) of a regex literal starting at `i`, or -1 when it is not one.
function regexEnd(src, i) {
  let inClass = false;
  for (let j = i + 1; j < src.length && src[j] !== '\n'; j++) {
    const ch = src[j];
    if (ch === '\\') j++;
    else if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    else if (ch === '/' && !inClass) return j + 1;
  }
  return -1;
}

// End index (exclusive) of a PHP heredoc/nowdoc starting at `i`, or -1. The closing label may be
// indented (PHP 7.3+), so it is any line that starts with the label.
function heredocEnd(src, i) {
  const open = /^<<<[ \t]*(["']?)([A-Za-z_]\w*)\1\r?\n/.exec(src.slice(i, i + 256));
  if (!open) return -1;
  const close = new RegExp(`\\n[ \\t]*${open[2]}\\b`, 'g');
  close.lastIndex = i + open[0].length - 1;
  const m = close.exec(src);
  return m ? m.index + m[0].length : src.length;
}

// Removes /* */ and line comments while copying string (and, for JS, regex) literals untouched.
// `lineComment`: true for //, 'ws' for // only after whitespace (SCSS: keeps url(http://…)), false for none.
// `jsLiterals`: JS rules, where '…' and "…" end at a newline and /…/ can be a regex literal.
// `heredoc`: PHP <<<ID … ID blocks are copied whole, so quotes inside them (SQL, "don't") cannot
// shift what the scanner thinks is a string.
function stripCLike(src, { lineComment = true, hash = false, quotes = '\'"`', jsLiterals = false, heredoc = false } = {}) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (heredoc && c === '<' && src.startsWith('<<<', i)) {
      const end = heredocEnd(src, i);
      if (end > 0) {
        out += src.slice(i, end);
        i = end;
        continue;
      }
    }
    if (quotes.includes(c)) {
      const oneLine = jsLiterals && c !== '`';
      let j = i + 1;
      while (j < n && src[j] !== c && !(oneLine && src[j] === '\n')) j += src[j] === '\\' ? 2 : 1;
      const end = j < n && src[j] === c ? j + 1 : j;
      out += src.slice(i, end);
      i = end;
      continue;
    }
    if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2);
      // An unclosed "/*" means the scanner lost track of a literal: keep the rest rather than drop it.
      if (end < 0) {
        out += src.slice(i);
        break;
      }
      i = end + 2;
      continue;
    }
    const slash = c === '/' && d === '/' && (lineComment === true || (lineComment === 'ws' && (i === 0 || /\s/.test(src[i - 1]))));
    if (slash || (hash && c === '#' && d !== '[')) {
      const end = src.indexOf('\n', i);
      i = end < 0 ? n : end;
      continue;
    }
    if (jsLiterals && c === '/') {
      const prev = prevToken(out);
      const end = !prev || REGEX_AFTER_CHAR.has(prev) || REGEX_AFTER_WORD.has(prev) ? regexEnd(src, i) : -1;
      if (end > 0) {
        out += src.slice(i, end);
        i = end;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

const stripMarkup = src => src.replace(/<!--[\s\S]*?-->/g, '');

function stripVue(src) {
  return src.replace(
    /(<script\b[^>]*>)([\s\S]*?)(<\/script>)|(<style\b[^>]*>)([\s\S]*?)(<\/style>)|<!--[\s\S]*?-->/g,
    (m, so, sb, sc, to, tb, tc) => {
      if (so) return so + stripCLike(sb, { jsLiterals: true }) + sc;
      if (to) return to + stripCLike(tb, { lineComment: /lang=["'](?:scss|less)["']/.test(to) ? 'ws' : false, quotes: '\'"' }) + tc;
      return '';
    },
  );
}

// Trailing spaces left by removed comments go, and runs of blank lines shrink to one.
function tidy(text) {
  const out = [];
  for (const line of text.split('\n').map(l => l.trimEnd())) {
    if (line === '' && out.length && out[out.length - 1] === '') continue;
    out.push(line);
  }
  return out.join('\n').replace(/^\n+/, '');
}

export function stripAllComments(path, src) {
  const ext = path.includes('.') ? path.split('.').pop().toLowerCase() : '';
  let out;
  if (path.endsWith('.blade.php')) out = stripMarkup(src.replace(/\{\{--[\s\S]*?--\}\}/g, ''));
  else if (ext === 'php') out = stripCLike(src, { hash: true, heredoc: true });
  else if (['js', 'mjs', 'cjs', 'ts', 'jsx', 'tsx'].includes(ext)) out = stripCLike(src, { jsLiterals: true });
  else if (ext === 'vue') out = stripVue(src);
  else if (ext === 'css') out = stripCLike(src, { lineComment: false, quotes: '\'"' });
  else if (ext === 'scss' || ext === 'less') out = stripCLike(src, { lineComment: 'ws', quotes: '\'"' });
  else if (['html', 'htm', 'xml'].includes(ext)) out = stripMarkup(src);
  else return src;
  return out === src ? src : tidy(out);
}

const isPhpSource = p => p.endsWith('.php') && !p.endsWith('.blade.php');

// ---- imports ----

// Top-level `use` statements of a PHP file, single or grouped (`use App\{A, B};`, also over several
// lines). Only the head before the first declaration is touched, so trait `use` and closure `use (…)`
// inside classes and functions stay.
const PHP_DECL = /^(?:(?:abstract|final|readonly)\s+)*(?:class|interface|trait|enum|function)\b|^return\b/m;
const PHP_USE = /^use\s[^;]*;[ \t]*(?:\r?\n|$)/gm;

// ES imports: `import x from '…'`, `import { a,\n b } from '…'`, `import type …`, `import '…'`.
// Dynamic `import(…)` and `import.meta` are code and stay.
const JS_IMPORT = /^[ \t]*import\b(?!\s*[.(])[^'"`;]*?['"][^'"\n]+['"](?:\s*(?:assert|with)\s*\{[^}]*\})?[ \t]*;?[ \t]*(?:\r?\n|$)/gm;

export function stripAllImports(path, src) {
  const ext = path.includes('.') ? path.split('.').pop().toLowerCase() : '';
  let out;
  if (isPhpSource(path)) {
    const decl = PHP_DECL.exec(src);
    const head = decl ? src.slice(0, decl.index) : src;
    out = head.replace(PHP_USE, '') + (decl ? src.slice(decl.index) : '');
  } else if (['js', 'mjs', 'cjs', 'ts', 'jsx', 'tsx'].includes(ext)) {
    out = src.replace(JS_IMPORT, '');
  } else if (ext === 'vue') {
    // A script that started with its imports does not start with a blank line now.
    out = src.replace(/(<script\b[^>]*>)([\s\S]*?)(<\/script>)/g, (m, open, body, close) => {
      const rest = body.replace(JS_IMPORT, '');
      return open + (rest === body ? body : rest.replace(/^\n(?:[ \t]*\n)+/, '\n')) + close;
    });
  } else {
    return src;
  }
  return out === src ? src : tidy(out);
}

// Export-time transforms for one file. Removing all comments already covers the IDE-helper tags.
export function transformContent(path, content, { stripDocs = true, stripComments = false, stripImports = false, docTags = DEFAULT_DOC_TAGS } = {}) {
  let out = content;
  if (stripComments) out = stripAllComments(path, out);
  else if (stripDocs && isPhpSource(path)) out = stripClassDocTags(out, docTags);
  return stripImports ? stripAllImports(path, out) : out;
}
