// Minimal glob matching for exclude/deny patterns.
// "name" or "*.ext" (no slash) matches any path segment;
// "dir/sub" or "/dir" is anchored at the project root and also matches everything below it.
const toRegex = glob => glob
  .replace(/[.+^${}()|[\]\\]/g, '\\$&')
  .replace(/\*\*/g, '\u0000')
  .replace(/\*/g, '[^/]*')
  .replace(/\?/g, '[^/]')
  .replace(/\u0000/g, '.*');

export function matcher(pattern) {
  let p = pattern.trim().replace(/^\.\//, '').replace(/\/+$/, '');
  const anchored = p.includes('/');
  p = p.replace(/^\/+/, '');
  if (anchored) {
    const re = new RegExp(`^${toRegex(p)}(?:/.*)?$`);
    return rel => re.test(rel);
  }
  const re = new RegExp(`^${toRegex(p)}$`);
  return rel => rel.split('/').some(seg => re.test(seg));
}

export function anyMatch(patterns) {
  const list = patterns.map(matcher);
  return rel => list.some(m => m(rel));
}
