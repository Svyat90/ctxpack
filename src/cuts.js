import { createHash } from 'node:crypto';

// Blocks of lines the user cut out of a file in the UI. A cut is [first, last], 1-based lines of the
// file on disk, and is tied to the file's hash so it is dropped when the file changes.

export const hashText = text => createHash('sha1').update(text).digest('hex').slice(0, 12);

// Sorted, clamped to the file, overlapping and touching ranges merged.
export function normalizeRanges(ranges, lineCount) {
  const list = (Array.isArray(ranges) ? ranges : [])
    .filter(r => Array.isArray(r) && r.length === 2 && r.every(Number.isInteger))
    .map(([a, b]) => [Math.max(1, Math.min(a, b)), Math.min(lineCount, Math.max(a, b))])
    .filter(([a, b]) => a <= b)
    .sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const r of list) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else out.push([...r]);
  }
  return out;
}

const MARK = '\u0000ctxpack-cut:';

// Each cut becomes one placeholder line (keeping the indent of its first line), so the comment
// transforms cannot eat the note. `origin[i]` is the file line of output line i, or { cut } for a placeholder.
export function applyCuts(text, ranges) {
  const lines = text.split('\n');
  const out = [];
  const origin = [];
  let r = 0;
  for (let i = 1; i <= lines.length; i++) {
    const cut = ranges[r];
    if (cut && i === cut[0]) {
      out.push(`${/^[ \t]*/.exec(lines[i - 1])[0]}${MARK}${r}\u0000`);
      origin.push({ cut });
      i = cut[1];
      r++;
      continue;
    }
    out.push(lines[i - 1]);
    origin.push(i);
  }
  return { text: out.join('\n'), origin };
}

// The comment syntax at line `at` of the file (Vue: by the top-level block the line is in).
function commentFor(path, lines, at) {
  const ext = path.includes('.') ? path.split('.').pop().toLowerCase() : '';
  if (path.endsWith('.blade.php')) return ['{{--', '--}}'];
  if (ext === 'vue') {
    let block = 'html';
    for (let i = 0; i < at - 1; i++) {
      if (/^<script\b/.test(lines[i])) block = 'js';
      else if (/^<style\b/.test(lines[i])) block = 'css';
      else if (/^<\/(?:script|style)>/.test(lines[i])) block = 'html';
    }
    return block === 'js' ? ['//', ''] : block === 'css' ? ['/*', '*/'] : ['<!--', '-->'];
  }
  if (['php', 'js', 'mjs', 'cjs', 'ts', 'jsx', 'tsx', 'json', 'scss', 'less'].includes(ext)) return ['//', ''];
  if (ext === 'css') return ['/*', '*/'];
  if (['html', 'htm', 'xml', 'md', 'svg'].includes(ext)) return ['<!--', '-->'];
  if (['yml', 'yaml', 'neon', 'sh', 'ini', 'toml', 'env', 'py', 'rb'].includes(ext) || /(?:^|\/)(?:Dockerfile|Makefile|\.env[\w.]*)$/.test(path)) return ['#', ''];
  return ['', ''];
}

export function cutNote(path, original, [a, b]) {
  const [open, close] = commentFor(path, original.split('\n'), a);
  const n = b - a + 1;
  const text = `ctxpack: ${n === 1 ? `line ${a}` : `lines ${a}-${b}`} removed`;
  return [open, text, close].filter(Boolean).join(' ');
}

// Which line of `before` each line of `after` came from, where `after` is `before` with comments or
// docblock lines removed (whole lines, line tails, runs of blank lines). Non-blank lines are matched
// forward (same text, or the start of a line whose comment tail was cut); blank lines go between them.
export function alignLines(after, before) {
  const map = new Array(after.length).fill(-1);
  const WINDOW = 400;
  let j = 0;
  for (let i = 0; i < after.length; i++) {
    const line = after[i].trimEnd();
    if (!line) continue;
    let hit = -1;
    for (let k = j; k < before.length && k < j + WINDOW; k++) {
      const b = before[k].trimEnd();
      if (b === line || b.startsWith(line)) {
        hit = k;
        break;
      }
    }
    map[i] = hit >= 0 ? hit : Math.min(j, before.length - 1);
    j = map[i] + 1;
  }
  const next = new Array(after.length);
  for (let i = after.length - 1, n = before.length; i >= 0; i--) {
    next[i] = n;
    if (map[i] >= 0) n = map[i];
  }
  let prev = -1;
  for (let i = 0; i < after.length; i++) {
    if (map[i] >= 0) {
      prev = map[i];
      continue;
    }
    map[i] = prev + 1 < next[i] ? prev + 1 : Math.max(0, prev);
    prev = map[i];
  }
  return map;
}

// Turns the placeholders left by applyCuts (and kept through the transforms) into comments, and maps
// every line of the result to its file line. `markers` are the result lines that stand for a cut.
export function finishCuts(path, original, cutText, origin, transformed) {
  const after = transformed.split('\n');
  const before = cutText.split('\n');
  const align = transformed === cutText ? after.map((_, i) => i) : alignLines(after, before);
  const ranges = origin.filter(o => typeof o === 'object').map(o => o.cut);
  const markers = [];
  const map = [];
  const lines = after.map((line, i) => {
    const m = line.indexOf(MARK);
    if (m < 0) {
      const o = origin[align[i]];
      map.push(typeof o === 'number' ? o : o.cut[0]);
      return line;
    }
    const range = ranges[Number(line.slice(m + MARK.length, line.indexOf('\u0000', m + 1)))];
    markers.push({ line: i, range });
    map.push(range[0]);
    return line.slice(0, m) + cutNote(path, original, range);
  });
  return { content: lines.join('\n'), map, markers };
}
