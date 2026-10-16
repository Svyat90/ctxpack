#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { startServer } from '../src/server.js';
import { createApi } from '../src/api.js';
import { CONFIG_NAME, STARTER } from '../src/config.js';

const HELP = `ctxpack: збирає вибрані файли проєкту в один Markdown для AI-чату

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

Опції ui:
  --port <число>        порт (за замовчуванням випадковий)
  --no-open             не відкривати браузер
  --out <папка>         куди кнопка «Зберегти» пише файли

Приклади:
  ctxpack ui ~/code/shop-app
  ctxpack export --include app/Http/Controllers/UserController.php --related --depth 2 --split
  ctxpack export --changed --related --copy --task "Додати фільтр за роллю"`;

const BOOL = new Set(['changed', 'related', 'split', 'stdout', 'copy', 'no-open', 'no-git', 'help']);
const VALUE = new Set(['include', 'preset', 'depth', 'budget', 'task', 'out', 'port']);

function parseArgs(argv) {
  const args = { _: [], include: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h') { args.help = true; continue; }
    if (!a.startsWith('--')) { args._.push(a); continue; }
    const eq = a.indexOf('=');
    const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
    if (BOOL.has(key)) { args[key] = true; continue; }
    if (!VALUE.has(key)) throw new Error(`Невідома опція --${key}. Див. ctxpack --help`);
    const val = eq > 0 ? a.slice(eq + 1) : argv[++i];
    if (val === undefined) throw new Error(`--${key} потребує значення`);
    if (key === 'include') args.include.push(...val.split(',').map(s => s.trim()).filter(Boolean));
    else args[key] = val;
  }
  return args;
}

const log = msg => process.stderr.write(msg + '\n');
const fmt = t => (t >= 1000 ? (t / 1000).toFixed(1) + 'K' : String(t));

function copyToClipboard(text) {
  const tries = process.platform === 'darwin' ? [['pbcopy', []]]
    : process.platform === 'win32' ? [['clip', []]]
    : [['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]];
  return tries.some(([cmd, a]) => spawnSync(cmd, a, { input: text }).status === 0);
}

function init(root) {
  const file = path.join(root, CONFIG_NAME);
  if (fs.existsSync(file)) throw new Error(`${file} вже існує`);
  fs.writeFileSync(file, JSON.stringify(STARTER, null, 2) + '\n');
  log(`Створено ${file}`);
}

function exportCmd(root, args) {
  const api = createApi(root, { outDir: path.resolve(args.out || 'ctxpack-out'), useGit: !args['no-git'] });
  const cfg = api.config;
  let preset = {};
  if (args.preset) {
    preset = cfg.presets[args.preset];
    if (!preset) throw new Error(`Пресет «${args.preset}» не знайдено. Є: ${Object.keys(cfg.presets).join(', ') || 'жодного'}`);
  }

  const { files, missing } = api.expand([...(preset.include || []), ...args.include]);
  for (const m of missing) log(`увага: нічого не знайдено для «${m}»`);
  const selected = new Set(files);
  if (args.changed) {
    const changed = api.changed();
    if (!changed.git) log('увага: це не git-репозиторій, --changed пропущено');
    changed.files.forEach(p => selected.add(p));
  }
  if (!selected.size) throw new Error('Нічого не вибрано. Вкажіть --include, --preset або --changed.');

  if (args.related || preset.related) {
    const related = args.depth ? { depth: Number(args.depth) } : {};
    const { suggestions } = api.related({ selected: [...selected], related });
    suggestions.forEach(s => selected.add(s.path));
    log(`Додано пов'язаних файлів: ${suggestions.length}`);
  }

  const result = api.export({
    selected: [...selected],
    task: args.task ?? preset.task ?? '',
    budget: args.budget ?? preset.budget ?? cfg.defaultBudget,
    split: !!args.split,
    save: !args.stdout,
  });
  for (const w of result.warnings) log(`увага: ${w.text}`);

  if (args.stdout) process.stdout.write(result.parts.map(p => p.markdown).join('\n\n'));
  else result.saved.forEach(f => log(f));

  const fileCount = result.parts.reduce((s, p) => s + p.files, 0);
  log(`Файлів: ${fileCount} · ~${fmt(result.total)} токенів${result.usable ? ` · бюджет ${fmt(result.usable)}` : ''}${result.parts.length > 1 ? ` · частин: ${result.parts.length}` : ''}`);

  if (args.copy) {
    if (!copyToClipboard(result.parts[0].markdown)) log('увага: не вдалося скопіювати в буфер обміну');
    else log(result.parts.length > 1 ? 'Скопійовано частину 1. Решта у файлах.' : 'Скопійовано в буфер обміну.');
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [cmd = 'help', target = '.'] = args._;
  if (args.help || cmd === 'help') return console.log(HELP);
  const root = path.resolve(target);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`Папку не знайдено: ${root}`);

  if (cmd === 'init') return init(root);
  if (cmd === 'export') return exportCmd(root, args);
  if (cmd === 'ui') {
    const { url } = await startServer({
      root,
      port: Number(args.port) || 0,
      open: !args['no-open'],
      outDir: path.resolve(args.out || 'ctxpack-out'),
    });
    log(`ctxpack: ${root}\nВідкрийте ${url}\nCtrl+C, щоб зупинити.`);
    return;
  }
  throw new Error(`Невідома команда «${cmd}». Див. ctxpack --help`);
}

main().catch(err => {
  log(`ctxpack: ${err.message}`);
  process.exit(1);
});
