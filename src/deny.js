import path from 'node:path';
import { anyMatch } from './match.js';

// Never exported, not even when picked by hand.
export const DENY = [
  '.env', '.env.*', '*.pem', '*.key', '*.p12', '*.pfx', '*.keystore',
  'id_rsa*', 'id_ecdsa*', 'id_ed25519*', 'auth.json',
  '/storage', '*.sqlite', '*.sqlite3', '.git',
];
const SAFE_ENV = new Set(['.env.example', '.env.sample', '.env.dist']);
const denyMatch = anyMatch(DENY);

export function isDenied(rel) {
  const base = path.posix.basename(rel);
  if (SAFE_ENV.has(base)) {
    const dir = path.posix.dirname(rel);
    return dir !== '.' && denyMatch(dir);
  }
  return denyMatch(rel);
}

// Kinds are codes; their human names live in src/i18n.js ("kind.<code>").
const SECRET_PATTERNS = [
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['aws-key', /\bAKIA[0-9A-Z]{16}\b/],
  ['github-token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['slack-token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
];
// `'password' => 'abc123secret'`, `apiKey: "..."`. Values must mix letters and digits and carry no `|`,
// so Laravel validation rules like 'required|string|min:8' are not reported.
const ASSIGNMENT = /(?:api[_-]?key|secret|token|passw(?:or)?d)\w*['"]?\s*(?:=>|=|:)\s*['"]([^'"\s]{8,})['"]/i;

export function scanSecrets(text) {
  const hits = [];
  text.split('\n').forEach((line, i) => {
    if (line.length > 2000) return;
    const known = SECRET_PATTERNS.find(([, re]) => re.test(line));
    if (known) return hits.push({ line: i + 1, kind: known[0] });
    const m = ASSIGNMENT.exec(line);
    if (m && !m[1].includes('|') && /\d/.test(m[1]) && /[A-Za-z]/.test(m[1])) hits.push({ line: i + 1, kind: 'assignment' });
  });
  return hits;
}
