#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { startServer, DEFAULT_PORT } from '../src/server.js';
import { createApi } from '../src/api.js';
import { CONFIG_NAME, STARTER } from '../src/config.js';
import { t, envLang, normLang } from '../src/i18n.js';

const HELP = {
  en: `ctxpack: packs selected project files into one Markdown file for an AI chat

Usage:
  ctxpack ui [path]                 web UI for picking files (default: current folder)
  ctxpack export [path] [options]   generate Markdown without the UI
  ctxpack init [path]               create ${CONFIG_NAME} with starter settings

Export options:
  --include <paths>     files, folders or globs, comma-separated; can repeat
  --preset <name>       a preset from ${CONFIG_NAME}
  --changed             add files changed in git
  --related             add all related files
  --depth <1-5>         related-file depth (with --related)
  --budget <profile>    small, large, none or a number (32k)
  --split               split into parts that fit the budget
  --task <text>         task description at the top of the file
  --out <folder>        where to save (default ./ctxpack-out)
  --stdout              print Markdown to stdout instead of a file
  --copy                copy the result to the clipboard
  --no-git              do not use git even inside a repository
  --keep-docs           keep @property/@method/@mixin in class docblocks (removed by default)
  --strip-comments      remove all comments (to compare the context size)
  --strip-imports       remove PHP use and JS/TS/Vue import statements

UI options:
  --port <number>       port (default ${DEFAULT_PORT})
  --no-open             do not open the browser
  --out <folder>        where the Save button writes files

Common:
  --lang <en|uk>        message language (default: CTXPACK_LANG or the system locale)

Examples:
  ctxpack ui ~/code/shop-app
  ctxpack export --include app/Http/Controllers/UserController.php --related --depth 2 --split
  ctxpack export --changed --related --copy --task "Add a role filter"`,

  uk: `ctxpack: збирає вибрані файли проєкту в один Markdown для AI-чату

Використання:
  ctxpack ui [шлях]                 веб-інтерфейс для вибору файлів (за замовчуванням поточна папка)
  ctxpack export [шлях] [опції]     згенерувати MD без інтерфейсу
  ctxpack init [шлях]               створити ${CONFIG_NAME} зі стартовими налаштуваннями

Опції export:
  --include <шляхи>     файли, папки або glob через кому; можна повторювати
  --preset <назва>      пресет з ${CONFIG_NAME}
  --changed             додати файли, змінені в git
  --related             додати всі пов'язані файли
  --depth <1-5>         глибина пошуку пов'язаних (для --related)
  --budget <профіль>    small, large, none або число (32k)
  --split               розбити на частини під бюджет
  --task <текст>        опис задачі на початку файлу
  --out <папка>         куди зберегти (за замовчуванням ./ctxpack-out)
  --stdout              вивести MD у stdout замість файлу
  --copy                скопіювати результат у буфер обміну
  --no-git              не використовувати git навіть у репозиторії
  --keep-docs           лишити @property/@method/@mixin у PHPDoc над класами (за замовчуванням прибираються)
  --strip-comments      прибрати всі коментарі (щоб порівняти розмір контексту)
  --strip-imports       прибрати use у PHP та import у JS/TS/Vue

Опції ui:
  --port <число>        порт (за замовчуванням ${DEFAULT_PORT})
  --no-open             не відкривати браузер
  --out <папка>         куди кнопка «Зберегти» пише файли

Загальні:
  --lang <en|uk>        мова повідомлень (за замовчуванням CTXPACK_LANG або мова системи)

Приклади:
  ctxpack ui ~/code/shop-app
  ctxpack export --include app/Http/Controllers/UserController.php --related --depth 2 --split
  ctxpack export --changed --related --copy --task "Додати фільтр за роллю"`,
};

const BOOL = new Set(['changed', 'related', 'split', 'stdout', 'copy', 'no-open', 'no-git', 'keep-docs', 'strip-comments', 'strip-imports', 'help']);
const VALUE = new Set(['include', 'preset', 'depth', 'budget', 'task', 'out', 'port', 'lang']);

// --lang is read before the full parse so that parse errors are already translated.
function peekLang(argv) {
  const i = argv.findIndex(a => a === '--lang' || a.startsWith('--lang='));
  if (i < 0) return envLang();
  return normLang(argv[i].includes('=') ? argv[i].split('=')[1] : argv[i + 1]);
}
const lang = peekLang(process.argv.slice(2));
const msg = (key, params) => t(lang, key, params);

