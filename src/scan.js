import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { anyMatch } from './match.js';
import { isDenied } from './deny.js';
import { orderPaths } from './order.js';

const BINARY_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg', 'psd',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'pdf', 'zip', 'gz', 'tgz', 'tar', 'rar', '7z',
  'mp3', 'mp4', 'mov', 'webm', 'wav', 'ogg',
  'wasm', 'bin', 'exe', 'dll', 'so', 'dylib', 'jar', 'class', 'phar',
]);

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8');
}

// Returns every candidate file (relative, "/"-separated) in tree order.
// Entries carry `flag: 'deny'` (never exportable) or `flag: 'big'` (over maxFileKb); excluded and binary files are left out.
export function listFiles(root, cfg, { useGit = true } = {}) {
  const excluded = anyMatch(cfg.exclude);
  let rels = null;
  if (useGit) {
    try {
      rels = git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
    } catch {
      rels = null;
    }
  }
  const usedGit = rels !== null;
  if (!rels) rels = walk(root, excluded);

  const byPath = new Map();
  for (const rel of new Set(rels)) {
    const entry = inspect(root, rel, cfg, excluded);
    if (entry) byPath.set(rel, entry);
  }
  return { root, git: usedGit, files: orderPaths(byPath.keys()).map(p => byPath.get(p)) };
}

function inspect(root, rel, cfg, excluded) {
  if (isDenied(rel)) return { path: rel, size: 0, tokens: 0, flag: 'deny' };
  if (excluded(rel)) return null;
  if (BINARY_EXT.has(path.extname(rel).slice(1).toLowerCase())) return null;
  const abs = path.join(root, rel);
  let st;
  try {
    st = fs.lstatSync(abs);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  const tokens = Math.ceil(st.size / cfg.tokenCharsRatio);
  if (st.size > cfg.maxFileKb * 1024) return { path: rel, size: st.size, tokens, flag: 'big' };
  if (looksBinary(abs)) return null;
  return { path: rel, size: st.size, tokens };
}

function looksBinary(abs) {
  let fd;
  try {
    fd = fs.openSync(abs, 'r');
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).includes(0);
  } catch {
    return true;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// Fallback for folders without git: never descends into excluded or denied directories.
function walk(root, excluded) {
  const out = [];
  const visit = dir => {
    let items;
    try {
      items = fs.readdirSync(path.join(root, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      if (it.name === '.git') continue;
      const rel = dir ? `${dir}/${it.name}` : it.name;
      if (it.isDirectory()) {
        if (isDenied(rel)) out.push(rel);
        else if (!excluded(rel)) visit(rel);
      } else if (it.isFile()) {
        out.push(rel);
      }
    }
  };
  visit('');
  return out;
}

// Modified, staged and untracked files under root (deleted ones skipped). null when root is not in a git repo.
export function changedFiles(root) {
  let prefix;
  let out;
  try {
    prefix = git(root, ['rev-parse', '--show-prefix']).trim();
    out = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.']);
  } catch {
    return null;
  }
  const items = out.split('\0');
  const paths = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.length < 4) continue;
    const xy = item.slice(0, 2);
    const p = item.slice(3);
    if (xy[0] === 'R' || xy[0] === 'C') i++; // the next item is the rename source
    if (xy.includes('D')) continue;
    if (prefix && !p.startsWith(prefix)) continue;
    paths.push(p.slice(prefix.length));
  }
  return orderPaths(paths);
}
