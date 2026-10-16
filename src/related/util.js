export const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const isPhp = p => p.endsWith('.php') && !p.endsWith('.blade.php');
export const shortName = fqcn => fqcn.split('\\').pop();