function parseArgs(argv) {
  const args = { _: [], include: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h') { args.help = true; continue; }
    if (!a.startsWith('--')) { args._.push(a); continue; }
    const eq = a.indexOf('=');
    const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
    if (BOOL.has(key)) { args[key] = true; continue; }
    if (!VALUE.has(key)) throw new Error(msg('cli.unknownOption', { key }));
    const val = eq > 0 ? a.slice(eq + 1) : argv[++i];
    if (val === undefined) throw new Error(msg('cli.needsValue', { key }));
    if (key === 'include') args.include.push(...val.split(',').map(s => s.trim()).filter(Boolean));
    else args[key] = val;
  }
  return args;
}

const log = text => process.stderr.write(text + '\n');
const fmt = n => (n >= 1000 ? (n / 1000).toFixed(1) + 'K' : String(n));

function copyToClipboard(text) {
  const tries = process.platform === 'darwin' ? [['pbcopy', []]]
    : process.platform === 'win32' ? [['clip', []]]
    : [['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]];
  return tries.some(([cmd, a]) => spawnSync(cmd, a, { input: text }).status === 0);
}

function init(root) {
  const file = path.join(root, CONFIG_NAME);
  if (fs.existsSync(file)) throw new Error(msg('cli.configExists', { file }));
  fs.writeFileSync(file, JSON.stringify(STARTER, null, 2) + '\n');
  log(msg('cli.created', { file }));
}

function exportCmd(root, args) {
  const api = createApi(root, { outDir: path.resolve(args.out || 'ctxpack-out'), useGit: !args['no-git'] });
  const cfg = api.config;
  let preset = {};
  if (args.preset) {
    preset = cfg.presets[args.preset];
    if (!preset) throw new Error(msg('cli.presetMissing', { name: args.preset, list: Object.keys(cfg.presets).join(', ') || msg('cli.none') }));
  }

  const { files, missing } = api.expand([...(preset.include || []), ...args.include]);
  for (const inc of missing) log(msg('cli.noMatch', { inc }));
  const selected = new Set(files);
  if (args.changed) {
    const changed = api.changed();
    if (!changed.git) log(msg('cli.notGit'));
    changed.files.forEach(p => selected.add(p));
  }
  if (!selected.size) throw new Error(msg('cli.nothingSelected'));

  if (args.related || preset.related) {
    const related = args.depth ? { depth: Number(args.depth) } : {};
    const { suggestions } = api.related({ selected: [...selected], related });
    suggestions.forEach(s => selected.add(s.path));
    log(msg('cli.relatedAdded', { n: suggestions.length }));
  }

  const result = api.export({
    selected: [...selected],
    task: args.task ?? preset.task ?? '',
    budget: args.budget ?? preset.budget ?? cfg.defaultBudget,
    split: !!args.split,
    stripDocs: !args['keep-docs'],
    stripComments: !!args['strip-comments'],
    stripImports: !!args['strip-imports'],
    save: !args.stdout,
  }, lang);
  for (const w of result.warnings) log(msg('cli.warning', { text: w.text }));

  if (args.stdout) process.stdout.write(result.parts.map(p => p.markdown).join('\n\n'));
  else result.saved.forEach(f => log(f));

  const fileCount = result.parts.reduce((s, p) => s + p.files, 0);
  log(msg('cli.summary', { files: fileCount, tokens: fmt(result.total) })
    + (result.usable ? msg('cli.summaryBudget', { usable: fmt(result.usable) }) : '')
    + (result.parts.length > 1 ? msg('cli.summaryParts', { n: result.parts.length }) : '')
    + (result.stripped.tokens > 0 ? msg('cli.summaryStripped', { tokens: fmt(result.stripped.tokens), files: result.stripped.files }) : ''));

  if (args.copy) {
    if (!copyToClipboard(result.parts[0].markdown)) log(msg('cli.copyFailed'));
    else log(result.parts.length > 1 ? msg('cli.copiedFirst') : msg('cli.copied'));
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [cmd = 'help', target = '.'] = args._;
  if (args.help || cmd === 'help') return console.log(HELP[lang]);
  const root = path.resolve(target);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(msg('cli.noDir', { dir: root }));

  if (cmd === 'init') return init(root);
  if (cmd === 'export') return exportCmd(root, args);
  if (cmd === 'ui') {
    const port = args.port === undefined ? DEFAULT_PORT : Number(args.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(msg('cli.badPort', { port: args.port }));
    let started;
    try {
      started = await startServer({ root, port, open: !args['no-open'], outDir: path.resolve(args.out || 'ctxpack-out') });
    } catch (err) {
      if (err.code === 'EADDRINUSE') throw new Error(msg('cli.portBusy', { port, next: port + 1 }));
      throw err;
    }
    log(msg('cli.serving', { root, url: started.url }));
    return;
  }
  throw new Error(msg('cli.unknownCommand', { cmd }));
}

main().catch(err => {
  log(`ctxpack: ${err.message}`);
  process.exit(1);
});
