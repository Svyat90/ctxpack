export const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const isPhp = p => p.endsWith('.php') && !p.endsWith('.blade.php');
export const shortName = fqcn => fqcn.split('\\').pop();

// 1-based numbers of the lines matching `re` (not global), skipping comment lines and,
// with `imports: false`, top-level PHP `use` imports (trait `use` inside a class is indented and kept).
export function lineHits(text, re, { max = 3, imports = true } = {}) {
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length && out.length < max; i++) {
    const l = lines[i];
    if (/^\s*(?:\/\/|\/?\*|#(?!\[))/.test(l)) continue;
    if (!imports && /^use\s/.test(l)) continue;
    if (re.test(l)) out.push(i + 1);
  }
  return out;
}

export const sitesIn = (file, lines) => lines.map(line => ({ file, line }));
