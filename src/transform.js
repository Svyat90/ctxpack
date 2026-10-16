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

// Removes /* */ and line comments while copying string (and, for JS, regex) literals untouched.
// `lineComment`: true for //, 'ws' for // only after whitespace (SCSS: keeps url(http://…)), false for none.
// `jsLiterals`: JS rules, where '…' and "…" end at a newline and /…/ can be a regex literal.
function stripCLike(src, { lineComment = true, hash = false, quotes = '\'"`', jsLiterals = false } = {}) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
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
      i = end < 0 ? n : end + 2;
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
  else if (ext === 'php') out = stripCLike(src, { hash: true });
  else if (['js', 'mjs', 'cjs', 'ts', 'jsx', 'tsx'].includes(ext)) out = stripCLike(src, { jsLiterals: true });
  else if (ext === 'vue') out = stripVue(src);
  else if (ext === 'css') out = stripCLike(src, { lineComment: false, quotes: '\'"' });
  else if (ext === 'scss' || ext === 'less') out = stripCLike(src, { lineComment: 'ws', quotes: '\'"' });
  else if (['html', 'htm', 'xml'].includes(ext)) out = stripMarkup(src);
  else return src;
  return out === src ? src : tidy(out);
}

const isPhpSource = p => p.endsWith('.php') && !p.endsWith('.blade.php');

// Export-time transforms for one file. Removing all comments already covers the IDE-helper tags.
export function transformContent(path, content, { stripDocs = true, stripComments = false, docTags = DEFAULT_DOC_TAGS } = {}) {
  if (stripComments) return stripAllComments(path, content);
  if (stripDocs && isPhpSource(path)) return stripClassDocTags(content, docTags);
  return content;
}
